/**
 * PropertyTraining.tsx — Baseline Capture Flow
 *
 * Training mode captures the property in its ideal state.
 * The user walks through and captures photos/videos from different angles.
 * The AI analyzes the media and creates rooms, items, and baselines.
 *
 * Flow:
 * 1. Instructions + "Start Capture" button
 * 2. Camera view for capturing media (3-15+ items)
 * 3. Thumbnails with visible X delete, pinch-to-zoom, photo/video toggle
 * 4. "Done Capturing" -> uploads all media -> triggers AI training
 * 5. Results screen showing detected rooms and items
 */

import React, { useState, useRef, useCallback, useEffect, useMemo } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  Alert,
  FlatList,
  Modal,
  useWindowDimensions,
  Animated,
  Easing,
  BackHandler,
  Linking,
  AppState,
  type AppStateStatus,
} from "react-native";
import { Image } from "expo-image";
import { SafeAreaView } from "react-native-safe-area-context";
import { CameraView, useCameraPermissions, useMicrophonePermissions } from "expo-camera";
import { requireOptionalNativeModule } from "expo-modules-core";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { runOnJS } from "react-native-reanimated";
import * as Haptics from "expo-haptics";
import { useNavigation, useRoute } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import type { RouteProp } from "@react-navigation/native";
import type { RootStackParamList } from "../navigation";
import {
  uploadBase64Image,
  uploadImageFile,
  uploadVideoFile,
  trainProperty,
  ApiError,
} from "../lib/api";
import { colors } from "../lib/tokens";
import * as FileSystem from "expo-file-system";
import { buildCapabilities, getVideoTrainingCapability } from "../lib/runtime/capabilities";

type Nav = NativeStackNavigationProp<RootStackParamList, "PropertyTraining">;
type TrainingRoute = RouteProp<RootStackParamList, "PropertyTraining">;

type TrainingPhase = "intro" | "capturing" | "uploading" | "training" | "results";
type CaptureMode = "photo" | "video";

interface CapturedMedia {
  id: string;
  type: CaptureMode;
  base64?: string; // Only for photos
  uri: string;
  previewUri?: string;
}

interface TrainingResult {
  rooms: Array<{
    name: string;
    roomType: string;
    items: Array<{ name: string; category: string }>;
    baselineCount: number;
  }>;
  totalRooms: number;
  totalItems: number;
  dedupe?: {
    enabled: boolean;
    inputCount: number;
    keptCount: number;
    droppedCount: number;
  };
  mediaSummary?: {
    uploadedImages: number;
    uploadedVideos: number;
    analyzedFrames: number;
  };
}

const TRAINING_MESSAGES = [
  "Analyzing your photos…",
  "Identifying rooms and spaces…",
  "Cataloging items and fixtures…",
  "Building inspection baselines…",
  "Almost there…",
];
// Base timestamps for short videos (<60s). For longer videos,
// generateKeyframeTimestamps() extends sampling across the full duration.
const BASE_KEYFRAME_TIMESTAMPS_MS = [
  500, 1500, 2500, 4000, 6000, 8000, 10_000, 13_000,
  16_000, 20_000, 24_000, 30_000, 36_000, 42_000, 48_000, 55_000,
];
// Increased from 5 to 8 — more diverse angles for better walkthrough matching
const VIDEO_KEYFRAME_MAX_PER_VIDEO = 8;
// Max candidates to extract before sharpness scoring
const VIDEO_KEYFRAME_MAX_CANDIDATES = 20;

/** Generate duration-aware timestamps. For videos longer than 60s,
 *  extends sampling evenly across the full duration so no content is ignored. */
function generateKeyframeTimestamps(durationMs?: number): number[] {
  if (!durationMs || durationMs <= 60_000) {
    return BASE_KEYFRAME_TIMESTAMPS_MS;
  }
  // Use base timestamps for first minute, then add evenly-spaced samples for the rest
  const extended = [...BASE_KEYFRAME_TIMESTAMPS_MS];
  const remainingMs = durationMs - 60_000;
  const extraCount = Math.min(8, Math.ceil(remainingMs / 10_000)); // ~1 sample per 10s
  for (let i = 1; i <= extraCount; i++) {
    extended.push(60_000 + Math.round((remainingMs * i) / (extraCount + 1)));
  }
  return extended;
}

type VideoThumbnailsModule = {
  getThumbnailAsync: (
    uri: string,
    options: { time: number; quality: number },
  ) => Promise<{ uri: string }>;
};

type NativeVideoThumbnailsModule = {
  getThumbnail: (
    uri: string,
    options: { time: number; quality: number },
  ) => Promise<{ uri: string }>;
};

let cachedVideoThumbnailsModule: VideoThumbnailsModule | null | undefined;
let loggedMissingVideoThumbnailsModule = false;

function getVideoThumbnailsModule(): VideoThumbnailsModule | null {
  if (cachedVideoThumbnailsModule !== undefined) {
    return cachedVideoThumbnailsModule;
  }

  const nativeModule =
    requireOptionalNativeModule<NativeVideoThumbnailsModule>("ExpoVideoThumbnails");

  if (!nativeModule) {
    if (!loggedMissingVideoThumbnailsModule) {
      loggedMissingVideoThumbnailsModule = true;
      console.warn(
        "[PropertyTraining] ExpoVideoThumbnails native module is unavailable in this client build.",
      );
    }
    console.warn(
      "[PropertyTraining] Video training is unavailable in this client build. Use photo capture or install the latest Atria dev build.",
    );
    cachedVideoThumbnailsModule = null;
    return null;
  }

  cachedVideoThumbnailsModule = {
    getThumbnailAsync: (uri, options) => nativeModule.getThumbnail(uri, options),
  };
  return cachedVideoThumbnailsModule;
}

export default function PropertyTrainingScreen() {
  const navigation = useNavigation<Nav>();
  const route = useRoute<TrainingRoute>();
  const { propertyId, propertyName } = route.params;
  const { width, height } = useWindowDimensions();
  const isLandscape = width > height;

  const [permission, requestPermission] = useCameraPermissions();
  const [microphonePermission, requestMicrophonePermission] = useMicrophonePermissions();
  const [phase, setPhase] = useState<TrainingPhase>("intro");
  const [captures, setCaptures] = useState<CapturedMedia[]>([]);
  const [captureMode, setCaptureMode] = useState<CaptureMode>("photo");
  const [isAddMore, setIsAddMore] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [zoom, setZoom] = useState(0);
  const [uploadProgress, setUploadProgress] = useState({ current: 0, total: 0 });
  const [trainingResult, setTrainingResult] = useState<TrainingResult | null>(null);
  const previousResultRef = useRef<TrainingResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cameraRef = useRef<CameraView>(null);
  const videoThumbnailsRef = useRef<VideoThumbnailsModule | null>(getVideoThumbnailsModule());
  const videoSupportAlertShownRef = useRef(false);
  const baseZoomRef = useRef(0);
  const isCapturingRef = useRef(false);
  const isRecordingRef = useRef(false);
  const capturesRef = useRef<CapturedMedia[]>([]);
  const recordingPulse = useRef(new Animated.Value(0)).current;
  const [previewMedia, setPreviewMedia] = useState<CapturedMedia | null>(null);
  const captureFlashAnim = useRef(new Animated.Value(0)).current;
  const thumbnailListRef = useRef<FlatList>(null);
  // Track successful uploads so retries don't duplicate — maps capture.id → upload record ids
  const uploadedIdsRef = useRef<Map<string, string[]>>(new Map());
  const cancelRequestedRef = useRef(false);
  const runIdRef = useRef(0);
  const trainingAbortRef = useRef<AbortController | null>(null);
  const videoTrainingCapability = useMemo(() => getVideoTrainingCapability(), []);
  const videoKeyframesAvailable = videoThumbnailsRef.current !== null;
  const videoTrainingBuildNote = !videoTrainingCapability.optimized
    ? [videoTrainingCapability.reason, videoTrainingCapability.recoveryHint]
        .filter(Boolean)
        .join(" ")
    : null;

  useEffect(() => {
    if (!videoTrainingCapability.supported && captureMode === "video" && !isRecording) {
      setCaptureMode("photo");
    }
  }, [captureMode, isRecording, videoTrainingCapability.supported]);

  // ── Processing Screen Animations ──
  const breatheAnim = useRef(new Animated.Value(0)).current;
  const spinAnim = useRef(new Animated.Value(0)).current;
  const progressAnim = useRef(new Animated.Value(0)).current;
  const fadeAnim = useRef(new Animated.Value(1)).current;
  const slideAnim = useRef(new Animated.Value(0)).current;
  const [trainingMessageIndex, setTrainingMessageIndex] = useState(0);
  const messageFadeAnim = useRef(new Animated.Value(1)).current;

  // ── Pinch-to-Zoom Gesture ──
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;

  useEffect(() => {
    capturesRef.current = captures;
  }, [captures]);

  const deleteLocalMedia = useCallback((uri?: string | null) => {
    if (!uri || !uri.startsWith("file://")) return;

    try {
      const file = new FileSystem.File(uri);
      if (file.exists) {
        file.delete();
      }
    } catch (err) {
      console.warn("[PropertyTraining] Failed to delete local media", { uri, err });
    }
  }, []);

  const deleteCapturedFiles = useCallback((capture: CapturedMedia) => {
    if (capture.previewUri && capture.previewUri !== capture.uri) {
      deleteLocalMedia(capture.previewUri);
    }
    deleteLocalMedia(capture.uri);
  }, [deleteLocalMedia]);

  const releaseCapturedMedia = useCallback(
    (media: CapturedMedia[]) => {
      media.forEach((capture) => deleteCapturedFiles(capture));
      capturesRef.current = [];
      uploadedIdsRef.current.clear();
    },
    [deleteCapturedFiles],
  );

  const clearCapturedMedia = useCallback(
    (media: CapturedMedia[]) => {
      releaseCapturedMedia(media);
      setCaptures([]);
    },
    [releaseCapturedMedia],
  );

  const pinchGesture = Gesture.Pinch()
    .onStart(() => {
      baseZoomRef.current = zoomRef.current;
    })
    .onUpdate((event) => {
      const newZoom = Math.min(1, Math.max(0, baseZoomRef.current + (event.scale - 1) * 0.5));
      runOnJS(setZoom)(newZoom);
    })
    .onEnd(() => {
      baseZoomRef.current = zoomRef.current;
    });

  // ── Recording Pulse Animation ──
  useEffect(() => {
    let pulseLoop: Animated.CompositeAnimation | null = null;

    if (isRecording) {
      recordingPulse.setValue(0);
      pulseLoop = Animated.loop(
        Animated.sequence([
          Animated.timing(recordingPulse, {
            toValue: 1,
            duration: 900,
            easing: Easing.out(Easing.quad),
            useNativeDriver: true,
          }),
          Animated.timing(recordingPulse, {
            toValue: 0,
            duration: 0,
            useNativeDriver: true,
          }),
        ]),
      );
      pulseLoop.start();
    } else {
      recordingPulse.stopAnimation();
      recordingPulse.setValue(0);
    }

    return () => {
      if (pulseLoop) pulseLoop.stop();
    };
  }, [isRecording, recordingPulse]);

  // ── Processing Animations (breathe + spin) ──
  useEffect(() => {
    const isProcessing = phase === "uploading" || phase === "training";
    if (!isProcessing) return;

    // Breathing ring: scale 1.0→1.15→1.0
    const breatheLoop = Animated.loop(
      Animated.sequence([
        Animated.timing(breatheAnim, {
          toValue: 1,
          duration: 2500,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true,
        }),
        Animated.timing(breatheAnim, {
          toValue: 0,
          duration: 2500,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true,
        }),
      ]),
    );

    // Spinning arc: 0→1 (0→360°) continuous
    const spinLoop = Animated.loop(
      Animated.timing(spinAnim, {
        toValue: 1,
        duration: 1200,
        easing: Easing.linear,
        useNativeDriver: true,
      }),
    );

    breatheAnim.setValue(0);
    spinAnim.setValue(0);
    breatheLoop.start();
    spinLoop.start();

    return () => {
      breatheLoop.stop();
      spinLoop.stop();
    };
  }, [phase, breatheAnim, spinAnim]);

  // ── Smooth Progress Interpolation ──
  useEffect(() => {
    if (phase !== "uploading" || uploadProgress.total === 0) return;
    const target = uploadProgress.current / uploadProgress.total;
    Animated.timing(progressAnim, {
      toValue: target,
      duration: 400,
      easing: Easing.out(Easing.quad),
      useNativeDriver: false, // width animation can't use native driver
    }).start();
  }, [uploadProgress.current, uploadProgress.total, phase, progressAnim]);

  // ── Phase Transition Animation ──
  const prevPhaseRef = useRef(phase);
  useEffect(() => {
    const prev = prevPhaseRef.current;
    prevPhaseRef.current = phase;

    // Animate on uploading→training transition
    if (prev === "uploading" && phase === "training") {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      fadeAnim.setValue(0);
      slideAnim.setValue(12);
      Animated.parallel([
        Animated.timing(fadeAnim, {
          toValue: 1,
          duration: 350,
          easing: Easing.out(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.timing(slideAnim, {
          toValue: 0,
          duration: 350,
          easing: Easing.out(Easing.quad),
          useNativeDriver: true,
        }),
      ]).start();
    } else if (
      (prev !== "uploading" && prev !== "training") &&
      (phase === "uploading" || phase === "training")
    ) {
      // Entering processing: fade in
      fadeAnim.setValue(0);
      slideAnim.setValue(16);
      progressAnim.setValue(0);
      Animated.parallel([
        Animated.timing(fadeAnim, {
          toValue: 1,
          duration: 400,
          easing: Easing.out(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.timing(slideAnim, {
          toValue: 0,
          duration: 400,
          easing: Easing.out(Easing.quad),
          useNativeDriver: true,
        }),
      ]).start();
    }
  }, [phase, fadeAnim, slideAnim, progressAnim]);

  // ── Rotating Training Messages ──
  useEffect(() => {
    if (phase !== "training") {
      setTrainingMessageIndex(0);
      return;
    }

    messageFadeAnim.setValue(1);
    let cancelled = false;

    const interval = setInterval(() => {
      if (cancelled) return;
      // Fade out → change → fade in
      Animated.timing(messageFadeAnim, {
        toValue: 0,
        duration: 200,
        useNativeDriver: true,
      }).start(({ finished }) => {
        if (!finished || cancelled) return;
        setTrainingMessageIndex((prev) => (prev + 1) % TRAINING_MESSAGES.length);
        Animated.timing(messageFadeAnim, {
          toValue: 1,
          duration: 300,
          useNativeDriver: true,
        }).start();
      });
    }, 4000);

    return () => {
      cancelled = true;
      clearInterval(interval);
      messageFadeAnim.stopAnimation();
    };
  }, [phase, messageFadeAnim]);

  // ── Android Back Handler (confirm before discarding captures) ──
  useEffect(() => {
    if (phase !== "capturing") return;

    const onBackPress = () => {
      if (isRecordingRef.current) {
        Alert.alert(
          "Recording in Progress",
          "Stop recording before leaving capture mode.",
        );
        return true;
      }

      if (captures.length === 0) {
        uploadedIdsRef.current.clear();
        if (isAddMore && previousResultRef.current) {
          setTrainingResult(previousResultRef.current);
          setPhase("results");
        } else {
          setPhase("intro");
        }
        return true;
      }

      Alert.alert(
        "Discard Captures",
        `You have ${captures.length} item${captures.length !== 1 ? "s" : ""}. Discard and go back?`,
        [
          { text: "Keep Capturing", style: "cancel" },
          {
            text: "Discard",
            style: "destructive",
            onPress: () => {
              clearCapturedMedia(capturesRef.current);
              if (isAddMore && previousResultRef.current) {
                setTrainingResult(previousResultRef.current);
                setPhase("results");
              } else {
                setPhase("intro");
              }
            },
          },
        ],
      );
      return true; // prevent default back action
    };

    const sub = BackHandler.addEventListener("hardwareBackPress", onBackPress);
    return () => sub.remove();
  }, [clearCapturedMedia, phase, captures.length, isAddMore]);

  useEffect(() => {
    return () => {
      releaseCapturedMedia(capturesRef.current);
    };
  }, [releaseCapturedMedia]);

  // Pause animations and camera when backgrounded, resume on foreground
  useEffect(() => {
    const handleAppState = (state: AppStateStatus) => {
      if (state === "active") {
        // Resume — animations restart naturally via their useEffect deps
      } else {
        // Background — stop recording if active to release audio session
        if (isRecordingRef.current && cameraRef.current) {
          cameraRef.current.stopRecording?.();
          isRecordingRef.current = false;
        }
      }
    };
    const sub = AppState.addEventListener("change", handleAppState);
    return () => sub.remove();
  }, []);

  const handleStartCapture = useCallback(async () => {
    if (!permission?.granted) {
      const result = await requestPermission();
      if (!result.granted) {
        Alert.alert(
          "Camera Required",
          "Camera access is needed to capture baseline images for training.",
          [
            { text: "Cancel", style: "cancel" },
            {
              text: "Open Settings",
              onPress: () => Linking.openSettings(),
            },
          ],
        );
        return;
      }
    }
    clearCapturedMedia(capturesRef.current);
    setError(null);
    setTrainingResult(null);
    setIsAddMore(false);
    previousResultRef.current = null;
    setPhase("capturing");
  }, [clearCapturedMedia, permission, requestPermission]);

  const handleCapture = useCallback(async () => {
    if (!cameraRef.current || isCapturingRef.current) return;
    isCapturingRef.current = true;

    try {
      const photo = await cameraRef.current.takePictureAsync({
        quality: 0.8,
        base64: true,
      });

      if (photo?.base64 && photo?.uri) {
        const newCapture: CapturedMedia = {
          id: `cap-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          type: "photo",
          base64: photo.base64,
          uri: photo.uri,
        };
        setCaptures((prev) => [...prev, newCapture]);
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);

        // Flash animation for capture feedback
        captureFlashAnim.setValue(1);
        Animated.timing(captureFlashAnim, {
          toValue: 0,
          duration: 200,
          easing: Easing.out(Easing.quad),
          useNativeDriver: true,
        }).start();

        // Auto-scroll thumbnail strip to newest capture
        setTimeout(() => {
          thumbnailListRef.current?.scrollToEnd({ animated: true });
        }, 100);
      }
    } catch (err) {
      console.error("Capture failed:", err);
      setError("Capture failed. Please try again.");
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } finally {
      isCapturingRef.current = false;
    }
  }, []);

  const extractVideoPreviewUri = useCallback(async (videoUri: string) => {
    const videoThumbnails = videoThumbnailsRef.current;
    if (!videoThumbnails) {
      return null;
    }

    for (const time of BASE_KEYFRAME_TIMESTAMPS_MS.slice(0, 3)) {
      try {
        const thumb = await videoThumbnails.getThumbnailAsync(videoUri, {
          time,
          quality: 0.85,
        });
        if (thumb?.uri) {
          return thumb.uri;
        }
      } catch {
        // Try the next timestamp when an early frame is unavailable.
      }
    }

    return null;
  }, []);

  // ── Video Recording ──
  const handleStartRecording = useCallback(async () => {
    if (!cameraRef.current || isRecordingRef.current) return;

    if (!videoTrainingCapability.supported) {
      Alert.alert(
        "Video Training Unavailable",
        [videoTrainingCapability.reason, videoTrainingCapability.recoveryHint]
          .filter(Boolean)
          .join(" "),
      );
      return;
    }

    if (!microphonePermission?.granted) {
      const result = await requestMicrophonePermission();
      if (!result.granted) {
        Alert.alert(
          "Microphone Required",
          "Microphone access is needed to record training videos.",
          [
            { text: "Cancel", style: "cancel" },
            {
              text: "Open Settings",
              onPress: () => Linking.openSettings(),
            },
          ],
        );
        return;
      }
    }

    if (!videoTrainingCapability.optimized && !videoSupportAlertShownRef.current) {
      videoSupportAlertShownRef.current = true;
      Alert.alert(
        "Video Training Reduced",
        [videoTrainingCapability.reason, videoTrainingCapability.recoveryHint]
          .filter(Boolean)
          .join(" "),
      );
    }

    isRecordingRef.current = true;
    setIsRecording(true);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);

    try {
      const result = await cameraRef.current.recordAsync({
        maxDuration: 60, // 1 minute max
      });

      if (result?.uri) {
        const previewUri = await extractVideoPreviewUri(result.uri);
        const newCapture: CapturedMedia = {
          id: `vid-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          type: "video",
          uri: result.uri,
          previewUri: previewUri ?? undefined,
        };
        setCaptures((prev) => [...prev, newCapture]);
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);

        // Auto-scroll thumbnail strip to newest capture
        setTimeout(() => {
          thumbnailListRef.current?.scrollToEnd({ animated: true });
        }, 100);
      }
    } catch (err) {
      console.error("Recording failed:", err);
      setError("Recording failed. Please try again.");
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } finally {
      isRecordingRef.current = false;
      setIsRecording(false);
    }
  }, [extractVideoPreviewUri, microphonePermission, requestMicrophonePermission, videoTrainingCapability]);

  const handleStopRecording = useCallback(() => {
    if (!cameraRef.current || !isRecordingRef.current) return;
    cameraRef.current.stopRecording();
    // recordAsync promise will resolve with the URI
  }, []);

  const handleRemoveCapture = useCallback((id: string) => {
    // Clear cached upload ID so it doesn't get sent to training if removed
    uploadedIdsRef.current.delete(id);
    setCaptures((prev) => {
      const capture = prev.find((item) => item.id === id);
      if (capture) {
        deleteCapturedFiles(capture);
      }
      const next = prev.filter((item) => item.id !== id);
      capturesRef.current = next;
      return next;
    });
  }, [deleteCapturedFiles]);

  const isRunActive = useCallback((runId: number) => {
    return runIdRef.current === runId && !cancelRequestedRef.current;
  }, []);

  const extractVideoKeyframeUris = useCallback(async (videoUri: string) => {
    const videoThumbnails = videoThumbnailsRef.current;
    if (!videoThumbnails) {
      return [];
    }

    // Get video duration for dynamic timestamp generation
    let videoDurationMs: number | undefined;
    if (buildCapabilities.hasExpoAvNativeModule) {
      try {
        const { Audio } = await import("expo-av");
        const { sound } = await Audio.Sound.createAsync({ uri: videoUri });
        const status = await sound.getStatusAsync();
        if (status.isLoaded && status.durationMillis) {
          videoDurationMs = status.durationMillis;
        }
        await sound.unloadAsync();
      } catch {
        // Duration unavailable — use base timestamps.
      }
    }

    // Phase 1: Extract ALL candidate frames at each timestamp
    const candidates: Array<{ uri: string; time: number; sharpness: number }> = [];
    const seen = new Set<string>();

    const timestamps = generateKeyframeTimestamps(videoDurationMs);
    for (const time of timestamps) {
      try {
        const thumb = await videoThumbnails.getThumbnailAsync(videoUri, {
          time,
          quality: 0.85,
        });
        if (!thumb?.uri || seen.has(thumb.uri)) continue;
        seen.add(thumb.uri);

        // Compute real sharpness via Laplacian variance on a downsized grayscale frame.
        // Falls back to file size if decode fails.
        let sharpness = 0;
        try {
          const base64Content = await FileSystem.readAsStringAsync(thumb.uri, {
            encoding: "base64" as const,
          });
          const { decodeBase64JpegToRgb, rgbToGrayscale, laplacianVariance } =
            await import("../lib/vision/image-utils");
          const decoded = await decodeBase64JpegToRgb(base64Content);
          if (decoded) {
            const gray = rgbToGrayscale(decoded.rgb, decoded.width, decoded.height);
            sharpness = laplacianVariance(gray, decoded.width, decoded.height);
          }
        } catch {
          // Decode failed — score as 0 (unknown sharpness).
          // Do NOT use file size as fallback — it's on a different scale
          // and would rank blurry decode-failed frames above sharp ones.
          sharpness = 0;
          try {
            // Still log for debugging
            const info = await FileSystem.getInfoAsync(thumb.uri);
            void info; // suppress unused
          } catch { /* sharpness stays 0 */ }
        }

        candidates.push({ uri: thumb.uri, time, sharpness });
      } catch {
        // Ignore out-of-range timestamps and continue trying others.
      }
    }

    if (candidates.length <= VIDEO_KEYFRAME_MAX_PER_VIDEO) {
      return candidates.map(c => c.uri);
    }

    // Phase 2: Score and select the best diverse set.
    // Sort by sharpness (Laplacian variance) descending, then pick with temporal spread.
    candidates.sort((a, b) => b.sharpness - a.sharpness);

    // Greedy selection: pick sharpest frames that are at least 1.5s apart
    const MIN_TIME_GAP_MS = 1500;
    const selected: typeof candidates = [];
    for (const candidate of candidates) {
      if (selected.length >= VIDEO_KEYFRAME_MAX_PER_VIDEO) break;
      const tooClose = selected.some(s => Math.abs(s.time - candidate.time) < MIN_TIME_GAP_MS);
      if (!tooClose) {
        selected.push(candidate);
      }
    }

    // If we didn't fill up (all frames too close together), fill from remaining
    if (selected.length < VIDEO_KEYFRAME_MAX_PER_VIDEO) {
      for (const candidate of candidates) {
        if (selected.length >= VIDEO_KEYFRAME_MAX_PER_VIDEO) break;
        if (!selected.includes(candidate)) {
          selected.push(candidate);
        }
      }
    }

    // Clean up unselected frames
    const selectedUris = new Set(selected.map(s => s.uri));
    for (const candidate of candidates) {
      if (!selectedUris.has(candidate.uri)) {
        FileSystem.deleteAsync(candidate.uri, { idempotent: true }).catch(() => {});
      }
    }

    // Return in temporal order for consistent baseline ordering
    selected.sort((a, b) => a.time - b.time);
    return selected.map(c => c.uri);
  }, []);

  const hasUsableVideoTrainingFrames = useCallback(async () => {
    if (captures.some((capture) => capture.type === "photo")) {
      return true;
    }

    const videos = captures.filter((capture) => capture.type === "video");
    if (videos.length === 0) {
      return false;
    }

    // Lightweight probe: try extracting a single thumbnail from each video.
    // Don't run the full sharpness-scored extraction (that happens during upload).
    const videoThumbnails = videoThumbnailsRef.current;
    if (!videoThumbnails) return false;

    for (const video of videos) {
      for (const time of BASE_KEYFRAME_TIMESTAMPS_MS.slice(0, 3)) {
        try {
          const thumb = await videoThumbnails.getThumbnailAsync(video.uri, {
            time,
            quality: 0.5, // Low quality for probe only
          });
          if (thumb?.uri) {
            deleteLocalMedia(thumb.uri); // Clean up probe thumbnail
            return true; // At least one frame can be extracted
          }
        } catch {
          continue; // Try next timestamp
        }
      }
    }

    return false;
  }, [captures, deleteLocalMedia]);

  const handleCancelProcessing = useCallback(() => {
    if (phase !== "uploading" && phase !== "training") return;
    cancelRequestedRef.current = true;
    runIdRef.current++;
    // Abort the in-flight training HTTP request so the server stops processing
    trainingAbortRef.current?.abort();
    trainingAbortRef.current = null;
    setError("Upload/training canceled.");
    setPhase("capturing");
  }, [phase]);

  const handleUploadAndTrain = useCallback(async () => {
    const currentRunId = Date.now();
    runIdRef.current = currentRunId;
    cancelRequestedRef.current = false;

    setPhase("uploading");
    setError(null);
    const total =
      captures.length +
      captures.filter((c) => c.type === "video").length *
        VIDEO_KEYFRAME_MAX_PER_VIDEO;
    setUploadProgress({ current: 0, total });
    let stage: "upload" | "train" = "upload";
    let progressCurrent = 0;
    let uploadedImageCount = 0;

    const mediaUploadIds: string[] = [];

    try {
      // Upload all media — skip items already uploaded (allows safe retry)
      for (let i = 0; i < captures.length; i++) {
        if (!isRunActive(currentRunId)) {
          throw new Error("Processing canceled");
        }

        const capture = captures[i];
        setUploadProgress({ current: progressCurrent, total });
        const existingIds = uploadedIdsRef.current.get(capture.id);
        const uploadedForCapture = existingIds ? [...existingIds] : [];
        const hasReusableUpload =
          capture.type === "photo"
            ? uploadedForCapture.length > 0
            : uploadedForCapture.length > 1;

        // Reuse fully uploaded captures on retry, but do not skip video keyframe extraction
        // if only the archive video made it up in a prior attempt.
        if (hasReusableUpload) {
          mediaUploadIds.push(...uploadedForCapture);
          uploadedImageCount +=
            capture.type === "photo"
              ? uploadedForCapture.length
              : Math.max(uploadedForCapture.length - 1, 0);
          progressCurrent += uploadedForCapture.length;
          setUploadProgress({ current: progressCurrent, total });
          continue;
        }

        if (capture.type === "video") {
          let videoId = uploadedForCapture[0];
          if (!videoId) {
            const videoResult = await uploadVideoFile(
              capture.uri,
              propertyId,
              `training-video-${i + 1}.mp4`,
            );
            videoId = videoResult.id;
            uploadedForCapture.push(videoId);
          }

          mediaUploadIds.push(videoId);
          progressCurrent += 1;
          setUploadProgress({ current: progressCurrent, total });
          // Save partial progress so the raw video isn't re-uploaded on retry.
          uploadedIdsRef.current.set(capture.id, [...uploadedForCapture]);

          const keyframeUris = await extractVideoKeyframeUris(capture.uri);
          try {
            for (let frameIndex = 0; frameIndex < keyframeUris.length; frameIndex++) {
              if (!isRunActive(currentRunId)) {
                throw new Error("Processing canceled");
              }

              const frameResult = await uploadImageFile(
                keyframeUris[frameIndex],
                propertyId,
                `training-video-${i + 1}-frame-${frameIndex + 1}.jpg`,
              );
              uploadedForCapture.push(frameResult.id);
              mediaUploadIds.push(frameResult.id);
              uploadedImageCount += 1;
              progressCurrent += 1;
              setUploadProgress({ current: progressCurrent, total });
            }
          } finally {
            keyframeUris.forEach((uri) => deleteLocalMedia(uri));
          }
        } else {
          const imageResult = await uploadBase64Image(
            `data:image/jpeg;base64,${capture.base64}`,
            propertyId,
            `training-${i + 1}.jpg`,
          );
          uploadedForCapture.push(imageResult.id);
          mediaUploadIds.push(imageResult.id);
          uploadedImageCount += 1;
          progressCurrent += 1;
          setUploadProgress({ current: progressCurrent, total });
        }

        uploadedIdsRef.current.set(capture.id, uploadedForCapture);
      }

      if (!isRunActive(currentRunId)) {
        throw new Error("Processing canceled");
      }
      if (uploadedImageCount === 0) {
        throw new Error(
          "No training frames available. Capture at least one photo, or rebuild the dev client to enable video keyframe extraction.",
        );
      }

      setUploadProgress({ current: total, total });

      // Trigger training
      stage = "train";
      setPhase("training");
      const abortController = new AbortController();
      trainingAbortRef.current = abortController;
      const result = await trainProperty(propertyId, mediaUploadIds, {
        signal: abortController.signal,
      });
      trainingAbortRef.current = null;
      if (!isRunActive(currentRunId)) {
        return;
      }
      setTrainingResult(result);
      capturesRef.current.forEach((capture) => deleteCapturedFiles(capture));
      setPhase("results");
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (err) {
      trainingAbortRef.current = null;
      if (!isRunActive(currentRunId)) {
        return;
      }
      console.error("Training failed:", err);
      const message = err instanceof Error ? err.message : "";
      if (message.toLowerCase().includes("canceled")) {
        setPhase("capturing");
        setError("Upload/training canceled.");
        return;
      }

      // Status-specific error messages for better user feedback
      if (err instanceof ApiError) {
        if (err.status === 409) {
          setError("Training is already in progress for this property. Please wait a moment and try again.");
        } else if (err.status === 413) {
          setError("Images are too large. Try capturing fewer or lower-resolution images.");
        } else if (err.status === 503) {
          setError("AI processing is temporarily unavailable. Please try again in a few minutes.");
        } else if (err.status >= 500) {
          setError(`Server error during ${stage === "upload" ? "upload" : "training"}. Please try again in a few moments.`);
        } else {
          setError(`${stage === "upload" ? "Upload" : "Training"} failed: ${err.message}`);
        }
      } else {
        setError(
          err instanceof Error
            ? `${stage === "upload" ? "Upload" : "Training"} failed: ${err.message}`
            : "Training failed. Please check your connection and try again.",
        );
      }
      setPhase("capturing");
    }
  }, [captures, deleteCapturedFiles, extractVideoKeyframeUris, isRunActive, propertyId]);

  const handleDoneCapturing = useCallback(async () => {
    const hasVideosWithKeyframes =
      videoThumbnailsRef.current &&
      captures.some((c) => c.type === "video");
    // Add More: 1 capture minimum. Initial: 3, unless a video will produce keyframes
    const minCaptures = isAddMore ? 1 : hasVideosWithKeyframes ? 1 : 3;

    if (captures.length < minCaptures) {
      Alert.alert(
        "More Images Needed",
        isAddMore
          ? "Please capture at least 1 photo or video."
          : "Please capture at least 3 images from different rooms and angles for accurate training.",
      );
      return;
    }

    if (!videoTrainingCapability.supported && captures.every((capture) => capture.type === "video")) {
      Alert.alert(
        "Photos Still Required",
        [videoTrainingCapability.reason, "Capture at least one photo before training.", videoTrainingCapability.recoveryHint]
          .filter(Boolean)
          .join(" "),
      );
      return;
    }

    const hasUsableFrames = await hasUsableVideoTrainingFrames();
    if (!hasUsableFrames) {
      Alert.alert(
        "No Training Frames Available",
        videoTrainingCapability.supported
          ? "These videos did not produce usable training frames. Capture at least one photo or record a steadier video clip before training."
          : [videoTrainingCapability.reason, "Capture at least one photo before training.", videoTrainingCapability.recoveryHint]
              .filter(Boolean)
              .join(" "),
      );
      return;
    }

    Alert.alert(
      isAddMore ? "Add to Training" : "Start Training",
      `Upload ${captures.length} item${captures.length !== 1 ? "s" : ""} and ${isAddMore ? "re-train" : "train"} AI on this property? This may take a minute.`,
      [
        { text: "Cancel", style: "cancel" },
        { text: isAddMore ? "Re-train" : "Train", style: "default", onPress: handleUploadAndTrain },
      ],
    );
  }, [captures, hasUsableVideoTrainingFrames, isAddMore, handleUploadAndTrain, videoTrainingCapability]);

  // ──── Intro Phase ────
  if (phase === "intro") {
    return (
      <SafeAreaView style={styles.container} edges={["top", "bottom"]}>
        <ScrollView
          contentContainerStyle={styles.introContent}
          showsVerticalScrollIndicator={false}
          bounces
        >
          <TouchableOpacity
            style={styles.backButton}
            onPress={() => navigation.goBack()}
            activeOpacity={0.7}
          >
            <Text style={styles.backButtonText}>{"<"} Back</Text>
          </TouchableOpacity>

          <Text style={styles.title}>Train Property</Text>
          <Text style={styles.propertyLabel}>{propertyName}</Text>

          <View style={styles.instructionCard}>
            <Text style={styles.instructionTitle}>How Training Works</Text>

            <View style={styles.stepRow}>
              <View style={styles.stepCircle}>
                <Text style={styles.stepNumber}>1</Text>
              </View>
              <View style={styles.stepContent}>
                <Text style={styles.stepTitle}>Walk Through</Text>
                <Text style={styles.stepText}>
                  Capture photos or videos of each room from different angles
                </Text>
              </View>
            </View>

            <View style={styles.stepRow}>
              <View style={styles.stepCircle}>
                <Text style={styles.stepNumber}>2</Text>
              </View>
              <View style={styles.stepContent}>
                <Text style={styles.stepTitle}>Capture Angles</Text>
                <Text style={styles.stepText}>
                  Take 3-5 shots per room showing key areas. Pinch to zoom.
                </Text>
              </View>
            </View>

            <View style={styles.stepRow}>
              <View style={styles.stepCircle}>
                <Text style={styles.stepNumber}>3</Text>
              </View>
              <View style={styles.stepContent}>
                <Text style={styles.stepTitle}>AI Analysis</Text>
                <Text style={styles.stepText}>
                  AI identifies rooms, items, and creates inspection baselines
                </Text>
              </View>
            </View>
          </View>

          <View style={styles.tipCard}>
            <Text style={styles.tipTitle}>Tips for Best Results</Text>
            <Text style={styles.tipText}>
              {"\u2022"} Turn on all lights for even illumination{"\n"}
              {"\u2022"} Hold phone steady for sharp captures{"\n"}
              {"\u2022"} Property should be in guest-ready state{"\n"}
              {"\u2022"} Include all rooms, outdoor areas, and closets{"\n"}
              {"\u2022"} More images = more accurate inspections
            </Text>
          </View>

          {videoTrainingBuildNote && (
            <View style={styles.buildCapabilityCard}>
              <Text style={styles.buildCapabilityTitle}>
                {videoTrainingCapability.supported ? "Video Training In This Build" : "Photo-Only Training In This Build"}
              </Text>
              <Text style={styles.buildCapabilityText}>{videoTrainingBuildNote}</Text>
            </View>
          )}

          <TouchableOpacity
            style={styles.startButton}
            onPress={handleStartCapture}
            activeOpacity={0.8}
          >
            <Text style={styles.startButtonText}>Start Capture</Text>
          </TouchableOpacity>
        </ScrollView>
      </SafeAreaView>
    );
  }

  // ──── Uploading / Training Phase ────
  if (phase === "uploading" || phase === "training") {
    const spinRotation = spinAnim.interpolate({
      inputRange: [0, 1],
      outputRange: ["0deg", "360deg"],
    });
    const breatheScale = breatheAnim.interpolate({
      inputRange: [0, 1],
      outputRange: [1, 1.18],
    });
    const breatheOpacity = breatheAnim.interpolate({
      inputRange: [0, 1],
      outputRange: [0.25, 0.5],
    });

    const stepIndex = phase === "uploading" ? 0 : 1;

    return (
      <SafeAreaView style={styles.container} edges={["top", "bottom"]}>
        <View style={styles.processingContainer}>
          {/* Animated spinner area */}
          <View style={styles.spinnerArea}>
            {/* Breathing outer ring */}
            <Animated.View
              style={[
                styles.breatheRing,
                { transform: [{ scale: breatheScale }], opacity: breatheOpacity },
              ]}
            />
            {/* Spinning arc */}
            <Animated.View
              style={[
                styles.spinnerArc,
                { transform: [{ rotate: spinRotation }] },
              ]}
            />
            {/* Center icon */}
            <View style={styles.spinnerCenter}>
              <Text style={styles.spinnerIcon}>
                {phase === "uploading" ? "↑" : "✦"}
              </Text>
            </View>
          </View>

          {/* Animated content — fades/slides on phase change */}
          <Animated.View
            style={[
              styles.processingTextContainer,
              { opacity: fadeAnim, transform: [{ translateY: slideAnim }] },
            ]}
          >
            <Text style={styles.processingTitle}>
              {phase === "uploading" ? "Uploading Media" : "Training AI"}
            </Text>

            {phase === "uploading" ? (
              <>
                <Text style={styles.processingSubtext}>
                  {uploadProgress.current} of {uploadProgress.total} items
                </Text>
                {/* Animated progress bar */}
                <View style={styles.progressBarContainer}>
                  <View style={styles.progressBar}>
                    <Animated.View
                      style={[
                        styles.progressFill,
                        {
                          width: progressAnim.interpolate({
                            inputRange: [0, 1],
                            outputRange: ["0%", "100%"],
                          }),
                        },
                      ]}
                    />
                    {/* Glow on leading edge */}
                    <Animated.View
                      style={[
                        styles.progressGlow,
                        {
                          left: progressAnim.interpolate({
                            inputRange: [0, 1],
                            outputRange: ["0%", "100%"],
                          }),
                        },
                      ]}
                    />
                  </View>
                  <Text style={styles.progressPercent}>
                    {uploadProgress.total > 0
                      ? Math.round((uploadProgress.current / uploadProgress.total) * 100)
                      : 0}
                    %
                  </Text>
                </View>
              </>
            ) : (
              /* Rotating status messages during training */
              <Animated.Text
                style={[styles.processingSubtext, styles.rotatingMessage, { opacity: messageFadeAnim }]}
              >
                {TRAINING_MESSAGES[trainingMessageIndex]}
              </Animated.Text>
            )}
          </Animated.View>

          {/* Step indicator dots */}
          <View style={styles.stepDots}>
            {["Upload", "Analyze", "Complete"].map((label, i) => (
              <View key={label} style={styles.stepDotItem}>
                <View
                  style={[
                    styles.stepDotCircle,
                    i < stepIndex && styles.stepDotDone,
                    i === stepIndex && styles.stepDotActive,
                  ]}
                >
                  {i < stepIndex ? (
                    <Text style={styles.stepDotCheck}>✓</Text>
                  ) : i === stepIndex ? (
                    <View style={styles.stepDotPulse} />
                  ) : null}
                </View>
                <Text
                  style={[
                    styles.stepDotLabel,
                    i === stepIndex && styles.stepDotLabelActive,
                    i < stepIndex && styles.stepDotLabelDone,
                  ]}
                >
                  {label}
                </Text>
              </View>
            ))}
          </View>

          <Text style={styles.processingHint}>
            This may take up to a minute
          </Text>
          <TouchableOpacity
            style={styles.processingCancelButton}
            onPress={handleCancelProcessing}
            activeOpacity={0.75}
          >
            <Text style={styles.processingCancelText}>Cancel</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  // ──── Results Phase ────
  if (phase === "results" && !trainingResult) {
    // Defensive fallback: results phase without data (e.g., cancel race condition)
    return (
      <SafeAreaView style={styles.container} edges={["top", "bottom"]}>
        <View style={{ flex: 1, justifyContent: "center", alignItems: "center", padding: 24 }}>
          <Text style={{ fontSize: 16, color: colors.slate600, textAlign: "center", marginBottom: 16 }}>
            Training completed but results were not available.
          </Text>
          <TouchableOpacity
            style={{ backgroundColor: "#2372B8", paddingHorizontal: 32, paddingVertical: 14, borderRadius: 12 }}
            onPress={() => navigation.goBack()}
          >
            <Text style={{ color: "#fff", fontSize: 16, fontWeight: "600", textAlign: "center" }}>Done</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }
  if (phase === "results" && trainingResult) {
    const keptFrames = trainingResult.dedupe?.keptCount ?? captures.length;
    const droppedFrames = trainingResult.dedupe?.droppedCount ?? 0;
    const uploadedVideos = trainingResult.mediaSummary?.uploadedVideos ?? 0;

    return (
      <SafeAreaView style={styles.container} edges={["top", "bottom"]}>
        <ScrollView contentContainerStyle={styles.resultsContent}>
          {/* Success Header */}
          <View style={styles.successHeader}>
            <View style={styles.successCircle}>
              <Text style={styles.successCheck}>✓</Text>
            </View>
            <Text style={styles.resultsTitle}>Training Complete</Text>
            <Text style={styles.resultsSubtitle}>
              {propertyName} is ready for inspections
            </Text>
          </View>

          {/* Summary Stats */}
          <View style={styles.statsRow}>
            <View style={styles.statCard}>
              <Text style={styles.statValue}>{trainingResult.totalRooms}</Text>
              <Text style={styles.statLabel}>Rooms</Text>
            </View>
            <View style={styles.statCard}>
              <Text style={styles.statValue}>{trainingResult.totalItems}</Text>
              <Text style={styles.statLabel}>Items</Text>
            </View>
            <View style={styles.statCard}>
              <Text style={styles.statValue}>{keptFrames}</Text>
              <Text style={styles.statLabel}>Frames Kept</Text>
            </View>
          </View>

          {trainingResult.dedupe?.enabled && (
            <Text style={styles.dedupeSummary}>
              {droppedFrames > 0
                ? `Keyframe dedupe removed ${droppedFrames} near-duplicate frame${droppedFrames !== 1 ? "s" : ""} (${trainingResult.dedupe.inputCount} → ${trainingResult.dedupe.keptCount}).`
                : `Keyframe dedupe ran (${trainingResult.dedupe.inputCount} frames analyzed, no near-duplicates removed).`}
            </Text>
          )}
          {uploadedVideos > 0 && (
            <Text style={styles.mediaSummaryNote}>
              {uploadedVideos} video file{uploadedVideos !== 1 ? "s were" : " was"} uploaded for archive. Training analyzed{" "}
              {trainingResult.mediaSummary?.analyzedFrames ?? keptFrames} image frame
              {(trainingResult.mediaSummary?.analyzedFrames ?? keptFrames) !== 1
                ? "s"
                : ""}{" "}
              (including extracted video keyframes when available).
            </Text>
          )}

          {/* Room Details */}
          <Text style={styles.sectionTitle}>Detected Rooms</Text>
          {trainingResult.rooms.map((room, idx) => (
            <View key={idx} style={styles.roomCard}>
              <View style={styles.roomHeader}>
                <Text style={styles.roomName}>{room.name}</Text>
                <View style={styles.roomTypeBadge}>
                  <Text style={styles.roomTypeText}>{room.roomType}</Text>
                </View>
              </View>
              {room.items.length > 0 && (
                <Text style={styles.roomItems}>
                  {room.items.map((i) => i.name).join(" \u2022 ")}
                </Text>
              )}
              <Text style={styles.roomBaselines}>
                {room.baselineCount} baseline image{room.baselineCount !== 1 ? "s" : ""}
              </Text>
            </View>
          ))}
        </ScrollView>

        <View style={styles.resultsFooter}>
          <TouchableOpacity
            style={styles.addMoreButton}
            onPress={() => {
              previousResultRef.current = trainingResult;
              clearCapturedMedia(capturesRef.current);
              setTrainingResult(null);
              setIsAddMore(true);
              setPhase("capturing");
            }}
            activeOpacity={0.8}
          >
            <Text style={styles.addMoreButtonText}>Add More</Text>
            <Text style={styles.addMoreButtonSub}>
              Re-train with additional photos
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.doneButton}
            onPress={() => {
              clearCapturedMedia(capturesRef.current);
              navigation.popToTop();
            }}
            activeOpacity={0.8}
          >
            <Text style={styles.doneButtonText}>Done</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  // ──── Permission Check ────
  if (!permission?.granted) {
    return (
      <View style={styles.permissionContainer}>
        <View style={styles.permissionCard}>
          <Text style={styles.permissionTitle}>Camera Access</Text>
          <Text style={styles.permissionText}>
            Camera access is required to capture baseline images for property training.
          </Text>
          <TouchableOpacity
            style={styles.permissionButton}
            onPress={requestPermission}
            activeOpacity={0.8}
          >
            <Text style={styles.permissionButtonText}>Grant Permission</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  // ──── Capturing Phase ────
  return (
    <View style={styles.container}>
      {/* Camera fills the entire screen — wrapped in gesture detector for pinch-to-zoom */}
      <GestureDetector gesture={pinchGesture}>
        <View style={StyleSheet.absoluteFill}>
          <CameraView
            ref={cameraRef}
            style={StyleSheet.absoluteFill}
            facing="back"
            zoom={zoom}
            mode={captureMode === "video" ? "video" : "picture"}
            responsiveOrientationWhenOrientationLocked
          />
        </View>
      </GestureDetector>

      {/* Zoom indicator */}
      {zoom > 0.01 && (
        <View style={styles.zoomIndicator} pointerEvents="none">
          <Text style={styles.zoomText}>{(1 + zoom * 9).toFixed(1)}×</Text>
        </View>
      )}

      {/* Top Bar */}
      <SafeAreaView style={[styles.cameraTopBar, isLandscape && styles.cameraTopBarLandscape]}>
        <TouchableOpacity
          style={styles.cameraBackButton}
          onPress={() => {
            if (isRecordingRef.current) {
              Alert.alert(
                "Recording in Progress",
                "Stop recording before leaving capture mode.",
              );
              return;
            }

            if (captures.length > 0) {
              Alert.alert(
                "Discard Captures?",
                `You have ${captures.length} captured item${captures.length !== 1 ? "s" : ""}. Going back will discard them.`,
                [
                  { text: "Keep Capturing", style: "cancel" },
                  {
                    text: "Discard",
                    style: "destructive",
                    onPress: () => {
                      clearCapturedMedia(capturesRef.current);
                      if (isAddMore && previousResultRef.current) {
                        setTrainingResult(previousResultRef.current);
                        setPhase("results");
                      } else {
                        setPhase("intro");
                      }
                    },
                  },
                ],
              );
            } else if (isAddMore && previousResultRef.current) {
              uploadedIdsRef.current.clear();
              setTrainingResult(previousResultRef.current);
              setPhase("results");
            } else {
              uploadedIdsRef.current.clear();
              setPhase("intro");
            }
          }}
          activeOpacity={0.7}
        >
          <Text style={styles.cameraBackText}>{"<"} Back</Text>
        </TouchableOpacity>

        <View style={styles.captureCountBadge}>
          <Text style={styles.captureCountText}>
            {captures.length} captured
          </Text>
        </View>

        <View style={[styles.trainingBadge, isRecording && styles.recordingBadge]}>
          <View style={[styles.trainingDot, isRecording && styles.recordingDot]} />
          <Text style={[styles.trainingBadgeText, isRecording && styles.recordingBadgeText]}>
            {isRecording ? "REC" : "TRAINING"}
          </Text>
        </View>
      </SafeAreaView>

      {/* Error banner */}
      {error && (
        <View style={styles.errorBanner}>
          <Text style={styles.errorText}>{error}</Text>
          <View style={{ flexDirection: "row", gap: 16 }}>
            <TouchableOpacity
              onPress={() =>
                navigation.navigate("ReportIssue", {
                  prefillError: error,
                  prefillScreen: "PropertyTraining",
                })
              }
            >
              <Text style={styles.errorReport}>Report</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => setError(null)}>
              <Text style={styles.errorDismiss}>Dismiss</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

      {captureMode === "video" && !isRecording && videoTrainingBuildNote && (
        <View style={styles.infoBanner}>
          <Text style={styles.infoText}>{videoTrainingBuildNote}</Text>
        </View>
      )}

      {/* Guidance text */}
      {!isRecording && (
        <View style={styles.guidanceContainer} pointerEvents="none">
          <Text style={styles.guidanceText}>
            {captures.length === 0
              ? isAddMore
                ? "Capture the areas you missed"
                : "Point at the first room and tap capture"
              : !isAddMore &&
                  captures.length < 3 &&
                  !(videoKeyframesAvailable && captures.some((c) => c.type === "video"))
                ? `Capture ${3 - captures.length} more item${3 - captures.length !== 1 ? "s" : ""} (minimum)`
                : "Keep capturing or tap Done when finished"}
          </Text>
        </View>
      )}

      {/* Bottom Controls */}
      <SafeAreaView style={styles.cameraBottomControls} edges={["bottom"]}>
        {/* Thumbnail strip with visible X delete buttons */}
        {captures.length > 0 && (
          <FlatList
            ref={thumbnailListRef}
            data={captures}
            horizontal
            showsHorizontalScrollIndicator={false}
            keyExtractor={(item) => item.id}
            contentContainerStyle={styles.thumbnailStrip}
            renderItem={({ item }) => (
              <View style={styles.thumbnailWrapper}>
                <TouchableOpacity
                  style={styles.thumbnail}
                  onPress={() => setPreviewMedia(item)}
                  activeOpacity={0.7}
                >
                  {item.type === "video" ? (
                    item.previewUri ? (
                      <Image
                        source={{ uri: item.previewUri }}
                        style={styles.thumbnailImage}
                        cachePolicy="none"
                      />
                    ) : (
                      <View style={[styles.thumbnailImage, { backgroundColor: colors.camera.background, justifyContent: "center", alignItems: "center" }]}>
                        <Text style={{ color: "#fff", fontSize: 22 }}>▶</Text>
                      </View>
                    )
                  ) : (
                    <Image
                      source={{ uri: item.uri }}
                      style={styles.thumbnailImage}
                      cachePolicy="none"
                    />
                  )}
                  {/* Video badge indicator */}
                  {item.type === "video" && (
                    <View style={styles.videoIndicator}>
                      <Text style={styles.videoIndicatorText}>VID</Text>
                    </View>
                  )}
                </TouchableOpacity>
                {/* Visible X delete button */}
                <TouchableOpacity
                  style={styles.thumbnailDeleteButton}
                  onPress={() => handleRemoveCapture(item.id)}
                  hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
                >
                  <Text style={styles.thumbnailDeleteText}>✕</Text>
                </TouchableOpacity>
              </View>
            )}
          />
        )}

        <View style={styles.captureRow}>
          {/* Done button */}
          {(() => {
            const hasVideoKeyframes =
              videoKeyframesAvailable &&
              captures.some((c) => c.type === "video");
            const minCaptures = isAddMore ? 1 : hasVideoKeyframes ? 1 : 3;
            const isDisabled = captures.length < minCaptures;
            return (
              <TouchableOpacity
                style={[
                  styles.finishButton,
                  isDisabled && styles.finishButtonDisabled,
                ]}
                onPress={handleDoneCapturing}
                disabled={isDisabled}
                activeOpacity={0.7}
              >
                <Text
                  style={[
                    styles.finishButtonText,
                    isDisabled && styles.finishButtonTextDisabled,
                  ]}
                >
                  Done ({captures.length})
                </Text>
              </TouchableOpacity>
            );
          })()}

          {/* Capture / Record button */}
          <TouchableOpacity
            style={[
              styles.captureButton,
              isRecording && styles.captureButtonRecording,
            ]}
            onPress={
              captureMode === "photo"
                ? handleCapture
                : isRecording
                  ? handleStopRecording
                  : handleStartRecording
            }
            activeOpacity={0.6}
          >
            {isRecording && (
              <Animated.View
                pointerEvents="none"
                style={[
                  styles.capturePulseRing,
                  {
                    opacity: recordingPulse.interpolate({
                      inputRange: [0, 1],
                      outputRange: [0.42, 0],
                    }),
                    transform: [
                      {
                        scale: recordingPulse.interpolate({
                          inputRange: [0, 1],
                          outputRange: [1, 1.4],
                        }),
                      },
                    ],
                  },
                ]}
              />
            )}
            <View
              style={[
                styles.captureRing,
                captureMode === "video" && styles.captureRingVideo,
                isRecording && styles.captureRingRecording,
              ]}
            />
          </TouchableOpacity>

          {/* Mode toggle (Photo / Video) */}
          <TouchableOpacity
            style={[
              styles.modeToggle,
              !videoTrainingCapability.supported && captureMode === "photo" && styles.modeToggleDisabled,
            ]}
            onPress={() => {
              if (isRecording) return;
              if (!videoTrainingCapability.supported && captureMode === "photo") {
                Alert.alert(
                  "Video Training Unavailable",
                  [videoTrainingCapability.reason, videoTrainingCapability.recoveryHint]
                    .filter(Boolean)
                    .join(" "),
                );
                return;
              }
              setCaptureMode((m) => (m === "photo" ? "video" : "photo"));
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            }}
            activeOpacity={0.7}
            disabled={isRecording}
          >
            <Text style={styles.modeToggleText}>
              {captureMode === "photo" ? "VIDEO" : "PHOTO"}
            </Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>

      {/* Capture flash overlay */}
      <Animated.View
        style={[
          StyleSheet.absoluteFill,
          styles.captureFlash,
          { opacity: captureFlashAnim },
        ]}
        pointerEvents="none"
      />

      {/* Full-screen preview modal */}
      <Modal
        visible={!!previewMedia}
        transparent
        animationType="fade"
        onRequestClose={() => setPreviewMedia(null)}
      >
        <View style={styles.previewOverlay}>
          <SafeAreaView style={styles.previewContainer}>
            <View style={styles.previewTopBar}>
              <TouchableOpacity
                style={styles.previewCloseButton}
                onPress={() => setPreviewMedia(null)}
                activeOpacity={0.7}
              >
                <Text style={styles.previewCloseText}>✕ Close</Text>
              </TouchableOpacity>
              <Text style={styles.previewTypeLabel}>
                {previewMedia?.type === "video" ? "Video" : "Photo"} Preview
              </Text>
              <TouchableOpacity
                style={styles.previewDeleteButton}
                onPress={() => {
                  if (previewMedia) {
                    handleRemoveCapture(previewMedia.id);
                    setPreviewMedia(null);
                  }
                }}
                activeOpacity={0.7}
              >
                <Text style={styles.previewDeleteText}>Delete</Text>
              </TouchableOpacity>
            </View>
            {previewMedia?.type === "video" ? (
              previewMedia.previewUri ? (
                <View style={styles.previewVideoFrameWrap}>
                  <Image
                    source={{ uri: previewMedia.previewUri }}
                    style={styles.previewImage}
                    contentFit="contain"
                    cachePolicy="none"
                  />
                  <View style={styles.previewVideoBadge}>
                    <Text style={styles.previewVideoBadgeText}>Video preview frame</Text>
                  </View>
                </View>
              ) : (
                <View style={styles.previewVideoPlaceholder}>
                  <Text style={styles.previewVideoIcon}>▶</Text>
                  <Text style={styles.previewVideoText}>Video captured</Text>
                </View>
              )
            ) : (
              <Image
                source={{ uri: previewMedia?.uri }}
                style={styles.previewImage}
                contentFit="contain"
                cachePolicy="none"
              />
            )}
          </SafeAreaView>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },

  // ── Intro Phase ──
  introContent: {
    padding: 20,
    paddingTop: 12,
    paddingBottom: 40,
  },
  backButton: {
    marginBottom: 20,
    alignSelf: "flex-start",
    paddingVertical: 4,
    paddingRight: 8,
  },
  backButtonText: {
    color: colors.muted,
    fontSize: 16,
    fontWeight: "500",
  },
  title: {
    fontSize: 30,
    fontWeight: "600",
    color: colors.heading,
    letterSpacing: -0.5,
    marginBottom: 4,
  },
  propertyLabel: {
    fontSize: 16,
    color: colors.primary,
    fontWeight: "600",
    marginBottom: 28,
  },
  instructionCard: {
    backgroundColor: colors.card,
    borderRadius: 18,
    padding: 22,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: colors.stone,
  },
  instructionTitle: {
    fontSize: 17,
    fontWeight: "600",
    color: colors.heading,
    marginBottom: 20,
    letterSpacing: -0.2,
  },
  stepRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    marginBottom: 18,
    gap: 14,
  },
  stepCircle: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: "rgba(77, 166, 255, 0.15)",
    borderWidth: 1.5,
    borderColor: "rgba(77, 166, 255, 0.4)",
    justifyContent: "center",
    alignItems: "center",
  },
  stepNumber: {
    color: colors.primary,
    fontSize: 14,
    fontWeight: "600",
  },
  stepContent: {
    flex: 1,
    paddingTop: 2,
  },
  stepTitle: {
    color: colors.heading,
    fontSize: 15,
    fontWeight: "600",
    marginBottom: 2,
  },
  stepText: {
    color: colors.muted,
    fontSize: 14,
    lineHeight: 20,
  },
  tipCard: {
    backgroundColor: "rgba(77, 166, 255, 0.06)",
    borderRadius: 16,
    padding: 20,
    marginBottom: 32,
    borderWidth: 1,
    borderColor: "rgba(77, 166, 255, 0.12)",
  },
  tipTitle: {
    fontSize: 14,
    fontWeight: "600",
    color: colors.primary,
    marginBottom: 10,
    letterSpacing: 0.3,
    textTransform: "uppercase",
  },
  tipText: {
    color: colors.muted,
    fontSize: 14,
    lineHeight: 24,
  },
  buildCapabilityCard: {
    backgroundColor: "rgba(245, 158, 11, 0.08)",
    borderRadius: 16,
    padding: 18,
    marginBottom: 24,
    borderWidth: 1,
    borderColor: "rgba(245, 158, 11, 0.18)",
  },
  buildCapabilityTitle: {
    fontSize: 13,
    fontWeight: "700",
    color: colors.heading,
    marginBottom: 6,
    letterSpacing: 0.2,
    textTransform: "uppercase",
  },
  buildCapabilityText: {
    color: colors.muted,
    fontSize: 14,
    lineHeight: 20,
  },
  startButton: {
    backgroundColor: colors.primary,
    borderRadius: 16,
    paddingVertical: 18,
    alignItems: "center",
    marginTop: "auto",
    marginBottom: 20,
    shadowColor: colors.primary,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 12,
    elevation: 8,
  },
  startButtonText: {
    color: colors.primaryForeground,
    fontSize: 18,
    fontWeight: "600",
    letterSpacing: 0.3,
  },

  // ── Processing Phase ──
  processingContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    padding: 32,
  },
  spinnerArea: {
    width: 100,
    height: 100,
    justifyContent: "center",
    alignItems: "center",
    marginBottom: 32,
  },
  breatheRing: {
    position: "absolute",
    width: 100,
    height: 100,
    borderRadius: 50,
    borderWidth: 1.5,
    borderColor: colors.primary,
    backgroundColor: "rgba(77, 166, 255, 0.04)",
  },
  spinnerArc: {
    position: "absolute",
    width: 80,
    height: 80,
    borderRadius: 40,
    borderWidth: 3,
    borderColor: "transparent",
    borderTopColor: colors.primary,
    borderRightColor: "rgba(77, 166, 255, 0.4)",
  },
  spinnerCenter: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: "rgba(77, 166, 255, 0.08)",
    justifyContent: "center",
    alignItems: "center",
  },
  spinnerIcon: {
    fontSize: 20,
    color: colors.primary,
    fontWeight: "600",
  },
  processingTextContainer: {
    alignItems: "center",
    width: "100%",
  },
  processingTitle: {
    color: colors.heading,
    fontSize: 22,
    fontWeight: "600",
    marginBottom: 8,
    letterSpacing: -0.3,
  },
  processingSubtext: {
    color: colors.muted,
    fontSize: 16,
    marginBottom: 28,
  },
  rotatingMessage: {
    minHeight: 24,
    textAlign: "center",
  },
  progressBarContainer: {
    width: "80%",
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    marginBottom: 16,
  },
  progressBar: {
    flex: 1,
    height: 6,
    backgroundColor: colors.stone,
    borderRadius: 3,
    overflow: "hidden",
    position: "relative" as const,
  },
  progressFill: {
    height: "100%",
    backgroundColor: colors.primary,
    borderRadius: 3,
  },
  progressGlow: {
    position: "absolute",
    top: -3,
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: "rgba(77, 166, 255, 0.35)",
    marginLeft: -6,
  },
  progressPercent: {
    color: colors.primary,
    fontSize: 14,
    fontWeight: "600",
    minWidth: 40,
    textAlign: "right",
  },
  stepDots: {
    flexDirection: "row",
    alignItems: "center",
    gap: 32,
    marginBottom: 24,
    marginTop: 8,
  },
  stepDotItem: {
    alignItems: "center",
    gap: 6,
  },
  stepDotCircle: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: colors.stone,
    justifyContent: "center",
    alignItems: "center",
  },
  stepDotActive: {
    backgroundColor: colors.primary,
    width: 28,
    height: 28,
    borderRadius: 14,
  },
  stepDotDone: {
    backgroundColor: colors.success,
  },
  stepDotPulse: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.primaryForeground,
  },
  stepDotCheck: {
    color: colors.primaryForeground,
    fontSize: 12,
    fontWeight: "600",
  },
  stepDotLabel: {
    fontSize: 11,
    fontWeight: "500",
    color: colors.muted,
    letterSpacing: 0.3,
  },
  stepDotLabelActive: {
    color: colors.primary,
    fontWeight: "600",
  },
  stepDotLabelDone: {
    color: colors.success,
  },
  processingHint: {
    color: colors.muted,
    fontSize: 13,
  },
  processingCancelButton: {
    marginTop: 16,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.stone,
    backgroundColor: colors.card,
  },
  processingCancelText: {
    fontSize: 14,
    fontWeight: "600",
    color: colors.error,
  },

  // ── Results Phase ──
  resultsContent: {
    padding: 20,
    paddingTop: 32,
  },
  successHeader: {
    alignItems: "center",
    marginBottom: 28,
  },
  successCircle: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: "rgba(34, 197, 94, 0.12)",
    borderWidth: 2,
    borderColor: "rgba(34, 197, 94, 0.3)",
    justifyContent: "center",
    alignItems: "center",
    marginBottom: 16,
  },
  successCheck: {
    color: colors.success,
    fontSize: 24,
    fontWeight: "600",
  },
  resultsTitle: {
    fontSize: 28,
    fontWeight: "600",
    color: colors.heading,
    marginBottom: 4,
    letterSpacing: -0.5,
  },
  resultsSubtitle: {
    fontSize: 15,
    color: colors.success,
    fontWeight: "500",
  },
  statsRow: {
    flexDirection: "row",
    gap: 10,
    marginBottom: 28,
  },
  statCard: {
    flex: 1,
    backgroundColor: colors.card,
    borderRadius: 16,
    padding: 18,
    alignItems: "center",
    borderWidth: 1,
    borderColor: colors.stone,
  },
  statValue: {
    fontSize: 28,
    fontWeight: "600",
    color: colors.primary,
    marginBottom: 4,
  },
  statLabel: {
    fontSize: 12,
    color: colors.muted,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  dedupeSummary: {
    fontSize: 13,
    color: colors.muted,
    marginTop: -16,
    marginBottom: 8,
    textAlign: "center",
  },
  mediaSummaryNote: {
    fontSize: 13,
    color: colors.warning,
    marginBottom: 18,
    textAlign: "center",
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: "600",
    color: colors.heading,
    marginBottom: 12,
    letterSpacing: -0.2,
  },
  roomCard: {
    backgroundColor: colors.card,
    borderRadius: 14,
    padding: 16,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: colors.stone,
  },
  roomHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 8,
  },
  roomName: {
    fontSize: 16,
    fontWeight: "600",
    color: colors.heading,
    flex: 1,
  },
  roomTypeBadge: {
    backgroundColor: "rgba(77, 166, 255, 0.1)",
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 6,
  },
  roomTypeText: {
    fontSize: 12,
    color: colors.primary,
    fontWeight: "600",
  },
  roomItems: {
    color: colors.muted,
    fontSize: 13,
    lineHeight: 20,
    marginBottom: 6,
  },
  roomBaselines: {
    color: colors.muted,
    fontSize: 12,
    fontWeight: "500",
  },
  resultsFooter: {
    padding: 20,
    paddingBottom: 32,
    gap: 12,
  },
  addMoreButton: {
    borderWidth: 1.5,
    borderColor: colors.primary,
    borderRadius: 16,
    paddingVertical: 16,
    alignItems: "center",
  },
  addMoreButtonText: {
    color: colors.primary,
    fontSize: 18,
    fontWeight: "600",
    letterSpacing: 0.3,
  },
  addMoreButtonSub: {
    color: colors.muted,
    fontSize: 13,
    marginTop: 2,
  },
  doneButton: {
    backgroundColor: colors.primary,
    borderRadius: 16,
    paddingVertical: 18,
    alignItems: "center",
    shadowColor: colors.primary,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 12,
    elevation: 8,
  },
  doneButtonText: {
    color: colors.primaryForeground,
    fontSize: 18,
    fontWeight: "600",
    letterSpacing: 0.3,
  },

  // ── Camera Capture Phase ──
  cameraTopBar: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingTop: 8,
    zIndex: 10,
  },
  cameraTopBarLandscape: {
    paddingHorizontal: 32,
  },
  cameraBackButton: {
    backgroundColor: "rgba(0,0,0,0.65)",
    borderRadius: 10,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.08)",
  },
  cameraBackText: {
    color: "#fff",
    fontSize: 15,
    fontWeight: "600",
  },
  captureCountBadge: {
    backgroundColor: "rgba(0,0,0,0.65)",
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: "rgba(77,166,255,0.3)",
  },
  captureCountText: {
    color: "#fff",
    fontSize: 15,
    fontWeight: "600",
  },
  trainingBadge: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "rgba(0,0,0,0.65)",
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
    gap: 6,
    borderWidth: 1,
    borderColor: "rgba(34, 197, 94, 0.2)",
  },
  trainingDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.success,
  },
  trainingBadgeText: {
    color: colors.success,
    fontSize: 12,
    fontWeight: "600",
    letterSpacing: 0.5,
  },
  recordingBadge: {
    borderColor: "rgba(239, 68, 68, 0.4)",
  },
  recordingDot: {
    backgroundColor: colors.error,
  },
  recordingBadgeText: {
    color: colors.error,
  },
  errorBanner: {
    position: "absolute",
    top: 100,
    left: 16,
    right: 16,
    backgroundColor: "rgba(239, 68, 68, 0.92)",
    borderRadius: 14,
    padding: 16,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    zIndex: 20,
    borderWidth: 1,
    borderColor: "rgba(239, 68, 68, 0.5)",
  },
  errorText: {
    color: "#fff",
    fontSize: 14,
    flex: 1,
    marginRight: 8,
    fontWeight: "500",
  },
  errorReport: {
    color: "rgba(255,255,255,0.7)",
    fontWeight: "500",
    fontSize: 14,
    textDecorationLine: "underline" as const,
  },
  errorDismiss: {
    color: "#fff",
    fontWeight: "600",
    fontSize: 14,
  },
  infoBanner: {
    position: "absolute",
    top: 172,
    left: 16,
    right: 16,
    backgroundColor: "rgba(251, 191, 36, 0.96)",
    borderRadius: 14,
    paddingHorizontal: 16,
    paddingVertical: 12,
    zIndex: 18,
    borderWidth: 1,
    borderColor: "rgba(251, 191, 36, 0.58)",
  },
  infoText: {
    color: colors.heading,
    fontSize: 13,
    lineHeight: 18,
    fontWeight: "600",
  },
  guidanceContainer: {
    position: "absolute",
    top: "38%",
    left: 20,
    right: 20,
    alignItems: "center",
    zIndex: 5,
  },
  guidanceText: {
    backgroundColor: "rgba(0,0,0,0.65)",
    color: "#fff",
    fontSize: 15,
    fontWeight: "600",
    paddingHorizontal: 22,
    paddingVertical: 12,
    borderRadius: 24,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.08)",
  },

  // ── Zoom Indicator ──
  zoomIndicator: {
    position: "absolute",
    bottom: "45%",
    alignSelf: "center",
    backgroundColor: "rgba(0,0,0,0.65)",
    borderRadius: 16,
    paddingHorizontal: 14,
    paddingVertical: 6,
    zIndex: 5,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.08)",
  },
  zoomText: {
    color: "#fff",
    fontSize: 14,
    fontWeight: "600",
  },

  // ── Bottom Controls ──
  cameraBottomControls: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    zIndex: 10,
  },
  thumbnailStrip: {
    paddingHorizontal: 16,
    paddingBottom: 14,
    paddingTop: 6,
    gap: 10,
  },
  thumbnailWrapper: {
    position: "relative",
  },
  thumbnail: {
    width: 56,
    height: 56,
    borderRadius: 10,
    overflow: "hidden",
    borderWidth: 2,
    borderColor: "rgba(255,255,255,0.25)",
  },
  thumbnailImage: {
    width: "100%",
    height: "100%",
  },
  thumbnailDeleteButton: {
    position: "absolute",
    top: -5,
    right: -5,
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: "rgba(239, 68, 68, 0.92)",
    justifyContent: "center",
    alignItems: "center",
    borderWidth: 1.5,
    borderColor: "rgba(0,0,0,0.4)",
    zIndex: 1,
  },
  thumbnailDeleteText: {
    color: "#fff",
    fontSize: 10,
    fontWeight: "600",
    lineHeight: 12,
  },
  videoIndicator: {
    position: "absolute",
    bottom: 2,
    left: 2,
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: "rgba(0,0,0,0.65)",
    justifyContent: "center",
    alignItems: "center",
  },
  videoIndicatorText: {
    color: "#fff",
    fontSize: 8,
    fontWeight: "600",
  },
  captureRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 32,
    paddingBottom: 28,
  },
  finishButton: {
    backgroundColor: "rgba(77, 166, 255, 0.92)",
    borderRadius: 28,
    paddingHorizontal: 22,
    paddingVertical: 14,
    minWidth: 100,
    alignItems: "center",
    borderWidth: 1,
    borderColor: "rgba(77, 166, 255, 0.5)",
  },
  finishButtonDisabled: {
    backgroundColor: "rgba(100, 116, 139, 0.35)",
    borderColor: "rgba(100, 116, 139, 0.2)",
  },
  finishButtonText: {
    color: colors.primaryForeground,
    fontSize: 16,
    fontWeight: "600",
  },
  finishButtonTextDisabled: {
    color: colors.slate300,
  },
  captureButton: {
    width: 76,
    height: 76,
    borderRadius: 38,
    backgroundColor: "rgba(255,255,255,0.15)",
    justifyContent: "center",
    alignItems: "center",
    borderWidth: 2,
    borderColor: "rgba(255,255,255,0.2)",
  },
  captureButtonRecording: {
    backgroundColor: "rgba(239, 68, 68, 0.2)",
    borderColor: "rgba(239, 68, 68, 0.4)",
  },
  captureRing: {
    width: 58,
    height: 58,
    borderRadius: 29,
    borderWidth: 4,
    borderColor: colors.camera.text,
  },
  captureRingVideo: {
    borderColor: colors.error,
  },
  captureRingRecording: {
    width: 32,
    height: 32,
    borderRadius: 8,
    borderWidth: 0,
    backgroundColor: colors.error,
  },
  capturePulseRing: {
    position: "absolute",
    width: 58,
    height: 58,
    borderRadius: 29,
    borderWidth: 2,
    borderColor: colors.error,
  },
  modeToggle: {
    backgroundColor: "rgba(0,0,0,0.65)",
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 10,
    minWidth: 80,
    alignItems: "center",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.08)",
  },
  modeToggleDisabled: {
    opacity: 0.55,
  },
  modeToggleText: {
    color: "#fff",
    fontSize: 12,
    fontWeight: "600",
    letterSpacing: 1,
  },
  permissionContainer: {
    flex: 1,
    backgroundColor: colors.background,
    justifyContent: "center",
    alignItems: "center",
    padding: 32,
  },
  permissionCard: {
    backgroundColor: colors.card,
    borderRadius: 20,
    padding: 32,
    alignItems: "center",
    borderWidth: 1,
    borderColor: colors.stone,
    maxWidth: 340,
    width: "100%",
  },
  permissionTitle: {
    color: colors.heading,
    fontSize: 20,
    fontWeight: "600",
    marginBottom: 12,
  },
  permissionText: {
    color: colors.muted,
    fontSize: 15,
    textAlign: "center",
    marginBottom: 24,
    lineHeight: 22,
  },
  permissionButton: {
    backgroundColor: colors.primary,
    borderRadius: 14,
    paddingHorizontal: 28,
    paddingVertical: 14,
    shadowColor: colors.primary,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 12,
    elevation: 8,
  },
  permissionButtonText: {
    color: colors.primaryForeground,
    fontSize: 16,
    fontWeight: "600",
  },

  // ── Capture Flash ──
  captureFlash: {
    backgroundColor: "#fff",
    zIndex: 50,
  },

  // ── Full-Screen Preview ──
  previewOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.95)",
  },
  previewContainer: {
    flex: 1,
  },
  previewTopBar: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  previewCloseButton: {
    backgroundColor: "rgba(255,255,255,0.12)",
    borderRadius: 10,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  previewCloseText: {
    color: "#fff",
    fontSize: 15,
    fontWeight: "600",
  },
  previewTypeLabel: {
    color: "rgba(255,255,255,0.6)",
    fontSize: 14,
    fontWeight: "600",
  },
  previewDeleteButton: {
    backgroundColor: "rgba(239, 68, 68, 0.15)",
    borderRadius: 10,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: "rgba(239, 68, 68, 0.3)",
  },
  previewDeleteText: {
    color: colors.error,
    fontSize: 15,
    fontWeight: "600",
  },
  previewImage: {
    flex: 1,
    borderRadius: 8,
    margin: 16,
  },
  previewVideoPlaceholder: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
  },
  previewVideoFrameWrap: {
    flex: 1,
  },
  previewVideoBadge: {
    position: "absolute",
    bottom: 28,
    alignSelf: "center",
    backgroundColor: "rgba(0,0,0,0.68)",
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  previewVideoBadgeText: {
    color: "rgba(255,255,255,0.92)",
    fontSize: 12,
    fontWeight: "600",
  },
  previewVideoIcon: {
    color: "rgba(255,255,255,0.4)",
    fontSize: 64,
    marginBottom: 16,
  },
  previewVideoText: {
    color: "rgba(255,255,255,0.5)",
    fontSize: 16,
    fontWeight: "500",
  },
});

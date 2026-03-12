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

import React, { useState, useRef, useCallback, useEffect } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  Alert,
  Image,
  FlatList,
  useWindowDimensions,
  Animated,
  Easing,
  BackHandler,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { CameraView, useCameraPermissions } from "expo-camera";
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
} from "../lib/api";
import { colors } from "../lib/tokens";

type Nav = NativeStackNavigationProp<RootStackParamList, "PropertyTraining">;
type TrainingRoute = RouteProp<RootStackParamList, "PropertyTraining">;

type TrainingPhase = "intro" | "capturing" | "uploading" | "training" | "results";
type CaptureMode = "photo" | "video";

interface CapturedMedia {
  id: string;
  type: CaptureMode;
  base64?: string; // Only for photos
  uri: string;
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
const VIDEO_KEYFRAME_TIMESTAMPS_MS = [
  0,
  1200,
  3000,
  6000,
  10_000,
  16_000,
  24_000,
  36_000,
  48_000,
];
const VIDEO_KEYFRAME_MAX_PER_VIDEO = 5;

type VideoThumbnailsModule = {
  getThumbnailAsync: (
    uri: string,
    options: { time: number; quality: number },
  ) => Promise<{ uri: string }>;
};

let cachedVideoThumbnailsModule: VideoThumbnailsModule | null | undefined;

async function getVideoThumbnailsModule(): Promise<VideoThumbnailsModule | null> {
  if (cachedVideoThumbnailsModule !== undefined) {
    return cachedVideoThumbnailsModule;
  }

  try {
    const mod = (await import("expo-video-thumbnails")) as VideoThumbnailsModule;
    cachedVideoThumbnailsModule = mod;
    return mod;
  } catch (err) {
    console.warn(
      "[PropertyTraining] expo-video-thumbnails unavailable in this client build:",
      err instanceof Error ? err.message : String(err),
    );
    cachedVideoThumbnailsModule = null;
    return null;
  }
}

export default function PropertyTrainingScreen() {
  const navigation = useNavigation<Nav>();
  const route = useRoute<TrainingRoute>();
  const { propertyId, propertyName } = route.params;
  const { width, height } = useWindowDimensions();
  const isLandscape = width > height;

  const [permission, requestPermission] = useCameraPermissions();
  const [phase, setPhase] = useState<TrainingPhase>("intro");
  const [captures, setCaptures] = useState<CapturedMedia[]>([]);
  const [captureMode, setCaptureMode] = useState<CaptureMode>("photo");
  const [isRecording, setIsRecording] = useState(false);
  const [zoom, setZoom] = useState(0);
  const [uploadProgress, setUploadProgress] = useState({ current: 0, total: 0 });
  const [trainingResult, setTrainingResult] = useState<TrainingResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cameraRef = useRef<CameraView>(null);
  const baseZoomRef = useRef(0);
  const isCapturingRef = useRef(false);
  const isRecordingRef = useRef(false);
  const recordingPulse = useRef(new Animated.Value(0)).current;
  // Track successful uploads so retries don't duplicate — maps capture.id → upload record ids
  const uploadedIdsRef = useRef<Map<string, string[]>>(new Map());
  const cancelRequestedRef = useRef(false);
  const runIdRef = useRef(0);

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
        setPhase("intro");
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
            onPress: () => navigation.goBack(),
          },
        ],
      );
      return true; // prevent default back action
    };

    const sub = BackHandler.addEventListener("hardwareBackPress", onBackPress);
    return () => sub.remove();
  }, [phase, captures.length, navigation]);

  const handleStartCapture = useCallback(async () => {
    if (!permission?.granted) {
      const result = await requestPermission();
      if (!result.granted) {
        Alert.alert(
          "Camera Required",
          "Camera access is needed to capture baseline images for training.",
        );
        return;
      }
    }
    setError(null);
    setPhase("capturing");
  }, [permission, requestPermission]);

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
      }
    } catch (err) {
      console.error("Capture failed:", err);
      setError("Capture failed. Please try again.");
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } finally {
      isCapturingRef.current = false;
    }
  }, []);

  // ── Video Recording ──
  const handleStartRecording = useCallback(async () => {
    if (!cameraRef.current || isRecordingRef.current) return;
    isRecordingRef.current = true;
    setIsRecording(true);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);

    try {
      const result = await cameraRef.current.recordAsync({
        maxDuration: 60, // 1 minute max
      });

      if (result?.uri) {
        const newCapture: CapturedMedia = {
          id: `vid-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          type: "video",
          uri: result.uri,
        };
        setCaptures((prev) => [...prev, newCapture]);
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      }
    } catch (err) {
      console.error("Recording failed:", err);
      setError("Recording failed. Please try again.");
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } finally {
      isRecordingRef.current = false;
      setIsRecording(false);
    }
  }, []);

  const handleStopRecording = useCallback(() => {
    if (!cameraRef.current || !isRecordingRef.current) return;
    cameraRef.current.stopRecording();
    // recordAsync promise will resolve with the URI
  }, []);

  const handleRemoveCapture = useCallback((id: string) => {
    // Clear cached upload ID so it doesn't get sent to training if removed
    uploadedIdsRef.current.delete(id);
    setCaptures((prev) => prev.filter((c) => c.id !== id));
  }, []);

  const isRunActive = useCallback((runId: number) => {
    return runIdRef.current === runId && !cancelRequestedRef.current;
  }, []);

  const extractVideoKeyframeUris = useCallback(async (videoUri: string) => {
    const videoThumbnails = await getVideoThumbnailsModule();
    if (!videoThumbnails) {
      return [];
    }

    const frames: string[] = [];
    const seen = new Set<string>();

    for (const time of VIDEO_KEYFRAME_TIMESTAMPS_MS) {
      try {
        const thumb = await videoThumbnails.getThumbnailAsync(videoUri, {
          time,
          quality: 0.65,
        });
        if (!thumb?.uri || seen.has(thumb.uri)) continue;
        seen.add(thumb.uri);
        frames.push(thumb.uri);
        if (frames.length >= VIDEO_KEYFRAME_MAX_PER_VIDEO) break;
      } catch {
        // Ignore out-of-range timestamps and continue trying others.
      }
    }

    return frames;
  }, []);

  const handleCancelProcessing = useCallback(() => {
    if (phase !== "uploading" && phase !== "training") return;
    cancelRequestedRef.current = true;
    runIdRef.current++;
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

        // Skip if already uploaded in a previous attempt
        const existingIds = uploadedIdsRef.current.get(capture.id);
        if (existingIds && existingIds.length > 0) {
          mediaUploadIds.push(...existingIds);
          progressCurrent += existingIds.length;
          setUploadProgress({ current: progressCurrent, total });
          continue;
        }

        const uploadedForCapture: string[] = [];

        if (capture.type === "video") {
          const videoResult = await uploadVideoFile(
            capture.uri,
            propertyId,
            `training-video-${i + 1}.mp4`,
          );
          uploadedForCapture.push(videoResult.id);
          mediaUploadIds.push(videoResult.id);
          progressCurrent += 1;
          setUploadProgress({ current: progressCurrent, total });

          const keyframeUris = await extractVideoKeyframeUris(capture.uri);
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
      const result = await trainProperty(propertyId, mediaUploadIds);
      if (!isRunActive(currentRunId)) {
        return;
      }
      setTrainingResult(result);
      setPhase("results");
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (err) {
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
      setError(
        err instanceof Error
          ? `${stage === "upload" ? "Upload" : "Training"} failed: ${err.message}`
          : "Training failed. Please check your connection and try again.",
      );
      setPhase("capturing");
    }
  }, [captures, extractVideoKeyframeUris, isRunActive, propertyId]);

  const handleDoneCapturing = useCallback(() => {
    if (captures.length < 3) {
      Alert.alert(
        "More Images Needed",
        "Please capture at least 3 images from different rooms and angles for accurate training.",
      );
      return;
    }

    Alert.alert(
      "Start Training",
      `Upload ${captures.length} item${captures.length !== 1 ? "s" : ""} and train AI on this property? This may take a minute.`,
      [
        { text: "Cancel", style: "cancel" },
        { text: "Train", style: "default", onPress: handleUploadAndTrain },
      ],
    );
  }, [captures.length, handleUploadAndTrain]);

  // ──── Intro Phase ────
  if (phase === "intro") {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.introContent}>
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

          <TouchableOpacity
            style={styles.startButton}
            onPress={handleStartCapture}
            activeOpacity={0.8}
          >
            <Text style={styles.startButtonText}>Start Capture</Text>
          </TouchableOpacity>
        </View>
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
      <SafeAreaView style={styles.container}>
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
  if (phase === "results" && trainingResult) {
    const keptFrames = trainingResult.dedupe?.keptCount ?? captures.length;
    const droppedFrames = trainingResult.dedupe?.droppedCount ?? 0;
    const uploadedVideos = trainingResult.mediaSummary?.uploadedVideos ?? 0;

    return (
      <SafeAreaView style={styles.container}>
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
            style={styles.doneButton}
            onPress={() => navigation.popToTop()}
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
                    onPress: () => setPhase("intro"),
                  },
                ],
              );
            } else {
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

      {/* Guidance text */}
      {!isRecording && (
        <View style={styles.guidanceContainer} pointerEvents="none">
          <Text style={styles.guidanceText}>
            {captures.length === 0
              ? "Point at the first room and tap capture"
              : captures.length < 3
                ? `Capture ${3 - captures.length} more item${3 - captures.length !== 1 ? "s" : ""} (minimum)`
                : "Keep capturing or tap Done when finished"}
          </Text>
        </View>
      )}

      {/* Bottom Controls */}
      <SafeAreaView style={styles.cameraBottomControls}>
        {/* Thumbnail strip with visible X delete buttons */}
        {captures.length > 0 && (
          <FlatList
            data={captures}
            horizontal
            showsHorizontalScrollIndicator={false}
            keyExtractor={(item) => item.id}
            contentContainerStyle={styles.thumbnailStrip}
            renderItem={({ item }) => (
              <View style={styles.thumbnailWrapper}>
                <TouchableOpacity style={styles.thumbnail}>
                  {item.type === "video" ? (
                    <View style={[styles.thumbnailImage, { backgroundColor: colors.camera.background, justifyContent: "center", alignItems: "center" }]}>
                      <Text style={{ color: "#fff", fontSize: 22 }}>▶</Text>
                    </View>
                  ) : (
                    <Image source={{ uri: item.uri }} style={styles.thumbnailImage} />
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
          <TouchableOpacity
            style={[
              styles.finishButton,
              captures.length < 3 && styles.finishButtonDisabled,
            ]}
            onPress={handleDoneCapturing}
            disabled={captures.length < 3}
            activeOpacity={0.7}
          >
            <Text
              style={[
                styles.finishButtonText,
                captures.length < 3 && styles.finishButtonTextDisabled,
              ]}
            >
              Done ({captures.length})
            </Text>
          </TouchableOpacity>

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
            style={styles.modeToggle}
            onPress={() => {
              if (isRecording) return;
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
    flex: 1,
    padding: 20,
    paddingTop: 12,
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
});

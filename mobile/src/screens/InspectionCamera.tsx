import React, { useState, useCallback, useRef, useEffect } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Alert,
  BackHandler,
  Modal,
  TextInput,
  KeyboardAvoidingView,
  Platform,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { CameraView, useCameraPermissions } from "expo-camera";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { runOnJS } from "react-native-reanimated";
import * as Haptics from "expo-haptics";
import { useNavigation, useRoute } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import type { RouteProp } from "@react-navigation/native";
import type { RootStackParamList, SummaryData, SummaryRoomData, SummaryFindingData } from "../navigation";
import FindingsPanel from "../components/FindingsPanel";
import CoverageTracker from "../components/CoverageTracker";
import { Ionicons } from "@expo/vector-icons";
import { colors } from "../lib/tokens";
import type { Finding } from "../lib/inspection/types";
import {
  SessionManager,
  type InspectionMode,
} from "../lib/inspection/session-manager";
import { ComparisonManager } from "../lib/vision/comparison-manager";
import { MotionFilter } from "../lib/sensors/motion-filter";
import { ChangeDetector } from "../lib/vision/change-detector";
import { RoomDetector } from "../lib/vision/room-detector";
import { loadOnnxModel, type OnnxModelLoader } from "../lib/vision/onnx-model";
import {
  getInspectionBaselines,
  getPropertyConditions,
  submitBulkResults,
} from "../lib/api";
import { supabase } from "../lib/supabase";
import * as FileSystem from "expo-file-system";
import { decodeBase64JpegToRgb, rgbToGrayscale } from "../lib/vision/image-utils";
import {
  enqueueBulkSubmission,
  flushBulkSubmissionQueue,
} from "../lib/inspection/offline-bulk-queue";
import type { ImageSourceType } from "../lib/image-source/types";
import { InspectionAnnouncer } from "../lib/audio/inspection-announcer";

type Nav = NativeStackNavigationProp<RootStackParamList, "InspectionCamera">;
type CameraRoute = RouteProp<RootStackParamList, "InspectionCamera">;

interface RoomBaseline {
  roomId: string;
  roomName: string;
  baselines: Array<{
    id: string;
    imageUrl: string;
    label: string | null;
    embedding: number[] | null;
  }>;
}

const CHANGE_FRAME_WIDTH = 320;
const CHANGE_FRAME_HEIGHT = 240;

export default function InspectionCameraScreen() {
  const navigation = useNavigation<Nav>();
  const route = useRoute<CameraRoute>();
  const { inspectionId, propertyId, inspectionMode } = route.params;
  const activeImageSource: ImageSourceType = route.params.imageSource || "camera";
  const activeImageSourceLabel =
    activeImageSource === "camera"
      ? "Phone"
      : activeImageSource === "frame"
        ? "Frame"
        : "OpenGlass";

  const [permission, requestPermission] = useCameraPermissions();
  const [paused, setPaused] = useState(false);
  const [currentRoom, setCurrentRoom] = useState<string | null>(null);
  const [findings, setFindings] = useState<Finding[]>([]);
  const [coverage, setCoverage] = useState(0);
  const [roomAngles, setRoomAngles] = useState({ scanned: 0, total: 0 });
  const [isProcessing, setIsProcessing] = useState(false);
  const [isAutoDetect, setIsAutoDetect] = useState(false);
  const [autoCaptureEnabled, setAutoCaptureEnabled] = useState(true);
  const [showNoteModal, setShowNoteModal] = useState(false);
  const [showNotesLogModal, setShowNotesLogModal] = useState(false);
  const [noteText, setNoteText] = useState("");
  const [captureHint, setCaptureHint] = useState<string | null>(null);
  const [zoom, setZoom] = useState(0);
  const [roomWaypoints, setRoomWaypoints] = useState<
    Array<{ id: string; label: string | null; scanned: boolean }>
  >([]);
  const cameraRef = useRef<CameraView>(null);
  const baseZoomRef = useRef(0);

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
  const autoCaptureTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Core engines
  const sessionRef = useRef<SessionManager | null>(null);
  const comparisonRef = useRef<ComparisonManager | null>(null);
  const motionFilterRef = useRef<MotionFilter | null>(null);
  const changeDetectorRef = useRef<ChangeDetector | null>(null);
  const roomDetectorRef = useRef<RoomDetector | null>(null);
  const modelLoaderRef = useRef<OnnxModelLoader | null>(null);
  const roomDetectionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const captureHintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoCaptureEnabledRef = useRef(autoCaptureEnabled);
  const autoAllRoomsCompleteHintRef = useRef(false);
  const baselinesRef = useRef<RoomBaseline[]>([]);
  const knownConditionsByRoomRef = useRef<Map<string, string[]>>(new Map());
  const globalKnownConditionsRef = useRef<string[]>([]);
  const announcerRef = useRef(new InspectionAnnouncer());

  useEffect(() => {
    autoCaptureEnabledRef.current = autoCaptureEnabled;
  }, [autoCaptureEnabled]);

  const showCaptureHint = useCallback((message: string) => {
    setCaptureHint(message);
    if (captureHintTimerRef.current) {
      clearTimeout(captureHintTimerRef.current);
    }
    captureHintTimerRef.current = setTimeout(() => {
      setCaptureHint(null);
      captureHintTimerRef.current = null;
    }, 1800);
  }, []);

  // Initialize engines on mount
  useEffect(() => {
    const session = new SessionManager(
      inspectionId,
      propertyId,
      inspectionMode as InspectionMode,
    );
    sessionRef.current = session;

    const motionFilter = new MotionFilter();
    motionFilterRef.current = motionFilter;
    motionFilter.start();

    const changeDetector = new ChangeDetector();
    changeDetectorRef.current = changeDetector;

    const comparison = new ComparisonManager(motionFilter, changeDetector);
    comparisonRef.current = comparison;
    announcerRef.current.setEnabled(activeImageSource !== "camera");

    // Initialize room detector
    const roomDetector = new RoomDetector();
    roomDetectorRef.current = roomDetector;

    // Register finding callback
    comparison.onResult((result, roomId) => {
      if (result.findings?.length > 0) {
        for (const f of result.findings) {
          const findingId = session.addFinding(roomId, f);
          setFindings((prev) => [
            ...prev,
            {
              id: findingId,
              description: f.description,
              severity: f.severity,
              confidence: f.confidence,
              category: f.category,
              status: "suggested",
            },
          ]);
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
        }
        if (activeImageSource !== "camera") {
          const firstFinding = result.findings[0];
          if (firstFinding) {
            const roomNameForAudio =
              baselinesRef.current.find((room) => room.roomId === roomId)
                ?.roomName || "current room";
            void announcerRef.current.announceFinding(
              roomNameForAudio,
              firstFinding.description,
            );
          }
        }
      }
      if (result.readiness_score != null) {
        session.updateRoomScore(roomId, result.readiness_score);
      }
    });

    comparison.onStatusChange((status) => {
      setIsProcessing(status === "processing");
    });

    // Load baselines
    loadBaselines(session);
    loadKnownConditions();

    if (activeImageSource !== "camera") {
      showCaptureHint(
        `${activeImageSource === "frame" ? "Frame" : "OpenGlass"} source selected. Phone camera remains fallback for detailed captures.`,
      );
      void announcerRef.current.announceStatus("Glasses mode enabled.");
    }

    // Best-effort flush for any previously queued bulk submissions.
    flushBulkSubmissionQueue()
      .then((result) => {
        if (result.flushed > 0) {
          showCaptureHint(`Synced ${result.flushed} pending inspection upload(s).`);
        }
      })
      .catch(() => {
        // Offline or backend unavailable — queue remains on device.
      });

    // Attempt to load ONNX model for auto room detection
    loadOnnxModel()
      .then((loader) => {
        modelLoaderRef.current = loader;
        if (loader.isLoaded) {
          roomDetector.setModelLoader(loader);
          setIsAutoDetect(true);
          startRoomDetectionLoop(roomDetector, session);
        }
      })
      .catch((err) => {
        console.warn("ONNX model load failed, room auto-detect disabled:", err);
      });

    // Start auto-capture loop (every 5s, checks if conditions are met)
    autoCaptureTimerRef.current = setInterval(() => {
      if (!autoCaptureEnabledRef.current) return;
      if (session.isPaused()) return;
      if (!motionFilter.isStable()) return;
      if (comparison.isPaused()) return;

      const state = session.getState();
      if (!state.currentRoomId) return;

      autoCaptureTick(session, comparison);
    }, 5000);

    return () => {
      motionFilter.stop();
      modelLoaderRef.current?.dispose();
      if (autoCaptureTimerRef.current) {
        clearInterval(autoCaptureTimerRef.current);
      }
      if (roomDetectionTimerRef.current) {
        clearTimeout(roomDetectionTimerRef.current);
      }
      if (captureHintTimerRef.current) {
        clearTimeout(captureHintTimerRef.current);
      }
      announcerRef.current.setEnabled(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const updateCoverageUI = useCallback(
    (session: SessionManager, roomId?: string) => {
      setCoverage(Math.round(session.getOverallCoverage()));
      if (roomId) {
        const state = session.getState();
        const visit = state.visitedRooms.get(roomId);
        const roomBaselines = baselinesRef.current.find(
          (r) => r.roomId === roomId,
        );

        if (visit && roomBaselines) {
          setRoomAngles({
            scanned: visit.anglesScanned.size,
            total: roomBaselines.baselines?.length || 0,
          });

          // Update waypoint data for CoverageTracker
          setRoomWaypoints(
            (roomBaselines.baselines || []).map((b) => ({
              id: b.id,
              label: b.label || null,
              scanned: visit.anglesScanned.has(b.id),
            })),
          );
        }
      }
    },
    [],
  );

  const getNextIncompleteRoom = useCallback((session: SessionManager) => {
    const state = session.getState();
    for (const room of baselinesRef.current) {
      const total = room.baselines?.length ?? 0;
      if (total === 0) continue;
      const scanned = state.visitedRooms.get(room.roomId)?.anglesScanned.size ?? 0;
      if (scanned < total) {
        return room;
      }
    }
    return null;
  }, []);

  const autoAdvanceIfRoomComplete = useCallback(
    (session: SessionManager, roomId: string) => {
      if (!autoCaptureEnabledRef.current) return;

      const roomCoverage = session.getRoomCoverage(roomId);
      if (roomCoverage < 100) return;

      const nextRoom = getNextIncompleteRoom(session);
      if (!nextRoom) {
        if (!autoAllRoomsCompleteHintRef.current) {
          showCaptureHint("All room angles captured. End inspection when ready.");
          autoAllRoomsCompleteHintRef.current = true;
        }
        return;
      }

      if (nextRoom.roomId === roomId) return;

      session.enterRoom(nextRoom.roomId, nextRoom.roomName);
      setCurrentRoom(nextRoom.roomName);
      updateCoverageUI(session, nextRoom.roomId);
      autoAllRoomsCompleteHintRef.current = false;
      showCaptureHint(`Room complete. Auto-switched to ${nextRoom.roomName}.`);
      if (activeImageSource !== "camera") {
        void announcerRef.current.announceCoverage(nextRoom.roomName);
      }
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    },
    [activeImageSource, getNextIncompleteRoom, showCaptureHint, updateCoverageUI],
  );

  const loadBaselines = useCallback(
    async (session: SessionManager) => {
      try {
        const data = await getInspectionBaselines(inspectionId);

        // Map API response shape to our RoomBaseline interface.
        // API returns: rooms[].baselineImages[] (Drizzle column names)
        // We need:   rooms[].baselines[] with { id, imageUrl, label, embedding }
        interface ApiRoom {
          id: string;
          name: string;
          baselineImages?: Array<{
            id: string;
            imageUrl: string;
            label: string | null;
            embedding: number[] | null;
          }>;
        }

        const mappedRooms: RoomBaseline[] = ((data.rooms || []) as ApiRoom[]).map(
          (room) => ({
            roomId: room.id,
            roomName: room.name,
            baselines: (room.baselineImages || []).map((bl) => ({
              id: bl.id,
              imageUrl: bl.imageUrl,
              label: bl.label || null,
              embedding: bl.embedding || null,
            })),
          }),
        );

        baselinesRef.current = mappedRooms;

        // Feed baselines to room detector for auto room detection
        const detector = roomDetectorRef.current;
        if (detector) {
          const detectorBaselines = mappedRooms.flatMap((room) =>
            (room.baselines || []).map((b) => ({
              id: b.id,
              roomId: room.roomId,
              roomName: room.roomName,
              label: b.label,
              imageUrl: b.imageUrl,
              embedding: b.embedding,
            })),
          );
          detector.loadBaselines(detectorBaselines);
        }

        const roomAnglesMap = new Map<string, number>();
        for (const room of mappedRooms) {
          roomAnglesMap.set(room.roomId, room.baselines?.length || 0);
        }
        session.setRoomAngles(roomAnglesMap);

        if (mappedRooms.length > 0) {
          const firstRoom = mappedRooms[0];
          session.enterRoom(firstRoom.roomId, firstRoom.roomName);
          setCurrentRoom(firstRoom.roomName);
          updateCoverageUI(session, firstRoom.roomId);
        }
      } catch (err) {
        console.error("Failed to load baselines:", err);
      }
    },
    [inspectionId, updateCoverageUI],
  );

  const loadKnownConditions = useCallback(async () => {
    try {
      const conditions = await getPropertyConditions(propertyId, {
        activeOnly: true,
      });

      const byRoom = new Map<string, string[]>();
      const global: string[] = [];

      for (const condition of conditions) {
        const description = condition.description?.trim();
        if (!description) continue;

        if (condition.roomId) {
          const list = byRoom.get(condition.roomId) || [];
          list.push(description);
          byRoom.set(condition.roomId, list);
        } else {
          global.push(description);
        }
      }

      knownConditionsByRoomRef.current = byRoom;
      globalKnownConditionsRef.current = global;
    } catch {
      // Condition register unavailable should not block inspections.
      knownConditionsByRoomRef.current = new Map();
      globalKnownConditionsRef.current = [];
    }
  }, [propertyId]);

  /**
   * Room detection loop — processes camera frames at ~3fps for auto room detection.
   * Adaptively slows to 1fps when highly confident for >30s.
   * Only runs when ONNX model is loaded.
   */
  const startRoomDetectionLoop = useCallback(
    (detector: RoomDetector, session: SessionManager) => {
      const tick = async () => {
        if (session.isPaused() || !cameraRef.current) {
          roomDetectionTimerRef.current = setTimeout(tick, detector.getRecommendedInterval());
          return;
        }

        try {
          // Capture a low-res frame for room detection
          const photo = await cameraRef.current.takePictureAsync({
            quality: 0.3,
            base64: false, // Just need the URI
          });

          if (photo?.uri) {
            const result = await detector.processFrameFromUri(photo.uri);

            // Clean up the temp photo file to avoid storage leak on long sessions
            FileSystem.deleteAsync(photo.uri, { idempotent: true }).catch(() => {});

            if (result?.roomChanged && result.room) {
              // Auto-switch room in session
              session.enterRoom(result.room.roomId, result.room.roomName);
              setCurrentRoom(result.room.roomName);
              updateCoverageUI(session, result.room.roomId);
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            }

            // Update angle scanning from room detector
            if (result?.anglesScanned) {
              for (const angle of result.anglesScanned) {
                if (angle.scanned) {
                  // Find the room that owns this baseline in a single pass
                  const ownerRoom = baselinesRef.current.find((r) =>
                    r.baselines.some((b) => b.id === angle.baselineId),
                  );
                  if (ownerRoom) {
                    session.recordAngleScan(ownerRoom.roomId, angle.baselineId);
                    updateCoverageUI(session, ownerRoom.roomId);
                  }
                }
              }
            }
          }
        } catch {
          // Frame capture failed — continue loop
        }

        // Schedule next tick at adaptive rate
        roomDetectionTimerRef.current = setTimeout(tick, detector.getRecommendedInterval());
      };

      // Start the loop
      roomDetectionTimerRef.current = setTimeout(tick, 1000); // Initial 1s delay
    },
    [updateCoverageUI],
  );

  const captureChangeFrame = useCallback(async (): Promise<Uint8Array | null> => {
    if (!cameraRef.current) return null;

    let rawPhotoUri: string | null = null;
    let resizedUri: string | null = null;

    try {
      const photo = await cameraRef.current.takePictureAsync({
        quality: 0.2,
        base64: false,
      });

      if (!photo?.uri) return null;
      rawPhotoUri = photo.uri;

      const ImageManipulator = await import("expo-image-manipulator");
      const resized = await ImageManipulator.manipulateAsync(
        photo.uri,
        [{ resize: { width: CHANGE_FRAME_WIDTH, height: CHANGE_FRAME_HEIGHT } }],
        {
          format: ImageManipulator.SaveFormat.JPEG,
          base64: true,
          compress: 0.5,
        },
      );

      resizedUri = resized.uri;
      if (!resized.base64) return null;

      const decoded = await decodeBase64JpegToRgb(resized.base64);
      if (!decoded) return null;

      return rgbToGrayscale(decoded.rgb, decoded.width, decoded.height);
    } catch {
      return null;
    } finally {
      if (rawPhotoUri) {
        FileSystem.deleteAsync(rawPhotoUri, { idempotent: true }).catch(() => {});
      }
      if (resizedUri && resizedUri !== rawPhotoUri) {
        FileSystem.deleteAsync(resizedUri, { idempotent: true }).catch(() => {});
      }
    }
  }, []);

  /**
   * Auto-capture tick — called by the interval timer.
   * Triggers a silent comparison if the camera is stable and cooldown elapsed.
   */
  const autoCaptureTick = useCallback(
    async (session: SessionManager, comparison: ComparisonManager) => {
      if (!cameraRef.current || paused) return;

      const state = session.getState();
      const currentRoomId = state.currentRoomId;
      if (!currentRoomId) return;

      const room = baselinesRef.current.find(
        (r) => r.roomId === currentRoomId,
      );
      if (!room?.baselines?.length) return;

      // Pick an unscanned angle, or fall back to first
      const visit = state.visitedRooms.get(currentRoomId);
      const unscanned = room.baselines.find(
        (b) => !visit?.anglesScanned.has(b.id),
      );
      if (!unscanned && autoCaptureEnabledRef.current) {
        autoAdvanceIfRoomComplete(session, currentRoomId);
        return;
      }
      const baseline = unscanned || room.baselines[0];

      // Feed lightweight change detection before expensive burst capture.
      const changeFrame = await captureChangeFrame();
      const changeResult = changeFrame
        ? comparison.feedChangeFrame(changeFrame)
        : undefined;
      if (!comparison.shouldTrigger(changeResult)) {
        return;
      }

      // Record angle
      session.recordAngleScan(currentRoomId, baseline.id);
      updateCoverageUI(session, currentRoomId);
      autoAdvanceIfRoomComplete(session, currentRoomId);

      const {
        data: { session: authSession },
      } = await supabase.auth.getSession();
      if (!authSession?.access_token) return;

      const apiUrl = process.env.EXPO_PUBLIC_API_URL;
      if (!apiUrl) return;

      const roomKnownConditions = Array.from(
        new Set([
          ...(globalKnownConditionsRef.current || []),
          ...(knownConditionsByRoomRef.current.get(currentRoomId) || []),
        ]),
      );

      // Single-frame capture function — ComparisonManager handles burst internally
      const captureFrame = async () => {
        if (!cameraRef.current) return null;
        try {
          const photo = await cameraRef.current.takePictureAsync({
            quality: 0.7,
            base64: true,
          });
          if (photo?.base64) {
            return `data:image/jpeg;base64,${photo.base64}`;
          }
        } catch {
          // Camera capture failed silently
        }
        return null;
      };

      void comparison.triggerComparison(
        captureFrame,
        baseline.imageUrl,
        room.roomName,
        currentRoomId,
        {
          inspectionMode,
          knownConditions: roomKnownConditions,
          inspectionId,
          baselineImageId: baseline.id,
          apiUrl,
          authToken: authSession.access_token,
        },
      );
    },
    [autoAdvanceIfRoomComplete, captureChangeFrame, paused, inspectionMode, inspectionId, updateCoverageUI],
  );

  // Manual room switching (always available — primary mode when ONNX model not loaded)
  const handleSwitchRoom = useCallback(() => {
    const rooms = baselinesRef.current;
    if (rooms.length === 0) return;

    const session = sessionRef.current;
    if (!session) return;

    const state = session.getState();
    const currentIdx = rooms.findIndex(
      (r) => r.roomId === state.currentRoomId,
    );
    const nextIdx = (currentIdx + 1) % rooms.length;
    const nextRoom = rooms[nextIdx];

    session.enterRoom(nextRoom.roomId, nextRoom.roomName);
    setCurrentRoom(nextRoom.roomName);
    updateCoverageUI(session, nextRoom.roomId);

    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  }, [updateCoverageUI]);

  const handlePause = useCallback(() => {
    const session = sessionRef.current;
    const comparison = comparisonRef.current;
    if (!session || !comparison) return;

    setPaused((p) => {
      if (p) {
        session.resume();
        comparison.resume();
      } else {
        session.pause();
        comparison.pause();
      }
      return !p;
    });
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
  }, []);

  const handleEndInspection = useCallback(async () => {
    const session = sessionRef.current;
    if (!session) {
      navigation.replace("InspectionSummary", { inspectionId, propertyId });
      return;
    }

    const state = session.getState();
    const results: Array<{
      roomId: string;
      baselineImageId: string;
      currentImageUrl?: string;
      score: number | null;
      findings: Array<{
        id: string;
        description: string;
        severity: string;
        confidence: number;
        category: string;
        isClaimable: boolean;
        source: "manual_note" | "ai";
      }>;
    }> = [];

    for (const [roomId, visit] of state.visitedRooms) {
      const roomBaselines = baselinesRef.current.find(
        (r) => r.roomId === roomId,
      );
      const firstBaseline = roomBaselines?.baselines?.[0];
      if (!firstBaseline?.id) {
        const confirmedCount = visit.findings.filter((f) => f.status === "confirmed").length;
        if (confirmedCount > 0) {
          console.warn(
            `Room ${roomId} had ${confirmedCount} confirmed finding(s) but no baselines — findings dropped from submission`,
          );
        }
        continue;
      }

      results.push({
        roomId,
        baselineImageId: firstBaseline.id,
        score: visit.bestScore ?? null,
        findings: visit.findings
          .filter((f) => f.status === "confirmed")
          .map((f) => ({
            id: f.id,
            description: f.description,
            severity: f.severity,
            confidence: f.confidence,
            category: f.category,
            isClaimable: f.isClaimable || false,
            source: f.category === "manual_note" ? "manual_note" : "ai",
          })),
      });
    }

    if (results.length > 0) {
      try {
        await flushBulkSubmissionQueue();
        await submitBulkResults(
          inspectionId,
          results,
          session.getCompletionTier(),
        );
      } catch (err) {
        console.error("Failed to submit results:", err);
        try {
          await enqueueBulkSubmission({
            inspectionId,
            results,
            completionTier: session.getCompletionTier(),
          });
          Alert.alert(
            "Saved for sync",
            "Inspection ended and results were saved on-device. They will auto-sync when your connection is available.",
          );
        } catch {
          Alert.alert(
            "Sync warning",
            "Inspection ended, but we could not sync or queue results on this device.",
          );
        }
      }
    }

    // Build summary data from session state
    const summaryRooms: SummaryRoomData[] = [];
    const allConfirmed: SummaryData["confirmedFindings"] = [];

    for (const [roomId, visit] of state.visitedRooms) {
      const roomBaseline = baselinesRef.current.find((r) => r.roomId === roomId);
      const anglesTotal = roomBaseline?.baselines?.length || 0;

      const roomFindings: SummaryFindingData[] = visit.findings.map((f) => ({
        id: f.id,
        description: f.description,
        severity: f.severity,
        confidence: f.confidence,
        category: f.category,
        status: f.status,
        roomName: visit.roomName,
        source: f.category === "manual_note" ? "manual_note" : "ai",
      }));

      const confirmed = visit.findings.filter((f) => f.status === "confirmed");
      for (const cf of confirmed) {
        allConfirmed.push({
          id: cf.id,
          description: cf.description,
          severity: cf.severity,
          confidence: cf.confidence,
          category: cf.category,
          roomName: visit.roomName,
          status: cf.status,
          source: cf.category === "manual_note" ? "manual_note" : "ai",
        });
      }

      summaryRooms.push({
        roomId,
        roomName: visit.roomName,
        score: visit.bestScore,
        coverage: anglesTotal > 0 ? Math.round((visit.anglesScanned.size / anglesTotal) * 100) : 0,
        anglesScanned: visit.anglesScanned.size,
        anglesTotal,
        confirmedFindings: confirmed.length,
        findings: roomFindings,
      });
    }

    const summaryData: SummaryData = {
      overallScore: session.getOverallScore(),
      completionTier: session.getCompletionTier(),
      overallCoverage: Math.round(session.getOverallCoverage()),
      durationMs: session.getDurationMs(),
      inspectionMode: inspectionMode,
      rooms: summaryRooms,
      confirmedFindings: allConfirmed,
    };

    navigation.replace("InspectionSummary", {
      inspectionId,
      propertyId,
      summaryData,
    });
  }, [navigation, inspectionId, propertyId, inspectionMode]);

  // Intercept Android hardware back button to prevent data loss
  useEffect(() => {
    const onBackPress = () => {
      Alert.alert(
        "End Inspection",
        "Are you sure you want to end this inspection?",
        [
          { text: "Cancel", style: "cancel" },
          {
            text: "End",
            style: "destructive",
            onPress: handleEndInspection,
          },
        ],
      );
      return true; // Prevent default back behavior
    };
    const sub = BackHandler.addEventListener("hardwareBackPress", onBackPress);
    return () => sub.remove();
  }, [handleEndInspection]);

  // Manual capture trigger
  const handleManualCapture = useCallback(async () => {
    const session = sessionRef.current;
    const comparison = comparisonRef.current;
    if (!session || !comparison || !cameraRef.current || paused) return;
    if (isProcessing) {
      showCaptureHint("AI is still processing the last capture...");
      return;
    }

    const state = session.getState();
    const currentRoomId = state.currentRoomId;
    if (!currentRoomId) return;

    const room = baselinesRef.current.find((r) => r.roomId === currentRoomId);
    if (!room?.baselines?.length) return;

    const visit = state.visitedRooms.get(currentRoomId);
    const unscanned = room.baselines.find(
      (b) => !visit?.anglesScanned.has(b.id),
    );
    if (!unscanned && autoCaptureEnabled) {
      autoAdvanceIfRoomComplete(session, currentRoomId);
      return;
    }
    const baseline = unscanned || room.baselines[0];
    if (!unscanned) {
      showCaptureHint("Room coverage complete. Tap room name to switch rooms.");
    }

    if (!comparison.shouldTrigger()) {
      showCaptureHint("Hold steady or wait a moment before capturing again.");
      return;
    }

    // Record angle as scanned
    session.recordAngleScan(currentRoomId, baseline.id);
    updateCoverageUI(session, currentRoomId);
    autoAdvanceIfRoomComplete(session, currentRoomId);

    // Flash feedback
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);

    const {
      data: { session: authSession },
    } = await supabase.auth.getSession();
    if (!authSession?.access_token) return;

    const apiUrl = process.env.EXPO_PUBLIC_API_URL;
    if (!apiUrl) return;

    const roomKnownConditions = Array.from(
      new Set([
        ...(globalKnownConditionsRef.current || []),
        ...(knownConditionsByRoomRef.current.get(currentRoomId) || []),
      ]),
    );

    const captureFrame = async () => {
      if (!cameraRef.current) return null;
      try {
        const photo = await cameraRef.current.takePictureAsync({
          quality: 0.7,
          base64: true,
        });
        if (photo?.base64) {
          return `data:image/jpeg;base64,${photo.base64}`;
        }
      } catch {
        // Camera capture failed
      }
      return null;
    };

    void comparison.triggerComparison(
      captureFrame,
      baseline.imageUrl,
      room.roomName,
      currentRoomId,
      {
        inspectionMode,
        knownConditions: roomKnownConditions,
        inspectionId,
        baselineImageId: baseline.id,
        apiUrl,
        authToken: authSession.access_token,
      },
    );
  }, [
    autoAdvanceIfRoomComplete,
    autoCaptureEnabled,
    paused,
    isProcessing,
    inspectionMode,
    inspectionId,
    showCaptureHint,
    updateCoverageUI,
  ]);

  const handleConfirmFinding = useCallback((findingId: string) => {
    sessionRef.current?.updateFindingStatus(findingId, "confirmed");
    setFindings((prev) => prev.filter((f) => f.id !== findingId));
    showCaptureHint("Finding confirmed");
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  }, [showCaptureHint]);

  const handleDismissFinding = useCallback((findingId: string) => {
    sessionRef.current?.updateFindingStatus(findingId, "dismissed");
    setFindings((prev) => prev.filter((f) => f.id !== findingId));
    showCaptureHint("Finding dismissed");
  }, [showCaptureHint]);

  const handleAddNote = useCallback(() => {
    setShowNoteModal(true);
  }, []);

  const handleSubmitNote = useCallback(() => {
    const session = sessionRef.current;
    const text = noteText.trim();
    if (!session || !text) return;

    const state = session.getState();
    const roomId = state.currentRoomId;
    if (!roomId) return;

    // Add as a manual finding
    const findingId = session.addFinding(roomId, {
      description: text,
      severity: "maintenance",
      confidence: 1.0,
      category: "manual_note",
      findingCategory: "condition",
      isClaimable: false,
    });

    setFindings((prev) => [
      ...prev,
      {
        id: findingId,
        description: text,
        severity: "maintenance",
        confidence: 1.0,
        category: "manual_note",
        status: "confirmed",
      },
    ]);

    // Auto-confirm manual notes
    session.updateFindingStatus(findingId, "confirmed");

    setNoteText("");
    setShowNoteModal(false);
    showCaptureHint("Note added");
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  }, [noteText, showCaptureHint]);

  const handleDeleteNote = useCallback((findingId: string) => {
    sessionRef.current?.updateFindingStatus(findingId, "dismissed");
    setFindings((prev) => prev.filter((f) => f.id !== findingId));
    showCaptureHint("Note removed");
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  }, [showCaptureHint]);

  useEffect(() => {
    if (!permission?.granted) {
      requestPermission();
    }
  }, [permission, requestPermission]);

  if (!permission?.granted) {
    return (
      <View style={styles.permissionContainer}>
        <Text style={styles.permissionText}>Camera access is required</Text>
        <TouchableOpacity
          style={styles.permissionButton}
          onPress={requestPermission}
        >
          <Text style={styles.permissionButtonText}>Grant Permission</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const manualNotes = findings.filter(
    (finding) => finding.category === "manual_note" && finding.status === "confirmed",
  );

  return (
    <View style={styles.container}>
      {/* Camera with pinch-to-zoom gesture */}
      <GestureDetector gesture={pinchGesture}>
        <View style={StyleSheet.absoluteFill}>
          <CameraView
            ref={cameraRef}
            style={StyleSheet.absoluteFill}
            facing="back"
            zoom={zoom}
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

      {/* Top HUD — rendered OUTSIDE CameraView so touches work on iOS */}
      <SafeAreaView style={styles.topHud}>
          <View style={styles.topBar}>
            <TouchableOpacity
              style={styles.endButton}
              onPress={() => {
                Alert.alert(
                  "End Inspection",
                  "Are you sure you want to end this inspection?",
                  [
                    { text: "Cancel", style: "cancel" },
                    {
                      text: "End",
                      style: "destructive",
                      onPress: handleEndInspection,
                    },
                  ],
                );
              }}
              accessibilityRole="button"
              accessibilityLabel="End inspection"
            >
              <Text style={styles.endButtonText}>← End</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.roomBadge}
              onPress={handleSwitchRoom}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityLabel={`Current room: ${currentRoom || "Scanning"}. Tap to switch room`}
            >
              <View style={styles.roomBadgeHeader}>
                <Text style={styles.roomName}>
                  {currentRoom || "Scanning..."}
                </Text>
                <View style={[
                  styles.detectModeBadge,
                  isAutoDetect && styles.detectModeBadgeAuto,
                ]}>
                  <Text style={styles.detectModeText}>
                    {(isAutoDetect ? "Auto" : "Manual") +
                      (activeImageSource === "camera"
                        ? ""
                        : ` • ${activeImageSourceLabel}`)}
                  </Text>
                </View>
              </View>
              {roomAngles.total > 0 && (
                <Text style={styles.angleCount}>
                  {roomAngles.scanned}/{roomAngles.total} angles
                </Text>
              )}
            </TouchableOpacity>

            <View style={styles.recBadge}>
              <View
                style={[
                  styles.recDot,
                  isProcessing && styles.recDotProcessing,
                ]}
              />
              <Text style={styles.recText}>
                {isProcessing ? "AI" : "REC"}
              </Text>
            </View>
          </View>

          <View style={styles.coverageRow}>
            <CoverageTracker
              coverage={coverage}
              currentRoomName={currentRoom || undefined}
              roomWaypoints={roomWaypoints}
            />
          </View>
        </SafeAreaView>

        {/* Pause overlay */}
        {paused && (
          <TouchableOpacity
            style={styles.pauseOverlay}
            onPress={handlePause}
            activeOpacity={1}
            accessibilityRole="button"
            accessibilityLabel="Resume inspection"
          >
            <Text style={styles.pauseText}>PAUSED</Text>
            <Text style={styles.pauseSubtext}>Tap anywhere to resume</Text>
          </TouchableOpacity>
        )}

        {/* Bottom controls */}
        <SafeAreaView style={styles.bottomControls}>
          {captureHint && (
            <View style={styles.captureHintBubble}>
              <Text style={styles.captureHintText}>{captureHint}</Text>
            </View>
          )}

          <TouchableOpacity
            style={[
              styles.autoCaptureToggle,
              autoCaptureEnabled && styles.autoCaptureToggleOn,
            ]}
            onPress={() => {
              setAutoCaptureEnabled((value) => {
                const next = !value;
                autoAllRoomsCompleteHintRef.current = false;
                showCaptureHint(
                  next
                    ? "Hands-free AI capture enabled"
                    : "Hands-free AI capture paused",
                );
                return next;
              });
            }}
            activeOpacity={0.75}
          >
            <Text style={styles.autoCaptureToggleText}>
              {autoCaptureEnabled ? "Hands-Free ON" : "Hands-Free OFF"}
            </Text>
          </TouchableOpacity>

          <View style={styles.captureRow}>
            {/* Note button — left of capture */}
            <TouchableOpacity
              style={styles.utilityButton}
              onPress={handleAddNote}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityLabel="Add a note about an issue"
            >
              <Ionicons name="document-text-outline" size={18} color="rgba(255,255,255,0.8)" />
              <Text style={styles.utilityButtonText}>Note</Text>
            </TouchableOpacity>

            {/* Capture button — center */}
            <TouchableOpacity
              style={[
                styles.captureButton,
                isProcessing && styles.captureButtonProcessing,
              ]}
              onPress={handleManualCapture}
              disabled={paused}
              activeOpacity={0.6}
              accessibilityRole="button"
              accessibilityLabel={isProcessing ? "AI is processing" : "Capture photo for comparison"}
            >
              <View
                style={[
                  styles.captureRing,
                  isProcessing && styles.captureRingProcessing,
                ]}
              />
            </TouchableOpacity>

            {/* Pause button — right of capture */}
            <TouchableOpacity
              style={[styles.utilityButton, styles.utilityButtonWide]}
              onPress={() => setShowNotesLogModal(true)}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityLabel="Open inspection notes"
            >
              <Ionicons
                name="list"
                size={18}
                color="rgba(255,255,255,0.8)"
              />
              <Text style={styles.utilityButtonText}>
                Notes ({manualNotes.length})
              </Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.utilityButton}
              onPress={handlePause}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityLabel={paused ? "Resume inspection" : "Pause inspection"}
            >
              <Ionicons
                name={paused ? "play" : "pause"}
                size={18}
                color="rgba(255,255,255,0.8)"
              />
              <Text style={styles.utilityButtonText}>
                {paused ? "Resume" : "Pause"}
              </Text>
            </TouchableOpacity>
          </View>
        </SafeAreaView>

        {/* Voice/Note Modal */}
        <Modal
          visible={showNoteModal}
          transparent
          animationType="slide"
          onRequestClose={() => setShowNoteModal(false)}
        >
          <KeyboardAvoidingView
            behavior={Platform.OS === "ios" ? "padding" : "height"}
            style={styles.noteModalOverlay}
          >
            <View style={styles.noteModalContent}>
              <Text style={styles.noteModalTitle}>Add Note</Text>
              <Text style={styles.noteModalSubtitle}>
                Describe the issue you see
              </Text>
              <TextInput
                style={styles.noteInput}
                placeholder="e.g. Water stain on ceiling near AC vent"
                placeholderTextColor={colors.slate500}
                value={noteText}
                onChangeText={setNoteText}
                multiline
                autoFocus
                maxLength={500}
              />
              <View style={styles.noteModalButtons}>
                <TouchableOpacity
                  style={styles.noteModalCancel}
                  onPress={() => {
                    setNoteText("");
                    setShowNoteModal(false);
                  }}
                >
                  <Text style={styles.noteModalCancelText}>Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[
                    styles.noteModalSubmit,
                    !noteText.trim() && styles.noteModalSubmitDisabled,
                  ]}
                  onPress={handleSubmitNote}
                  disabled={!noteText.trim()}
                >
                  <Text style={styles.noteModalSubmitText}>Add Finding</Text>
                </TouchableOpacity>
              </View>
            </View>
          </KeyboardAvoidingView>
        </Modal>

        <Modal
          visible={showNotesLogModal}
          transparent
          animationType="fade"
          onRequestClose={() => setShowNotesLogModal(false)}
        >
          <View style={styles.noteModalOverlay}>
            <View style={styles.notesLogModalContent}>
              <Text style={styles.noteModalTitle}>Inspection Notes</Text>
              <Text style={styles.noteModalSubtitle}>
                Review and remove notes while inspecting
              </Text>

              <View style={styles.notesLogList}>
                {manualNotes.length === 0 ? (
                  <Text style={styles.notesLogEmptyText}>No notes yet</Text>
                ) : (
                  manualNotes.map((note) => (
                    <View key={note.id} style={styles.noteListItem}>
                      <Text style={styles.noteListText}>{note.description}</Text>
                      <TouchableOpacity
                        onPress={() => handleDeleteNote(note.id)}
                        style={styles.noteDeleteButton}
                      >
                        <Text style={styles.noteDeleteButtonText}>Delete</Text>
                      </TouchableOpacity>
                    </View>
                  ))
                )}
              </View>

              <TouchableOpacity
                style={styles.noteModalSubmit}
                onPress={() => setShowNotesLogModal(false)}
              >
                <Text style={styles.noteModalSubmitText}>Done</Text>
              </TouchableOpacity>
            </View>
          </View>
        </Modal>

      {/* Findings Panel */}
      <FindingsPanel
        findings={findings.filter((f) => f.status === "suggested")}
        onConfirm={handleConfirmFinding}
        onDismiss={handleDismissFinding}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.camera.background,
  },
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
  topHud: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    zIndex: 10,
  },
  topBar: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingTop: 8,
  },
  endButton: {
    backgroundColor: "rgba(0,0,0,0.65)",
    borderRadius: 10,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.08)",
  },
  endButtonText: {
    color: "#fff",
    fontSize: 15,
    fontWeight: "600",
  },
  roomBadge: {
    backgroundColor: "rgba(0,0,0,0.65)",
    borderRadius: 12,
    paddingHorizontal: 18,
    paddingVertical: 10,
    alignItems: "center",
    borderWidth: 1,
    borderColor: "rgba(77,166,255,0.3)",
  },
  roomBadgeHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  roomName: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "600",
  },
  detectModeBadge: {
    backgroundColor: "rgba(255,255,255,0.15)",
    borderRadius: 6,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  detectModeBadgeAuto: {
    backgroundColor: "rgba(34,197,94,0.25)",
  },
  detectModeText: {
    color: "rgba(255,255,255,0.7)",
    fontSize: 10,
    fontWeight: "600",
    letterSpacing: 0.3,
  },
  angleCount: {
    color: colors.slate300,
    fontSize: 12,
    marginTop: 2,
    fontWeight: "500",
  },
  recBadge: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "rgba(0,0,0,0.65)",
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
    gap: 6,
    borderWidth: 1,
    borderColor: "rgba(239, 68, 68, 0.2)",
  },
  recDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.error,
  },
  recDotProcessing: {
    backgroundColor: colors.primary,
  },
  recText: {
    color: colors.error,
    fontSize: 12,
    fontWeight: "600",
    letterSpacing: 0.5,
  },
  coverageRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    marginTop: 8,
    gap: 8,
  },
  pauseOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.75)",
    justifyContent: "center",
    alignItems: "center",
    zIndex: 25, // Must be above FindingsPanel (z-index: 20) to block interaction when paused
  },
  pauseText: {
    color: colors.primary,
    fontSize: 36,
    fontWeight: "600",
    letterSpacing: 6,
  },
  pauseSubtext: {
    color: colors.slate300,
    fontSize: 15,
    marginTop: 10,
    fontWeight: "500",
  },
  bottomControls: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    paddingBottom: 24,
    zIndex: 10,
  },
  captureRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 14,
  },
  autoCaptureToggle: {
    alignSelf: "center",
    marginBottom: 10,
    backgroundColor: "rgba(148,163,184,0.18)",
    borderWidth: 1,
    borderColor: "rgba(148,163,184,0.3)",
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 7,
  },
  autoCaptureToggleOn: {
    backgroundColor: "rgba(34,197,94,0.18)",
    borderColor: "rgba(34,197,94,0.35)",
  },
  autoCaptureToggleText: {
    color: "#fff",
    fontSize: 12,
    fontWeight: "600",
    letterSpacing: 0.2,
  },
  captureHintBubble: {
    marginBottom: 12,
    backgroundColor: "rgba(15, 23, 42, 0.86)",
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.14)",
  },
  captureHintText: {
    color: "#fff",
    fontSize: 12,
    fontWeight: "500",
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
  captureButtonProcessing: {
    opacity: 0.5,
  },
  captureRing: {
    width: 58,
    height: 58,
    borderRadius: 29,
    borderWidth: 4,
    borderColor: colors.camera.text,
  },
  captureRingProcessing: {
    borderColor: colors.primary,
  },
  utilityButton: {
    alignItems: "center",
    justifyContent: "center",
    width: 56,
    gap: 4,
  },
  utilityButtonWide: {
    width: 84,
  },
  utilityButtonText: {
    color: "rgba(255,255,255,0.6)",
    fontSize: 11,
    fontWeight: "500",
    letterSpacing: 0.2,
  },
  noteModalOverlay: {
    flex: 1,
    justifyContent: "flex-end",
    backgroundColor: "rgba(0,0,0,0.6)",
  },
  noteModalContent: {
    backgroundColor: colors.card,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: 24,
    paddingBottom: 40,
  },
  notesLogModalContent: {
    marginHorizontal: 20,
    marginTop: "30%",
    backgroundColor: colors.card,
    borderRadius: 16,
    padding: 20,
    borderWidth: 1,
    borderColor: colors.stone,
    maxHeight: "55%",
  },
  notesLogList: {
    marginTop: 4,
    marginBottom: 14,
    gap: 8,
  },
  notesLogEmptyText: {
    color: colors.muted,
    fontSize: 14,
    fontWeight: "500",
  },
  noteListItem: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
    backgroundColor: colors.secondary,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.stone,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  noteListText: {
    flex: 1,
    color: colors.foreground,
    fontSize: 14,
    fontWeight: "500",
  },
  noteDeleteButton: {
    backgroundColor: "rgba(239,68,68,0.1)",
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "rgba(239,68,68,0.25)",
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  noteDeleteButtonText: {
    color: colors.error,
    fontSize: 12,
    fontWeight: "600",
  },
  noteModalTitle: {
    color: colors.heading,
    fontSize: 20,
    fontWeight: "600",
    marginBottom: 4,
  },
  noteModalSubtitle: {
    color: colors.muted,
    fontSize: 14,
    marginBottom: 16,
  },
  noteInput: {
    backgroundColor: colors.secondary,
    borderRadius: 12,
    padding: 16,
    color: colors.foreground,
    fontSize: 16,
    minHeight: 80,
    textAlignVertical: "top",
    borderWidth: 1,
    borderColor: colors.stone,
  },
  noteModalButtons: {
    flexDirection: "row",
    gap: 12,
    marginTop: 16,
  },
  noteModalCancel: {
    flex: 1,
    backgroundColor: colors.secondary,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: "center",
  },
  noteModalCancelText: {
    color: colors.heading,
    fontSize: 16,
    fontWeight: "600",
  },
  noteModalSubmit: {
    flex: 1,
    backgroundColor: colors.primary,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: "center",
  },
  noteModalSubmitDisabled: {
    opacity: 0.4,
  },
  noteModalSubmitText: {
    color: colors.primaryForeground,
    fontSize: 16,
    fontWeight: "600",
  },
  permissionContainer: {
    flex: 1,
    backgroundColor: colors.background,
    justifyContent: "center",
    alignItems: "center",
    padding: 32,
  },
  permissionText: {
    color: "#fff",
    fontSize: 18,
    textAlign: "center",
    marginBottom: 20,
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

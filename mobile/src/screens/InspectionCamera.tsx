import React, { useState, useCallback, useRef, useEffect } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Alert,
  BackHandler,
  Modal,
  Switch,
  TextInput,
  KeyboardAvoidingView,
  Platform,
  Linking,
  Animated,
  AppState,
  type AppStateStatus,
} from "react-native";
import { Image } from "expo-image";
import { SafeAreaView } from "react-native-safe-area-context";
import { CameraView, useCameraPermissions } from "expo-camera";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { runOnJS } from "react-native-reanimated";
import * as Haptics from "expo-haptics";
import { useNavigation, useRoute } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import type { RouteProp } from "@react-navigation/native";
import type { RootStackParamList, SummaryData, SummaryRoomData, SummaryFindingData } from "../navigation";
import FindingsPanel, { type DismissReason } from "../components/FindingsPanel";
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
import { RoomDetector, type BaselineCandidate } from "../lib/vision/room-detector";
import { loadOnnxModel, type OnnxModelLoader } from "../lib/vision/onnx-model";
import {
  getInspectionBaselines,
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
    previewUrl?: string;
    label: string | null;
    embedding: number[] | null;
    metadata?: {
      imageType?: "overview" | "detail" | "required_detail" | "standard";
      parentBaselineId?: string | null;
      detailSubject?: string | null;
    } | null;
  }>;
}

const CHANGE_FRAME_WIDTH = 320;
const CHANGE_FRAME_HEIGHT = 240;
const LOCALIZATION_NOT_READY_THRESHOLD = 0.40;
const LOCALIZATION_LOCKED_THRESHOLD = 0.50;
const LOCALIZATION_AUTO_CAPTURE_THRESHOLD = 0.55;
const LOCALIZATION_AMBIGUITY_GAP = 0.04;
const LOCALIZATION_OVERLAY_GRACE_MS = 1400;
const LOCALIZATION_ROOM_SYNC_THRESHOLD = 0.68;
/** On-device coverage credit: grant when embedding similarity exceeds this.
 *  No server round-trip needed — ONNX embedding match is sufficient for coverage.
 *  0.60 is conservative enough to avoid false matches but reachable during walking. */
const ON_DEVICE_COVERAGE_THRESHOLD = 0.60;
const AUTO_CAPTURE_INTERVAL_MS = 500;

type LocalizationState =
  | "not_localized"        // No candidate above NOT_READY threshold (0.40)
  | "localizing"           // Candidate found, smoothing (< 3 frames)
  | "ambiguous"            // Top-2 candidates within AMBIGUITY_GAP (0.04) of each other
  | "localized"            // Locked, similarity ≥ LOCKED threshold (0.50)
  | "capturing"            // Comparison in flight
  | "verification_failed"; // Server could not geometrically verify this view

function getSimilarityColor(similarity: number): string {
  if (similarity >= 0.55) return "#22c55e"; // green
  if (similarity >= 0.45) return "#eab308"; // yellow
  return "#ef4444"; // red
}

function getLocalizationGuidance(state: LocalizationState, stuckSince: number | null): string | null {
  const stuckMs = stuckSince ? Date.now() - stuckSince : 0;
  switch (state) {
    case "not_localized":
      return stuckMs > 10000
        ? "Try pointing at a distinctive area you trained"
        : "Point camera at a trained area";
    case "localizing": return "Keep the camera on this area";
    case "ambiguous":
      return stuckMs > 8000
        ? "Tap a view below to capture it directly"
        : "Move closer to distinguish views";
    case "localized": return null;
    case "capturing": return "Analyzing...";
    case "verification_failed": return "Try a slightly different angle";
  }
}

function cosineSimilarity(
  a: ArrayLike<number>,
  b: ArrayLike<number>,
): number {
  if (a.length !== b.length || a.length === 0) return Number.NEGATIVE_INFINITY;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? Number.NEGATIVE_INFINITY : dot / denom;
}

type CapturedFrameData = {
  dataUri: string;
  uri: string;
};

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
  const [autoDetectUnavailableReason, setAutoDetectUnavailableReason] = useState<string | null>(null);
  const [autoCaptureEnabled, setAutoCaptureEnabled] = useState(true);
  const [showNoteModal, setShowNoteModal] = useState(false);
  const [showNotesLogModal, setShowNotesLogModal] = useState(false);
  const [showSettingsModal, setShowSettingsModal] = useState(false);
  const [noteText, setNoteText] = useState("");
  const [captureHint, setCaptureHint] = useState<string | null>(null);
  const [localizationState, setLocalizationState] = useState<LocalizationState>("not_localized");
  const [lockedBaselineInfo, setLockedBaselineInfo] = useState<{
    baselineId: string;
    imageUrl: string;
    label: string | null;
    similarity: number;
    isLocked: boolean;
    topCandidates: BaselineCandidate[];
  } | null>(null);
  const [localizationStuckSince, setLocalizationStuckSince] = useState<number | null>(null);
  const [userSelectedBaselineId, setUserSelectedBaselineId] = useState<string | null>(null);
  const [showTargetAssist, setShowTargetAssist] = useState(false);
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
  const targetAssistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoCaptureEnabledRef = useRef(autoCaptureEnabled);
  const autoAllRoomsCompleteHintRef = useRef(false);
  const borderPulseAnim = useRef(new Animated.Value(1)).current;

  // Pulse the border opacity when localized (green)
  useEffect(() => {
    if (lockedBaselineInfo?.isLocked && lockedBaselineInfo.similarity >= 0.55) {
      const pulse = Animated.loop(
        Animated.sequence([
          Animated.timing(borderPulseAnim, {
            toValue: 0.5,
            duration: 900,
            useNativeDriver: true,
          }),
          Animated.timing(borderPulseAnim, {
            toValue: 1,
            duration: 900,
            useNativeDriver: true,
          }),
        ]),
      );
      pulse.start();
      return () => pulse.stop();
    } else {
      borderPulseAnim.setValue(1);
    }
  }, [lockedBaselineInfo?.isLocked, lockedBaselineInfo?.similarity]);

  const isSubmittingRef = useRef(false);
  const baselinesRef = useRef<RoomBaseline[]>([]);
  const knownConditionsByRoomRef = useRef<Map<string, string[]>>(new Map());
  const globalKnownConditionsRef = useRef<string[]>([]);
  const announcerRef = useRef(new InspectionAnnouncer());
  const pausedRef = useRef(paused);
  const isMountedRef = useRef(true);
  const isProcessingRef = useRef(isProcessing);
  const overlayGraceUntilRef = useRef(0);
  const autoCapturTickRef = useRef<((s: SessionManager, c: ComparisonManager) => Promise<void>) | undefined>(undefined);
  const autoCaptureStartTimeRef = useRef<number>(Date.now());
  const hasFirstAutoCaptureRef = useRef(false);
  const userSelectedBaselineIdRef = useRef<string | null>(null);
  const isCapturingRef = useRef(false);
  /** Tracks consecutive localization failures per room+baseline to avoid cross-room false advancement */
  const locFailuresByBaselineRef = useRef<Map<string, number>>(new Map());
  /** Tracks in-flight AI analyses (after verified event, before result) */
  const pendingAnalysesRef = useRef<Map<string, { roomId: string; baselineId: string; startedAt: number }>>(new Map());
  /** Tracks comparisonIds that already received early coverage credit via verified event */
  const verifiedComparisonIdsRef = useRef<Set<string>>(new Set());
  /** Tracks baselines that already received on-device coverage credit (embedding-only, no server) */
  const onDeviceCreditedRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    autoCaptureEnabledRef.current = autoCaptureEnabled;
  }, [autoCaptureEnabled]);

  useEffect(() => {
    userSelectedBaselineIdRef.current = userSelectedBaselineId;
  }, [userSelectedBaselineId]);

  useEffect(() => {
    pausedRef.current = paused;
  }, [paused]);

  useEffect(() => {
    isProcessingRef.current = isProcessing;
  }, [isProcessing]);

  useEffect(() => {
    if (targetAssistTimerRef.current) {
      clearTimeout(targetAssistTimerRef.current);
      targetAssistTimerRef.current = null;
    }

    const shouldOfferTargetAssist =
      !paused &&
      !!lockedBaselineInfo &&
      lockedBaselineInfo.topCandidates.length > 0 &&
      localizationState !== "localized" &&
      localizationState !== "capturing";

    if (!shouldOfferTargetAssist) {
      setShowTargetAssist(false);
      return;
    }

    targetAssistTimerRef.current = setTimeout(() => {
      setShowTargetAssist(true);
    }, 5_000);

    return () => {
      if (targetAssistTimerRef.current) {
        clearTimeout(targetAssistTimerRef.current);
        targetAssistTimerRef.current = null;
      }
    };
  }, [lockedBaselineInfo, localizationState, paused]);

  useEffect(() => {
    if (localizationState === "localized" || localizationState === "capturing") {
      setUserSelectedBaselineId(null);
      setShowTargetAssist(false);
    }
  }, [localizationState]);

  const showCaptureHint = useCallback((message: string) => {
    setCaptureHint(message);
    if (captureHintTimerRef.current) {
      clearTimeout(captureHintTimerRef.current);
    }
    captureHintTimerRef.current = setTimeout(() => {
      setCaptureHint(null);
      captureHintTimerRef.current = null;
    }, 4500);
  }, []);

  const getBaselineById = useCallback((baselineId: string) => {
    return baselinesRef.current
      .flatMap((room) =>
        room.baselines.map((baseline) => ({
          ...baseline,
          roomId: room.roomId,
          roomName: room.roomName,
        })),
      )
      .find((baseline) => baseline.id === baselineId) || null;
  }, []);

  const captureHighResFrame = useCallback(async (): Promise<CapturedFrameData | null> => {
    if (!cameraRef.current || isCapturingRef.current) return null;
    isCapturingRef.current = true;
    try {
      const photo = await cameraRef.current.takePictureAsync({
        quality: 0.7,
        base64: true,
      });
      if (!photo?.base64 || !photo.uri) {
        return null;
      }
      return {
        dataUri: `data:image/jpeg;base64,${photo.base64}`,
        uri: photo.uri,
      };
    } catch {
      return null;
    } finally {
      isCapturingRef.current = false;
    }
  }, []);

  const rankCandidatesForCapturedFrame = useCallback(
    async (
      imageUri: string,
      currentRoomId: string,
      fallbackTopCandidates: BaselineCandidate[],
    ): Promise<BaselineCandidate[]> => {
      const loader = modelLoaderRef.current;
      const allBaselines = baselinesRef.current.flatMap((room) =>
        room.baselines.map((baseline) => ({
          ...baseline,
          roomId: room.roomId,
        })),
      );

      if (!loader?.isLoaded) {
        return fallbackTopCandidates;
      }

      const embedding = await loader.generateEmbedding(imageUri);
      if (!embedding) {
        return fallbackTopCandidates;
      }

      const currentRoomBaselines = allBaselines.filter(
        (baseline) => baseline.roomId === currentRoomId,
      );
      const searchSpace =
        currentRoomBaselines.length > 0 && (lockedBaselineInfo?.similarity ?? 0) >= LOCALIZATION_ROOM_SYNC_THRESHOLD
          ? currentRoomBaselines
          : allBaselines;

      const ranked = searchSpace
        .filter(
          (baseline) =>
            Array.isArray(baseline.embedding) &&
            baseline.embedding.length === embedding.length,
        )
        .map((baseline) => ({
          baselineId: baseline.id,
          similarity: cosineSimilarity(embedding, baseline.embedding as number[]),
        }))
        .sort((a, b) => b.similarity - a.similarity);

      if (ranked.length === 0) {
        return fallbackTopCandidates;
      }

      if (userSelectedBaselineId) {
        const selectedIdx = ranked.findIndex(
          (candidate) => candidate.baselineId === userSelectedBaselineId,
        );
        if (selectedIdx > 0) {
          const [selected] = ranked.splice(selectedIdx, 1);
          ranked.unshift(selected);
        }
      }

      return ranked.slice(0, 3);
    },
    [lockedBaselineInfo?.similarity, userSelectedBaselineId],
  );

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

    // Register verified callback — grants coverage credit early (~1-2s)
    comparison.onVerified((event, context) => {
      if (!isMountedRef.current) return;

      // Sweep stale pending entries (>90s) on every verified event
      const now = Date.now();
      for (const [id, entry] of pendingAnalysesRef.current) {
        if (now - entry.startedAt > 90_000) {
          pendingAnalysesRef.current.delete(id);
          verifiedComparisonIdsRef.current.delete(id);
        }
      }

      const { roomId, roomName, baselineImageId } = context;
      const resolvedBaseline = event.verifiedBaselineId
        ? getBaselineById(event.verifiedBaselineId)
        : baselineImageId
          ? getBaselineById(baselineImageId)
          : null;
      const resolvedRoomId = resolvedBaseline?.roomId || roomId;
      const resolvedBaselineId = event.verifiedBaselineId || baselineImageId;

      // Mark this comparison as already credited
      if (event.comparisonId) {
        verifiedComparisonIdsRef.current.add(event.comparisonId);
      }

      // Track pending AI analysis
      if (event.comparisonId && resolvedBaselineId) {
        pendingAnalysesRef.current.set(event.comparisonId, {
          roomId: resolvedRoomId,
          baselineId: resolvedBaselineId,
          startedAt: Date.now(),
        });
      }

      // Clear localization failure streak on any verified result
      locFailuresByBaselineRef.current.clear();

      setLocalizationState("localized");
      setShowTargetAssist(false);
      setUserSelectedBaselineId(null);

      // Room sync
      if (resolvedBaseline && session.getState().currentRoomId !== resolvedBaseline.roomId) {
        activateRoom(session, resolvedBaseline.roomId, resolvedBaseline.roomName);
      }

      // Grant coverage credit (directional hierarchy rules apply)
      if (resolvedBaselineId) {
        if (event.verificationMode === "user_confirmed_bypass") {
          // Lower confidence — only credit the single baseline, no cluster/hierarchy expansion
          session.recordAngleScan(resolvedRoomId, resolvedBaselineId);
          roomDetectorRef.current?.markAngleScanned(resolvedBaselineId, resolvedRoomId);
        } else {
          // Geometric verified — full cluster + hierarchy credit
          const clusterIds = roomDetectorRef.current?.getClusterMembers(resolvedBaselineId) || [resolvedBaselineId];
          const hierarchyIds: string[] = [];
          const hierarchy = roomDetectorRef.current?.getHierarchy(resolvedBaselineId);
          if (hierarchy) {
            if (hierarchy.parentId) hierarchyIds.push(hierarchy.parentId);
            if (hierarchy.childIds.length > 0) hierarchyIds.push(...hierarchy.childIds);
            // required_detail children are NOT auto-credited (they stay in requiredChildIds)
          }
          const allCreditIds = new Set([...clusterIds, ...hierarchyIds]);
          for (const cid of allCreditIds) {
            session.recordAngleScan(resolvedRoomId, cid);
            roomDetectorRef.current?.markAngleScanned(cid, resolvedRoomId);
          }
        }
        updateCoverageUI(session, resolvedRoomId);
      }

      showCaptureHint("✓ Captured (analyzing...)");
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    });

    // Register finding callback
    comparison.onResult((result, context) => {
      if (!isMountedRef.current) return; // Skip state updates after unmount
      const { roomId, roomName, baselineImageId, triggerSource } = context;
      const resolvedBaseline = result.verifiedBaselineId
        ? getBaselineById(result.verifiedBaselineId)
        : baselineImageId
          ? getBaselineById(baselineImageId)
          : null;
      const resolvedRoomId = resolvedBaseline?.roomId || roomId;
      const resolvedRoomName = resolvedBaseline?.roomName || roomName;
      const resolvedBaselineId = result.verifiedBaselineId || baselineImageId;

      session.recordEvent("comparison_completed", resolvedRoomId, {
        baselineImageId: resolvedBaselineId,
        triggerSource,
        status: result.status,
        summary: result.summary,
        findingsCount: result.findings?.length || 0,
        readinessScore: result.readiness_score,
        skippedByPreflight: result.diagnostics?.skippedByPreflight || false,
        preflightReason: result.diagnostics?.preflight?.reason,
        alignmentScore: result.diagnostics?.preflight?.alignment?.score,
      });

      // Clean up pending analysis tracking for ALL result paths (including early returns).
      // Must happen before any early-return to prevent leaking entries.
      const comparisonId = result.comparisonId;
      const alreadyCredited = comparisonId ? verifiedComparisonIdsRef.current.has(comparisonId) : false;
      if (comparisonId) {
        pendingAnalysesRef.current.delete(comparisonId);
        verifiedComparisonIdsRef.current.delete(comparisonId);
      }

      if (result.status === "localization_failed") {
        // Track consecutive failures per room+baseline — reset all OTHER keys
        // so only truly consecutive same-baseline failures accumulate
        const failKey = `${resolvedRoomId}:${resolvedBaselineId || "unknown"}`;
        const prevCount = locFailuresByBaselineRef.current.get(failKey) || 0;
        const newCount = prevCount + 1;
        // Clear every key except the current one to enforce consecutiveness
        locFailuresByBaselineRef.current.clear();
        locFailuresByBaselineRef.current.set(failKey, newCount);

        session.recordEvent("capture_rejected_alignment", resolvedRoomId, {
          baselineImageId: resolvedBaselineId,
          triggerSource,
          summary: result.summary,
          consecutiveFailures: newCount,
        });

        // After 3 consecutive failures for the SAME room+baseline,
        // grant provisional progress so users aren't stuck at 0% forever.
        if (newCount >= 3 && resolvedBaselineId) {
          locFailuresByBaselineRef.current.delete(failKey);
          // Provisional progress: only credit the single failed baseline, not cluster/children.
          // Cluster + hierarchy credit requires actual server-verified evidence.
          session.recordAngleScan(resolvedRoomId, resolvedBaselineId);
          roomDetectorRef.current?.markAngleScanned(resolvedBaselineId, resolvedRoomId);
          updateCoverageUI(session, resolvedRoomId);
          setLocalizationState("localized");
          setShowTargetAssist(false);
          showCaptureHint("View captured (verification skipped)");
          autoAdvanceIfRoomComplete(session, resolvedRoomId);
          return;
        }

        setLocalizationState("verification_failed");
        setShowTargetAssist(true);
        showCaptureHint(result.userGuidance || "Try a slightly different angle");
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
        return;
      }

      // Any non-localization failure result breaks the "consecutive same-baseline
      // failures" streak, including comparison_unavailable and successful captures.
      locFailuresByBaselineRef.current.clear();

      if (result.status === "comparison_unavailable") {
        setLocalizationState("localized");
        setShowTargetAssist(false);
        showCaptureHint(result.userGuidance || "That angle could not be analyzed. Try again.");
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
        return;
      }

      setLocalizationState("localized");
      setShowTargetAssist(false);
      setUserSelectedBaselineId(null);

      if (resolvedBaseline && session.getState().currentRoomId !== resolvedBaseline.roomId) {
        activateRoom(session, resolvedBaseline.roomId, resolvedBaseline.roomName);
      }

      // Grant coverage credit ONLY if not already granted by verified event
      if (resolvedBaselineId && !alreadyCredited) {
        // 1. Cluster credit (visually similar angles)
        const clusterIds = roomDetectorRef.current?.getClusterMembers(resolvedBaselineId) || [resolvedBaselineId];

        // 2. Hierarchy credit (directional):
        //    - Overview matched → credit detail children (wide shot proves items exist)
        //      but NOT required_detail children (those need independent capture)
        //    - Detail/required_detail matched → credit parent overview (you're in that area)
        //    - No sibling credit in either direction
        const hierarchyIds: string[] = [];
        const hierarchy = roomDetectorRef.current?.getHierarchy(resolvedBaselineId);
        if (hierarchy) {
          if (hierarchy.parentId) {
            hierarchyIds.push(hierarchy.parentId);
          }
          if (hierarchy.childIds.length > 0) {
            hierarchyIds.push(...hierarchy.childIds);
          }
        }

        // 3. Union all (Set-based, no double-counting)
        const allCreditIds = new Set([...clusterIds, ...hierarchyIds]);
        for (const cid of allCreditIds) {
          session.recordAngleScan(resolvedRoomId, cid);
          roomDetectorRef.current?.markAngleScanned(cid, resolvedRoomId);
        }
        updateCoverageUI(session, resolvedRoomId);
      }

      if ((result.findings?.length || 0) === 0 && resolvedBaselineId) {
        autoAdvanceIfRoomComplete(session, resolvedRoomId);
      }

      if (result.findings?.length > 0) {
        for (const f of result.findings) {
          const findingId = session.addFinding(resolvedRoomId, f);
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
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
        }
        if (activeImageSource !== "camera") {
          const firstFinding = result.findings[0];
          if (firstFinding) {
            void announcerRef.current.announceFinding(
              resolvedRoomName || "current room",
              firstFinding.description,
            );
          }
        }
      } else if (
        result.status === "localized_no_change" ||
        result.status === "localized_changed"
      ) {
        showCaptureHint(
          triggerSource === "auto"
            ? "Saved view captured automatically"
            : "Saved view captured",
        );
      }

      if (result.readiness_score != null) {
        session.updateRoomScore(resolvedRoomId, result.readiness_score);
      }
    });

    let activeProcessingCount = 0;
    let processingTimeoutId: ReturnType<typeof setTimeout> | null = null;
    comparison.onStatusChange((status) => {
      if (!isMountedRef.current) return;

      // Ref-counted processing: supports maxConcurrent > 1
      if (status === "processing") {
        activeProcessingCount++;
      } else {
        activeProcessingCount = Math.max(0, activeProcessingCount - 1);
      }
      setIsProcessing(activeProcessingCount > 0);

      // Safety timeout: only fires when ALL comparisons appear stuck
      if (processingTimeoutId) {
        clearTimeout(processingTimeoutId);
        processingTimeoutId = null;
      }
      if (activeProcessingCount > 0) {
        processingTimeoutId = setTimeout(() => {
          if (isMountedRef.current && activeProcessingCount > 0) {
            activeProcessingCount = 0;
            setIsProcessing(false);
            comparison.forceResetStuckComparison();
            console.warn("[InspectionCamera] isProcessing safety timeout fired after 10s");
          }
        }, 10_000);
      }
      if (status === "error") {
        showCaptureHint("That angle could not be analyzed. Try again.");
        // Clean up any stale pending entries since error events don't carry comparisonId
        const now = Date.now();
        for (const [id, entry] of pendingAnalysesRef.current) {
          if (now - entry.startedAt > 10_000) {
            pendingAnalysesRef.current.delete(id);
            verifiedComparisonIdsRef.current.delete(id);
          }
        }
      }
    });

    // Load baselines (also populates known conditions from the same response)
    loadBaselines(session);

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
          setAutoDetectUnavailableReason(null);
          roomDetector.setModelLoader(loader);
          setIsAutoDetect(true);
          startRoomDetectionLoop(roomDetector, session);
        } else if (loader.unavailableReason) {
          setAutoDetectUnavailableReason(loader.unavailableReason);
          setCaptureHint(loader.unavailableReason);
          Alert.alert("Use The Atria Dev Build", loader.unavailableReason);
        }
      })
      .catch((err) => {
        console.warn("ONNX model load failed, room auto-detect disabled:", err);
        const fallbackMessage =
          "AI inspection requires the Atria dev build. Open the latest dev build instead of Expo Go.";
        setAutoDetectUnavailableReason(fallbackMessage);
        setCaptureHint(fallbackMessage);
        Alert.alert("Use The Atria Dev Build", fallbackMessage);
      });

    // Start auto-capture loop (every 3s, checks if conditions are met)
    autoCaptureTimerRef.current = setInterval(() => {
      if (!autoCaptureEnabledRef.current) return;
      if (session.isPaused()) return;
      if (comparison.isPaused()) return;

      const state = session.getState();
      if (!state.currentRoomId) return;

      void autoCapturTickRef.current?.(session, comparison);
    }, AUTO_CAPTURE_INTERVAL_MS);

    return () => {
      isMountedRef.current = false;
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
      if (targetAssistTimerRef.current) {
        clearTimeout(targetAssistTimerRef.current);
      }
      if (processingTimeoutId) {
        clearTimeout(processingTimeoutId);
      }
      announcerRef.current.setEnabled(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Pause sensors, camera, and timers when app goes to background
  useEffect(() => {
    const appStateRef = { wasBackground: false };

    const handleAppStateChange = (nextAppState: AppStateStatus) => {
      if (nextAppState === "background" || nextAppState === "inactive") {
        appStateRef.wasBackground = true;
        motionFilterRef.current?.stop();
        if (autoCaptureTimerRef.current) {
          clearInterval(autoCaptureTimerRef.current);
          autoCaptureTimerRef.current = null;
        }
        if (roomDetectionTimerRef.current) {
          clearTimeout(roomDetectionTimerRef.current);
          roomDetectionTimerRef.current = null;
        }
      } else if (nextAppState === "active" && appStateRef.wasBackground) {
        appStateRef.wasBackground = false;
        if (!pausedRef.current) {
          motionFilterRef.current?.start();

          // Restart auto-capture interval if it was running before backgrounding
          if (autoCaptureEnabledRef.current && !autoCaptureTimerRef.current) {
            const s = sessionRef.current;
            const c = comparisonRef.current;
            if (s && c) {
              autoCaptureTimerRef.current = setInterval(() => {
                void autoCapturTickRef.current?.(s, c);
              }, AUTO_CAPTURE_INTERVAL_MS);
            }
          }

          // Restart room detection loop if detector exists and loop is dead
          const detector = roomDetectorRef.current;
          const session = sessionRef.current;
          if (detector && session && !roomDetectionTimerRef.current) {
            startRoomDetectionLoop(detector, session);
          }
        }
      }
    };

    const subscription = AppState.addEventListener("change", handleAppStateChange);
    return () => subscription.remove();
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

  const activateRoom = useCallback(
    (session: SessionManager, roomId: string, roomName: string) => {
      changeDetectorRef.current?.reset();
      comparisonRef.current?.resetBackoff();
      session.enterRoom(roomId, roomName);
      setCurrentRoom(roomName);
      updateCoverageUI(session, roomId);
    },
    [updateCoverageUI],
  );

  const syncRoomFromLockedBaseline = useCallback(
    (
      session: SessionManager,
      locked: {
        baseline: { roomId: string; roomName: string };
        similarity: number;
        isLocked: boolean;
      } | null,
    ) => {
      if (!locked?.isLocked || locked.similarity < LOCALIZATION_ROOM_SYNC_THRESHOLD) {
        return;
      }

      const activeRoomId = session.getState().currentRoomId;
      if (activeRoomId === locked.baseline.roomId) {
        return;
      }

      activateRoom(session, locked.baseline.roomId, locked.baseline.roomName);
    },
    [activateRoom],
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

      activateRoom(session, nextRoom.roomId, nextRoom.roomName);
      autoAllRoomsCompleteHintRef.current = false;
      showCaptureHint(`Room complete. Auto-switched to ${nextRoom.roomName}.`);
      if (activeImageSource !== "camera") {
        void announcerRef.current.announceCoverage(nextRoom.roomName);
      }
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    },
    [activateRoom, activeImageSource, getNextIncompleteRoom, showCaptureHint],
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
            previewUrl?: string | null;
            label: string | null;
            embedding: number[] | null;
            metadata?: {
              imageType?: "overview" | "detail" | "required_detail" | "standard";
              parentBaselineId?: string | null;
              detailSubject?: string | null;
            } | null;
          }>;
        }

        const mappedRooms: RoomBaseline[] = ((data.rooms || []) as ApiRoom[]).map(
          (room) => ({
            roomId: room.id,
            roomName: room.name,
            baselines: (room.baselineImages || []).map((bl) => ({
              id: bl.id,
              imageUrl: bl.imageUrl,
              previewUrl: bl.previewUrl || undefined,
              label: bl.label || null,
              embedding: bl.embedding || null,
              metadata: bl.metadata || null,
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
              previewUrl: b.previewUrl,
              embedding: b.embedding,
              metadata: b.metadata,
            })),
          );
          detector.loadBaselines(detectorBaselines);
        }

        const roomAnglesMap = new Map<string, number>();
        for (const room of mappedRooms) {
          roomAnglesMap.set(room.roomId, room.baselines?.length || 0);
        }
        session.setRoomAngles(roomAnglesMap);

        // Parse known conditions from the same baselines response (avoids extra API call)
        interface ApiCondition {
          description?: string | null;
          roomId?: string | null;
        }
        const conditions = (data.knownConditions || []) as ApiCondition[];
        const byRoom = new Map<string, string[]>();
        const globalConds: string[] = [];
        for (const c of conditions) {
          const desc = c.description?.trim();
          if (!desc) continue;
          if (c.roomId) {
            const list = byRoom.get(c.roomId) || [];
            list.push(desc);
            byRoom.set(c.roomId, list);
          } else {
            globalConds.push(desc);
          }
        }
        knownConditionsByRoomRef.current = byRoom;
        globalKnownConditionsRef.current = globalConds;

        if (mappedRooms.length > 0) {
          const firstRoom = mappedRooms[0];
          activateRoom(session, firstRoom.roomId, firstRoom.roomName);
        }
      } catch (err) {
        console.error("Failed to load baselines:", err);
        Alert.alert(
          "Failed to load baselines",
          "Could not load inspection data. Check your connection and try again.",
          [
            { text: "Retry", onPress: () => { if (sessionRef.current) void loadBaselines(sessionRef.current); } },
            {
              text: "Go Back",
              style: "destructive",
              onPress: () => navigation.goBack(),
            },
          ],
        );
      }
    },
    [activateRoom, inspectionId, navigation],
  );

  /**
   * Room detection loop — processes camera frames at ~3fps for auto room detection.
   * Adaptively slows to 1fps when highly confident for >30s.
   * Only runs when ONNX model is loaded.
   */
  const startRoomDetectionLoop = useCallback(
    (detector: RoomDetector, session: SessionManager) => {
      const tick = async () => {
        if (session.isPaused() || !cameraRef.current) {
          // Don't reschedule while paused — handlePause/AppState resume will restart the loop
          roomDetectionTimerRef.current = null;
          return;
        }

        if (!isMountedRef.current) {
          roomDetectionTimerRef.current = null;
          return;
        }

        if (isProcessingRef.current) {
          roomDetectionTimerRef.current = setTimeout(tick, detector.getRecommendedInterval());
          return;
        }

        try {
          // Capture a low-res frame for room detection
          if (isCapturingRef.current) {
            roomDetectionTimerRef.current = setTimeout(tick, detector.getRecommendedInterval());
            return;
          }
          isCapturingRef.current = true;
          let photo: { uri?: string } | null = null;
          try {
            photo = await cameraRef.current.takePictureAsync({
              quality: 0.3,
              base64: false, // Just need the URI
            });
          } finally {
            isCapturingRef.current = false;
          }

          if (photo?.uri) {
            const result = await detector.processFrameFromUri(photo.uri);

            // Clean up the temp photo file to avoid storage leak on long sessions
            FileSystem.deleteAsync(photo.uri, { idempotent: true }).catch(() => {});

            if (result?.roomChanged && result.room) {
              // Auto-switch room in session
              activateRoom(session, result.room.roomId, result.room.roomName);
              void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            }

            // Update baseline localization state from detector
            const locked = detector.getLockedBaseline();
            const topK = detector.getTopCandidates(3);

            if (locked) {
              overlayGraceUntilRef.current = Date.now() + LOCALIZATION_OVERLAY_GRACE_MS;
              setLockedBaselineInfo({
                baselineId: locked.baseline.id,
                imageUrl: locked.baseline.previewUrl || locked.baseline.imageUrl,
                label: locked.baseline.label,
                similarity: locked.similarity,
                isLocked: locked.isLocked,
                topCandidates: topK,
              });

              syncRoomFromLockedBaseline(session, locked);

              // Determine localization state
              const gap = topK.length >= 2
                ? topK[0].similarity - topK[1].similarity
                : 1;

              if (locked.similarity < LOCALIZATION_NOT_READY_THRESHOLD) {
                setLocalizationState(
                  Date.now() < overlayGraceUntilRef.current
                    ? "localizing"
                    : "not_localized",
                );
                setLocalizationStuckSince((prev) => prev ?? Date.now());
              } else if (!locked.isLocked) {
                setLocalizationState("localizing");
                setLocalizationStuckSince((prev) => prev ?? Date.now());
              } else if (gap < LOCALIZATION_AMBIGUITY_GAP && baselinesRef.current.length > 1) {
                // Only show ambiguous state for multi-room properties;
                // single-room properties should just use the best candidate
                setLocalizationState("ambiguous");
                setLocalizationStuckSince((prev) => prev ?? Date.now());
              } else if (locked.similarity >= LOCALIZATION_LOCKED_THRESHOLD) {
                setLocalizationState("localized");
                setLocalizationStuckSince(null);

                // On-device coverage credit: when embedding similarity is high enough,
                // grant coverage immediately without waiting for server round-trip.
                // This enables walking-pace inspection — ONNX match IS the verification.
                if (
                  locked.similarity >= ON_DEVICE_COVERAGE_THRESHOLD &&
                  locked.isLocked &&
                  !onDeviceCreditedRef.current.has(locked.baseline.id)
                ) {
                  const baselineId = locked.baseline.id;
                  const bRoomId = locked.baseline.roomId;
                  onDeviceCreditedRef.current.add(baselineId);

                  // Full cluster + hierarchy credit (same rules as verified event)
                  const clusterIds = detector.getClusterMembers(baselineId) || [baselineId];
                  const hierarchyIds: string[] = [];
                  const hierarchy = detector.getHierarchy(baselineId);
                  if (hierarchy) {
                    if (hierarchy.parentId) hierarchyIds.push(hierarchy.parentId);
                    if (hierarchy.childIds.length > 0) hierarchyIds.push(...hierarchy.childIds);
                    // required_detail children are NOT auto-credited
                  }
                  const allCreditIds = new Set([...clusterIds, ...hierarchyIds]);
                  for (const cid of allCreditIds) {
                    session.recordAngleScan(bRoomId, cid);
                    detector.markAngleScanned(cid, bRoomId);
                    onDeviceCreditedRef.current.add(cid); // prevent re-credit
                  }
                  updateCoverageUI(session, bRoomId);
                  showCaptureHint("View captured");
                  void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
                  autoAdvanceIfRoomComplete(session, bRoomId);
                }
              } else {
                setLocalizationState("localizing");
                setLocalizationStuckSince((prev) => prev ?? Date.now());
              }
            } else {
              const withinOverlayGrace = Date.now() < overlayGraceUntilRef.current;
              if (!withinOverlayGrace) {
                setLockedBaselineInfo(null);
                setLocalizationState("not_localized");
                setLocalizationStuckSince((prev) => prev ?? Date.now());
              } else {
                setLocalizationState("localizing");
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
    [activateRoom, syncRoomFromLockedBaseline, updateCoverageUI, showCaptureHint, autoAdvanceIfRoomComplete],
  );

  const captureChangeFrame = useCallback(async (): Promise<Uint8Array | null> => {
    if (!cameraRef.current || isCapturingRef.current) return null;

    let rawPhotoUri: string | null = null;
    let resizedUri: string | null = null;

    try {
      isCapturingRef.current = true;
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
      isCapturingRef.current = false;
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
      if (!isMountedRef.current || !cameraRef.current || pausedRef.current) return;

      const state = session.getState();
      const currentRoomId = state.currentRoomId;
      if (!currentRoomId) return;

      const room = baselinesRef.current.find(
        (r) => r.roomId === currentRoomId,
      );
      if (!room?.baselines?.length) return;

      // Use locked baseline from detector if available, but fall back to best
      // candidate when localization hasn't achieved a strong lock yet.
      // Localization is a QUALITY signal (pick the best baseline), not a GATE.
      const detector = roomDetectorRef.current;
      const locked = detector?.getLockedBaseline();
      const topK = detector?.getTopCandidates(3) || [];

      const isStrongLock = locked?.isLocked && locked.similarity >= LOCALIZATION_AUTO_CAPTURE_THRESHOLD;

      // When strongly locked, still skip if ambiguous (top-2 too close)
      // UNLESS: user has explicitly selected a baseline, or the property only has 1 room
      const isSingleRoom = baselinesRef.current.length <= 1;
      const userHasSelected = !!userSelectedBaselineIdRef.current;
      if (isStrongLock && topK.length >= 2 && !userHasSelected && !isSingleRoom) {
        const gap = topK[0].similarity - topK[1].similarity;
        if (gap < LOCALIZATION_AMBIGUITY_GAP) return;
      }

      // Determine which baseline to use:
      // 1. If strongly locked, use the locked baseline
      // 2. If not locked but we have candidates, use the best candidate
      // 3. Fall back to first baseline in the room
      let baseline: typeof room.baselines[0];
      let bestSimilarity: number;

      if (isStrongLock && locked) {
        baseline = room.baselines.find(b => b.id === locked.baseline.id) || room.baselines[0];
        bestSimilarity = locked.similarity;
      } else if (topK.length > 0) {
        // Use the best available candidate even without a strong lock
        const bestCandidate = topK[0];
        baseline = room.baselines.find(b => b.id === bestCandidate.baselineId) || room.baselines[0];
        bestSimilarity = bestCandidate.similarity;

        // If similarity is essentially zero and we've already done a first capture, wait
        if (bestSimilarity <= 0 && hasFirstAutoCaptureRef.current) return;
      } else if (!hasFirstAutoCaptureRef.current) {
        // No detector results yet — use the first baseline in the room
        // to ensure we fire a comparison within ~5-10s of camera open
        const elapsed = Date.now() - autoCaptureStartTimeRef.current;
        if (elapsed < 5000) return; // Wait at least 5s for detector to produce candidates
        baseline = room.baselines[0];
        bestSimilarity = 0;
      } else {
        // No candidates and we've already done the first capture — wait for localization
        return;
      }

      // Check if all angles are scanned for auto-advance
      const visit = state.visitedRooms.get(currentRoomId);
      const allScanned = room.baselines.every(b => visit?.anglesScanned.has(b.id));
      if (allScanned && autoCaptureEnabledRef.current) {
        autoAdvanceIfRoomComplete(session, currentRoomId);
        return;
      }

      // Feed lightweight change detection before expensive burst capture.
      const changeFrame = await captureChangeFrame();
      if (!isMountedRef.current || pausedRef.current) return;
      const changeResult = changeFrame
        ? comparison.feedChangeFrame(changeFrame)
        : undefined;
      const allowWalkthroughMotion = true;
      if (
        !comparison.shouldTrigger(changeResult, {
          allowInitialStillFrame: (visit?.anglesScanned.size || 0) === 0,
          allowWalkthroughMotion,
        })
      ) {
        return;
      }

      const {
        data: { session: authSession },
      } = await supabase.auth.getSession();
      if (!isMountedRef.current || pausedRef.current) return;
      if (!authSession?.access_token) return;

      const apiUrl = process.env.EXPO_PUBLIC_API_URL;
      if (!apiUrl) return;

      const firstCapture = await captureHighResFrame();
      if (!isMountedRef.current || pausedRef.current) return;
      if (!firstCapture) return;

      let rerankedTopK = topK;
      try {
        rerankedTopK = await rankCandidatesForCapturedFrame(
          firstCapture.uri,
          currentRoomId,
          topK,
        );
      } finally {
        FileSystem.deleteAsync(firstCapture.uri, { idempotent: true }).catch(() => {});
      }
      if (!isMountedRef.current || pausedRef.current) return;

      // Coverage-aware selection: prefer unscanned-cluster candidates within
      // 0.10 similarity of the top candidate to capture new areas first
      if (detector && rerankedTopK.length >= 2) {
        const topSim = rerankedTopK[0].similarity;
        const topIsScanned = !detector.isInUnscannedCluster(rerankedTopK[0].baselineId, currentRoomId);
        if (topIsScanned) {
          const unscannedAlt = rerankedTopK.find(
            (c) =>
              c.similarity >= topSim - 0.10 &&
              getBaselineById(c.baselineId)?.roomId === currentRoomId &&
              detector.isInUnscannedCluster(c.baselineId, currentRoomId),
          );
          if (unscannedAlt) {
            // Promote unscanned candidate to front
            rerankedTopK = [
              unscannedAlt,
              ...rerankedTopK.filter((c) => c.baselineId !== unscannedAlt.baselineId),
            ];
          }
        }
      }

      const selectedBaseline =
        getBaselineById(rerankedTopK[0]?.baselineId || baseline.id) || {
          ...baseline,
          roomId: room.roomId,
          roomName: room.roomName,
        };
      const selectedRoomId = selectedBaseline.roomId || currentRoomId;
      const selectedRoomName = selectedBaseline.roomName || room.roomName;
      const roomKnownConditions = Array.from(
        new Set([
          ...(globalKnownConditionsRef.current || []),
          ...(knownConditionsByRoomRef.current.get(selectedRoomId) || []),
        ]),
      );
      const captureFrameReranked =
        rerankedTopK[0]?.baselineId !== topK[0]?.baselineId;

      let reusedInitialFrame = false;
      const captureFrame = async () => {
        if (!reusedInitialFrame) {
          reusedInitialFrame = true;
          return firstCapture.dataUri;
        }

        const burstFrame = await captureHighResFrame();
        if (!burstFrame) return null;
        FileSystem.deleteAsync(burstFrame.uri, { idempotent: true }).catch(() => {});
        return burstFrame.dataUri;
      };

      session.recordEvent("comparison_requested", selectedRoomId, {
        baselineImageId: selectedBaseline.id,
        triggerSource: "auto",
        lockedSimilarity: rerankedTopK[0]?.similarity ?? bestSimilarity,
        topCandidates: rerankedTopK.map(c => ({ id: c.baselineId, sim: c.similarity })),
        captureFrameReranked,
        userSelectedBaselineId,
      });

      if (!isMountedRef.current || pausedRef.current) return;
      setLocalizationState("capturing");
      hasFirstAutoCaptureRef.current = true;
      void comparison.triggerComparison(
        captureFrame,
        selectedBaseline.imageUrl,
        selectedRoomName,
        selectedRoomId,
        {
          inspectionMode,
          knownConditions: roomKnownConditions,
          inspectionId,
          baselineImageId: selectedBaseline.id,
          triggerSource: "auto",
          apiUrl,
          authToken: authSession.access_token,
          clientSimilarity: rerankedTopK[0]?.similarity ?? bestSimilarity,
          topCandidateIds: rerankedTopK.slice(0, 3).map(c => c.baselineId),
          userSelectedCandidateId: userSelectedBaselineId || undefined,
          skipBurst: !(motionFilterRef.current?.isStable() ?? true),
          refreshToken: async () => {
            const { data } = await supabase.auth.refreshSession();
            return data.session?.access_token ?? null;
          },
        },
      );
    },
    [
      captureChangeFrame,
      captureHighResFrame,
      getBaselineById,
      inspectionId,
      inspectionMode,
      rankCandidatesForCapturedFrame,
      userSelectedBaselineId,
    ],
  );

  // Keep ref in sync so interval callbacks always call the latest version
  useEffect(() => {
    autoCapturTickRef.current = autoCaptureTick;
  }, [autoCaptureTick]);

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

    session.recordEvent("room_switched_manually", nextRoom.roomId, {
      fromRoomId: state.currentRoomId,
      toRoomId: nextRoom.roomId,
    });
    activateRoom(session, nextRoom.roomId, nextRoom.roomName);

    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  }, [activateRoom]);

  const handlePause = useCallback(() => {
    const session = sessionRef.current;
    const comparison = comparisonRef.current;
    if (!session || !comparison) return;

    setPaused((p) => {
      if (p) {
        // Resuming
        session.resume();
        comparison.resume();
        motionFilterRef.current?.start();

        // Restart auto-capture interval
        if (autoCaptureEnabledRef.current && !autoCaptureTimerRef.current) {
          autoCaptureTimerRef.current = setInterval(() => {
            void autoCapturTickRef.current?.(session, comparison);
          }, AUTO_CAPTURE_INTERVAL_MS);
        }

        // Restart room detection loop
        const detector = roomDetectorRef.current;
        if (detector && !roomDetectionTimerRef.current) {
          startRoomDetectionLoop(detector, session);
        }
      } else {
        // Pausing — stop sensors and timers to save battery
        session.pause();
        comparison.pause();
        motionFilterRef.current?.stop();

        if (autoCaptureTimerRef.current) {
          clearInterval(autoCaptureTimerRef.current);
          autoCaptureTimerRef.current = null;
        }
        if (roomDetectionTimerRef.current) {
          clearTimeout(roomDetectionTimerRef.current);
          roomDetectionTimerRef.current = null;
        }
      }
      return !p;
    });
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
  }, [startRoomDetectionLoop]);

  const handleToggleHandsFree = useCallback(() => {
    const session = sessionRef.current;
    setAutoCaptureEnabled((value) => {
      const next = !value;
      autoAllRoomsCompleteHintRef.current = false;
      session?.recordEvent("hands_free_toggled", session.getState().currentRoomId || undefined, {
        enabled: next,
      });
      showCaptureHint(
        next
          ? "Hands-free AI capture enabled"
          : "Hands-free AI capture paused",
      );
      return next;
    });
  }, [showCaptureHint]);

  const handleEndInspection = useCallback(async () => {
    if (isSubmittingRef.current) return;

    // Clean up stale pending analyses (>90s)
    const now = Date.now();
    for (const [id, entry] of pendingAnalysesRef.current) {
      if (now - entry.startedAt > 90_000) {
        pendingAnalysesRef.current.delete(id);
        verifiedComparisonIdsRef.current.delete(id);
        console.warn(`[InspectionCamera] Stale pending analysis ${id} cleaned up after 90s`);
      }
    }

    // Log if AI analyses are still in-flight (coverage already recorded, findings may be missed)
    const pendingCount = pendingAnalysesRef.current.size;
    if (pendingCount > 0) {
      console.warn(
        `[InspectionCamera] Ending inspection with ${pendingCount} pending AI analysis(es). Coverage already recorded.`,
      );
      // Clear pending tracking — coverage was already granted by verified events
      pendingAnalysesRef.current.clear();
      verifiedComparisonIdsRef.current.clear();
    }

    isSubmittingRef.current = true;

    // Pause capture loops to prevent late findings from being missed
    comparisonRef.current?.pause();
    sessionRef.current?.pause();

    const session = sessionRef.current;
    if (!session) {
      isSubmittingRef.current = false;
      navigation.replace("InspectionSummary", { inspectionId, propertyId });
      return;
    }

    try {

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
      const confirmedFindings = visit.findings.filter((f) => f.status === "confirmed");
      const hasVerifiedCoverage = visit.anglesScanned.size > 0 || visit.bestScore !== null;
      if (!firstBaseline?.id) {
        const confirmedCount = confirmedFindings.length;
        if (confirmedCount > 0) {
          console.warn(
            `Room ${roomId} had ${confirmedCount} confirmed finding(s) but no baselines — findings dropped from submission`,
          );
        }
        continue;
      }

      // Only include rooms with actual evidence — prevents phantom completions
      // when user opens and immediately ends an inspection
      if (!hasVerifiedCoverage && confirmedFindings.length === 0) {
        continue;
      }

      results.push({
        roomId,
        baselineImageId: firstBaseline.id,
        score: visit.bestScore ?? null,
        findings: confirmedFindings.map((f) => ({
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

    session.recordEvent("inspection_submit_requested", undefined, {
      resultCount: results.length,
      confirmedFindings: results.reduce(
        (total, result) => total + result.findings.length,
        0,
      ),
      completionTier: session.getCompletionTier(),
    });

    const eventLog = session.getEvents();

    try {
      await flushBulkSubmissionQueue();
      await submitBulkResults(
        inspectionId,
        results,
        session.getCompletionTier(),
        undefined,
        eventLog,
      );
    } catch (err) {
      console.error("Failed to submit results:", err);
      try {
        await enqueueBulkSubmission({
          inspectionId,
          results,
          completionTier: session.getCompletionTier(),
          events: eventLog,
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
    } finally {
      isSubmittingRef.current = false;
    }
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
    if (!isMountedRef.current) return;
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

    // Manual capture uses the locked baseline from detector
    // It does NOT bypass localization — it means "attempt localization now"
    const detector = roomDetectorRef.current;
    const locked = detector?.getLockedBaseline();
    const topK = detector?.getTopCandidates(3) || [];

    const isStuck = localizationStuckSince != null && Date.now() - localizationStuckSince > 15000;

    let forcedBaselineId: string | null = null;
    let forcedBaselineSimilarity = 0;
    if (!locked || locked.similarity < 0.45) {
      if (isStuck) {
        // Force compare mode: localization has been failing for >15s,
        // allow capture with whatever the best candidate is
        const forceCandidates = detector?.getTopCandidates(3) || [];
        forcedBaselineId = forceCandidates[0]?.baselineId || room.baselines[0]?.id || null;
        forcedBaselineSimilarity = forceCandidates[0]?.similarity ?? 0;
        if (!forcedBaselineId) {
          showCaptureHint("No baselines available. Point camera at a trained area.");
          return;
        }
      } else {
        showCaptureHint("Point camera at a trained area first.");
        return;
      }
    }

    const effectiveLocked = forcedBaselineId
      ? { baseline: { id: forcedBaselineId }, similarity: forcedBaselineSimilarity }
      : locked!;
    const baseline = room.baselines.find(b => b.id === effectiveLocked.baseline.id) || room.baselines[0];

    if (!comparison.canTriggerManual()) {
      showCaptureHint("Give the last capture a moment to finish.");
      return;
    }

    // Flash feedback
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);

    const {
      data: { session: authSession },
    } = await supabase.auth.getSession();
    if (!isMountedRef.current) return;
    if (!authSession?.access_token) {
      showCaptureHint("Session expired. Please restart the app.");
      return;
    }

    const apiUrl = process.env.EXPO_PUBLIC_API_URL;
    if (!apiUrl) {
      showCaptureHint("Configuration error. Please restart the app.");
      return;
    }

    const firstCapture = await captureHighResFrame();
    if (!isMountedRef.current) return;
    if (!firstCapture) {
      showCaptureHint("Capture failed. Try again.");
      return;
    }

    let rerankedTopK = topK;
    try {
      rerankedTopK = await rankCandidatesForCapturedFrame(
        firstCapture.uri,
        currentRoomId,
        topK,
      );
    } finally {
      FileSystem.deleteAsync(firstCapture.uri, { idempotent: true }).catch(() => {});
    }

    const selectedBaseline =
      getBaselineById(rerankedTopK[0]?.baselineId || baseline.id) || {
        ...baseline,
        roomId: room.roomId,
        roomName: room.roomName,
      };
    const selectedRoomId = selectedBaseline.roomId || currentRoomId;
    const selectedRoomName = selectedBaseline.roomName || room.roomName;
    const roomKnownConditions = Array.from(
      new Set([
        ...(globalKnownConditionsRef.current || []),
        ...(knownConditionsByRoomRef.current.get(selectedRoomId) || []),
      ]),
    );
    const captureFrameReranked =
      rerankedTopK[0]?.baselineId !== topK[0]?.baselineId;

    let reusedInitialFrame = false;
    const captureFrame = async () => {
      if (!reusedInitialFrame) {
        reusedInitialFrame = true;
        return firstCapture.dataUri;
      }

      const burstFrame = await captureHighResFrame();
      if (!burstFrame) return null;
      FileSystem.deleteAsync(burstFrame.uri, { idempotent: true }).catch(() => {});
      return burstFrame.dataUri;
    };

    session.recordEvent("comparison_requested", selectedRoomId, {
      baselineImageId: selectedBaseline.id,
      triggerSource: "manual",
      lockedSimilarity: rerankedTopK[0]?.similarity ?? locked?.similarity,
      topCandidates: rerankedTopK.map(c => ({ id: c.baselineId, sim: c.similarity })),
      captureFrameReranked,
      userSelectedBaselineId,
    });

    if (!isMountedRef.current) return;
    setLocalizationState("capturing");
    void comparison.triggerComparison(
      captureFrame,
      selectedBaseline.imageUrl,
      selectedRoomName,
      selectedRoomId,
      {
        inspectionMode,
        knownConditions: roomKnownConditions,
        inspectionId,
        baselineImageId: selectedBaseline.id,
        triggerSource: "manual",
        apiUrl,
        authToken: authSession.access_token,
        clientSimilarity: rerankedTopK[0]?.similarity ?? locked?.similarity,
        topCandidateIds: rerankedTopK.slice(0, 3).map(c => c.baselineId),
        userSelectedCandidateId: userSelectedBaselineId || undefined,
        refreshToken: async () => {
          const { data } = await supabase.auth.refreshSession();
          return data.session?.access_token ?? null;
        },
      },
    );
  }, [
    captureHighResFrame,
    getBaselineById,
    paused,
    isProcessing,
    inspectionMode,
    inspectionId,
    rankCandidatesForCapturedFrame,
    showCaptureHint,
    userSelectedBaselineId,
    localizationStuckSince,
  ]);

  /**
   * Target-assist tap capture — immediately triggers a comparison against the
   * user-selected baseline, bypassing the normal localization gate.
   */
  const handleTargetAssistCapture = useCallback(async (baselineId: string) => {
    if (!isMountedRef.current) return;
    const session = sessionRef.current;
    const comparison = comparisonRef.current;
    if (!session || !comparison || !cameraRef.current || pausedRef.current) return;
    if (isProcessingRef.current) {
      showCaptureHint("AI is still processing the last capture...");
      return;
    }

    // Resolve the tapped baseline from the full baselines list, not just current room.
    // Ambiguous candidates can span rooms, so we must carry the real room context.
    const resolved = getBaselineById(baselineId);
    if (!resolved) return;

    const selectedRoomId = resolved.roomId;
    const selectedRoomName = resolved.roomName;

    if (!comparison.canTriggerManual()) {
      showCaptureHint("Give the last capture a moment to finish.");
      return;
    }

    showCaptureHint(`Capturing ${resolved.label || "selected view"}...`);

    const {
      data: { session: authSession },
    } = await supabase.auth.getSession();
    if (!isMountedRef.current || pausedRef.current) return;
    if (!authSession?.access_token) {
      showCaptureHint("Session expired. Please restart the app.");
      return;
    }

    const apiUrl = process.env.EXPO_PUBLIC_API_URL;
    if (!apiUrl) return;

    const firstCapture = await captureHighResFrame();
    if (!isMountedRef.current || pausedRef.current || !firstCapture) {
      if (firstCapture) {
        FileSystem.deleteAsync(firstCapture.uri, { idempotent: true }).catch(() => {});
      }
      showCaptureHint("Capture failed. Try again.");
      return;
    }

    // Clean up the captured file after extracting the data URI
    const capturedDataUri = firstCapture.dataUri;
    FileSystem.deleteAsync(firstCapture.uri, { idempotent: true }).catch(() => {});

    // If the tapped baseline belongs to a different room, switch to it
    const currentRoomId = session.getState().currentRoomId;
    if (currentRoomId !== selectedRoomId) {
      activateRoom(session, selectedRoomId, selectedRoomName);
    }

    const roomKnownConditions = Array.from(
      new Set([
        ...(globalKnownConditionsRef.current || []),
        ...(knownConditionsByRoomRef.current.get(selectedRoomId) || []),
      ]),
    );

    let reusedInitialFrame = false;
    const captureFrame = async () => {
      if (!reusedInitialFrame) {
        reusedInitialFrame = true;
        return capturedDataUri;
      }
      const burstFrame = await captureHighResFrame();
      if (!burstFrame) return null;
      FileSystem.deleteAsync(burstFrame.uri, { idempotent: true }).catch(() => {});
      return burstFrame.dataUri;
    };

    session.recordEvent("comparison_requested", selectedRoomId, {
      baselineImageId: resolved.id,
      triggerSource: "target_assist",
    });

    setLocalizationState("capturing");
    setShowTargetAssist(false);
    void comparison.triggerComparison(
      captureFrame,
      resolved.imageUrl,
      selectedRoomName,
      selectedRoomId,
      {
        inspectionMode,
        knownConditions: roomKnownConditions,
        inspectionId,
        baselineImageId: resolved.id,
        triggerSource: "manual",
        apiUrl,
        authToken: authSession.access_token,
        clientSimilarity: 0,
        topCandidateIds: [resolved.id],
        userSelectedCandidateId: baselineId,
        userConfirmed: true,
        refreshToken: async () => {
          const { data } = await supabase.auth.refreshSession();
          return data.session?.access_token ?? null;
        },
      },
    );
  }, [
    captureHighResFrame,
    getBaselineById,
    activateRoom,
    inspectionMode,
    inspectionId,
    showCaptureHint,
  ]);

  const handleConfirmFinding = useCallback((findingId: string) => {
    sessionRef.current?.updateFindingStatus(findingId, "confirmed");
    setFindings((prev) => prev.filter((f) => f.id !== findingId));
    showCaptureHint("Finding confirmed");
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  }, [showCaptureHint]);

  const handleDismissFinding = useCallback((findingId: string, reason?: DismissReason) => {
    sessionRef.current?.updateFindingStatus(findingId, "dismissed", reason ?? undefined);
    setFindings((prev) => prev.filter((f) => f.id !== findingId));
    const hint = reason === "not_accurate"
      ? "Dismissed — feedback saved for review"
      : reason === "still_there"
        ? "Dismissed — item is still present"
        : reason === "known_issue"
          ? "Dismissed — marked as known issue"
          : "Finding dismissed";
    showCaptureHint(hint);
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
    Alert.alert(
      "Delete this note?",
      "This will permanently remove the note from this inspection.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: () => {
            sessionRef.current?.updateFindingStatus(findingId, "dismissed");
            setFindings((prev) => prev.filter((f) => f.id !== findingId));
            showCaptureHint("Note removed");
            void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
          },
        },
      ],
    );
  }, [showCaptureHint]);

  useEffect(() => {
    if (!permission?.granted) {
      requestPermission();
    }
  }, [permission, requestPermission]);

  if (!permission?.granted) {
    const canAsk = permission?.canAskAgain !== false;
    return (
      <View style={styles.permissionContainer}>
        <Text style={styles.permissionText}>Camera access is required</Text>
        <Text style={[styles.permissionText, { fontSize: 14, marginBottom: 16, opacity: 0.7 }]}>
          {canAsk
            ? "Tap below to grant camera access."
            : "Camera permission was denied. Please enable it in Settings."}
        </Text>
        <TouchableOpacity
          style={styles.permissionButton}
          onPress={canAsk ? requestPermission : () => void Linking.openSettings()}
        >
          <Text style={styles.permissionButtonText}>
            {canAsk ? "Grant Permission" : "Open Settings"}
          </Text>
        </TouchableOpacity>
      </View>
    );
  }

  const manualNotes = findings.filter(
    (finding) => finding.category === "manual_note" && finding.status === "confirmed",
  );
  const roomModeLabel = isAutoDetect
    ? "Auto-detect"
    : autoDetectUnavailableReason
      ? "Dev build required"
    : activeImageSource === "camera"
      ? null
      : activeImageSourceLabel;

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

      {/* Border indicator when localized — color reflects similarity, pulses when green */}
      {lockedBaselineInfo && !paused && lockedBaselineInfo.isLocked && (() => {
        const borderColor = getSimilarityColor(lockedBaselineInfo.similarity);
        const isGreen = lockedBaselineInfo.similarity >= 0.55;
        return (
          <Animated.View
            style={[
              styles.ghostOverlay,
              { opacity: isGreen ? borderPulseAnim : 1 },
            ]}
            pointerEvents="none"
          >
            <View
              style={[
                StyleSheet.absoluteFill,
                {
                  borderColor,
                  borderWidth: isGreen ? 5 : 4,
                  borderRadius: 2,
                  shadowColor: borderColor,
                  shadowRadius: 8,
                  shadowOpacity: 0.6,
                  shadowOffset: { width: 0, height: 0 },
                },
              ]}
            />
          </Animated.View>
        );
      })()}

      {lockedBaselineInfo &&
        !paused &&
        !isProcessing &&
        (localizationState === "ambiguous" || showTargetAssist) &&
        /* Delay showing assist UI — give auto-capture 8s to resolve on its own */
        (localizationStuckSince != null && Date.now() - localizationStuckSince > 8000) && (
          <View style={styles.targetAssistStrip}>
            <Text style={styles.targetAssistLabel}>
              Tap a view to help AI
            </Text>
            <View style={styles.ambiguousThumbnails}>
              {lockedBaselineInfo.topCandidates.slice(0, 3).map((candidate, idx) => {
                const baseline = getBaselineById(candidate.baselineId);
                if (!baseline) return null;
                const isSelected = userSelectedBaselineId === candidate.baselineId;
                const isMultiRoom = baselinesRef.current.length > 1;
                // Multi-room: always lead with room name so cross-room candidates are distinguishable
                // Single-room: use baseline label or generic "View N"
                const viewLabel = isMultiRoom
                  ? (baseline.roomName || `Room ${idx + 1}`)
                  : (baseline.label || `View ${idx + 1}`);

                return (
                  <TouchableOpacity
                    key={candidate.baselineId}
                    style={[
                      styles.ambiguousThumb,
                      isSelected && styles.ambiguousThumbSelected,
                    ]}
                    activeOpacity={0.8}
                    onPress={() => {
                      setUserSelectedBaselineId(candidate.baselineId);
                      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                      // Immediately trigger a comparison against the selected baseline
                      void handleTargetAssistCapture(candidate.baselineId);
                    }}
                  >
                    <Image
                      source={{ uri: baseline.previewUrl || baseline.imageUrl }}
                      style={styles.ambiguousThumbImage}
                      contentFit="cover"
                      cachePolicy="none"
                    />
                    {/* Badge: room name for multi-room, view number for single-room */}
                    <View style={styles.ambiguousThumbRoomBadge}>
                      <Text style={styles.ambiguousThumbRoomText} numberOfLines={1}>
                        {viewLabel}
                      </Text>
                    </View>
                    <Text style={styles.ambiguousThumbHint}>
                      {isSelected ? "Capturing..." : "Tap"}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>
        )}

      {/* Localization guidance */}
      {!paused && localizationState !== "localized" && localizationState !== "capturing" && (
        <View style={styles.localizationGuide} pointerEvents="none">
          <Text style={styles.localizationGuideText}>
            {localizationState === "not_localized" && autoDetectUnavailableReason
              ? autoDetectUnavailableReason
              : getLocalizationGuidance(localizationState, localizationStuckSince)}
          </Text>
        </View>
      )}

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

            <View
              style={styles.roomBadge}
              accessibilityRole="text"
              accessibilityLabel={`Current room: ${currentRoom || "Scanning"}`}
            >
              <View style={styles.roomBadgeHeader}>
                <Text style={styles.roomName}>
                  {currentRoom || "Scanning..."}
                </Text>
                {roomModeLabel ? (
                  <View
                    style={[
                      styles.detectModeBadge,
                      isAutoDetect && styles.detectModeBadgeAuto,
                    ]}
                  >
                    <Text style={styles.detectModeText}>{roomModeLabel}</Text>
                  </View>
                ) : null}
              </View>
              {roomAngles.total > 0 && (
                <Text style={styles.angleCount} numberOfLines={1}>
                  {roomAngles.scanned}/{roomAngles.total} angles
                </Text>
              )}
            </View>

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

          <View style={styles.captureRow}>
            {/* Settings gear — left */}
            <TouchableOpacity
              style={styles.utilityButton}
              onPress={() => setShowSettingsModal(true)}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityLabel="Inspection settings"
            >
              <Ionicons name="settings-outline" size={20} color="rgba(255,255,255,0.8)" />
              <Text style={styles.utilityButtonText}>Settings</Text>
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

            {/* Notes button — always opens the notes log (with inline add) */}
            <TouchableOpacity
              style={[styles.utilityButton, styles.utilityButtonWide]}
              onPress={() => setShowNotesLogModal(true)}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityLabel={
                manualNotes.length > 0
                  ? `${manualNotes.length} inspection note${manualNotes.length > 1 ? "s" : ""}`
                  : "Add a note"
              }
            >
              <Ionicons
                name="document-text-outline"
                size={18}
                color="rgba(255,255,255,0.8)"
              />
              <Text style={styles.utilityButtonText}>
                {manualNotes.length > 0 ? `Notes (${manualNotes.length})` : "Add Note"}
              </Text>
            </TouchableOpacity>

            {/* Pause button */}
            <TouchableOpacity
              style={styles.utilityButton}
              onPress={handlePause}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityLabel={paused ? "Resume inspection" : "Pause inspection"}
            >
              <Ionicons
                name={paused ? "play" : "pause"}
                size={20}
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
                  <Text style={styles.noteModalSubmitText}>Save Note</Text>
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
                {manualNotes.length > 0
                  ? "Review and manage your notes"
                  : "Add notes about issues you see during the inspection"}
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
                style={[styles.noteModalSubmit, { marginBottom: 8 }]}
                onPress={() => {
                  setShowNotesLogModal(false);
                  setTimeout(() => handleAddNote(), 300);
                }}
              >
                <Text style={styles.noteModalSubmitText}>+ Add Note</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.noteModalCancel}
                onPress={() => setShowNotesLogModal(false)}
              >
                <Text style={styles.noteModalCancelText}>Done</Text>
              </TouchableOpacity>
            </View>
          </View>
        </Modal>

      {/* Settings Modal */}
      <Modal
        visible={showSettingsModal}
        transparent
        animationType="fade"
        onRequestClose={() => setShowSettingsModal(false)}
      >
        <View style={styles.noteModalOverlay}>
          <View style={styles.notesLogModalContent}>
            <Text style={styles.noteModalTitle}>Inspection Settings</Text>
            <Text style={styles.noteModalSubtitle}>
              Adjust how the inspection runs
            </Text>

            <View style={styles.settingsSection}>
              <View
                style={[
                  styles.settingsRow,
                  autoCaptureEnabled && styles.settingsRowActive,
                ]}
              >
                <View style={styles.settingsRowLeft}>
                  <Ionicons
                    name="scan-outline"
                    size={20}
                    color={autoCaptureEnabled ? "#22c55e" : colors.muted}
                  />
                  <View>
                    <Text style={styles.settingsLabel}>Hands-Free Capture</Text>
                    <Text style={styles.settingsDescription}>
                      Atria captures new angles automatically when the AI has a usable view
                    </Text>
                  </View>
                </View>
                <Switch
                  value={autoCaptureEnabled}
                  onValueChange={handleToggleHandsFree}
                  thumbColor="#ffffff"
                  trackColor={{
                    false: "rgba(148, 163, 184, 0.35)",
                    true: "rgba(34, 197, 94, 0.55)",
                  }}
                />
              </View>

              <View style={styles.settingsRow}>
                <View style={styles.settingsRowLeft}>
                  <Ionicons
                    name="locate-outline"
                    size={20}
                    color={isAutoDetect ? "#22c55e" : colors.muted}
                  />
                  <View>
                    <Text style={styles.settingsLabel}>Room Selection</Text>
                    <Text style={styles.settingsDescription}>
                      {isAutoDetect
                        ? "Auto-detect is on, but you can still switch rooms yourself"
                        : "Manual room selection is active for this inspection"}
                    </Text>
                  </View>
                </View>
                <TouchableOpacity
                  style={[
                    styles.settingsActionButton,
                    baselinesRef.current.length <= 1 && styles.settingsActionButtonDisabled,
                  ]}
                  onPress={() => {
                    if (baselinesRef.current.length <= 1) return;
                    handleSwitchRoom();
                    setShowSettingsModal(false);
                    showCaptureHint("Switched to the next trained room.");
                  }}
                  disabled={baselinesRef.current.length <= 1}
                  activeOpacity={0.8}
                >
                  <Text style={styles.settingsActionButtonText}>
                    {baselinesRef.current.length <= 1 ? "One Room" : "Switch Room"}
                  </Text>
                </TouchableOpacity>
              </View>

              {activeImageSource !== "camera" && (
                <View style={styles.settingsRow}>
                  <View style={styles.settingsRowLeft}>
                    <Ionicons name="videocam-outline" size={20} color={colors.primary} />
                    <View>
                      <Text style={styles.settingsLabel}>Image Source</Text>
                      <Text style={styles.settingsDescription}>
                        Currently using: {activeImageSourceLabel}
                      </Text>
                    </View>
                  </View>
                </View>
              )}
            </View>

            <TouchableOpacity
              style={styles.noteModalSubmit}
              onPress={() => setShowSettingsModal(false)}
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
    justifyContent: "space-evenly",
    paddingHorizontal: 12,
    gap: 12,
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
    width: 60,
    gap: 4,
  },
  utilityButtonWide: {
    width: 88,
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
    backgroundColor: colors.primary,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  noteModalSubmitDisabled: {
    opacity: 0.4,
  },
  noteModalSubmitText: {
    color: colors.primaryForeground,
    fontSize: 16,
    fontWeight: "600",
  },
  settingsSection: {
    gap: 10,
    marginBottom: 16,
  },
  settingsRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: colors.secondary,
    borderRadius: 12,
    padding: 14,
    borderWidth: 1,
    borderColor: colors.stone,
  },
  settingsRowActive: {
    borderColor: "rgba(34,197,94,0.3)",
  },
  settingsRowLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    flex: 1,
  },
  settingsLabel: {
    color: colors.heading,
    fontSize: 15,
    fontWeight: "600",
  },
  settingsDescription: {
    color: colors.muted,
    fontSize: 12,
    marginTop: 2,
    flexShrink: 1,
  },
  settingsActionButton: {
    backgroundColor: "rgba(77,166,255,0.12)",
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "rgba(77,166,255,0.25)",
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  settingsActionButtonDisabled: {
    opacity: 0.5,
  },
  settingsActionButtonText: {
    color: colors.primary,
    fontSize: 12,
    fontWeight: "700",
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
  // ── Ghost Overlay + Localization ──
  ghostOverlay: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 3,
  },
  targetAssistStrip: {
    position: "absolute",
    bottom: 182,
    left: 16,
    right: 16,
    zIndex: 6,
    alignItems: "center",
    gap: 8,
  },
  targetAssistLabel: {
    color: "#fff",
    fontSize: 12,
    fontWeight: "600",
    backgroundColor: "rgba(0,0,0,0.65)",
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  ambiguousThumbnails: {
    flexDirection: "row",
    gap: 12,
    backgroundColor: "rgba(15,23,42,0.82)",
    borderRadius: 10,
    padding: 8,
  },
  ambiguousThumb: {
    alignItems: "center",
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.14)",
    padding: 6,
    backgroundColor: "rgba(15,23,42,0.82)",
  },
  ambiguousThumbSelected: {
    borderColor: "rgba(34,197,94,0.7)",
    backgroundColor: "rgba(34,197,94,0.14)",
  },
  ambiguousThumbImage: {
    width: 100,
    height: 75,
    borderRadius: 6,
  },
  ambiguousThumbRoomBadge: {
    position: "absolute",
    top: 8,
    left: 8,
    backgroundColor: "rgba(0,0,0,0.7)",
    borderRadius: 4,
    paddingHorizontal: 5,
    paddingVertical: 2,
  },
  ambiguousThumbRoomText: {
    color: "rgba(255,255,255,0.9)",
    fontSize: 9,
    fontWeight: "600",
    maxWidth: 80,
  },
  ambiguousThumbLabel: {
    color: "rgba(255,255,255,0.88)",
    fontSize: 10,
    fontWeight: "500",
    marginTop: 4,
    textAlign: "center" as const,
    maxWidth: 100,
  },
  ambiguousThumbHint: {
    color: "rgba(255,255,255,0.74)",
    fontSize: 9,
    fontWeight: "500",
    marginTop: 2,
  },
  localizationGuide: {
    position: "absolute",
    bottom: "30%",
    alignSelf: "center",
    backgroundColor: "rgba(0,0,0,0.65)",
    borderRadius: 10,
    paddingHorizontal: 16,
    paddingVertical: 8,
    zIndex: 4,
  },
  localizationGuideText: {
    color: "rgba(255,255,255,0.9)",
    fontSize: 13,
    fontWeight: "500",
  },
});

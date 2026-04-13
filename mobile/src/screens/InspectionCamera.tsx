import React, { useState, useCallback, useRef, useEffect, useMemo } from "react";
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
  Keyboard,
  Animated,
  ActivityIndicator,
  AppState,
  ScrollView,
  type AppStateStatus,
} from "react-native";
import { Image } from "expo-image";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { CameraView, useCameraPermissions, useMicrophonePermissions } from "expo-camera";
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
import { colors, radius, spacing } from "../lib/tokens";
import type { Finding, AddItemType } from "../lib/inspection/types";
import {
  SessionManager,
  type CompletionTier,
  type InspectionMode,
} from "../lib/inspection/session-manager";
import { ComparisonManager } from "../lib/vision/comparison-manager";
import { MotionFilter } from "../lib/sensors/motion-filter";
import { ChangeDetector } from "../lib/vision/change-detector";
import { RoomDetector, type BaselineCandidate } from "../lib/vision/room-detector";
import { loadOnnxModel, type OnnxModelLoader } from "../lib/vision/onnx-model";
import {
  ApiError,
  getInspectionBaselines,
  submitBulkResults,
  getPropertyFeedback,
  postFindingFeedback,
  getPropertySupplies,
  reportError,
  uploadImageFile,
  uploadVideoFile,
} from "../lib/api";
import SupplyPicker, { type SupplyItem } from "../components/SupplyPicker";
import AddItemComposer, {
  type ComposerResult,
  type ComposerInitialValues,
} from "../components/AddItemComposer";
import AISuggestionCard, { inferItemType } from "../components/AISuggestionCard";
import { supabase } from "../lib/supabase";
import * as FileSystem from "expo-file-system";
import { decodeBase64JpegToRgb, rgbToGrayscale } from "../lib/vision/image-utils";
import {
  enqueueBulkSubmission,
  flushBulkSubmissionQueue,
} from "../lib/inspection/offline-bulk-queue";
import { getInspectionDisplayLabel } from "../lib/inspection/display-labels";
import type { ImageSourceType } from "../lib/image-source/types";
import { InspectionAnnouncer } from "../lib/audio/inspection-announcer";
import { BatchAnalyzer } from "../lib/vision/batch-analyzer";
import { createVoiceNoteRecorder, type VoiceNoteRecorder } from "../lib/audio/voice-notes";
import { loadYoloModel, type YoloModelLoader } from "../lib/vision/yolo-model";
import { ItemTracker } from "../lib/vision/item-tracker";
import { getVoiceNotesCapability } from "../lib/runtime/capabilities";

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
/** On-device coverage credit thresholds.
 *  FIRST_MATCH: Lower threshold to acquire initial foothold faster.
 *  Once any baseline is matched, tighten to NORMAL to avoid false positives.
 *  ROOM_CONFIRMED: When room detection is confident, we know the user is
 *  in the right place, so accept weaker baseline matches within that room. */
const ON_DEVICE_COVERAGE_THRESHOLD_FIRST_MATCH = 0.42;
const ON_DEVICE_COVERAGE_THRESHOLD_NORMAL = 0.48;
const ON_DEVICE_COVERAGE_THRESHOLD_ROOM_CONFIRMED = 0.44;
/** When only 1 effective angle remains, lower the threshold further.
 *  The user is in the right room (confirmed), looking for a specific target.
 *  Accept weaker matches to avoid "I'm literally pointing at it" frustration. */
const ON_DEVICE_COVERAGE_THRESHOLD_FINAL_ANGLE = 0.38;
const AUTO_CAPTURE_INTERVAL_MS = 500;

type LocalizationState =
  | "not_localized"        // No candidate above NOT_READY threshold (0.40)
  | "localizing"           // Candidate found, smoothing (< 3 frames)
  | "ambiguous"            // Top-2 candidates within AMBIGUITY_GAP (0.04) of each other
  | "localized"            // Locked, similarity ≥ LOCKED threshold (0.50)
  | "capturing"            // Comparison in flight
  | "verification_failed"; // Server could not geometrically verify this view

function getSimilarityColor(similarity: number): string {
  if (similarity >= 0.55) return colors.category.restock; // green
  if (similarity >= 0.45) return colors.severity.maintenance; // yellow
  return colors.severity.urgentRepair; // red
}

function getLocalizationGuidance(
  state: LocalizationState,
  stuckSince: number | null,
  similarity?: number,
): string | null {
  const stuckMs = stuckSince ? Date.now() - stuckSince : 0;
  switch (state) {
    case "not_localized":
      // If we have some similarity signal, user is in a trained area but not matching well
      if (similarity !== undefined && similarity >= 0.30) {
        return stuckMs > 6000
          ? "Try pointing directly at items you trained"
          : "Getting closer — hold steady briefly";
      }
      return stuckMs > 10000
        ? "Try pointing at a distinctive area you trained"
        : "Point camera at a trained area";
    case "localizing":
      return similarity !== undefined && similarity >= 0.40
        ? "Almost there — keep steady"
        : "Keep the camera on this area";
    case "ambiguous":
      return stuckMs > 8000
        ? "Tap a view below to capture it directly"
        : "Move closer to distinguish views";
    case "localized": return null;
    case "capturing": return "Analyzing...";
    case "verification_failed":
      return stuckMs > 5000
        ? "Try moving closer or pointing at key items"
        : "Adjusting — keep scanning";
  }
}

/** Create a fingerprint for finding suppression.
 *  Uses category + first 40 chars of lowered description to catch near-duplicates
 *  like "Books added to shelf" and "Additional books added to shelf". */
function findingFingerprint(category: string, description: string): string {
  const normDesc = description.toLowerCase().replace(/[^a-z0-9 ]/g, "").trim().slice(0, 40);
  return `${category}:${normDesc}`;
}

function normalizeInspectionGuidance(guidance?: string | null): string {
  const text = guidance?.trim();
  if (!text) return "Adjusting - keep scanning";
  const normalized = text.toLowerCase();
  if (
    normalized.includes("slightly different angle") ||
    normalized.includes("could not be analyzed") ||
    normalized.includes("try again") ||
    normalized.includes("adjust your angle")
  ) {
    return "Adjusting - keep scanning";
  }
  return text;
}

function resolveFindingSource(
  finding: Pick<Finding, "category" | "source">,
): "manual_note" | "ai" {
  if (finding.source) {
    return finding.source;
  }
  return ["manual_note", "restock", "operational"].includes(finding.category)
    ? "manual_note"
    : "ai";
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

type AddItemAttachmentDraft = {
  kind: "photo" | "video";
  localUri: string;
};

type QuickAddTemplate = {
  id: string;
  itemType: AddItemType;
  label: string;
  value: string;
  icon: keyof typeof Ionicons.glyphMap;
  roomKeywords?: string[];
};

const ADD_ITEM_TYPE_OPTIONS: Array<{
  key: AddItemType;
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
}> = [
  { key: "restock", label: "Restock", icon: "cart-outline" },
  { key: "maintenance", label: "Maintenance", icon: "construct-outline" },
  { key: "task", label: "Task", icon: "checkbox-outline" },
  { key: "note", label: "Note", icon: "document-text-outline" },
];

const QUICK_ADD_TEMPLATES: QuickAddTemplate[] = [
  {
    id: "maint-faucet",
    itemType: "maintenance",
    label: "Leaky faucet",
    value: "Leaky faucet needs repair",
    icon: "water-outline",
    roomKeywords: ["bath", "kitchen", "laundry"],
  },
  {
    id: "maint-bulb",
    itemType: "maintenance",
    label: "Light out",
    value: "Light fixture needs a new bulb",
    icon: "bulb-outline",
  },
  {
    id: "maint-hardware",
    itemType: "maintenance",
    label: "Loose hardware",
    value: "Loose handle or hardware needs tightening",
    icon: "hammer-outline",
  },
  {
    id: "task-air-filter",
    itemType: "task",
    label: "Replace air filter",
    value: "Replace HVAC air filter",
    icon: "swap-horizontal-outline",
  },
  {
    id: "task-smoke",
    itemType: "task",
    label: "Check detectors",
    value: "Check smoke and CO detectors",
    icon: "shield-checkmark-outline",
  },
  {
    id: "task-staging",
    itemType: "task",
    label: "Reset staging",
    value: "Reset room staging before guest arrival",
    icon: "color-wand-outline",
  },
  {
    id: "task-touchup",
    itemType: "task",
    label: "Touch-point clean",
    value: "Do a touch-point clean in this room",
    icon: "sparkles-outline",
  },
  {
    id: "task-outdoor",
    itemType: "task",
    label: "Reset outdoor setup",
    value: "Reset patio and outdoor seating setup",
    icon: "sunny-outline",
    roomKeywords: ["patio", "deck", "balcony", "outdoor"],
  },
];

function stripRestockQuantitySuffix(description: string): string {
  return description.replace(/\s*\(qty:\s*\d+\)\s*$/i, "").trim();
}

function buildItemDescription(text: string, itemType: AddItemType, quantity: number): string {
  if (itemType === "restock" && quantity > 1) {
    return `${text} (qty: ${quantity})`;
  }
  return text;
}

function getItemTypeAccent(itemType: AddItemType | undefined): string {
  switch (itemType) {
    case "restock":
      return colors.success;
    case "maintenance":
      return colors.warning;
    case "task":
      return colors.primary;
    case "note":
    default:
      return colors.muted;
  }
}

function getItemTypeIcon(itemType: AddItemType | undefined): keyof typeof Ionicons.glyphMap {
  switch (itemType) {
    case "restock":
      return "cart-outline";
    case "maintenance":
      return "construct-outline";
    case "task":
      return "checkbox-outline";
    case "note":
    default:
      return "document-text-outline";
  }
}

function getQuickAddTemplates(itemType: AddItemType, roomName?: string | null): QuickAddTemplate[] {
  const normalizedRoom = roomName?.toLowerCase() || "";
  return QUICK_ADD_TEMPLATES.filter((template) => {
    if (template.itemType !== itemType) return false;
    if (!template.roomKeywords?.length) return true;
    return template.roomKeywords.some((keyword) => normalizedRoom.includes(keyword));
  });
}

export default function InspectionCameraScreen() {
  const navigation = useNavigation<Nav>();
  const route = useRoute<CameraRoute>();
  const { inspectionId, propertyId, inspectionMode } = route.params;
  const insets = useSafeAreaInsets();
  const activeImageSource: ImageSourceType = route.params.imageSource || "camera";
  const activeImageSourceLabel =
    activeImageSource === "camera"
      ? "Phone"
      : activeImageSource === "frame"
        ? "Frame"
        : "OpenGlass";

  const [permission, requestPermission, getPermission] = useCameraPermissions();
  const [microphonePermission, requestMicrophonePermission] = useMicrophonePermissions();
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
  const [addItemType, setAddItemType] = useState<"note" | "restock" | "maintenance" | "task">("note");
  const [addItemQuantity, setAddItemQuantity] = useState(1);
  const [supplyCatalog, setSupplyCatalog] = useState<SupplyItem[]>([]);
  const [selectedSupplyItem, setSelectedSupplyItem] = useState<SupplyItem | null>(null);
  const [showSupplyPicker, setShowSupplyPicker] = useState(true);
  const [showSettingsModal, setShowSettingsModal] = useState(false);
  const [noteText, setNoteText] = useState("");
  const [editingFindingId, setEditingFindingId] = useState<string | null>(null);
  const [returnToItemsLogOnClose, setReturnToItemsLogOnClose] = useState(false);
  // Legacy pendingItemAttachment/existingItemMedia removed — AddItemComposer manages evidence state
  const [isSavingItem, setIsSavingItem] = useState(false);
  const [composerInitialValues, setComposerInitialValues] = useState<ComposerInitialValues | undefined>(undefined);
  const [isRecordingEvidence, setIsRecordingEvidence] = useState(false);
  const [evidenceRecordingSeconds, setEvidenceRecordingSeconds] = useState(0);
  const evidenceTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [expandedItemIds, setExpandedItemIds] = useState<string[]>([]);
  const [submissionStatus, setSubmissionStatus] = useState<string | null>(null);
  const [isInitializing, setIsInitializing] = useState(true);
  const [isRecordingVoice, setIsRecordingVoice] = useState(false);
  const [bottomControlsHeight, setBottomControlsHeight] = useState(0);
  const voiceRecorderRef = useRef<VoiceNoteRecorder | null>(null);
  const evidenceRecordingCancelledRef = useRef(false);
  const yoloModelRef = useRef<YoloModelLoader | null>(null);
  const itemTrackerRef = useRef<ItemTracker | null>(null);
  const yoloTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const yoloLoadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [detectedItems, setDetectedItems] = useState<string[]>([]);
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
  type WaypointState = "pending" | "captured" | "analyzing" | "issue_found";
  const [roomWaypoints, setRoomWaypoints] = useState<
    Array<{ id: string; label: string | null; scanned: boolean; state?: WaypointState; previewUrl?: string | null }>
  >([]);
  /** Tracks baselines currently being analyzed by AI (verified but no result yet) */
  const analyzingBaselinesRef = useRef<Set<string>>(new Set());
  /** Tracks baselines where AI found issues */
  const issueBaselinesRef = useRef<Set<string>>(new Set());
  const cameraRef = useRef<CameraView>(null);
  const isRecordingEvidenceRef = useRef(false);
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
  const detailHintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const targetAssistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoCaptureEnabledRef = useRef(autoCaptureEnabled);
  const autoAllRoomsCompleteHintRef = useRef(false);
  /** Fingerprints of dismissed findings — suppress similar findings for rest of inspection.
   *  Fingerprint = normalized `category:description_prefix` to catch near-duplicates. */
  const dismissedFingerprintsRef = useRef<Set<string>>(new Set());
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
  const batchAnalyzerRef = useRef<BatchAnalyzer | null>(null);
  /** Captured frames waiting for verified callbacks, keyed by client request key */
  const pendingBatchFramesRef = useRef<Map<string, {
    dataUri: string;
    baselineId: string;
    baselineUrl: string;
    roomId: string;
    roomName: string;
    label?: string;
    createdAt: number;
  }>>(new Map());
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
  /** Anti-stacking: timestamp of last on-device credit grant + which baseline it was */
  const lastOnDeviceCreditRef = useRef<{ baselineId: string; timestamp: number } | null>(null);
  /** Minimum ms between consecutive on-device credits for DIFFERENT baselines.
   *  Prevents one held camera position from farming multiple angles via embedding fluctuation. */
  const ON_DEVICE_CREDIT_COOLDOWN_MS = 2000;
  /** Whether any baseline has been matched yet this session. Used for first-match boost. */
  const hasFirstMatchRef = useRef(false);
  /** Last room-confidence signal from the detector loop. */
  const roomConfidenceRef = useRef(0);
  const isAutoDetectReloadingRef = useRef(false);
  const needsAutoDetectReloadRef = useRef(false);

  const makeRequestKey = useCallback(
    () => `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    [],
  );

  const sweepStalePendingBatchFrames = useCallback((maxAgeMs = 120_000) => {
    const now = Date.now();
    for (const [key, entry] of pendingBatchFramesRef.current) {
      if (now - entry.createdAt > maxAgeMs) {
        pendingBatchFramesRef.current.delete(key);
      }
    }
  }, []);
  const autoDetectReloadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const processingTimeoutIdRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const voiceNotesAvailable = getVoiceNotesCapability().supported;

  // Legacy resetAddItemComposer removed — AddItemComposer manages its own state

  const closeNoteModal = useCallback(() => {
    Keyboard.dismiss();
    if (voiceRecorderRef.current?.isRecording || isRecordingVoice) {
      setIsRecordingVoice(false);
      void voiceRecorderRef.current?.cancelRecording();
    }
    if (isRecordingEvidenceRef.current) {
      evidenceRecordingCancelledRef.current = true;
      try {
        cameraRef.current?.stopRecording?.();
      } catch {
        // Ignore stop errors when the camera is already idle.
      }
    }
    const reopenItemsLog = returnToItemsLogOnClose;
    setShowNoteModal(false);
    setEditingFindingId(null);
    setComposerInitialValues(undefined);
    setReturnToItemsLogOnClose(false);
    if (reopenItemsLog) {
      setShowNotesLogModal(true);
    }
  }, [isRecordingVoice, returnToItemsLogOnClose]);

  const openAddItemComposer = useCallback((options?: {
    item?: Finding;
    returnToLog?: boolean;
    defaultType?: AddItemType;
  }) => {
    const item = options?.item;
    Keyboard.dismiss();
    setShowNotesLogModal(false);
    setReturnToItemsLogOnClose(Boolean(options?.returnToLog));

    if (item) {
      const resolvedItemType: AddItemType =
        item.itemType ||
        (item.category === "restock"
          ? "restock"
          : item.category === "operational"
            ? "maintenance"
            : "note");
      setEditingFindingId(item.id);
      setComposerInitialValues({
        id: item.id,
        itemType: resolvedItemType,
        description: resolvedItemType === "restock"
          ? stripRestockQuantitySuffix(item.description)
          : item.description,
        quantity: item.restockQuantity || 1,
        supplyItemId: item.supplyItemId,
        imageUrl: item.imageUrl,
        videoUrl: item.videoUrl,
        evidenceItems: item.evidenceItems,
      });
    } else {
      setEditingFindingId(null);
      setComposerInitialValues({
        itemType: options?.defaultType || "note",
      });
    }

    setShowNoteModal(true);
  }, []);

  const runYoloDetectionTick = useCallback(async () => {
    if (!isMountedRef.current || pausedRef.current || isCapturingRef.current) return;
    if (!cameraRef.current || !yoloModelRef.current?.isLoaded) return;

    isCapturingRef.current = true;
    let photoUri: string | null = null;
    try {
      const photo = await cameraRef.current.takePictureAsync({ quality: 0.3, base64: false });
      if (!photo?.uri) return;
      photoUri = photo.uri;

      const result = await yoloModelRef.current.detect(photoUri);
      if (!result || !isMountedRef.current) return;

      const currentRoomId = sessionRef.current?.getState().currentRoomId;
      if (currentRoomId && itemTrackerRef.current) {
        itemTrackerRef.current.processDetections(
          currentRoomId,
          result.propertyRelevantObjects.map((obj) => ({
            className: obj.className,
            confidence: obj.confidence,
          })),
          Date.now(),
        );
        const itemCoverage = itemTrackerRef.current.getRoomCoverage(currentRoomId);
        setDetectedItems([`${itemCoverage.verified}/${itemCoverage.total} items verified`]);
      }
    } catch (err) {
      console.warn("[YOLO] Detection error:", err);
    } finally {
      isCapturingRef.current = false;
      if (photoUri) FileSystem.deleteAsync(photoUri, { idempotent: true }).catch(() => {});
    }
  }, []);

  const stopYoloLoop = useCallback(() => {
    if (yoloTimerRef.current) {
      clearInterval(yoloTimerRef.current);
      yoloTimerRef.current = null;
    }
  }, []);

  const startYoloLoop = useCallback(() => {
    if (!yoloModelRef.current?.isLoaded || yoloTimerRef.current) return;
    yoloTimerRef.current = setInterval(() => {
      void runYoloDetectionTick();
    }, 3000);
  }, [runYoloDetectionTick]);

  const scheduleYoloLoad = useCallback((delayMs = 5000) => {
    if (yoloModelRef.current?.isLoaded || yoloLoadTimerRef.current) return;
    yoloLoadTimerRef.current = setTimeout(async () => {
      yoloLoadTimerRef.current = null;
      if (!isMountedRef.current || pausedRef.current) return;
      try {
        const yolo = await loadYoloModel();
        if (!isMountedRef.current || pausedRef.current) {
          yolo.dispose();
          return;
        }
        yoloModelRef.current = yolo;
        if (yolo.isLoaded) {
          console.log("[YOLO] Model loaded — starting object detection loop");
          startYoloLoop();
        }
      } catch (err) {
        console.warn("[YOLO] Failed to load:", err);
      }
    }, delayMs);
  }, [startYoloLoop]);

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
    // Suppress specific noisy/repetitive guidance when room is mostly or fully covered.
    // Match exact messages, NOT substrings — avoids suppressing legitimate messages
    // like "Coverage complete — keep scanning for detail" or "Capture failed. Try again."
    const currentRoom = sessionRef.current?.getState().currentRoomId;
    const roomCov = currentRoom ? roomDetectorRef.current?.getRoomCoverage(currentRoom) : null;
    if (roomCov && roomCov.percentage >= 80) {
      const lower = message.toLowerCase().trim();
      if (
        lower === "adjusting — keep scanning" ||
        lower === "adjusting - keep scanning" ||
        lower === "try a slightly different angle" ||
        lower.startsWith("tap a suggested view")
      ) {
        return; // Don't show contradictory guidance near completion
      }
    }

    setCaptureHint(message);
    // Cancel any pending delayed detail hint so fresh captures aren't overwritten
    if (detailHintTimerRef.current) {
      clearTimeout(detailHintTimerRef.current);
      detailHintTimerRef.current = null;
    }
    if (captureHintTimerRef.current) {
      clearTimeout(captureHintTimerRef.current);
    }
    captureHintTimerRef.current = setTimeout(() => {
      setCaptureHint(null);
      captureHintTimerRef.current = null;
    }, 4500);
  }, []);

  // Legacy handleRemoveItemAttachment removed — AddItemComposer handles its own evidence

  const handleCaptureEvidencePhoto = useCallback(async (): Promise<{ uri: string } | null> => {
    if (!cameraRef.current || isSavingItem || isRecordingVoice || isRecordingEvidenceRef.current) {
      return null;
    }

    Keyboard.dismiss();
    try {
      const photo = await cameraRef.current.takePictureAsync({
        quality: 0.7,
        base64: false,
      });

      if (!photo?.uri) {
        throw new Error("No photo was captured");
      }

      showCaptureHint("Photo evidence attached");
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      return { uri: photo.uri };
    } catch (err) {
      reportError({
        screen: "InspectionCamera",
        action: "capture evidence photo",
        errorMessage:
          err instanceof Error ? err.message : "Evidence photo capture failed",
        isAutomatic: true,
      });
      Alert.alert("Photo unavailable", "Could not capture a photo for this item. Please try again.");
      return null;
    }
  }, [isRecordingVoice, isSavingItem, showCaptureHint]);

  const handleToggleEvidenceVideo = useCallback(async (): Promise<{ uri: string; durationMs?: number } | null> => {
    if (!cameraRef.current || isSavingItem || isRecordingVoice) {
      return null;
    }

    if (!microphonePermission?.granted) {
      const result = await requestMicrophonePermission();
      if (!result.granted) {
        Alert.alert(
          "Microphone Required",
          "Microphone access is needed to attach a short video note.",
          [
            { text: "Cancel", style: "cancel" },
            { text: "Open Settings", onPress: () => void Linking.openSettings() },
          ],
        );
        return null;
      }
    }

    Keyboard.dismiss();
    evidenceRecordingCancelledRef.current = false;
    isRecordingEvidenceRef.current = true;
    setIsRecordingEvidence(true);
    setEvidenceRecordingSeconds(0);
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);

    // Start elapsed-time counter
    evidenceTimerRef.current = setInterval(() => {
      setEvidenceRecordingSeconds((s) => s + 1);
    }, 1000);

    try {
      const result = await cameraRef.current.recordAsync({
        maxDuration: 60,
      });

      if (result?.uri && !evidenceRecordingCancelledRef.current) {
        showCaptureHint("Video evidence attached");
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        return { uri: result.uri };
      }
      return null;
    } catch (err) {
      if (!evidenceRecordingCancelledRef.current) {
        reportError({
          screen: "InspectionCamera",
          action: "record evidence video",
          errorMessage:
            err instanceof Error ? err.message : "Evidence video capture failed",
          isAutomatic: true,
        });
        Alert.alert("Video unavailable", "Could not capture a video for this item. Please try again.");
      }
      return null;
    } finally {
      if (evidenceTimerRef.current) {
        clearInterval(evidenceTimerRef.current);
        evidenceTimerRef.current = null;
      }
      isRecordingEvidenceRef.current = false;
      evidenceRecordingCancelledRef.current = false;
      setIsRecordingEvidence(false);
      setEvidenceRecordingSeconds(0);
    }
  }, [
    isRecordingVoice,
    isSavingItem,
    microphonePermission,
    requestMicrophonePermission,
    showCaptureHint,
  ]);

  const handleStopEvidenceVideo = useCallback(() => {
    evidenceRecordingCancelledRef.current = false;
    try {
      cameraRef.current?.stopRecording?.();
    } catch {
      // Ignore if recording already stopped.
    }
  }, []);

  const toggleExpandedItem = useCallback((findingId: string) => {
    setExpandedItemIds((prev) =>
      prev.includes(findingId)
        ? prev.filter((id) => id !== findingId)
        : [...prev, findingId],
    );
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

    // Initialize batch analyzer for holistic scene analysis
    const batchAnalyzer = new BatchAnalyzer({
      batchSize: 5,
      maxBatchWaitMs: 15000,
      maxConcurrentBatches: 2,
      apiUrl: process.env.EXPO_PUBLIC_API_URL || "",
      getAuthToken: async () => {
        const { data } = await supabase.auth.getSession();
        return data.session?.access_token || null;
      },
      inspectionMode,
      knownConditions: globalKnownConditionsRef.current || [],
      propertyId,
    });
    batchAnalyzer.setResultCallback((result) => {
      if (!isMountedRef.current) return;
      // Surface batch findings — use the batch result's roomId, NOT the current room.
      // The user may have moved to a different room by the time the batch result arrives.
      if (result.findings && result.findings.length > 0) {
        const batchRoomId = result.roomId;
        for (const f of result.findings) {
          if (batchRoomId) {
            sessionRef.current?.addFinding(batchRoomId, {
              description: f.description,
              severity: f.severity || "maintenance",
              confidence: f.confidence || 0.7,
              category: f.category || "condition",
              findingCategory: f.findingCategory || "condition",
              isClaimable: f.isClaimable || false,
            });
          }
        }
        const count = result.findings.length;
        const firstDesc = result.findings[0].description;
        const truncated = firstDesc.length > 50 ? firstDesc.slice(0, 47) + "..." : firstDesc;
        showCaptureHint(
          count === 1
            ? `🔍 Scene analysis: ${truncated}`
            : `🔍 Scene analysis: ${count} issues found`,
        );
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      }
    });
    batchAnalyzerRef.current = batchAnalyzer;

    // Initialize voice recorder (optional — degrades gracefully if unavailable)
    const voiceRecorder = createVoiceNoteRecorder(
      process.env.EXPO_PUBLIC_API_URL || "",
      async () => {
        const { data } = await supabase.auth.getSession();
        return data.session?.access_token || null;
      },
    );
    voiceRecorderRef.current = voiceRecorder;

    // Initialize YOLO object detector + item tracker (async, non-blocking)
    // Loads after MobileCLIP to avoid simultaneous ONNX sessions during startup
    const itemTracker = new ItemTracker();
    itemTrackerRef.current = itemTracker;
    // Deferred YOLO load — gives MobileCLIP time to fully initialize first
    scheduleYoloLoad();

    // Initialize room detector
    const roomDetector = new RoomDetector();
    roomDetectorRef.current = roomDetector;

    // Register verified callback — grants coverage credit early (~1-2s)
    comparison.onVerified((event, context) => {
      if (!isMountedRef.current) return;
      sweepStalePendingBatchFrames();

      // Sweep stale pending entries (>90s) on every verified event
      const now = Date.now();
      for (const [id, entry] of pendingAnalysesRef.current) {
        if (now - entry.startedAt > 90_000) {
          analyzingBaselinesRef.current.delete(entry.baselineId);
          pendingAnalysesRef.current.delete(id);
          verifiedComparisonIdsRef.current.delete(id);
        }
      }

      const { roomId, roomName, baselineImageId, requestKey } = context;
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
        // Mark baseline as "analyzing" for tri-state waypoint display
        analyzingBaselinesRef.current.add(resolvedBaselineId);
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

      // Skip if on-device credit already granted for this baseline
      if (resolvedBaselineId && onDeviceCreditedRef.current.has(resolvedBaselineId)) {
        // On-device path already handled coverage + haptics — just refresh waypoint dots
        // so the "analyzing" state shows up in the tri-state display
        updateCoverageUI(session, resolvedRoomId);
        if (requestKey) {
          pendingBatchFramesRef.current.delete(requestKey);
        }
        return;
      }

      // Grant coverage credit (directional hierarchy rules apply)
      if (resolvedBaselineId) {
        hasFirstMatchRef.current = true;
        // Mark in onDeviceCreditedRef so on-device loop won't re-credit/re-haptic
        onDeviceCreditedRef.current.add(resolvedBaselineId);

        if (event.verificationMode === "user_confirmed_bypass") {
          session.recordAngleScan(resolvedRoomId, resolvedBaselineId);
          roomDetectorRef.current?.markAngleScanned(resolvedBaselineId, resolvedRoomId);
        } else {
          // Completion credit: only the matched baseline + cluster peers
          const clusterIds = roomDetectorRef.current?.getClusterMembers(resolvedBaselineId) || [resolvedBaselineId];
          for (const cid of clusterIds) {
            session.recordAngleScan(resolvedRoomId, cid);
            roomDetectorRef.current?.markAngleScanned(cid, resolvedRoomId);
            onDeviceCreditedRef.current.add(cid);
          }

          // UI-only credit: hierarchy parent/children marked as "seen"
          const hierarchy = roomDetectorRef.current?.getHierarchy(resolvedBaselineId);
          if (hierarchy) {
            if (hierarchy.parentId) {
              roomDetectorRef.current?.markAngleScanned(hierarchy.parentId, resolvedRoomId, {
                countsForCompletion: false,
              });
              onDeviceCreditedRef.current.add(hierarchy.parentId);
            }
            for (const childId of hierarchy.childIds) {
              roomDetectorRef.current?.markAngleScanned(childId, resolvedRoomId, {
                countsForCompletion: false,
              });
              onDeviceCreditedRef.current.add(childId);
            }
          }
        }
        updateCoverageUI(session, resolvedRoomId);
      }

      // Feed frame to batch analyzer for holistic scene analysis.
      // Use the STORED frame from the comparison that earned this verified event,
      // NOT a fresh capture — avoids extra camera work and ensures the batch
      // analyzes the exact frame that earned coverage credit.
      if (batchAnalyzerRef.current && requestKey) {
        const storedFrame = pendingBatchFramesRef.current.get(requestKey);
        if (storedFrame) {
          batchAnalyzerRef.current.addFrame({
            roomId: storedFrame.roomId,
            roomName: storedFrame.roomName,
            dataUri: storedFrame.dataUri,
            baselineUrl: storedFrame.baselineUrl,
            baselineId: storedFrame.baselineId,
            label: storedFrame.label,
            capturedAt: Date.now(),
          });
          pendingBatchFramesRef.current.delete(requestKey);
        }
      }

      // Context-aware hint: don't show generic "Captured" when the final target wasn't credited
      const curRoom = session.getState().currentRoomId;
      const roomCov = curRoom ? roomDetectorRef.current?.getRoomCoverage(curRoom) : null;
      const remainingAngles = roomCov ? roomCov.total - roomCov.scanned : null;
      if (remainingAngles === 0) {
        showCaptureHint("✓ Room coverage complete!");
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      } else if (remainingAngles === 1) {
        showCaptureHint("Saved for analysis — still need final view");
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      } else {
        showCaptureHint("✓ Captured (analyzing...)");
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      }
    });

    // Register finding callback
    comparison.onResult((result, context) => {
      if (!isMountedRef.current) return; // Skip state updates after unmount
      const { roomId, roomName, baselineImageId, triggerSource, requestKey } = context;
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
      if (requestKey) {
        pendingBatchFramesRef.current.delete(requestKey);
      }

      // Transition waypoint state: analyzing → captured or issue_found
      if (resolvedBaselineId) {
        analyzingBaselinesRef.current.delete(resolvedBaselineId);
        // Note: issueBaselinesRef is set AFTER the suppression filter below,
        // not here, to avoid amber dots for fully-suppressed findings.
        // Refresh waypoint dots to reflect analyzing → captured transition
        updateCoverageUI(session, resolvedRoomId);
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
        // Only show target assist after repeated failures, not on the first miss
        if (newCount >= 2) {
          setShowTargetAssist(true);
        }
        // Softer message — the user is trying, don't make them feel like they're doing it wrong
        const hint = newCount >= 2
          ? "Tap a suggested view below, or try moving closer"
          : "Adjusting — keep scanning";
        showCaptureHint(hint);
        return;
      }

      // Any non-localization failure result breaks the "consecutive same-baseline
      // failures" streak, including comparison_unavailable and successful captures.
      locFailuresByBaselineRef.current.clear();

      if (result.status === "comparison_unavailable") {
        setLocalizationState("localized");
        setShowTargetAssist(false);
        showCaptureHint(
          normalizeInspectionGuidance(result.userGuidance) ||
            "Adjusting - keep scanning",
        );
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
        return;
      }

      if (result.status === "analysis_deferred") {
        setLocalizationState("localized");
        setShowTargetAssist(false);
        setUserSelectedBaselineId(null);
        showCaptureHint("Saved view captured; AI analysis deferred");
        return;
      }

      setLocalizationState("localized");
      setShowTargetAssist(false);
      setUserSelectedBaselineId(null);

      if (resolvedBaseline && session.getState().currentRoomId !== resolvedBaseline.roomId) {
        activateRoom(session, resolvedBaseline.roomId, resolvedBaseline.roomName);
      }

      // Grant coverage credit ONLY if not already granted by verified event or on-device credit
      const onDeviceAlreadyCredited = resolvedBaselineId ? onDeviceCreditedRef.current.has(resolvedBaselineId) : false;
      if (resolvedBaselineId && !alreadyCredited && !onDeviceAlreadyCredited) {
        hasFirstMatchRef.current = true;
        onDeviceCreditedRef.current.add(resolvedBaselineId);

        // Completion credit: matched baseline + cluster peers only
        const clusterIds = roomDetectorRef.current?.getClusterMembers(resolvedBaselineId) || [resolvedBaselineId];
        for (const cid of clusterIds) {
          session.recordAngleScan(resolvedRoomId, cid);
          roomDetectorRef.current?.markAngleScanned(cid, resolvedRoomId);
          onDeviceCreditedRef.current.add(cid);
        }

        // UI-only credit: hierarchy parent/children marked as "seen" in detector
        const hierarchy = roomDetectorRef.current?.getHierarchy(resolvedBaselineId);
        if (hierarchy) {
          if (hierarchy.parentId) {
            roomDetectorRef.current?.markAngleScanned(hierarchy.parentId, resolvedRoomId, {
              countsForCompletion: false,
            });
            onDeviceCreditedRef.current.add(hierarchy.parentId);
          }
          for (const childId of hierarchy.childIds) {
            roomDetectorRef.current?.markAngleScanned(childId, resolvedRoomId, {
              countsForCompletion: false,
            });
            onDeviceCreditedRef.current.add(childId);
          }
        }
        updateCoverageUI(session, resolvedRoomId);
      }

      if ((result.findings?.length || 0) === 0 && resolvedBaselineId) {
        autoAdvanceIfRoomComplete(session, resolvedRoomId);
      }

      if (result.findings?.length > 0) {
        // Filter out findings that match previously dismissed fingerprints
        const newFindings = result.findings.filter((f) => {
          const fp = findingFingerprint(f.category, f.description);
          if (dismissedFingerprintsRef.current.has(fp)) {
            console.log(`[InspectionCamera] Suppressed previously-dismissed finding: ${f.description.slice(0, 60)}`);
            return false;
          }
          return true;
        });

        for (const f of newFindings) {
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
        }

        if (newFindings.length === 0) {
          // All findings were suppressed — treat as clean
          if (resolvedBaselineId) {
            autoAdvanceIfRoomComplete(session, resolvedRoomId);
          }
        } else {
          // Prominent finding notification — use double haptic + visible hint
          // so the user knows the AI found something even while focused on the camera
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
          const count = newFindings.length;
          const firstDesc = newFindings[0].description;
          const truncated = firstDesc.length > 60 ? firstDesc.slice(0, 57) + "..." : firstDesc;
          showCaptureHint(
            count === 1
              ? `⚠️ Issue found: ${truncated}`
              : `⚠️ ${count} issues found — tap to review`,
          );
          // Mark affected baselines as having issues (for tri-state dots)
          if (resolvedBaselineId) {
            issueBaselinesRef.current.add(resolvedBaselineId);
            const currentRoomId = session.getState().currentRoomId;
            if (currentRoomId) updateCoverageUI(session, currentRoomId);
          }
          if (activeImageSource !== "camera") {
            const firstFinding = newFindings[0];
            if (firstFinding) {
              void announcerRef.current.announceFinding(
                resolvedRoomName || "current room",
                firstFinding.description,
              );
            }
          }
        }
      } else if (
        result.status === "localized_no_change" ||
        result.status === "localized_changed"
      ) {
        const roomProgress = roomDetectorRef.current?.getRoomProgress(resolvedRoomId);
        const totalAngles = roomProgress?.total || 0;
        const scannedCount = roomProgress?.scanned || 0;
        const displayLabel = resolvedBaseline
          ? getInspectionDisplayLabel({
              label: resolvedBaseline.label,
              roomName: resolvedBaseline.roomName,
              metadata: resolvedBaseline.metadata,
            })
          : null;

        // If this was already credited by the on-device / verified path, avoid
        // clobbering the more helpful targeted guidance with a generic save hint.
        if (alreadyCredited || onDeviceAlreadyCredited) {
          if (totalAngles > 0 && scannedCount >= totalAngles) {
            showCaptureHint("Room coverage complete ✓");
          }
        } else if (totalAngles > 0 && displayLabel) {
          const isRoomComplete = scannedCount >= totalAngles;
          const isLastAngle = totalAngles - scannedCount === 1;

          if (isRoomComplete) {
            showCaptureHint("Room coverage complete ✓");
          } else if (isLastAngle) {
            const remainingBaselines =
              (baselinesRef.current.find((r) => r.roomId === resolvedRoomId)?.baselines || [])
                .filter(
                  (b) =>
                    !onDeviceCreditedRef.current.has(b.id) &&
                    !roomDetectorRef.current
                      ?.getCompletionScannedAngles(resolvedRoomId)
                      .includes(b.id),
                );
            const remainingLabel =
              remainingBaselines.length === 1
                ? getInspectionDisplayLabel({
                    label: remainingBaselines[0].label,
                    roomName: resolvedBaseline?.roomName || resolvedRoomName,
                    metadata: remainingBaselines[0].metadata,
                  })
                : "1 view";
            showCaptureHint(`${displayLabel} captured — still need: ${remainingLabel}`);
          } else {
            showCaptureHint(
              triggerSource === "auto"
                ? `${displayLabel} captured automatically (${scannedCount}/${totalAngles})`
                : `${displayLabel} captured (${scannedCount}/${totalAngles})`,
            );
          }
        } else {
          showCaptureHint(
            triggerSource === "auto"
              ? "Saved view captured automatically"
              : "Saved view captured",
          );
        }
      }

      if (result.readiness_score != null) {
        session.updateRoomScore(resolvedRoomId, result.readiness_score);
      }
    });

    let activeProcessingCount = 0;
    // processingTimeoutId is tracked via processingTimeoutIdRef (not a local let)
    // so the unmount cleanup captures the current value, not a stale null.
    comparison.onStatusChange((status, event) => {
      if (!isMountedRef.current) return;

      // Ref-counted processing: supports maxConcurrent > 1
      if (status === "processing") {
        activeProcessingCount++;
      } else {
        activeProcessingCount = Math.max(0, activeProcessingCount - 1);
      }
      setIsProcessing(activeProcessingCount > 0);

      // Safety timeout: only fires when ALL comparisons appear stuck
      if (processingTimeoutIdRef.current) {
        clearTimeout(processingTimeoutIdRef.current);
        processingTimeoutIdRef.current = null;
      }
      if (activeProcessingCount > 0) {
        processingTimeoutIdRef.current = setTimeout(() => {
          if (isMountedRef.current && activeProcessingCount > 0) {
            activeProcessingCount = 0;
            setIsProcessing(false);
            comparison.forceResetStuckComparison();
            console.warn("[InspectionCamera] isProcessing safety timeout fired after 10s");
          }
        }, 10_000);
      }
      if (status === "error") {
        showCaptureHint("Adjusting - keep scanning");
        sweepStalePendingBatchFrames(10_000);
        if (event?.comparisonId) {
          // Clean up all tracking for this failed comparison
          const pending = pendingAnalysesRef.current.get(event.comparisonId);
          if (pending) {
            analyzingBaselinesRef.current.delete(pending.baselineId);
          }
          pendingAnalysesRef.current.delete(event.comparisonId);
          verifiedComparisonIdsRef.current.delete(event.comparisonId);
        } else {
          // Fallback cleanup for older servers that don't include comparisonId on error.
          const now = Date.now();
          for (const [id, entry] of pendingAnalysesRef.current) {
            if (now - entry.startedAt > 10_000) {
              analyzingBaselinesRef.current.delete(entry.baselineId);
              pendingAnalysesRef.current.delete(id);
              verifiedComparisonIdsRef.current.delete(id);
            }
          }
        }
        // Refresh waypoint dots to clear stuck blue dots
        const currentRoom = sessionRef.current?.getState().currentRoomId;
        if (currentRoom) {
          updateCoverageUI(sessionRef.current!, currentRoom);
        }
      }
    });

    // Load baselines (also populates known conditions from the same response)
    loadBaselines(session);

    // Pre-fetch supply catalog for restock item matching
    getPropertySupplies(propertyId)
      .then((items: SupplyItem[]) => setSupplyCatalog(Array.isArray(items) ? items : []))
      .catch(() => setSupplyCatalog([]));

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
    void ensureAutoDetectModel({
      alertOnFailure: true,
      unavailableReason:
        "AI inspection requires the Atria dev build. Open the latest dev build instead of Expo Go.",
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
      if (detailHintTimerRef.current) {
        clearTimeout(detailHintTimerRef.current);
      }
      if (targetAssistTimerRef.current) {
        clearTimeout(targetAssistTimerRef.current);
      }
      if (autoDetectReloadTimerRef.current) {
        clearTimeout(autoDetectReloadTimerRef.current);
      }
      if (yoloLoadTimerRef.current) {
        clearTimeout(yoloLoadTimerRef.current);
        yoloLoadTimerRef.current = null;
      }
      if (processingTimeoutIdRef.current) {
        clearTimeout(processingTimeoutIdRef.current);
      }
      announcerRef.current.setEnabled(false);
      pendingBatchFramesRef.current.clear();
      batchAnalyzerRef.current?.dispose();
      batchAnalyzerRef.current = null;
      voiceRecorderRef.current?.dispose();
      voiceRecorderRef.current = null;
      if (evidenceTimerRef.current) {
        clearInterval(evidenceTimerRef.current);
        evidenceTimerRef.current = null;
      }
      stopYoloLoop();
      yoloModelRef.current?.dispose();
      yoloModelRef.current = null;
      itemTrackerRef.current = null;
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
        batchAnalyzerRef.current?.pause();
        if (voiceRecorderRef.current?.isRecording) {
          setIsRecordingVoice(false);
          void voiceRecorderRef.current?.cancelRecording();
        }
        if (isRecordingEvidenceRef.current) {
          evidenceRecordingCancelledRef.current = true;
          try {
            cameraRef.current?.stopRecording?.();
          } catch {
            // Ignore stop errors when the camera is already idle.
          }
          isRecordingEvidenceRef.current = false;
          setIsRecordingEvidence(false);
        }
        if (yoloLoadTimerRef.current) {
          clearTimeout(yoloLoadTimerRef.current);
          yoloLoadTimerRef.current = null;
        }
        if (autoCaptureTimerRef.current) {
          clearInterval(autoCaptureTimerRef.current);
          autoCaptureTimerRef.current = null;
        }
        if (roomDetectionTimerRef.current) {
          clearTimeout(roomDetectionTimerRef.current);
          roomDetectionTimerRef.current = null;
        }
        stopYoloLoop();
      } else if (nextAppState === "active" && appStateRef.wasBackground) {
        appStateRef.wasBackground = false;
        void (async () => {
          try {
            // Re-check camera permission against the real system state — the
            // cached hook value may be stale after the user returns from Settings.
            const latestPermission = await getPermission();
            if (!latestPermission.granted) {
              console.warn("[InspectionCamera] Camera permission revoked while backgrounded");
              Alert.alert(
                "Camera Access Required",
                "Camera permission was revoked. Please re-enable it in Settings to continue the inspection.",
                [
                  { text: "Open Settings", onPress: () => Linking.openSettings() },
                  { text: "End Inspection", style: "destructive", onPress: () => handleEndInspection() },
                ],
              );
              return;
            }

            if (!pausedRef.current) {
              motionFilterRef.current?.start();
              batchAnalyzerRef.current?.resume();

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

              if (needsAutoDetectReloadRef.current) {
                await ensureAutoDetectModel({
                  unavailableReason:
                    "AI room detection paused after low memory. Reopen the inspection if it does not recover.",
                  successHint: "AI room detection restored",
                });
              }

              // Restart room detection loop if detector exists and loop is dead
              const detector = roomDetectorRef.current;
              const session = sessionRef.current;
              if (
                detector &&
                session &&
                modelLoaderRef.current?.isLoaded &&
                !roomDetectionTimerRef.current
              ) {
                startRoomDetectionLoop(detector, session);
              }

              // Restart YOLO detection if model is loaded and timer is dead
              if (yoloModelRef.current?.isLoaded) {
                startYoloLoop();
              } else {
                scheduleYoloLoad(1000);
              }
            }
          } catch (err) {
            console.warn("[InspectionCamera] Failed to refresh camera permission on foreground:", err);
          }
        })();
      }
    };

    const subscription = AppState.addEventListener("change", handleAppStateChange);

    // Memory warning handler — reduce footprint to avoid iOS jetsam kill
    const memorySubscription = AppState.addEventListener("memoryWarning", () => {
      console.warn("[InspectionCamera] iOS memory warning received — reducing footprint");
      // Pause room detection loop (biggest memory consumer: ONNX inference + camera)
      if (roomDetectionTimerRef.current) {
        clearTimeout(roomDetectionTimerRef.current);
        roomDetectionTimerRef.current = null;
      }
      if (autoDetectReloadTimerRef.current) {
        clearTimeout(autoDetectReloadTimerRef.current);
        autoDetectReloadTimerRef.current = null;
      }
      if (yoloLoadTimerRef.current) {
        clearTimeout(yoloLoadTimerRef.current);
        yoloLoadTimerRef.current = null;
      }
      // Stop auto-capture timer to prevent comparisons while model is disposed
      if (autoCaptureTimerRef.current) {
        clearInterval(autoCaptureTimerRef.current);
        autoCaptureTimerRef.current = null;
      }
      // Pause and clear the batch analyzer's own buffered frames to free memory.
      batchAnalyzerRef.current?.pause();
      batchAnalyzerRef.current?.clearBufferedFrames();
      // Clear pending batch frames to free base64 data URIs from memory
      pendingBatchFramesRef.current.clear();
      // Also dispose YOLO model + stop its timer to free additional memory
      stopYoloLoop();
      if (yoloModelRef.current?.isLoaded) {
        yoloModelRef.current.dispose();
        yoloModelRef.current = null;
      }
      if (AppState.currentState === "active" && !pausedRef.current) {
        scheduleYoloLoad(10000);
      }
      // Dispose MobileCLIP ONNX model to free memory, then reload it once the app has a
      // chance to breathe so auto-detect is not silently lost for the session.
      if (modelLoaderRef.current?.isLoaded) {
        needsAutoDetectReloadRef.current = true;
        setIsAutoDetect(false);
        setAutoDetectUnavailableReason("Low memory - reloading AI room detection...");
        modelLoaderRef.current.dispose();
        modelLoaderRef.current = null;
        showCaptureHint("Low memory - reloading AI room detection...");
        autoDetectReloadTimerRef.current = setTimeout(() => {
          autoDetectReloadTimerRef.current = null;
          if (
            needsAutoDetectReloadRef.current &&
            AppState.currentState === "active" &&
            !pausedRef.current
          ) {
            void ensureAutoDetectModel({
              unavailableReason:
                "AI room detection paused after low memory. Reopen the inspection if it does not recover.",
              successHint: "AI room detection restored",
            });
          }
        }, 8000); // Wait 8s before reloading — gives iOS time to reclaim memory
      }
      // Force-reset any stuck comparisons to free buffered images
      comparisonRef.current?.forceResetStuckComparison();
    });

    return () => {
      subscription.remove();
      memorySubscription.remove();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const updateCoverageUI = useCallback(
    (session: SessionManager, roomId?: string) => {
      // Sweep stale analyzing entries so blue dots don't persist forever
      // (main sweep is in onVerified, but this catches cases where no new captures happen)
      const sweepNow = Date.now();
      for (const [id, entry] of pendingAnalysesRef.current) {
        if (sweepNow - entry.startedAt > 90_000) {
          analyzingBaselinesRef.current.delete(entry.baselineId);
          pendingAnalysesRef.current.delete(id);
          verifiedComparisonIdsRef.current.delete(id);
        }
      }

      const detectorCoverage = roomDetectorRef.current?.getOverallCoverage();
      setCoverage(
        Math.round(
          detectorCoverage?.averagePercentage ?? session.getOverallCoverage(),
        ),
      );
      if (roomId) {
        const state = session.getState();
        const visit = state.visitedRooms.get(roomId);
        const roomBaselines = baselinesRef.current.find(
          (r) => r.roomId === roomId,
        );

        if (visit && roomBaselines) {
          const roomProgress = roomDetectorRef.current?.getRoomProgress(roomId);
          setRoomAngles({
            scanned: roomProgress?.scanned ?? visit.anglesScanned.size,
            total:
              roomProgress?.total ??
              roomBaselines.baselines?.length ??
              0,
          });

          // Update waypoint data for CoverageTracker
          // Use completion-scanned angles so dots reflect what was actually captured,
          // not hierarchy UI credit (which inflates the count confusingly)
          const detectorScanned = new Set(roomDetectorRef.current?.getCompletionScannedAngles(roomId) || []);
          setRoomWaypoints(
            (roomBaselines.baselines || []).map((b, index) => ({
              id: b.id,
              label: getInspectionDisplayLabel(
                {
                  label: b.label,
                  roomName: roomBaselines.roomName,
                  metadata: b.metadata,
                },
                index,
              ),
              scanned: detectorScanned.has(b.id) || visit.anglesScanned.has(b.id),
              state: issueBaselinesRef.current.has(b.id)
                ? "issue_found" as WaypointState
                : analyzingBaselinesRef.current.has(b.id)
                  ? "analyzing" as WaypointState
                  : (detectorScanned.has(b.id) || visit.anglesScanned.has(b.id))
                    ? "captured" as WaypointState
                    : "pending" as WaypointState,
              previewUrl: b.previewUrl || b.imageUrl || null,
            })),
          );
        }
      }
    },
    [],
  );

  const getEffectiveOverallCoverage = useCallback((session: SessionManager): number => {
    const detectorCoverage = roomDetectorRef.current?.getOverallCoverage();
    return detectorCoverage?.averagePercentage ?? session.getOverallCoverage();
  }, []);

  const getEffectiveCompletionTier = useCallback(
    (session: SessionManager): CompletionTier => {
      const coverage = getEffectiveOverallCoverage(session);
      if (coverage >= 90) return "thorough";
      if (coverage >= 50) return "standard";
      return "minimum";
    },
    [getEffectiveOverallCoverage],
  );

  const activateRoom = useCallback(
    (session: SessionManager, roomId: string, roomName: string) => {
      // Flush batch analyzer for the previous room before switching
      const prevRoomId = session.getState().currentRoomId;
      if (prevRoomId && prevRoomId !== roomId && batchAnalyzerRef.current) {
        batchAnalyzerRef.current.onRoomTransition(prevRoomId);
      }
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

  const getNextIncompleteRoom = useCallback((_session: SessionManager) => {
    // Use detector's effective progress (cluster-aware, hierarchy-excluded)
    for (const room of baselinesRef.current) {
      if (!room.baselines?.length) continue;
      const progress = roomDetectorRef.current?.getRoomCoverage(room.roomId);
      if (!progress || progress.percentage < 100) {
        return room;
      }
    }
    return null;
  }, []);

  const autoAdvanceIfRoomComplete = useCallback(
    (session: SessionManager, roomId: string) => {
      if (!autoCaptureEnabledRef.current) return;

      // Use detector's effective progress (cluster-aware, hierarchy-excluded)
      // NOT session's raw coverage which includes hierarchy-inflated scannedAngles
      const effectiveProgress = roomDetectorRef.current?.getRoomCoverage(roomId);
      if (!effectiveProgress || effectiveProgress.percentage < 100) return;

      const nextRoom = getNextIncompleteRoom(session);
      if (!nextRoom) {
        // All rooms at 100% — show a gentle message but DON'T stop scanning.
        // The user decides when they're done. Coverage keeps running so any
        // additional angles/findings are captured.
        if (!autoAllRoomsCompleteHintRef.current) {
          showCaptureHint("Coverage complete — keep scanning for detail or tap End.");
          autoAllRoomsCompleteHintRef.current = true;
        }
        return;
      }

      if (nextRoom.roomId === roomId) return;

      // Multi-room: auto-advance to the next incomplete room
      activateRoom(session, nextRoom.roomId, nextRoom.roomName);
      autoAllRoomsCompleteHintRef.current = false;
      showCaptureHint(`Moving to ${nextRoom.roomName}`);
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

        // Load expected items into ItemTracker for YOLO-based verification
        if (itemTrackerRef.current) {
          interface ApiItem {
            id: string;
            name: string;
            category?: string | null;
            importance?: string | null;
          }
          const allExpectedItems: Array<{
            id: string;
            name: string;
            category: string;
            inventoryClass: "fixed_structural" | "durable_movable" | "decorative" | "consumable";
            importance: "critical" | "high" | "normal" | "low";
            roomId: string;
          }> = [];
          for (const room of (data.rooms || []) as Array<{ id: string; items?: ApiItem[] }>) {
            for (const item of (room.items || [])) {
              // Map training category to four-class inventory doctrine
              const cat = (item.category || "furniture").toLowerCase();
              const inventoryClass =
                ["appliance", "fixture"].includes(cat) ? "fixed_structural" as const
                : ["furniture"].includes(cat) ? "durable_movable" as const
                : ["decor", "art", "textile"].includes(cat) ? "decorative" as const
                : ["consumable", "lighting"].includes(cat) ? "consumable" as const
                : "durable_movable" as const;
              allExpectedItems.push({
                id: item.id,
                name: item.name,
                category: cat,
                inventoryClass,
                importance: (item.importance || "normal") as "critical" | "high" | "normal" | "low",
                roomId: room.id,
              });
            }
          }
          if (allExpectedItems.length > 0) {
            itemTrackerRef.current.loadExpectedItems(allExpectedItems);
          }
        }

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
        setIsInitializing(false);

        // Seed finding suppression from server feedback (cross-inspection learning).
        // Non-blocking — if it fails, the inspection still works with session-local suppression only.
        getPropertyFeedback(propertyId).then((feedback) => {
          if (!isMountedRef.current) return;
          for (const item of feedback) {
            // Only suppress findings dismissed 2+ times — matches server-side threshold.
            // Single dismissals are not yet confident enough to suppress automatically.
            if (item.action === "dismissed" && item.findingFingerprint && (item.dismissCount ?? 0) >= 2) {
              dismissedFingerprintsRef.current.add(item.findingFingerprint);
            }
          }
          if (feedback.length > 0) {
            console.log(`[Feedback] Seeded ${dismissedFingerprintsRef.current.size} suppression rules from ${feedback.length} feedback entries`);
          }
        }).catch((err) => {
          console.warn("[Feedback] Failed to load property feedback:", err);
        });
      } catch (err) {
        setIsInitializing(false);
        reportError({
          screen: "InspectionCamera",
          action: "load inspection baselines",
          errorMessage:
            err instanceof Error ? err.message : "Failed to load baselines",
          isAutomatic: true,
        });
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
            roomConfidenceRef.current = result?.room?.confidence ?? 0;

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
              const isSingleRoom = baselinesRef.current.length <= 1;

              // Dynamic threshold: easier first match, tighter after foothold established.
              // If room detection is confident (room locked), also lower the bar since
              // we know the user is in the right place.
              const roomIsConfident =
                detector.getCurrentRoom() === locked.baseline.roomId &&
                roomConfidenceRef.current >= LOCALIZATION_ROOM_SYNC_THRESHOLD;
              // First-match boost guard: for multi-room, require room detection agreement
              const firstMatchAllowed = isSingleRoom ||
                detector.getCurrentRoom() === locked.baseline.roomId;

              // Final-angle targeting: when only 1 effective angle remains in this room
              // and the locked baseline is uncredited, use the lowest threshold.
              // The user is clearly trying to capture this specific target.
              const bRoomId = locked.baseline.roomId;
              const roomCov = detector.getRoomCoverage(bRoomId);
              const completionScanned = detector.getCompletionScannedAngles(bRoomId);
              const isFinalAngle =
                roomIsConfident &&
                roomCov &&
                roomCov.total > 0 &&
                (roomCov.total - roomCov.scanned) === 1 &&
                !onDeviceCreditedRef.current.has(locked.baseline.id) &&
                !completionScanned.includes(locked.baseline.id);

              // Log when final-angle bias is active for telemetry
              if (isFinalAngle && locked.similarity >= 0.30) {
                console.log(
                  `[FinalAngle] Target ${locked.baseline.id} sim=${locked.similarity.toFixed(3)} (threshold=${ON_DEVICE_COVERAGE_THRESHOLD_FINAL_ANGLE})`,
                );
              }

              const onDeviceThreshold = isFinalAngle
                ? ON_DEVICE_COVERAGE_THRESHOLD_FINAL_ANGLE
                : !hasFirstMatchRef.current && firstMatchAllowed
                  ? ON_DEVICE_COVERAGE_THRESHOLD_FIRST_MATCH
                  : roomIsConfident
                    ? ON_DEVICE_COVERAGE_THRESHOLD_ROOM_CONFIRMED
                    : ON_DEVICE_COVERAGE_THRESHOLD_NORMAL;

              const highConfidenceWalkingMatch =
                locked.similarity >= onDeviceThreshold &&
                (isSingleRoom || gap >= LOCALIZATION_AMBIGUITY_GAP);

              if (locked.similarity < LOCALIZATION_NOT_READY_THRESHOLD) {
                setLocalizationState(
                  Date.now() < overlayGraceUntilRef.current
                    ? "localizing"
                    : "not_localized",
                );
                setLocalizationStuckSince((prev) => prev ?? Date.now());
              } else if (highConfidenceWalkingMatch) {
                setLocalizationState("localized");
                setLocalizationStuckSince(null);

                // On-device coverage credit: when embedding similarity is high enough,
                // grant coverage immediately without waiting for server round-trip.
                // Anti-stacking: require cooldown between credits for different baselines
                // to prevent one held position from farming multiple angles.
                const alreadyCredited = onDeviceCreditedRef.current.has(locked.baseline.id);
                const lastCredit = lastOnDeviceCreditRef.current;
                const isDifferentBaseline = !lastCredit || lastCredit.baselineId !== locked.baseline.id;
                const cooldownActive = isDifferentBaseline && lastCredit &&
                  (Date.now() - lastCredit.timestamp) < ON_DEVICE_CREDIT_COOLDOWN_MS;

                if (!alreadyCredited && !cooldownActive) {
                  const baselineId = locked.baseline.id;
                  const bRoomId = locked.baseline.roomId;
                  onDeviceCreditedRef.current.add(baselineId);
                  lastOnDeviceCreditRef.current = { baselineId, timestamp: Date.now() };
                  hasFirstMatchRef.current = true;

                  // Completion credit: matched baseline + cluster peers only
                  const clusterIds = detector.getClusterMembers(baselineId) || [baselineId];
                  for (const cid of clusterIds) {
                    session.recordAngleScan(bRoomId, cid);
                    detector.markAngleScanned(cid, bRoomId);
                    onDeviceCreditedRef.current.add(cid);
                  }

                  // UI-only credit: hierarchy parent/children marked in detector only
                  const hierarchy = detector.getHierarchy(baselineId);
                  if (hierarchy) {
                    if (hierarchy.parentId) {
                      detector.markAngleScanned(hierarchy.parentId, bRoomId, {
                        countsForCompletion: false,
                      });
                      onDeviceCreditedRef.current.add(hierarchy.parentId);
                    }
                    for (const childId of hierarchy.childIds) {
                      detector.markAngleScanned(childId, bRoomId, {
                        countsForCompletion: false,
                      });
                      onDeviceCreditedRef.current.add(childId);
                    }
                  }

                  // If this is an overview with detail children that were auto-credited,
                  // suggest closer inspection after a brief delay (non-blocking)
                  if (hierarchy && hierarchy.childIds.length > 0) {
                    const detailLabels = hierarchy.childIds
                      .map(cid => {
                        const bl = (baselinesRef.current.find(r => r.roomId === bRoomId)?.baselines || [])
                          .find(b => b.id === cid);
                        return bl ? getInspectionDisplayLabel({ label: bl.label, roomName: locked.baseline.roomName, metadata: bl.metadata }) : null;
                      })
                      .filter(Boolean)
                      .slice(0, 2); // Show at most 2 items
                    if (detailLabels.length > 0) {
                      // Queue a delayed hint — cancel any previous one first
                      if (detailHintTimerRef.current) clearTimeout(detailHintTimerRef.current);
                      detailHintTimerRef.current = setTimeout(() => {
                        detailHintTimerRef.current = null;
                        if (isMountedRef.current && !pausedRef.current) {
                          showCaptureHint(`Tip: Get closer to check ${detailLabels.join(", ")}`);
                        }
                      }, 5000);
                    }
                  }

                  updateCoverageUI(session, bRoomId);

                  // Show specific progress feedback so user knows exactly what happened
                  const roomProgress = detector.getRoomProgress(bRoomId);
                  const scannedCount = roomProgress.scanned;
                  const totalAngles = roomProgress.total || 1;
                  const displayLabel = getInspectionDisplayLabel({
                    label: locked.baseline.label,
                    roomName: locked.baseline.roomName,
                    metadata: locked.baseline.metadata,
                  });
                  // Milestone-aware feedback
                  const isRoomComplete = scannedCount >= totalAngles;
                  const isHalfway = scannedCount === Math.ceil(totalAngles / 2) && totalAngles > 2;
                  const isLastAngle = (totalAngles - scannedCount) === 1;

                  if (isRoomComplete) {
                    showCaptureHint("Room coverage complete ✓");
                    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                  } else if (isLastAngle) {
                    // Get the remaining angle's label for the hint
                    const remainingBaselines = (baselinesRef.current.find(r => r.roomId === bRoomId)?.baselines || [])
                      .filter(b => !onDeviceCreditedRef.current.has(b.id) && !detector.getCompletionScannedAngles(bRoomId).includes(b.id));
                    const remainingLabel = remainingBaselines.length === 1
                      ? getInspectionDisplayLabel({ label: remainingBaselines[0].label, roomName: locked.baseline.roomName, metadata: remainingBaselines[0].metadata })
                      : "1 view";
                    showCaptureHint(`${displayLabel} captured — still need: ${remainingLabel}`);
                    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                  } else if (isHalfway) {
                    showCaptureHint(`${displayLabel} captured — halfway there (${scannedCount}/${totalAngles})`);
                    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                  } else {
                    showCaptureHint(`${displayLabel} captured (${scannedCount}/${totalAngles})`);
                    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                  }
                  autoAdvanceIfRoomComplete(session, bRoomId);
                }
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

  const ensureAutoDetectModel = useCallback(
    async (options?: {
      alertOnFailure?: boolean;
      unavailableReason?: string;
      successHint?: string;
    }) => {
      if (!isMountedRef.current || isAutoDetectReloadingRef.current) return;

      isAutoDetectReloadingRef.current = true;
      needsAutoDetectReloadRef.current = false;

      try {
        const loader = await loadOnnxModel();
        if (!isMountedRef.current) {
          loader.dispose();
          return;
        }

        modelLoaderRef.current = loader;
        roomDetectorRef.current?.setModelLoader(loader);

        if (loader.isLoaded) {
          setAutoDetectUnavailableReason(null);
          setIsAutoDetect(true);
          if (options?.successHint) {
            showCaptureHint(options.successHint);
          }

          const detector = roomDetectorRef.current;
          const session = sessionRef.current;
          const comparison = comparisonRef.current;
          if (
            detector &&
            session &&
            !pausedRef.current &&
            !roomDetectionTimerRef.current
          ) {
            startRoomDetectionLoop(detector, session);
          }
          if (
            session &&
            comparison &&
            autoCaptureEnabledRef.current &&
            !pausedRef.current &&
            !autoCaptureTimerRef.current
          ) {
            autoCaptureTimerRef.current = setInterval(() => {
              void autoCapturTickRef.current?.(session, comparison);
            }, AUTO_CAPTURE_INTERVAL_MS);
          }
          return;
        }

        const reason =
          loader.unavailableReason ||
          options?.unavailableReason ||
          "AI inspection is unavailable in this app runtime.";
        setIsAutoDetect(false);
        setAutoDetectUnavailableReason(reason);
        if (options?.alertOnFailure) {
          Alert.alert("Use The Atria Dev Build", reason);
        }
      } catch (err) {
        console.warn("ONNX model load failed, room auto-detect disabled:", err);
        if (!isMountedRef.current) return;
        const fallbackMessage =
          options?.unavailableReason ||
          "AI inspection requires the Atria dev build. Open the latest dev build instead of Expo Go.";
        setIsAutoDetect(false);
        setAutoDetectUnavailableReason(fallbackMessage);
        if (options?.alertOnFailure) {
          Alert.alert("Use The Atria Dev Build", fallbackMessage);
        }
      } finally {
        isAutoDetectReloadingRef.current = false;
      }
    },
    [showCaptureHint, startRoomDetectionLoop],
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

      // Check if room is complete using detector's effective progress model
      // (cluster-aware, hierarchy-excluded from completion).
      // Keep capturing even at 100% for findings detection.
      const effectiveRoomCoverage = roomDetectorRef.current?.getRoomCoverage(currentRoomId);
      const roomComplete = effectiveRoomCoverage ? effectiveRoomCoverage.percentage >= 100 : false;
      if (roomComplete && autoCaptureEnabledRef.current) {
        autoAdvanceIfRoomComplete(session, currentRoomId);
        // Don't return — keep capturing for findings even after coverage is complete
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
          allowInitialStillFrame: (state.visitedRooms.get(currentRoomId)?.anglesScanned.size || 0) === 0,
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
      const requestKey = makeRequestKey();
      pendingBatchFramesRef.current.set(requestKey, {
        dataUri: firstCapture.dataUri,
        baselineId: selectedBaseline.id,
        baselineUrl: selectedBaseline.imageUrl,
        roomId: selectedRoomId,
        roomName: selectedRoomName,
        label: selectedBaseline.label || undefined,
        createdAt: Date.now(),
      });
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
          requestKey,
          apiUrl,
          authToken: authSession.access_token,
          clientSimilarity: rerankedTopK[0]?.similarity ?? bestSimilarity,
          topCandidateIds: rerankedTopK.slice(0, 3).map(c => c.baselineId),
          userSelectedCandidateId: userSelectedBaselineIdRef.current || undefined,
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
        batchAnalyzerRef.current?.resume();
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

        if (yoloModelRef.current?.isLoaded) {
          startYoloLoop();
        } else {
          scheduleYoloLoad(1000);
        }
      } else {
        // Pausing — stop sensors and timers to save battery
        session.pause();
        comparison.pause();
        batchAnalyzerRef.current?.pause();
        motionFilterRef.current?.stop();
        if (voiceRecorderRef.current?.isRecording || isRecordingVoice) {
          setIsRecordingVoice(false);
          void voiceRecorderRef.current?.cancelRecording();
        }

        if (autoCaptureTimerRef.current) {
          clearInterval(autoCaptureTimerRef.current);
          autoCaptureTimerRef.current = null;
        }
        if (roomDetectionTimerRef.current) {
          clearTimeout(roomDetectionTimerRef.current);
          roomDetectionTimerRef.current = null;
        }
        stopYoloLoop();
      }
      return !p;
    });
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
  }, [isRecordingVoice, scheduleYoloLoad, startRoomDetectionLoop, startYoloLoop, stopYoloLoop]);

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

  const getQueuedSubmitAlertCopy = useCallback((error: unknown) => {
    const status = error instanceof ApiError ? error.status : undefined;
    const message = error instanceof Error ? error.message : "";

    if (status === 401) {
      return {
        title: "Saved locally — sign in required",
        message:
          "Inspection results were saved on this device, but your session needs attention before they can sync. Sign in again and Atria will retry automatically.",
      };
    }

    if (status && status >= 500) {
      return {
        title: "Server busy — saved locally",
        message:
          "Inspection results were saved on this device, but the server did not finish processing them right now. Atria will retry automatically.",
      };
    }

    if (/timed out/i.test(message)) {
      return {
        title: "Sync took too long — saved locally",
        message:
          "Inspection results were saved on this device, but the upload took longer than expected. Atria will retry automatically in the background.",
      };
    }

    if (/network/i.test(message)) {
      return {
        title: "Connection issue — saved locally",
        message:
          "Inspection results were saved on this device. Atria could not reach the server just now and will retry automatically when the connection is stable.",
      };
    }

    return {
      title: "Saved locally",
      message:
        "Inspection results were saved on this device and will retry syncing automatically.",
    };
  }, []);

  const handleEndInspection = useCallback(async () => {
    if (isSubmittingRef.current) return;
    isSubmittingRef.current = true;

    const session = sessionRef.current;
    const comparison = comparisonRef.current;
    if (!session) {
      isSubmittingRef.current = false;
      navigation.replace("InspectionSummary", { inspectionId, propertyId });
      return;
    }

    // Stop new detection/capture work, but allow in-flight comparisons to finish.
    comparison?.pause();
    session.pause();
    // Flush any remaining batch frames before ending, then pause
    batchAnalyzerRef.current?.flushAllRooms();
    batchAnalyzerRef.current?.pause();
    motionFilterRef.current?.stop();
    if (autoCaptureTimerRef.current) {
      clearInterval(autoCaptureTimerRef.current);
      autoCaptureTimerRef.current = null;
    }
    if (roomDetectionTimerRef.current) {
      clearTimeout(roomDetectionTimerRef.current);
      roomDetectionTimerRef.current = null;
    }
    // Stop YOLO detection loop
    if (yoloTimerRef.current) {
      clearInterval(yoloTimerRef.current);
      yoloTimerRef.current = null;
    }
    // Stop evidence recording timer
    if (evidenceTimerRef.current) {
      clearInterval(evidenceTimerRef.current);
      evidenceTimerRef.current = null;
    }

    // Telemetry: log stubborn uncaptured baselines for future optimization
    const detector = roomDetectorRef.current;
    if (detector) {
      const state = session.getState();
      for (const [roomId, visit] of state.visitedRooms) {
        const completionScanned = new Set(detector.getCompletionScannedAngles(roomId));
        const roomEntry = baselinesRef.current.find(rb => rb.roomId === roomId);
        const roomBaselineList = roomEntry?.baselines || [];
        const uncaptured = roomBaselineList.filter(b => !completionScanned.has(b.id));
        if (uncaptured.length > 0) {
          session.recordEvent("uncaptured_baselines_at_end", roomId, {
            uncapturedCount: uncaptured.length,
            totalBaselines: roomBaselineList.length,
            capturedCount: completionScanned.size,
            uncapturedIds: uncaptured.map(b => b.id),
            uncapturedLabels: uncaptured.map(b => b.label || "unknown"),
            uncapturedTypes: uncaptured.map(b => b.metadata?.imageType || "standard"),
            inspectionDurationMs: Date.now() - (visit.enteredAt || 0),
          });
          console.log(
            `[Telemetry] Room "${visit.roomName}": ${uncaptured.length}/${roomBaselineList.length} baselines uncaptured:`,
            uncaptured.map(b => `${b.label || b.id} (${b.metadata?.imageType || "standard"})`).join(", "),
          );
        }
      }

      // Also log rooms that were never visited at all
      for (const roomEntry of baselinesRef.current) {
        if (!state.visitedRooms.has(roomEntry.roomId)) {
          session.recordEvent("unvisited_room_at_end", roomEntry.roomId, {
            roomName: roomEntry.roomName,
            totalBaselines: roomEntry.baselines.length,
          });
          console.log(
            `[Telemetry] Room "${roomEntry.roomName}" was never visited (${roomEntry.baselines.length} baselines)`,
          );
        }
      }
    }

    // Clean up stale pending analyses (>90s)
    const now = Date.now();
    for (const [id, entry] of pendingAnalysesRef.current) {
      if (now - entry.startedAt > 90_000) {
        analyzingBaselinesRef.current.delete(entry.baselineId);
        pendingAnalysesRef.current.delete(id);
        verifiedComparisonIdsRef.current.delete(id);
        console.warn(`[InspectionCamera] Stale pending analysis ${id} cleaned up after 90s`);
      }
    }

    // Give in-flight AI analyses a short chance to land — non-blocking with spinner UI.
    let pendingCount = pendingAnalysesRef.current.size;
    if (pendingCount > 0) {
      setSubmissionStatus(`Waiting on ${pendingCount} analysis${pendingCount === 1 ? "" : "es"}...`);
      // Non-blocking drain: wait up to 8s using a promise that resolves when
      // pending analyses drain OR timeout expires. No UI thread blocking.
      await new Promise<void>((resolve) => {
        const checkInterval = setInterval(() => {
          const remaining = pendingAnalysesRef.current.size;
          if (remaining > 0) {
            setSubmissionStatus(`Waiting on ${remaining} analysis${remaining === 1 ? "" : "es"}...`);
          }
          if (remaining === 0) {
            clearInterval(checkInterval);
            resolve();
          }
        }, 250);
        setTimeout(() => {
          clearInterval(checkInterval);
          resolve();
        }, 8000);
      });
      pendingCount = pendingAnalysesRef.current.size;
      if (pendingCount > 0) {
        console.warn(
          `[InspectionCamera] Ending inspection with ${pendingCount} deferred AI analysis(es). Coverage already recorded.`,
        );
        session.recordEvent("inspection_analysis_deferred", undefined, {
          pendingCount,
        });
        pendingAnalysesRef.current.clear();
        verifiedComparisonIdsRef.current.clear();
        analyzingBaselinesRef.current.clear();
      }
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
        itemType?: AddItemType;
        restockQuantity?: number;
        supplyItemId?: string;
        imageUrl?: string;
        videoUrl?: string;
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

      const findingsPayload = confirmedFindings.map((f) => ({
            id: f.id,
            description: f.description,
            severity: f.severity,
            confidence: f.confidence,
            category: f.category,
            isClaimable: f.isClaimable || false,
            source: resolveFindingSource(f),
            itemType: f.itemType,
            restockQuantity: f.restockQuantity,
            supplyItemId: f.supplyItemId,
            imageUrl: f.imageUrl,
            videoUrl: f.videoUrl,
          }));

      const scannedBaselineIds = Array.from(visit.anglesScanned);
      if (scannedBaselineIds.length > 0) {
        scannedBaselineIds.forEach((baselineId, index) => {
          results.push({
            roomId,
            baselineImageId: baselineId,
            score: index === 0 ? visit.bestScore ?? null : null,
            findings: index === 0 ? findingsPayload : [],
          });
        });
      } else {
        results.push({
          roomId,
          baselineImageId: firstBaseline.id,
          score: visit.bestScore ?? null,
          findings: findingsPayload,
        });
      }
    }

    session.recordEvent("inspection_submit_requested", undefined, {
      resultCount: results.length,
      confirmedFindings: results.reduce(
        (total, result) => total + result.findings.length,
        0,
      ),
      completionTier: getEffectiveCompletionTier(session),
    });

    const eventLog = session.getEvents();

    // Build effective coverage data for server persistence (before try so catch can use it)
    const effectiveCoverageData = {
        overall: Math.round(getEffectiveOverallCoverage(session)),
        rooms: Array.from(session.getState().visitedRooms.entries()).map(([roomId]) => {
          const progress = roomDetectorRef.current?.getRoomProgress(roomId);
          return {
            roomId,
            effectiveAnglesScanned: progress?.scanned ?? 0,
            effectiveAnglesTotal: progress?.total ?? 0,
            effectiveCoverage: progress ? Math.round(progress.percentage) : 0,
          };
        }),
    };

    // Map result IDs from server response so note deletion works from the initial summary
    let serverResultIds: Array<{ id: string; roomId: string; baselineImageId: string }> = [];
    try {
      setSubmissionStatus("Submitting results...");
      await flushBulkSubmissionQueue();
      const submitResponse = await submitBulkResults(
        inspectionId,
        results,
        getEffectiveCompletionTier(session),
        undefined,
        eventLog,
        effectiveCoverageData,
      );
      if (submitResponse?.results && Array.isArray(submitResponse.results)) {
        serverResultIds = submitResponse.results.map((r: { id: string; roomId: string; baselineImageId: string }) => ({
          id: r.id,
          roomId: r.roomId,
          baselineImageId: r.baselineImageId,
        }));
      }
    } catch (firstErr) {
      reportError({
        screen: "InspectionCamera",
        action: "submit inspection results",
        errorMessage:
          firstErr instanceof Error ? firstErr.message : "Failed to submit inspection results",
        isAutomatic: true,
      });

      // Immediate retry: if network looks reachable, try once more before queueing
      let retrySucceeded = false;
      const isAuthError = firstErr instanceof ApiError && firstErr.status === 401;
      if (!isAuthError) {
        try {
          setSubmissionStatus("Retrying...");
          const probe = new AbortController();
          const probeTimer = setTimeout(() => probe.abort(), 4000);
          await fetch("https://clients3.google.com/generate_204", {
            method: "HEAD",
            signal: probe.signal,
          });
          clearTimeout(probeTimer);

          // Network is reachable — retry the submit
          const retryResponse = await submitBulkResults(
            inspectionId,
            results,
            getEffectiveCompletionTier(session),
            undefined,
            eventLog,
            effectiveCoverageData,
          );
          if (retryResponse?.results && Array.isArray(retryResponse.results)) {
            serverResultIds = retryResponse.results.map((r: { id: string; roomId: string; baselineImageId: string }) => ({
              id: r.id,
              roomId: r.roomId,
              baselineImageId: r.baselineImageId,
            }));
          }
          retrySucceeded = true;
        } catch {
          // Retry also failed — fall through to queue
        }
      }

      if (!retrySucceeded) {
        try {
          await enqueueBulkSubmission({
            inspectionId,
            results,
            completionTier: getEffectiveCompletionTier(session),
            events: eventLog,
            effectiveCoverage: effectiveCoverageData,
          });
          const copy = getQueuedSubmitAlertCopy(firstErr);
          Alert.alert(copy.title, copy.message);
        } catch {
          setSubmissionStatus(null); // Clear stuck overlay on double-failure
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

      // Map server result IDs to findings for note deletion support
      const roomResultId = serverResultIds.find(r => r.roomId === roomId)?.id;
      // Look up component-state findings to get itemType metadata
      const componentFindings = findings;
      const roomFindings: SummaryFindingData[] = visit.findings.map((f) => {
        const componentFinding = componentFindings.find((cf) => cf.id === f.id);
        return {
          id: f.id,
          description: f.description,
          severity: f.severity,
          confidence: f.confidence,
          category: f.category,
          status: f.status,
          roomName: visit.roomName,
          source: resolveFindingSource(componentFinding ?? f),
          resultId: roomResultId,
          itemType: componentFinding?.itemType,
          restockQuantity: componentFinding?.restockQuantity,
          supplyItemId: componentFinding?.supplyItemId,
          imageUrl: componentFinding?.imageUrl,
          videoUrl: componentFinding?.videoUrl,
          evidenceItems: componentFinding?.evidenceItems,
        };
      });

      const confirmed = visit.findings.filter((f) => f.status === "confirmed");
      for (const cf of confirmed) {
        const componentFinding = componentFindings.find((f) => f.id === cf.id);
        allConfirmed.push({
          id: cf.id,
          description: cf.description,
          severity: cf.severity,
          confidence: cf.confidence,
          category: cf.category,
          roomName: visit.roomName,
          status: cf.status,
          source: resolveFindingSource(componentFinding ?? cf),
          resultId: roomResultId,
          itemType: componentFinding?.itemType,
          restockQuantity: componentFinding?.restockQuantity,
          supplyItemId: componentFinding?.supplyItemId,
          imageUrl: componentFinding?.imageUrl,
          videoUrl: componentFinding?.videoUrl,
          evidenceItems: componentFinding?.evidenceItems,
        });
      }

      const roomProgress = roomDetectorRef.current?.getRoomProgress(roomId);
      summaryRooms.push({
        roomId,
        roomName: visit.roomName,
        resultId: roomResultId,
        score: visit.bestScore,
        coverage:
          roomProgress
            ? Math.round(roomProgress.percentage)
            : anglesTotal > 0
              ? Math.round((visit.anglesScanned.size / anglesTotal) * 100)
              : 0,
        anglesScanned: roomProgress?.scanned ?? visit.anglesScanned.size,
        anglesTotal: roomProgress?.total ?? anglesTotal,
        confirmedFindings: confirmed.length,
        findings: roomFindings,
      });
    }

    const effectiveOverallCoverage = getEffectiveOverallCoverage(session);
    const summaryData: SummaryData = {
      overallScore: session.getOverallScore(),
      completionTier: getEffectiveCompletionTier(session),
      overallCoverage: Math.round(effectiveOverallCoverage),
      durationMs: session.getDurationMs(),
      inspectionMode: inspectionMode,
      rooms: summaryRooms,
      confirmedFindings: allConfirmed,
    };

    setSubmissionStatus(null);
    navigation.replace("InspectionSummary", {
      inspectionId,
      propertyId,
      summaryData,
    });
    } finally {
      isSubmittingRef.current = false;
    }
  }, [
    navigation,
    inspectionId,
    propertyId,
    inspectionMode,
    getEffectiveCompletionTier,
    getEffectiveOverallCoverage,
    getQueuedSubmitAlertCopy,
    showCaptureHint,
  ]);

  // Intercept Android hardware back button to prevent data loss
  useEffect(() => {
    const onBackPress = () => {
      // Close the Add Item overlay first if it's open
      if (showNoteModal) {
        closeNoteModal();
        return true;
      }
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
  }, [handleEndInspection, showNoteModal, closeNoteModal]);

  // Manual capture trigger
  const handleManualCapture = useCallback(async () => {
    if (!isMountedRef.current) return;
    const session = sessionRef.current;
    const comparison = comparisonRef.current;
    if (!session || !comparison || !cameraRef.current || pausedRef.current) return;
    if (isProcessingRef.current) {
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
    const requestKey = makeRequestKey();
    pendingBatchFramesRef.current.set(requestKey, {
      dataUri: firstCapture.dataUri,
      baselineId: selectedBaseline.id,
      baselineUrl: selectedBaseline.imageUrl,
      roomId: selectedRoomId,
      roomName: selectedRoomName,
      label: selectedBaseline.label || undefined,
      createdAt: Date.now(),
    });
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
        requestKey,
        apiUrl,
        authToken: authSession.access_token,
        clientSimilarity: rerankedTopK[0]?.similarity ?? locked?.similarity,
        topCandidateIds: rerankedTopK.slice(0, 3).map(c => c.baselineId),
        userSelectedCandidateId: userSelectedBaselineIdRef.current || undefined,
        refreshToken: async () => {
          const { data } = await supabase.auth.refreshSession();
          return data.session?.access_token ?? null;
        },
      },
    );
  }, [
    captureHighResFrame,
    getBaselineById,
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

    showCaptureHint(
      `Capturing ${getInspectionDisplayLabel(resolved)}...`,
    );

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
    const requestKey = makeRequestKey();
    pendingBatchFramesRef.current.set(requestKey, {
      dataUri: capturedDataUri,
      baselineId: resolved.id,
      baselineUrl: resolved.imageUrl,
      roomId: selectedRoomId,
      roomName: selectedRoomName,
      label: resolved.label || undefined,
      createdAt: Date.now(),
    });
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
        requestKey,
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
    const session = sessionRef.current;
    session?.updateFindingStatus(findingId, "confirmed");

    // Persist confirmation to server for cross-inspection learning (non-blocking)
    const state = session?.getState();
    if (state) {
      for (const visit of state.visitedRooms.values()) {
        const finding = visit.findings.find((f) => f.id === findingId);
        if (finding) {
          postFindingFeedback(propertyId, {
            inspectionId,
            roomId: visit.roomId,
            findingFingerprint: findingFingerprint(finding.category, finding.description),
            findingDescription: finding.description,
            findingCategory: finding.category,
            findingSeverity: finding.severity,
            action: "confirmed",
          }).catch((err) => {
            console.warn("[Feedback] Failed to persist confirm:", err);
          });
          break;
        }
      }
    }

    setFindings((prev) => prev.filter((f) => f.id !== findingId));
    showCaptureHint("Finding confirmed ✓");
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
  }, [showCaptureHint, propertyId, inspectionId]);

  const handleAcceptSuggestionAsItem = useCallback((findingId: string, itemType: AddItemType) => {
    const finding = findings.find((f) => f.id === findingId);
    if (!finding) return;
    // Confirm the AI finding first
    sessionRef.current?.updateFindingStatus(findingId, "confirmed");
    setFindings((prev) => prev.filter((f) => f.id !== findingId));
    // Open composer pre-filled with the suggestion
    openAddItemComposer({
      item: { ...finding, itemType } as Finding,
    });
  }, [findings, openAddItemComposer]);

  const handleDismissFinding = useCallback((findingId: string, reason?: DismissReason) => {
    const session = sessionRef.current;
    session?.updateFindingStatus(findingId, "dismissed", reason ?? undefined);

    // Record fingerprint for same-inspection suppression
    const state = session?.getState();
    if (state) {
      for (const visit of state.visitedRooms.values()) {
        const finding = visit.findings.find((f) => f.id === findingId);
        if (finding) {
          dismissedFingerprintsRef.current.add(
            findingFingerprint(finding.category, finding.description),
          );

          // Known-condition promotion: add to room's known conditions
          // so Claude Vision is told "don't alert on this" in future comparisons
          if (reason === "known_issue" || reason === "not_accurate") {
            const existing = knownConditionsByRoomRef.current.get(visit.roomId) || [];
            existing.push(finding.description);
            knownConditionsByRoomRef.current.set(visit.roomId, existing);
          }

          // Persist to server for cross-inspection learning (non-blocking)
          postFindingFeedback(propertyId, {
            inspectionId,
            roomId: visit.roomId,
            findingFingerprint: findingFingerprint(finding.category, finding.description),
            findingDescription: finding.description,
            findingCategory: finding.category,
            findingSeverity: finding.severity,
            action: "dismissed",
            dismissReason: reason ?? undefined,
          }).catch((err) => {
            console.warn("[Feedback] Failed to persist dismiss:", err);
          });
          break;
        }
      }
    }

    setFindings((prev) => prev.filter((f) => f.id !== findingId));
    const hint = reason === "not_accurate"
      ? "Dismissed — won't alert on this again"
      : reason === "still_there"
        ? "Dismissed — item is still present"
        : reason === "known_issue"
          ? "Known issue noted — won't re-alert"
          : "Finding dismissed";
    showCaptureHint(hint);
  }, [showCaptureHint]);

  const handleAddNote = useCallback((source: "camera" | "item_log" = "camera") => {
    openAddItemComposer({
      returnToLog: source === "item_log",
      defaultType: "note",
    });
  }, [openAddItemComposer]);

  const handleEditItem = useCallback((item: Finding) => {
    openAddItemComposer({
      item,
      returnToLog: true,
    });
  }, [openAddItemComposer]);

  const handleCameraComposerSubmit = useCallback(async (result: ComposerResult) => {
    const session = sessionRef.current;
    if (!session) return;
    const state = session.getState();
    const roomId = state.currentRoomId;
    if (!roomId) return;

    const typeConfig = {
      note: { category: "manual_note" as const, findingCategory: "condition" as const, severity: "maintenance" as const },
      restock: { category: "restock" as const, findingCategory: "restock" as const, severity: "cosmetic" as const },
      maintenance: { category: "operational" as const, findingCategory: "condition" as const, severity: "maintenance" as const },
      task: { category: "manual_note" as const, findingCategory: "condition" as const, severity: "cosmetic" as const },
    };

    const config = typeConfig[result.itemType];

    setIsSavingItem(true);
    try {
      const evidenceItems = [...(result.existingEvidence || [])];
      let imageUrl = evidenceItems.find((e) => e.kind === "photo")?.url;
      let videoUrl = evidenceItems.find((e) => e.kind === "video")?.url;

      for (const [index, att] of result.attachments.entries()) {
        const timestamp = Date.now();
        if (att.kind === "photo") {
          const upload = await uploadImageFile(
            att.localUri,
            propertyId,
            `inspection-item-${timestamp}-${index + 1}.jpg`,
          );
          if (!imageUrl) {
            imageUrl = upload.fileUrl;
          }
          evidenceItems.push({
            id: `photo-${timestamp}-${index + 1}`,
            kind: "photo",
            url: upload.fileUrl,
            uploadState: "uploaded",
            createdAt: new Date().toISOString(),
          });
        } else if (att.kind === "video") {
          const upload = await uploadVideoFile(
            att.localUri,
            propertyId,
            `inspection-item-${timestamp}-${index + 1}.mp4`,
          );
          if (!videoUrl) {
            videoUrl = upload.fileUrl;
          }
          evidenceItems.push({
            id: `video-${timestamp}-${index + 1}`,
            kind: "video",
            url: upload.fileUrl,
            uploadState: "uploaded",
            createdAt: new Date().toISOString(),
          });
        }
      }

      // Clean up local files
      for (const att of result.attachments) {
        FileSystem.deleteAsync(att.localUri, { idempotent: true }).catch(() => {});
      }

      const findingPayload = {
        description: result.description,
        severity: config.severity,
        confidence: 1.0,
        category: config.category,
        source: "manual_note" as const,
        findingCategory: config.findingCategory,
        isClaimable: false,
        objectClass: result.itemType === "restock" ? "consumable" : undefined,
        itemType: result.itemType,
        restockQuantity: result.itemType === "restock" ? result.quantity : undefined,
        supplyItemId: result.supplyItem?.id,
        imageUrl,
        videoUrl,
        evidenceItems: evidenceItems.length > 0 ? evidenceItems : undefined,
      };

      if (editingFindingId) {
        session.updateFindingDetails(editingFindingId, findingPayload);
        setFindings((prev) =>
          prev.map((finding) =>
            finding.id === editingFindingId
              ? {
                  ...finding,
                  ...findingPayload,
                  status: "confirmed",
                  roomName: finding.roomName || currentRoom || undefined,
                }
              : finding,
          ),
        );
      } else {
        const findingId = session.addFinding(roomId, findingPayload);
        setFindings((prev) => [
          ...prev,
          {
            id: findingId,
            description: result.description,
            severity: config.severity,
            confidence: 1.0,
            category: config.category,
            status: "confirmed",
            roomName: currentRoom || undefined,
            itemType: result.itemType,
            restockQuantity: result.itemType === "restock" ? result.quantity : undefined,
            supplyItemId: result.supplyItem?.id,
            imageUrl,
            videoUrl,
            evidenceItems: evidenceItems.length > 0 ? evidenceItems : undefined,
            source: "manual_note",
          },
        ]);
        session.updateFindingStatus(findingId, "confirmed");
      }

      Keyboard.dismiss();
      const reopenItemsLog = returnToItemsLogOnClose;
      const hintMessages = {
        note: editingFindingId ? "Note updated" : "Note added",
        restock: editingFindingId ? "Restock item updated" : "Restock item added",
        maintenance: editingFindingId ? "Maintenance item updated" : "Maintenance item added",
        task: editingFindingId ? "Task updated" : "Task added",
      };

      setShowNoteModal(false);
      setEditingFindingId(null);
      setComposerInitialValues(undefined);
      setReturnToItemsLogOnClose(false);
      if (reopenItemsLog) {
        setShowNotesLogModal(true);
      }
      showCaptureHint(hintMessages[result.itemType]);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (err) {
      // Clean up local attachment files on error to prevent temp file leaks
      for (const att of result.attachments) {
        FileSystem.deleteAsync(att.localUri, { idempotent: true }).catch(() => {});
      }
      reportError({
        screen: "InspectionCamera",
        action: "save inspection item",
        errorMessage:
          err instanceof Error ? err.message : "Saving inspection item failed",
        isAutomatic: true,
      });
      Alert.alert(
        "Could not save item",
        err instanceof Error ? err.message : "Please try again.",
      );
    } finally {
      setIsSavingItem(false);
    }
  }, [
    currentRoom,
    editingFindingId,
    propertyId,
    returnToItemsLogOnClose,
    showCaptureHint,
  ]);

  const handleDeleteNote = useCallback((findingId: string) => {
    Alert.alert(
      "Delete this item?",
      "This will permanently remove the item from this inspection.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: () => {
            sessionRef.current?.updateFindingStatus(findingId, "dismissed");
            setFindings((prev) => prev.filter((f) => f.id !== findingId));
            setExpandedItemIds((prev) => prev.filter((id) => id !== findingId));
            showCaptureHint("Item removed");
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

  const manualItems = findings.filter(
    (finding) => finding.status === "confirmed" && (finding.itemType || finding.category === "manual_note"),
  );
  const groupedManualItems = useMemo(() => {
    const groups = new Map<AddItemType, Finding[]>();
    for (const item of manualItems) {
      const resolvedType: AddItemType =
        item.itemType ||
        (item.category === "restock"
          ? "restock"
          : item.category === "operational"
            ? "maintenance"
            : "note");
      const existing = groups.get(resolvedType) || [];
      existing.push(item);
      groups.set(resolvedType, existing);
    }

    return (["restock", "maintenance", "task", "note"] as AddItemType[])
      .map((itemType) => ({
        itemType,
        items: groups.get(itemType) || [],
      }))
      .filter((group) => group.items.length > 0);
  }, [manualItems]);
  const quickAddTemplates = useMemo(
    () => getQuickAddTemplates(addItemType, currentRoom),
    [addItemType, currentRoom],
  );

  if (!permission?.granted) {
    const canAsk = permission?.canAskAgain !== false;
    return (
      <View style={styles.permissionContainer}>
        <Text style={styles.permissionText}>Camera access is required</Text>
        <Text style={[styles.permissionText, { fontSize: 14, marginBottom: spacing.md, opacity: 0.7 }]}>
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
  // Keep backward compat: manualNotes is used for button label / notes log
  const manualNotes = manualItems;
  const roomModeLabel = isAutoDetect
    ? "Auto-detect"
    : autoDetectUnavailableReason
      ? "Dev build required"
    : activeImageSource === "camera"
      ? null
      : activeImageSourceLabel;
  const remainingRoomAngles = Math.max(roomAngles.total - roomAngles.scanned, 0);
  const roomProgressSummary =
    roomAngles.total > 0
      ? remainingRoomAngles > 0
        ? `${roomAngles.scanned} of ${roomAngles.total} angles · ${remainingRoomAngles} left`
        : "Room coverage complete"
      : currentRoom
        ? "Finding saved views"
        : "Scanning for room";
  const pendingWaypoints = roomWaypoints.filter((waypoint) => !waypoint.scanned);
  const primaryPendingWaypoint = pendingWaypoints[0] ?? null;
  const suggestedFindings = findings.filter((finding) => finding.status === "suggested");
  const issueReviewPrompt =
    suggestedFindings.length > 0
      ? suggestedFindings.length === 1
        ? "⚠️ Issue found below — swipe up to review"
        : `⚠️ ${suggestedFindings.length} issues found below — swipe up to review`
      : null;
  const shouldCondenseIssuePrompt =
    !!issueReviewPrompt &&
    typeof captureHint === "string" &&
    captureHint.trim().startsWith("⚠️");
  const bottomPrompt =
    (shouldCondenseIssuePrompt ? issueReviewPrompt : captureHint) ||
    (primaryPendingWaypoint && pendingWaypoints.length === 1
      ? `Still needed: ${primaryPendingWaypoint.label || "1 remaining view"}`
      : null);
  const findingsBottomInset =
    Math.max(bottomControlsHeight, bottomPrompt ? 160 : 108) + 8;

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
                  borderRadius: radius.xxs,
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
                // Single-room: use the most meaningful baseline label available.
                const viewLabel = isMultiRoom
                  ? (baseline.roomName || `Room ${idx + 1}`)
                  : getInspectionDisplayLabel(baseline, idx);

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
      {!paused && !captureHint && localizationState !== "localized" && localizationState !== "capturing" && (() => {
        // Suppress noisy guidance when room is mostly complete — the tracker UI is sufficient
        const scannedWps = roomWaypoints.filter(w => w.scanned).length;
        const totalWps = roomWaypoints.length;
        if (totalWps > 0 && scannedWps / totalWps >= 0.8) return false;
        return true;
      })() && (
        <View style={styles.localizationGuide} pointerEvents="none">
          <Text style={styles.localizationGuideText}>
            {localizationState === "not_localized" && autoDetectUnavailableReason
              ? autoDetectUnavailableReason
              : getLocalizationGuidance(localizationState, localizationStuckSince, lockedBaselineInfo?.similarity)}
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
      <SafeAreaView style={styles.topHud} edges={["top"]}>
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
                <Text style={styles.roomName} numberOfLines={2}>
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
              <Text style={styles.angleCount} numberOfLines={2}>
                {roomProgressSummary}
              </Text>
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
              roomScannedCount={roomAngles.scanned}
              roomTotalCount={roomAngles.total}
              activeFindingCount={findings.length}
            />
          </View>
        </SafeAreaView>

        {/* Pause state */}
        {paused && (
          <View
            pointerEvents="box-none"
            style={styles.pauseBannerContainer}
          >
            <View style={styles.pauseBanner}>
              <View style={styles.pauseBadge}>
                <Ionicons name="pause" size={16} color={colors.warning} />
              </View>
              <View style={styles.pauseCopy}>
                <Text style={styles.pauseBannerTitle}>Inspection paused</Text>
                <Text style={styles.pauseBannerText}>
                  Capture is paused, but you can still add items, review findings, and change settings.
                </Text>
              </View>
              <TouchableOpacity
                style={styles.pauseResumeButton}
                onPress={handlePause}
                activeOpacity={0.8}
                accessibilityRole="button"
                accessibilityLabel="Resume inspection"
              >
                <Text style={styles.pauseResumeText}>Resume</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}

        {/* Bottom controls */}
        <SafeAreaView
          style={styles.bottomControls}
          edges={["bottom"]}
          onLayout={(event) => {
            const nextHeight = Math.ceil(event.nativeEvent.layout.height);
            setBottomControlsHeight((prevHeight) =>
              Math.abs(prevHeight - nextHeight) > 1 ? nextHeight : prevHeight,
            );
          }}
        >
          {/* AI Action Prompt Card — shows for single latest suggestion */}
          {suggestedFindings.length === 1 && (
            <AISuggestionCard
              description={suggestedFindings[0].description}
              suggestedItemType={inferItemType(suggestedFindings[0].description)}
              confidence={suggestedFindings[0].confidence}
              onAccept={(itemType) =>
                handleAcceptSuggestionAsItem(suggestedFindings[0].id, itemType)
              }
              onDismiss={() => handleDismissFinding(suggestedFindings[0].id, "not_accurate")}
            />
          )}

          {bottomPrompt && suggestedFindings.length !== 1 && (
            <View style={styles.captureHintBubble}>
              <Text style={styles.captureHintText} numberOfLines={2}>
                {bottomPrompt}
              </Text>
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
              <Ionicons name="settings-outline" size={20} color={colors.camera.textMedium} />
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

            {/* Notes button — go directly to add if no notes, otherwise show log */}
            <TouchableOpacity
              style={[styles.utilityButton, styles.utilityButtonWide]}
              onPress={() => manualNotes.length > 0 ? setShowNotesLogModal(true) : handleAddNote()}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityLabel={
                manualItems.length > 0
                  ? `${manualItems.length} inspection item${manualItems.length > 1 ? "s" : ""}`
                  : "Add an item"
              }
            >
              <Ionicons
                name="add-circle-outline"
                size={18}
                color={colors.camera.textMedium}
              />
              <Text style={styles.utilityButtonText}>
                {manualItems.length > 0 ? `Items (${manualItems.length})` : "Add Item"}
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
                color={colors.camera.textMedium}
              />
              <Text style={styles.utilityButtonText}>
                {paused ? "Resume" : "Pause"}
              </Text>
            </TouchableOpacity>
          </View>
        </SafeAreaView>

        {/* Add Item Composer — shared component replaces inline overlay */}
        <AddItemComposer
          visible={showNoteModal}
          isEditing={!!editingFindingId}
          initialValues={composerInitialValues}
          supplyCatalog={supplyCatalog}
          canTakePhoto
          canRecordVideo
          canPickFromLibrary={false}
          canDictate={voiceNotesAvailable}
          onCapturePhoto={handleCaptureEvidencePhoto}
          onCaptureVideo={handleToggleEvidenceVideo}
          onStopVideoCapture={handleStopEvidenceVideo}
          onStartDictation={async () => {
            const recorder = voiceRecorderRef.current;
            if (!recorder) return false;
            const started = await recorder.startRecording();
            if (started) setIsRecordingVoice(true);
            return started;
          }}
          onStopDictation={async () => {
            const recorder = voiceRecorderRef.current;
            if (!recorder) return null;
            setIsRecordingVoice(false);
            const result = await recorder.stopRecording();
            return result?.transcript ? { transcript: result.transcript } : null;
          }}
          isDictating={isRecordingVoice}
          onSubmit={handleCameraComposerSubmit}
          onCancel={closeNoteModal}
          isSubmitting={isSavingItem}
          roomName={currentRoom}
        />

        <Modal
          visible={showNotesLogModal}
          transparent
          animationType="fade"
          onRequestClose={() => setShowNotesLogModal(false)}
        >
          <View style={styles.noteModalOverlay}>
            <View style={styles.notesLogModalContent}>
              <View style={styles.sheetHandle} />
              <View style={styles.sheetHeader}>
                <Text style={styles.noteModalTitle}>Inspection Items</Text>
                <Text style={styles.noteModalSubtitle}>
                  {manualItems.length > 0
                    ? "Review, edit, and keep adding property needs without losing your place."
                    : "Add restock needs, repairs, tasks, and notes as you inspect."}
                </Text>
              </View>

              {manualItems.length === 0 ? (
                <View style={styles.notesLogEmptyState}>
                  <Ionicons name="list-outline" size={26} color={colors.muted} />
                  <Text style={styles.notesLogEmptyTitle}>No items yet</Text>
                  <Text style={styles.notesLogEmptyText}>
                    Add the first item to start building your restock and repair list.
                  </Text>
                </View>
              ) : (
                <ScrollView
                  style={styles.sheetBody}
                  contentContainerStyle={styles.notesLogListContent}
                  showsVerticalScrollIndicator={false}
                >
                  {groupedManualItems.map((group) => (
                    <View key={group.itemType} style={styles.itemGroupSection}>
                      <View style={styles.itemGroupHeader}>
                        <View style={styles.itemGroupTitleRow}>
                          <Ionicons
                            name={getItemTypeIcon(group.itemType)}
                            size={16}
                            color={getItemTypeAccent(group.itemType)}
                          />
                          <Text style={styles.itemGroupTitle}>
                            {ADD_ITEM_TYPE_OPTIONS.find((option) => option.key === group.itemType)?.label || "Item"}
                          </Text>
                        </View>
                        <View style={styles.itemGroupCountBadge}>
                          <Text style={styles.itemGroupCountText}>{group.items.length}</Text>
                        </View>
                      </View>

                      {group.items.map((item) => {
                        const itemType = item.itemType || group.itemType;
                        const accent = getItemTypeAccent(itemType);
                        const isExpanded = expandedItemIds.includes(item.id);
                        const quantity = item.restockQuantity || 1;
                        const headline =
                          itemType === "restock"
                            ? stripRestockQuantitySuffix(item.description)
                            : item.description;
                        const showExpand = headline.length > 90;
                        return (
                          <View key={item.id} style={styles.noteListItemCard}>
                            <View style={styles.noteListItemHeader}>
                              <View style={[styles.noteListIconWrap, { backgroundColor: `${accent}18` }]}>
                                <Ionicons name={getItemTypeIcon(itemType)} size={16} color={accent} />
                              </View>
                              <View style={styles.noteListItemBody}>
                                <Text
                                  style={styles.noteListText}
                                  numberOfLines={isExpanded ? undefined : 2}
                                >
                                  {headline}
                                </Text>
                                <View style={styles.noteListMetaRow}>
                                  <Text style={styles.noteListMetaText}>
                                    {item.roomName || currentRoom || "Current room"}
                                  </Text>
                                  {itemType === "restock" && (
                                    <View style={styles.noteListBadge}>
                                      <Text style={styles.noteListBadgeText}>Qty {quantity}</Text>
                                    </View>
                                  )}
                                  {item.supplyItemId && (
                                    <View style={styles.noteListBadge}>
                                      <Text style={styles.noteListBadgeText}>Catalog linked</Text>
                                    </View>
                                  )}
                                </View>
                                {showExpand && (
                                  <TouchableOpacity onPress={() => toggleExpandedItem(item.id)} hitSlop={8}>
                                    <Text style={styles.noteListExpandText}>
                                      {isExpanded ? "Show less" : "Show more"}
                                    </Text>
                                  </TouchableOpacity>
                                )}
                              </View>
                              {item.imageUrl ? (
                                <Image source={{ uri: item.imageUrl }} style={styles.noteListThumb} contentFit="cover" />
                              ) : item.videoUrl ? (
                                <View style={styles.noteListThumbVideo}>
                                  <Ionicons name="videocam" size={18} color={colors.primary} />
                                </View>
                              ) : null}
                            </View>

                            <View style={styles.noteListActions}>
                              <TouchableOpacity
                                onPress={() => handleEditItem(item)}
                                style={styles.noteListActionButton}
                                activeOpacity={0.7}
                              >
                                <Ionicons name="create-outline" size={14} color={colors.primary} />
                                <Text style={styles.noteListActionText}>Edit</Text>
                              </TouchableOpacity>
                              <TouchableOpacity
                                onPress={() => handleDeleteNote(item.id)}
                                style={styles.noteDeleteButton}
                                activeOpacity={0.7}
                              >
                                <Text style={styles.noteDeleteButtonText}>Delete</Text>
                              </TouchableOpacity>
                            </View>
                          </View>
                        );
                      })}
                    </View>
                  ))}
                </ScrollView>
              )}

              <View
                style={[
                  styles.sheetFooter,
                  { paddingBottom: Math.max(insets.bottom, 16) },
                ]}
              >
                <TouchableOpacity
                  style={[styles.noteModalSubmit, { flex: 0, marginBottom: spacing.sm }]}
                  onPress={() => handleAddNote("item_log")}
                  activeOpacity={0.8}
                >
                  <Text style={styles.noteModalSubmitText}>+ Add Item</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.noteModalCancel, { flex: 0 }]}
                  onPress={() => setShowNotesLogModal(false)}
                  activeOpacity={0.8}
                >
                  <Text style={styles.noteModalCancelText}>Done</Text>
                </TouchableOpacity>
              </View>
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
            <View style={styles.sheetHandle} />
            <View style={styles.sheetHeader}>
              <Text style={styles.noteModalTitle}>Inspection Settings</Text>
              <Text style={styles.noteModalSubtitle}>
                Adjust how the inspection runs
              </Text>
            </View>

            <View style={{ paddingHorizontal: spacing.screen, paddingBottom: spacing.screen }}>
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
                    color={autoCaptureEnabled ? colors.category.restock : colors.muted}
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
                  thumbColor={colors.primaryForeground}
                  trackColor={{
                    false: colors.camera.pillBorder,
                    true: colors.successBorder,
                  }}
                />
              </View>

              <View style={styles.settingsRow}>
                <View style={styles.settingsRowLeft}>
                  <Ionicons
                    name="locate-outline"
                    size={20}
                    color={isAutoDetect ? colors.category.restock : colors.muted}
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
              style={[styles.noteModalSubmit, { flex: 0 }]}
              onPress={() => setShowSettingsModal(false)}
            >
              <Text style={styles.noteModalSubmitText}>Done</Text>
            </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* Findings Panel */}
      <FindingsPanel
        findings={suggestedFindings}
        onConfirm={handleConfirmFinding}
        onDismiss={handleDismissFinding}
        bottomInset={findingsBottomInset}
      />

      {/* Loading overlay — shown while baselines are loading */}
      {isInitializing && (
        <View style={styles.submissionOverlay}>
          <View style={styles.submissionCard}>
            <Ionicons name="scan-outline" size={28} color={colors.primary} />
            <Text style={styles.submissionText}>Preparing inspection...</Text>
            <Text style={styles.submissionSubtext}>Loading room data and AI models</Text>
          </View>
        </View>
      )}

      {/* Submission overlay — replaces blocking wait loop */}
      {submissionStatus && (
        <View style={styles.submissionOverlay}>
          <View style={styles.submissionCard}>
            <ActivityIndicator size="large" color={colors.primary} />
            <Text style={styles.submissionText}>{submissionStatus}</Text>
            <Text style={styles.submissionSubtext}>Coverage is already saved</Text>
          </View>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.camera.background,
  },
  submissionOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: colors.camera.overlay,
    justifyContent: "center",
    alignItems: "center",
    zIndex: 100,
  },
  submissionCard: {
    backgroundColor: colors.camera.sheetBg,
    borderRadius: 20,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.section,
    alignItems: "center",
    gap: spacing.content,
    borderWidth: 1,
    borderColor: colors.camera.borderSubtle,
  },
  submissionText: {
    color: colors.camera.text,
    fontSize: 16,
    fontWeight: "600",
  },
  submissionSubtext: {
    color: colors.camera.textMuted,
    fontSize: 13,
  },
  zoomIndicator: {
    position: "absolute",
    bottom: "45%",
    alignSelf: "center",
    backgroundColor: colors.camera.overlay,
    borderRadius: radius.xl,
    paddingHorizontal: spacing.card,
    paddingVertical: spacing.tight,
    zIndex: 5,
    borderWidth: 1,
    borderColor: colors.camera.borderSubtle,
  },
  zoomText: {
    color: colors.camera.text,
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
    alignItems: "flex-start",
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
    gap: spacing.content,
  },
  endButton: {
    backgroundColor: colors.camera.overlay,
    borderRadius: radius.lg,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.card,
    minHeight: 44,
    borderWidth: 1,
    borderColor: colors.camera.borderSubtle,
    flexShrink: 0,
  },
  endButtonText: {
    color: colors.camera.text,
    fontSize: 15,
    fontWeight: "600",
  },
  roomBadge: {
    backgroundColor: colors.camera.panelBg,
    borderRadius: 14,
    paddingHorizontal: spacing.container,
    paddingVertical: spacing.content,
    alignItems: "flex-start",
    borderWidth: 1,
    borderColor: colors.primaryBorder,
    flex: 1,
    minWidth: 0,
  },
  roomBadgeHeader: {
    flexDirection: "row",
    alignItems: "flex-start",
    flexWrap: "wrap",
    gap: spacing.sm,
    width: "100%",
  },
  roomName: {
    color: colors.camera.text,
    fontSize: 17,
    fontWeight: "700",
    flexShrink: 1,
    minWidth: 0,
  },
  detectModeBadge: {
    backgroundColor: colors.camera.panelBorder,
    borderRadius: radius.full,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xxs,
  },
  detectModeBadgeAuto: {
    backgroundColor: colors.primaryBgStrong,
  },
  detectModeText: {
    color: colors.camera.textBody,
    fontSize: 9,
    fontWeight: "600",
    letterSpacing: 0.4,
  },
  angleCount: {
    color: colors.camera.textAccent,
    fontSize: 12,
    marginTop: spacing.tight,
    fontWeight: "600",
    width: "100%",
  },
  recBadge: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    backgroundColor: colors.camera.panelBg,
    borderRadius: radius.full,
    paddingHorizontal: spacing.element,
    paddingVertical: spacing.tight,
    gap: 5,
    borderWidth: 1,
    borderColor: colors.camera.itemBorder,
    flexShrink: 0,
  },
  recDot: {
    width: 7,
    height: 7,
    borderRadius: radius.full,
    backgroundColor: colors.error,
  },
  recDotProcessing: {
    backgroundColor: colors.primary,
  },
  recText: {
    color: colors.camera.textMedium,
    fontSize: 11,
    fontWeight: "600",
    letterSpacing: 0.4,
  },
  coverageRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: spacing.md,
    marginTop: spacing.element,
    gap: spacing.sm,
  },
  pauseBannerContainer: {
    position: "absolute",
    top: 112,
    left: spacing.md,
    right: spacing.md,
    zIndex: 25,
  },
  pauseBanner: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: spacing.content,
    paddingHorizontal: spacing.card,
    paddingVertical: spacing.content,
    borderRadius: radius.xl,
    backgroundColor: colors.camera.sheetBg,
    borderWidth: 1,
    borderColor: colors.camera.borderSubtle,
  },
  pauseBadge: {
    width: 32,
    height: 32,
    borderRadius: radius.full,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.warningBg,
    borderWidth: 1,
    borderColor: colors.warningBg,
  },
  pauseCopy: {
    flex: 1,
    gap: spacing.xxs,
  },
  pauseBannerTitle: {
    color: colors.camera.text,
    fontSize: 15,
    fontWeight: "700",
  },
  pauseBannerText: {
    color: colors.camera.textMuted,
    fontSize: 12,
    lineHeight: 18,
  },
  pauseResumeButton: {
    alignSelf: "center",
    paddingHorizontal: spacing.content,
    paddingVertical: spacing.sm,
    borderRadius: radius.full,
    backgroundColor: colors.primaryBgStrong,
    borderWidth: 1,
    borderColor: colors.primaryBorder,
  },
  pauseResumeText: {
    color: colors.primary,
    fontSize: 13,
    fontWeight: "700",
  },
  bottomControls: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    paddingBottom: spacing.sm,
    zIndex: 10,
  },
  captureRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-evenly",
    paddingHorizontal: spacing.content,
    gap: spacing.content,
  },
  captureHintBubble: {
    marginBottom: spacing.content,
    marginHorizontal: spacing.md,
    backgroundColor: colors.camera.sheetBg,
    borderRadius: radius.lg,
    paddingHorizontal: spacing.card,
    paddingVertical: spacing.element,
    borderWidth: 1,
    borderColor: colors.camera.pillBorder,
  },
  captureHintText: {
    color: colors.camera.text,
    fontSize: 14,
    fontWeight: "600",
  },
  captureButton: {
    width: 76,
    height: 76,
    borderRadius: radius.full,
    backgroundColor: colors.camera.borderMedium,
    justifyContent: "center",
    alignItems: "center",
    borderWidth: 2,
    borderColor: colors.camera.borderPreview,
  },
  captureButtonProcessing: {
    opacity: 0.5,
  },
  captureRing: {
    width: 58,
    height: 58,
    borderRadius: radius.full,
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
    minHeight: 44,
    gap: spacing.xs,
  },
  utilityButtonWide: {
    width: 88,
  },
  utilityButtonText: {
    color: colors.camera.textMuted,
    fontSize: 11,
    fontWeight: "500",
    letterSpacing: 0.2,
  },
  noteModalOverlay: {
    flex: 1,
    justifyContent: "flex-end",
    backgroundColor: colors.camera.overlay,
  },
  sheetContent: {
    backgroundColor: colors.card,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    maxHeight: "88%",
    borderWidth: 1,
    borderColor: colors.stone,
    flexShrink: 1,
  },
  notesLogModalContent: {
    backgroundColor: colors.card,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    borderWidth: 1,
    borderColor: colors.stone,
    maxHeight: "82%",
  },
  sheetHandle: {
    alignSelf: "center",
    width: 40,
    height: 5,
    borderRadius: radius.full,
    backgroundColor: colors.stone,
    marginTop: spacing.element,
    marginBottom: spacing.tight,
  },
  sheetHeader: {
    paddingHorizontal: spacing.screen,
    paddingTop: spacing.xs,
    paddingBottom: spacing.content,
  },
  sheetContextBadge: {
    alignSelf: "flex-start",
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.tight,
    marginTop: 2,
  },
  sheetContextText: {
    color: colors.muted,
    fontSize: 11,
    fontWeight: "500",
  },
  sheetBody: {
    flex: 1,
  },
  sheetBodyContent: {
    paddingHorizontal: spacing.screen,
    paddingBottom: spacing.xl,
    gap: spacing.card,
  },
  sheetFooter: {
    paddingHorizontal: spacing.screen,
    paddingTop: spacing.content,
    borderTopWidth: 1,
    borderTopColor: colors.stone,
    backgroundColor: colors.card,
  },
  addItemChipRow: {
    flexDirection: "row",
    gap: spacing.sm,
    flexWrap: "wrap",
  },
  addItemChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.tight,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.card,
    borderRadius: radius.full,
    borderWidth: 1,
  },
  addItemChipText: {
    fontWeight: "600",
    fontSize: 13,
  },
  inlineHelperBanner: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: spacing.sm,
    padding: spacing.content,
    borderRadius: radius.lg,
    backgroundColor: colors.successBg,
    borderWidth: 1,
    borderColor: colors.successBorder,
  },
  inlineHelperText: {
    flex: 1,
    color: colors.success,
    fontSize: 13,
    lineHeight: 18,
    fontWeight: "500",
  },
  inlineHelperBannerMuted: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: spacing.sm,
    padding: spacing.content,
    borderRadius: radius.lg,
    backgroundColor: colors.secondary,
    borderWidth: 1,
    borderColor: colors.stone,
  },
  inlineHelperMutedText: {
    flex: 1,
    color: colors.muted,
    fontSize: 13,
    lineHeight: 18,
  },
  inlineHelperLinkButton: {
    alignSelf: "flex-start",
    paddingHorizontal: spacing.element,
    paddingVertical: spacing.tight,
    borderRadius: radius.full,
    backgroundColor: colors.primaryBgStrong,
  },
  inlineHelperLinkText: {
    color: colors.primary,
    fontSize: 12,
    fontWeight: "700",
  },
  quickTemplatesSection: {
    gap: spacing.sm,
  },
  quickTemplateRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.sm,
  },
  quickTemplateChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.tight,
    paddingHorizontal: spacing.element,
    paddingVertical: spacing.sm,
    borderRadius: radius.full,
    backgroundColor: colors.secondary,
    borderWidth: 1,
    borderColor: colors.stone,
  },
  quickTemplateText: {
    color: colors.heading,
    fontSize: 13,
    fontWeight: "600",
  },
  sectionMiniLabel: {
    color: colors.muted,
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 0.4,
    textTransform: "uppercase",
  },
  selectedSupplyCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    backgroundColor: colors.successBg,
    borderRadius: radius.md,
    padding: spacing.element,
    borderWidth: 1,
    borderColor: colors.successBorder,
  },
  selectedSupplyName: {
    color: colors.heading,
    fontSize: 14,
    fontWeight: "600",
  },
  selectedSupplyMeta: {
    color: colors.muted,
    fontSize: 11,
  },
  voiceButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.sm,
    paddingVertical: spacing.element,
    paddingHorizontal: spacing.md,
    borderRadius: radius.full,
    backgroundColor: colors.primaryBg,
    alignSelf: "center",
  },
  voiceButtonActive: {
    backgroundColor: colors.destructive,
  },
  voiceButtonText: {
    color: colors.primary,
    fontWeight: "600",
    fontSize: 14,
  },
  voiceButtonTextActive: {
    color: colors.camera.text,
  },
  inputSection: {
    gap: spacing.sm,
  },
  quantityRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: colors.secondary,
    borderRadius: radius.lg,
    paddingHorizontal: spacing.card,
    paddingVertical: spacing.content,
    borderWidth: 1,
    borderColor: colors.stone,
  },
  quantityLabel: {
    color: colors.heading,
    fontSize: 14,
    fontWeight: "600",
  },
  quantityControls: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.content,
  },
  quantityButton: {
    width: 32,
    height: 32,
    borderRadius: radius.full,
    backgroundColor: colors.primaryBg,
    alignItems: "center",
    justifyContent: "center",
  },
  quantityValue: {
    minWidth: 24,
    textAlign: "center",
    color: colors.heading,
    fontSize: 18,
    fontWeight: "700",
  },
  evidenceSection: {
    gap: spacing.element,
    padding: spacing.card,
    borderRadius: 14,
    backgroundColor: colors.secondary,
    borderWidth: 1,
    borderColor: colors.stone,
  },
  evidenceHeader: {
    gap: spacing.xs,
  },
  evidenceSubtext: {
    color: colors.muted,
    fontSize: 13,
    lineHeight: 18,
  },
  evidenceActionsRow: {
    flexDirection: "row",
    gap: spacing.element,
    flexWrap: "wrap",
  },
  evidenceAction: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.tight,
    paddingHorizontal: spacing.content,
    paddingVertical: spacing.element,
    borderRadius: radius.md,
    backgroundColor: colors.primaryBgStrong,
    borderWidth: 1,
    borderColor: colors.primaryBorder,
  },
  evidenceActionDanger: {
    backgroundColor: colors.destructive,
    borderColor: colors.destructive,
  },
  evidenceActionText: {
    color: colors.primary,
    fontSize: 13,
    fontWeight: "600",
  },
  evidenceActionTextDanger: {
    color: colors.camera.text,
  },
  attachmentCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.element,
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.stone,
    padding: spacing.element,
  },
  attachmentPreview: {
    width: 58,
    height: 58,
    borderRadius: radius.md,
    backgroundColor: colors.stone,
  },
  videoAttachmentBadge: {
    width: 58,
    height: 58,
    borderRadius: radius.md,
    backgroundColor: colors.primaryBgStrong,
    alignItems: "center",
    justifyContent: "center",
  },
  attachmentTitle: {
    color: colors.heading,
    fontSize: 14,
    fontWeight: "600",
  },
  attachmentMeta: {
    color: colors.muted,
    fontSize: 12,
    marginTop: spacing.xxs,
  },
  attachmentRemoveButton: {
    width: 32,
    height: 32,
    borderRadius: radius.full,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.errorBg,
  },
  notesLogEmptyState: {
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.element,
    paddingHorizontal: spacing.lg,
    paddingVertical: 36,
  },
  notesLogEmptyTitle: {
    color: colors.heading,
    fontSize: 16,
    fontWeight: "600",
  },
  notesLogEmptyText: {
    color: colors.muted,
    fontSize: 14,
    fontWeight: "500",
    textAlign: "center",
    lineHeight: 20,
  },
  notesLogListContent: {
    paddingHorizontal: spacing.screen,
    paddingBottom: spacing.md,
    gap: spacing.md,
  },
  itemGroupSection: {
    gap: spacing.element,
  },
  itemGroupHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  itemGroupTitleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  itemGroupTitle: {
    color: colors.heading,
    fontSize: 15,
    fontWeight: "700",
  },
  itemGroupCountBadge: {
    minWidth: 24,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderRadius: radius.full,
    backgroundColor: colors.secondary,
    alignItems: "center",
  },
  itemGroupCountText: {
    color: colors.muted,
    fontSize: 12,
    fontWeight: "700",
  },
  noteListItemCard: {
    backgroundColor: colors.secondary,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.stone,
    padding: spacing.content,
    gap: spacing.element,
  },
  noteListItemHeader: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: spacing.element,
  },
  noteListIconWrap: {
    width: 30,
    height: 30,
    borderRadius: radius.full,
    alignItems: "center",
    justifyContent: "center",
    marginTop: spacing.xxs,
  },
  noteListItemBody: {
    flex: 1,
    gap: spacing.tight,
  },
  noteListText: {
    color: colors.foreground,
    fontSize: 14,
    fontWeight: "500",
    lineHeight: 20,
  },
  noteListMetaRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.sm,
    alignItems: "center",
  },
  noteListMetaText: {
    color: colors.muted,
    fontSize: 12,
    fontWeight: "500",
  },
  noteListBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderRadius: radius.full,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.stone,
  },
  noteListBadgeText: {
    color: colors.primary,
    fontSize: 11,
    fontWeight: "600",
  },
  noteListExpandText: {
    color: colors.primary,
    fontSize: 12,
    fontWeight: "600",
  },
  noteListThumb: {
    width: 52,
    height: 52,
    borderRadius: radius.md,
    backgroundColor: colors.card,
  },
  noteListThumbVideo: {
    width: 52,
    height: 52,
    borderRadius: radius.md,
    backgroundColor: colors.card,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: colors.stone,
  },
  noteListActions: {
    flexDirection: "row",
    justifyContent: "flex-start",
    alignItems: "center",
    gap: spacing.sm,
  },
  noteListActionButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.tight,
    paddingHorizontal: spacing.element,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    backgroundColor: colors.primaryBgStrong,
  },
  noteListActionText: {
    color: colors.primary,
    fontSize: 13,
    fontWeight: "600",
  },
  noteDeleteButton: {
    backgroundColor: colors.errorBg,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.errorBorder,
    paddingHorizontal: spacing.element,
    paddingVertical: spacing.tight,
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
    marginBottom: spacing.xs,
  },
  noteModalSubtitle: {
    color: colors.muted,
    fontSize: 14,
    marginBottom: spacing.md,
  },
  noteInput: {
    backgroundColor: colors.secondary,
    borderRadius: radius.lg,
    padding: spacing.md,
    color: colors.foreground,
    fontSize: 16,
    minHeight: 104,
    textAlignVertical: "top",
    borderWidth: 1,
    borderColor: colors.stone,
  },
  noteModalButtons: {
    flexDirection: "row",
    gap: spacing.content,
  },
  noteModalCancel: {
    flex: 1,
    backgroundColor: colors.secondary,
    borderRadius: radius.lg,
    paddingVertical: spacing.card,
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
    borderRadius: radius.lg,
    paddingVertical: spacing.card,
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
    gap: spacing.element,
    marginBottom: spacing.md,
  },
  settingsRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: colors.secondary,
    borderRadius: radius.lg,
    padding: spacing.card,
    borderWidth: 1,
    borderColor: colors.stone,
  },
  settingsRowActive: {
    borderColor: colors.successBorder,
  },
  settingsRowLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.content,
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
    marginTop: spacing.xxs,
    flexShrink: 1,
  },
  settingsActionButton: {
    backgroundColor: colors.primaryBgStrong,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.primaryBorder,
    paddingHorizontal: spacing.content,
    paddingVertical: spacing.element,
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
    padding: spacing.xl,
  },
  permissionText: {
    color: colors.camera.text,
    fontSize: 18,
    textAlign: "center",
    marginBottom: spacing.screen,
  },
  permissionButton: {
    backgroundColor: colors.primary,
    borderRadius: 14,
    paddingHorizontal: spacing.section,
    paddingVertical: spacing.card,
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
    left: spacing.md,
    right: spacing.md,
    zIndex: 6,
    alignItems: "center",
    gap: spacing.sm,
  },
  targetAssistLabel: {
    color: colors.camera.text,
    fontSize: 12,
    fontWeight: "600",
    backgroundColor: colors.camera.overlay,
    borderRadius: radius.full,
    paddingHorizontal: spacing.content,
    paddingVertical: spacing.tight,
  },
  ambiguousThumbnails: {
    flexDirection: "row",
    gap: spacing.content,
    backgroundColor: colors.camera.overlayCard,
    borderRadius: radius.md,
    padding: spacing.sm,
  },
  ambiguousThumb: {
    alignItems: "center",
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.camera.borderLight,
    padding: spacing.tight,
    backgroundColor: colors.camera.overlayCard,
  },
  ambiguousThumbSelected: {
    borderColor: colors.camera.dotScannedLabel,
    backgroundColor: colors.successBg,
  },
  ambiguousThumbImage: {
    width: 100,
    height: 75,
    borderRadius: 6,
  },
  ambiguousThumbRoomBadge: {
    position: "absolute",
    top: spacing.sm,
    left: spacing.sm,
    backgroundColor: colors.camera.overlay,
    borderRadius: radius.xs,
    paddingHorizontal: 5,
    paddingVertical: spacing.xxs,
  },
  ambiguousThumbRoomText: {
    color: colors.camera.textBright,
    fontSize: 9,
    fontWeight: "600",
    maxWidth: 80,
  },
  ambiguousThumbLabel: {
    color: colors.camera.textHigh,
    fontSize: 10,
    fontWeight: "500",
    marginTop: spacing.xs,
    textAlign: "center" as const,
    maxWidth: 100,
  },
  ambiguousThumbHint: {
    color: colors.camera.textMedium,
    fontSize: 9,
    fontWeight: "500",
    marginTop: spacing.xxs,
  },
  localizationGuide: {
    position: "absolute",
    bottom: "30%",
    alignSelf: "center",
    backgroundColor: colors.camera.overlayCard,
    borderRadius: radius.lg,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    zIndex: 4,
    maxWidth: "82%",
  },
  localizationGuideText: {
    color: colors.camera.textBright,
    fontSize: 13,
    fontWeight: "500",
    textAlign: "center" as const,
  },
});

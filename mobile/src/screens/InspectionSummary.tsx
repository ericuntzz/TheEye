/**
 * InspectionSummary.tsx — Post-Inspection Report
 *
 * Shows the results of a completed inspection:
 * - Overall readiness score
 * - Completion tier + coverage
 * - Duration
 * - Room-by-room scores + findings
 * - Confirmed findings grouped by severity
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Alert,
  Linking,
  AppState,
  type AppStateStatus,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useNavigation, useRoute } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import type { RouteProp } from "@react-navigation/native";
import type { RootStackParamList, SummaryData, SummaryFindingData } from "../navigation";
import {
  getInspection,
  deleteInspectionFinding,
  updateInspectionFinding,
  addInspectionFinding,
  createRestockOrder,
  reportError,
  uploadImageFile,
  uploadVideoFile,
  resolveRoomAnchor,
} from "../lib/api";
import { colors, radius, fontSize, spacing } from "../lib/tokens";
import { Ionicons } from "@expo/vector-icons";
import AddItemComposer from "../components/AddItemComposer";
import type { ComposerResult, ComposerInitialValues } from "../components/AddItemComposer";
import { getItemTypeAccent, getItemTypeIcon, getItemTypeConfig } from "../lib/inspection/composer-utils";
import { serializeDraftForServer, normalizeFindingFromServer, createEmptyDraft } from "../lib/inspection/item-helpers";
import type { AddItemType, FindingEvidenceItem, InspectionItemDraft } from "../lib/inspection/item-types";
import { enqueueFindingMutation, flushFindingMutationQueue } from "../lib/inspection/offline-finding-queue";

type Nav = NativeStackNavigationProp<RootStackParamList, "InspectionSummary">;
type Route = RouteProp<RootStackParamList, "InspectionSummary">;

const SEVERITY_COLORS: Record<string, string> = {
  cosmetic: colors.slate500,
  maintenance: colors.warning,
  safety: colors.primary,
  urgent_repair: colors.error,
  guest_damage: colors.purple,
};

const SEVERITY_LABELS: Record<string, string> = {
  cosmetic: "Cosmetic",
  maintenance: "Maintenance",
  safety: "Safety",
  urgent_repair: "Urgent Repair",
  guest_damage: "Guest Damage",
};

const MODE_LABELS: Record<string, string> = {
  turnover: "Turnover",
  maintenance: "Maintenance",
  owner_arrival: "Owner Arrival",
  vacancy_check: "Vacancy Check",
};

type ImagePickerModule = typeof import("expo-image-picker");

let imagePickerModulePromise: Promise<ImagePickerModule | null> | null = null;

async function getImagePickerModule(): Promise<ImagePickerModule | null> {
  if (!imagePickerModulePromise) {
    imagePickerModulePromise = import("expo-image-picker").catch((error) => {
      reportError({
        screen: "InspectionSummary",
        action: "load expo-image-picker",
        errorMessage:
          error instanceof Error
            ? error.message
            : "Failed to load expo-image-picker",
        isAutomatic: true,
      });
      return null;
    });
  }

  return imagePickerModulePromise;
}

function resolveSummaryFindingSource(finding: {
  category?: string;
  source?: "manual_note" | "ai";
}): "manual_note" | "ai" {
  if (finding.source) {
    return finding.source;
  }
  return ["manual_note", "restock", "operational"].includes(
    finding.category || "",
  )
    ? "manual_note"
    : "ai";
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m ${seconds}s`;
}

function getScoreColor(score: number | null): string {
  if (score === null) return colors.muted;
  if (score >= 90) return colors.success;
  if (score >= 70) return colors.warning;
  if (score >= 50) return colors.primary;
  return colors.error;
}

function getTierLabel(tier: string): string {
  switch (tier) {
    case "thorough":
      return "Thorough";
    case "standard":
      return "Standard";
    case "minimum":
      return "Minimum";
    default:
      return tier;
  }
}

function getTierColor(tier: string): string {
  switch (tier) {
    case "thorough":
      return colors.success;
    case "standard":
      return colors.primary;
    default:
      return colors.slate300;
  }
}

function removeFindingFromSummary(
  summary: SummaryData,
  findingId: string,
): SummaryData {
  const nextRooms = summary.rooms.map((room) => {
    const nextFindings = room.findings.filter((finding) => finding.id !== findingId);
    return {
      ...room,
      findings: nextFindings,
      confirmedFindings: nextFindings.filter((finding) => finding.status !== "dismissed").length,
    };
  });

  return {
    ...summary,
    rooms: nextRooms,
    confirmedFindings: summary.confirmedFindings.filter((finding) => finding.id !== findingId),
  };
}

function updateFindingInSummary(
  summary: SummaryData,
  findingId: string,
  updates: Partial<SummaryFindingData>,
): SummaryData {
  const nextRooms = summary.rooms.map((room) => ({
    ...room,
    findings: room.findings.map((f) =>
      f.id === findingId ? { ...f, ...updates } : f,
    ),
  }));

  return {
    ...summary,
    rooms: nextRooms,
    confirmedFindings: summary.confirmedFindings.map((f) =>
      f.id === findingId ? { ...f, ...updates } : f,
    ),
  };
}

function addFindingToSummary(
  summary: SummaryData,
  finding: SummaryFindingData,
  roomId: string,
): SummaryData {
  let roomMatched = false;
  const nextRooms = summary.rooms.map((room) => {
    if (room.roomId !== roomId) return room;
    roomMatched = true;
    const nextFindings = [...room.findings, finding];
    return {
      ...room,
      findings: nextFindings,
      confirmedFindings: nextFindings.filter((f) => f.status !== "dismissed").length,
    };
  });

  if (!roomMatched) {
    return summary;
  }

  return {
    ...summary,
    rooms: nextRooms,
    confirmedFindings: [...summary.confirmedFindings, finding],
  };
}

function getFindingPreviewMedia(
  finding?: Pick<
    SummaryFindingData,
    "imageUrl" | "videoUrl" | "evidenceItems"
  > | null,
): { imageUrl?: string; videoUrl?: string } {
  if (!finding) {
    return {};
  }

  const firstPhoto =
    finding.evidenceItems?.find((item) => item.kind === "photo")?.url;
  const firstVideo =
    finding.evidenceItems?.find((item) => item.kind === "video")?.url;

  return {
    imageUrl: finding.imageUrl || firstPhoto,
    videoUrl: finding.videoUrl || firstVideo,
  };
}

interface QueuedFindingPayload extends Record<string, unknown> {
  resultId: string;
  findingId?: string;
  findingIndex?: number;
  localFindingId?: string;
  description: string;
  severity?: string;
  category?: string;
  itemType?: string;
  restockQuantity?: number;
  supplyItemId?: string;
  imageUrl?: string | null;
  videoUrl?: string | null;
  evidenceItems?: Array<{
    id: string;
    kind: "photo" | "video";
    url: string;
    thumbnailUrl?: string;
    durationMs?: number;
    createdAt?: string;
  }>;
  source?: string;
  derivedFromFindingId?: string | null;
  derivedFromComparisonId?: string | null;
  origin?: string;
  attachmentLocalUri?: string;
  attachmentKind?: "photo" | "video";
  attachmentDurationMs?: number;
  roomId?: string; // For offline replay: resolve room anchor when reconnecting
}

function draftToSummaryFinding(
  draft: InspectionItemDraft,
  options: {
    id: string;
    roomName: string;
    resultId?: string;
    findingIndex?: number;
    status?: string;
    confidence?: number;
  },
): SummaryFindingData {
  const serialized = serializeDraftForServer(draft);
  const previewPhoto =
    draft.attachments.find((item) => item.kind === "photo")?.localUri ||
    draft.attachments.find((item) => item.kind === "photo")?.url;
  const previewVideo =
    draft.attachments.find((item) => item.kind === "video")?.localUri ||
    draft.attachments.find((item) => item.kind === "video")?.url;

  return {
    id: options.id,
    description: draft.description,
    severity: draft.severity,
    confidence: options.confidence ?? 1,
    category: draft.category,
    roomName: options.roomName,
    status: options.status ?? "confirmed",
    source: draft.source,
    resultId: options.resultId,
    findingIndex: options.findingIndex,
    itemType: draft.itemType,
    restockQuantity: draft.restockQuantity,
    supplyItemId: draft.supplyItemId,
    imageUrl:
      previewPhoto ||
      (typeof serialized.imageUrl === "string" ? serialized.imageUrl : undefined),
    videoUrl:
      previewVideo ||
      (typeof serialized.videoUrl === "string" ? serialized.videoUrl : undefined),
    evidenceItems: draft.attachments,
    derivedFromFindingId: draft.derivedFromFindingId,
    derivedFromComparisonId: draft.derivedFromComparisonId,
    origin: draft.origin,
  };
}

function mapInspectionToSummary(payload: {
  inspectionMode?: string;
  completionTier?: string | null;
  readinessScore?: number | null;
  startedAt?: string | null;
  completedAt?: string | null;
  /** Persisted effective coverage from the detector model at completion time */
  effectiveCoverage?: {
    overall?: number;
    rooms?: Array<{
      roomId: string;
      effectiveAnglesScanned: number;
      effectiveAnglesTotal: number;
      effectiveCoverage: number;
    }>;
  } | null;
  rooms?: Array<{
    id: string;
    name: string;
    baselineImages?: Array<{ id: string }>;
  }>;
  results?: Array<{
    id: string;
    roomId: string;
    baselineImageId: string;
    score: number | null;
    findings?: Array<{
      id?: string;
      description?: string;
      severity?: string;
      confidence?: number;
      category?: string;
      status?: string;
      source?: "manual_note" | "ai";
      itemType?: "note" | "restock" | "maintenance" | "task";
      restockQuantity?: number;
      supplyItemId?: string;
      imageUrl?: string;
      videoUrl?: string;
      evidenceItems?: FindingEvidenceItem[];
      derivedFromFindingId?: string;
      derivedFromComparisonId?: string;
      origin?: "manual" | "ai_prompt_accept" | "template";
    }>;
  }>;
}): SummaryData {
  const rooms = payload.rooms || [];
  const results = payload.results || [];

  const roomMeta = new Map(
    rooms.map((room) => [
      room.id,
      {
        roomName: room.name,
        anglesTotal: room.baselineImages?.length || 0,
      },
    ]),
  );

  const roomBuckets = new Map<
    string,
    {
      resultId?: string;
      baselineIds: Set<string>;
      scores: number[];
      findings: SummaryFindingData[];
    }
  >();

  for (const result of results) {
    const bucket = roomBuckets.get(result.roomId) || {
      resultId: undefined,
      baselineIds: new Set<string>(),
      scores: [],
      findings: [],
    };
    bucket.resultId = bucket.resultId || result.id;
    bucket.baselineIds.add(result.baselineImageId);
    if (typeof result.score === "number") {
      bucket.scores.push(result.score);
    }

    const roomName = roomMeta.get(result.roomId)?.roomName || "Room";
    (result.findings || []).forEach((finding, findingIndex) => {
      const findingId =
        typeof finding.id === "string" && finding.id.length > 0
          ? finding.id
          : `${result.id}-${findingIndex}`;

      bucket.findings.push({
        id: findingId,
        description: finding.description || "Untitled finding",
        severity: finding.severity || "maintenance",
        confidence:
          typeof finding.confidence === "number" ? finding.confidence : 1,
        category: finding.category || "manual_note",
        roomName,
        status: finding.status || "confirmed",
        source: resolveSummaryFindingSource(finding),
        resultId: result.id,
        findingIndex,
        itemType: finding.itemType,
        restockQuantity: finding.restockQuantity,
        supplyItemId: finding.supplyItemId,
        imageUrl: finding.imageUrl,
        videoUrl: finding.videoUrl,
        evidenceItems: finding.evidenceItems,
        derivedFromFindingId: finding.derivedFromFindingId,
        derivedFromComparisonId: finding.derivedFromComparisonId,
        origin: finding.origin,
      });
    });

    roomBuckets.set(result.roomId, bucket);
  }

  const summaryRooms = rooms.map((room) => {
    const bucket = roomBuckets.get(room.id) || {
      resultId: undefined,
      baselineIds: new Set<string>(),
      scores: [],
      findings: [],
    };
    // Use persisted effective coverage when available (matches live inspection numbers).
    // Falls back to raw baseline count for inspections completed before this feature.
    const effectiveRoom = payload.effectiveCoverage?.rooms?.find(r => r.roomId === room.id);
    const anglesTotal = effectiveRoom?.effectiveAnglesTotal ?? (room.baselineImages?.length || 0);
    const anglesScanned = effectiveRoom
      ? effectiveRoom.effectiveAnglesScanned
      : Math.min(anglesTotal, bucket.baselineIds.size);
    const score =
      bucket.scores.length > 0
        ? bucket.scores.reduce((sum, value) => sum + value, 0) /
          bucket.scores.length
        : null;
    const coverage = effectiveRoom
      ? effectiveRoom.effectiveCoverage
      : anglesTotal > 0 ? Math.round((anglesScanned / anglesTotal) * 100) : 0;

    return {
      roomId: room.id,
      roomName: room.name,
      resultId: bucket.resultId,
      score,
      coverage,
      anglesScanned,
      anglesTotal,
      confirmedFindings: bucket.findings.filter((f) => f.status !== "dismissed").length,
      findings: bucket.findings.filter((f) => f.status !== "dismissed"),
    };
  });

  const allFindings = summaryRooms.flatMap((room) => room.findings);
  const totalAngles = summaryRooms.reduce(
    (sum, room) => sum + room.anglesTotal,
    0,
  );
  const totalScannedAngles = summaryRooms.reduce(
    (sum, room) => sum + room.anglesScanned,
    0,
  );
  const overallCoverage = payload.effectiveCoverage?.overall != null
    ? payload.effectiveCoverage.overall
    : totalAngles > 0 ? Math.round((totalScannedAngles / totalAngles) * 100) : 0;
  const startedAt = payload.startedAt ? new Date(payload.startedAt).getTime() : null;
  const completedAt = payload.completedAt ? new Date(payload.completedAt).getTime() : null;
  const durationMs =
    startedAt && completedAt && completedAt > startedAt
      ? completedAt - startedAt
      : 0;

  return {
    overallScore: payload.readinessScore ?? null,
    completionTier: payload.completionTier || "minimum",
    overallCoverage,
    durationMs,
    inspectionMode: payload.inspectionMode || "turnover",
    rooms: summaryRooms,
    confirmedFindings: allFindings,
  };
}

const DEFAULT_SUMMARY: SummaryData = {
  overallScore: null,
  completionTier: "minimum",
  overallCoverage: 0,
  durationMs: 0,
  inspectionMode: "turnover",
  rooms: [],
  confirmedFindings: [],
};

export default function InspectionSummaryScreen() {
  const navigation = useNavigation<Nav>();
  const route = useRoute<Route>();
  const { summaryData, inspectionId, propertyId } = route.params;

  const [data, setData] = useState<SummaryData>(summaryData || DEFAULT_SUMMARY);
  const [loading, setLoading] = useState(!summaryData);
  const [error, setError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [composerVisible, setComposerVisible] = useState(false);
  const [composerMode, setComposerMode] = useState<"edit" | "add">("add");
  const [composerFinding, setComposerFinding] = useState<SummaryFindingData | null>(null);
  const [isSubmittingComposer, setIsSubmittingComposer] = useState(false);
  const isFlushingQueueRef = useRef(false);

  // editInputRef removed — composer handles its own input
  const hasData = data.rooms.length > 0 || data.confirmedFindings.length > 0;

  useEffect(() => {
    setData(summaryData || DEFAULT_SUMMARY);
    setLoading(!summaryData);
    setError(null);
  }, [summaryData]);

  const reloadInspection = useCallback(async () => {
    const inspectionPayload = await getInspection(inspectionId);
    setData(mapInspectionToSummary(inspectionPayload));
  }, [inspectionId]);

  useEffect(() => {
    if (summaryData || !inspectionId) return;

    let cancelled = false;
    const load = async () => {
      try {
        setLoading(true);
        setError(null);
        const inspectionPayload = await getInspection(inspectionId);
        if (cancelled) return;
        setData(mapInspectionToSummary(inspectionPayload));
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof Error
              ? err.message
              : "Failed to load inspection details",
          );
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [inspectionId, summaryData]);

  const buildDraftFromComposer = useCallback(
    async (
      result: ComposerResult,
      options: {
        existingFinding?: SummaryFindingData | null;
        roomId?: string;
        roomName?: string;
        uploadLocalAttachment: boolean;
      },
    ): Promise<InspectionItemDraft> => {
      const config = getItemTypeConfig(result.itemType);
      const roomContext = {
        roomId: options.roomId,
        roomName: options.roomName || options.existingFinding?.roomName,
      };

      const draft = options.existingFinding
        ? normalizeFindingFromServer(options.existingFinding, roomContext)
        : createEmptyDraft(result.itemType, roomContext);

      draft.itemType = result.itemType;
      draft.category = config.category as InspectionItemDraft["category"];
      draft.severity = config.severity as InspectionItemDraft["severity"];
      draft.description = result.description;
      draft.restockQuantity =
        result.itemType === "restock" ? result.quantity : undefined;
      draft.supplyItemId = result.supplyItem?.id;
      draft.source = "manual_note";

      if (!options.existingFinding) {
        draft.origin = draft.origin || "manual";
      }

      // Preserve existing evidence that the user kept
      const preservedEvidence: FindingEvidenceItem[] = (result.existingEvidence || []).map((ev) => ({
        ...ev,
        uploadState: ev.uploadState || "uploaded",
      }));

      // Handle new attachments
      const newAttachments = result.attachments || [];
      if (newAttachments.length > 0) {
        const createdAt = new Date().toISOString();

        if (!options.uploadLocalAttachment) {
          // Offline: store as pending
          const pending: FindingEvidenceItem[] = newAttachments.map((att, i) => ({
            id: `local-evidence-${Date.now()}-${i}`,
            kind: att.kind,
            localUri: att.localUri,
            uploadState: "pending" as const,
            createdAt,
          }));
          draft.attachments = [...preservedEvidence, ...pending];
          return draft;
        }

        // Online: upload each new attachment
        const uploadResults = await Promise.allSettled(
          newAttachments.map(async (att, i) => {
            const uploadResult =
              att.kind === "photo"
                ? await uploadImageFile(
                    att.localUri,
                    propertyId,
                    `finding-photo-${Date.now()}-${i}.jpg`,
                  )
                : await uploadVideoFile(
                    att.localUri,
                    propertyId,
                    `finding-video-${Date.now()}-${i}.mp4`,
                  );

            const uploadedUrl =
              typeof uploadResult?.fileUrl === "string" && uploadResult.fileUrl.length > 0
                ? uploadResult.fileUrl
                : null;

            if (!uploadedUrl) {
              throw new Error(`Attachment ${i} upload did not return a file URL`);
            }

            return {
              id: `evidence-${Date.now()}-${i}`,
              kind: att.kind,
              url: uploadedUrl,
              thumbnailUrl: att.kind === "photo" ? uploadedUrl : undefined,
              uploadState: "uploaded" as const,
              createdAt,
            } as FindingEvidenceItem;
          }),
        );

        const uploaded = uploadResults
          .filter((r): r is PromiseFulfilledResult<FindingEvidenceItem> => r.status === "fulfilled")
          .map((r) => r.value);

        if (uploaded.length === 0 && newAttachments.length > 0) {
          throw new Error("All attachment uploads failed");
        }

        draft.attachments = [...preservedEvidence, ...uploaded];
        return draft;
      }

      // No new attachments — just preserve existing
      draft.attachments = preservedEvidence;
      return draft;
    },
    [propertyId],
  );

  const buildQueuedPayload = useCallback(
    (
      resultId: string,
      draft: InspectionItemDraft,
      extras?: Partial<QueuedFindingPayload>,
    ): QueuedFindingPayload => {
      const payload = {
        resultId,
        ...serializeDraftForServer(draft),
        ...extras,
      } as QueuedFindingPayload;

      const pendingAttachment = draft.attachments.find(
        (item) => item.localUri && item.uploadState !== "uploaded",
      );
      if (pendingAttachment?.localUri) {
        payload.attachmentLocalUri = pendingAttachment.localUri;
        payload.attachmentKind = pendingAttachment.kind;
        payload.attachmentDurationMs = pendingAttachment.durationMs;
      }

      return payload;
    },
    [],
  );

  const hydrateQueuedPayloadForReplay = useCallback(
    async (payload: QueuedFindingPayload): Promise<QueuedFindingPayload> => {
      if (!payload.attachmentLocalUri || !payload.attachmentKind) {
        return payload;
      }

      const uploadResult =
        payload.attachmentKind === "photo"
          ? await uploadImageFile(
              payload.attachmentLocalUri,
              propertyId,
              `finding-photo-${Date.now()}.jpg`,
            )
          : await uploadVideoFile(
              payload.attachmentLocalUri,
              propertyId,
              `finding-video-${Date.now()}.mp4`,
            );

      const uploadedUrl =
        typeof uploadResult?.fileUrl === "string" && uploadResult.fileUrl.length > 0
          ? uploadResult.fileUrl
          : null;

      if (!uploadedUrl) {
        throw new Error("Queued attachment upload did not return a file URL");
      }

      const createdAt = new Date().toISOString();
      const evidenceItems = [
        {
          id: `evidence-${Date.now()}`,
          kind: payload.attachmentKind,
          url: uploadedUrl,
          thumbnailUrl:
            payload.attachmentKind === "photo" ? uploadedUrl : undefined,
          durationMs:
            payload.attachmentKind === "video"
              ? payload.attachmentDurationMs
              : undefined,
          createdAt,
        },
      ];

      return {
        ...payload,
        imageUrl: payload.attachmentKind === "photo" ? uploadedUrl : null,
        videoUrl: payload.attachmentKind === "video" ? uploadedUrl : null,
        evidenceItems,
      };
    },
    [propertyId],
  );

  const flushQueuedFindingMutations = useCallback(async () => {
    if (isFlushingQueueRef.current) {
      return;
    }

    isFlushingQueueRef.current = true;
    const resolvedFindingIds = new Map<string, string>();

    try {
      const result = await flushFindingMutationQueue(async (mutation) => {
        const rawPayload = mutation.payload as QueuedFindingPayload;
        const hydratedPayload = await hydrateQueuedPayloadForReplay(rawPayload);
        const {
          localFindingId,
          attachmentLocalUri: _attachmentLocalUri,
          attachmentKind: _attachmentKind,
          attachmentDurationMs: _attachmentDurationMs,
          ...serverPayload
        } = hydratedPayload;

        if (mutation.type === "add") {
          // If a roomId was stored, resolve the room anchor for a canonical target
          const roomId = typeof serverPayload.roomId === "string" ? serverPayload.roomId : undefined;
          let targetResultId = serverPayload.resultId;
          if (roomId) {
            try {
              const { anchorId } = await resolveRoomAnchor(mutation.inspectionId, roomId);
              targetResultId = anchorId;
            } catch {
              // Anchor resolution failed — fall back to existing resultId
            }
          }
          const { roomId: _roomId, ...addPayload } = serverPayload;
          const response = await addInspectionFinding(
            mutation.inspectionId,
            { ...addPayload, resultId: targetResultId } as Parameters<typeof addInspectionFinding>[1],
          );
          if (localFindingId && typeof response?.finding?.id === "string") {
            resolvedFindingIds.set(localFindingId, response.finding.id);
          }
          return;
        }

        const resolvedFindingId =
          (localFindingId && resolvedFindingIds.get(localFindingId)) ||
          (typeof serverPayload.findingId === "string"
            ? serverPayload.findingId
            : undefined);

        if (mutation.type === "edit") {
          if (!resolvedFindingId && !Number.isInteger(serverPayload.findingIndex)) {
            return;
          }
          await updateInspectionFinding(mutation.inspectionId, {
            ...(serverPayload as Parameters<typeof updateInspectionFinding>[1]),
            ...(resolvedFindingId ? { findingId: resolvedFindingId } : {}),
          });
          return;
        }

        if (!resolvedFindingId && !Number.isInteger(serverPayload.findingIndex)) {
          return;
        }

        await deleteInspectionFinding(mutation.inspectionId, {
          resultId: serverPayload.resultId,
          ...(resolvedFindingId ? { findingId: resolvedFindingId } : {}),
          ...(Number.isInteger(serverPayload.findingIndex)
            ? { findingIndex: serverPayload.findingIndex as number }
            : {}),
        });
      });

      if (result.flushed > 0) {
        await reloadInspection();
      }
    } catch (err) {
      reportError({
        screen: "InspectionSummary",
        action: "flush queued finding mutations",
        errorMessage:
          err instanceof Error
            ? err.message
            : "Failed to replay queued finding mutations",
        isAutomatic: true,
      });
    } finally {
      isFlushingQueueRef.current = false;
    }
  }, [hydrateQueuedPayloadForReplay, reloadInspection]);

  useEffect(() => {
    if (!inspectionId) {
      return;
    }
    void flushQueuedFindingMutations();
  }, [inspectionId, flushQueuedFindingMutations]);

  useEffect(() => {
    const handleAppStateChange = (nextState: AppStateStatus) => {
      if (nextState === "active") {
        void flushQueuedFindingMutations();
      }
    };

    const subscription = AppState.addEventListener("change", handleAppStateChange);
    return () => {
      subscription.remove();
    };
  }, [flushQueuedFindingMutations]);

  const handleDeleteNote = useCallback(
    (finding: SummaryFindingData) => {
      Alert.alert(
        "Delete Note",
        "Remove this note from inspection details?",
        [
          { text: "Cancel", style: "cancel" },
          {
            text: "Delete",
            style: "destructive",
            onPress: async () => {
              // Capture the pre-delete snapshot via functional setter
              let previous: SummaryData | null = null;
              setData((current) => {
                previous = current;
                return removeFindingFromSummary(current, finding.id);
              });
              setDeletingId(finding.id);
              try {
                if (finding.resultId) {
                  await deleteInspectionFinding(inspectionId, {
                    resultId: finding.resultId,
                    findingId: finding.id,
                    findingIndex: finding.findingIndex,
                  });
                }
              } catch (err) {
                // Queue for offline retry — keep the optimistic delete
                try {
                  await enqueueFindingMutation("delete", inspectionId, {
                    resultId: finding.resultId,
                    findingId: finding.id,
                    findingIndex: finding.findingIndex,
                    localFindingId: finding.id,
                  });
                  // Don't revert — mutation is queued
                } catch {
                  // Queue also failed — revert
                  if (previous) setData(previous);
                }
                Alert.alert(
                  "Saved offline",
                  "Delete will sync when connection is restored.",
                );
              } finally {
                setDeletingId(null);
              }
            },
          },
        ],
      );
    },
    [inspectionId],
  );

  const handleEditNote = useCallback(
    (finding: SummaryFindingData) => {
      setComposerFinding(finding);
      setComposerMode("edit");
      setComposerVisible(true);
    },
    [],
  );

  const handleAddItem = useCallback(() => {
    if (data.rooms.length === 0) {
      Alert.alert("Cannot Add Item", "No rooms are available to attach an item to.");
      return;
    }

    setComposerFinding(null);
    setComposerMode("add");
    setComposerVisible(true);
  }, [data.rooms]);

  const handleComposerSubmit = useCallback(async (result: ComposerResult) => {
    setIsSubmittingComposer(true);

    try {
      if (composerMode === "edit" && composerFinding) {
        if (!composerFinding.resultId) {
          Alert.alert("Update failed", "This item is missing a result reference.");
          return;
        }

        let previous: SummaryData | null = null;

        try {
          const persistedDraft = await buildDraftFromComposer(result, {
            existingFinding: composerFinding,
            roomName: composerFinding.roomName,
            uploadLocalAttachment: true,
          });
          const persistedPayload = serializeDraftForServer(persistedDraft);

          await updateInspectionFinding(inspectionId, {
            ...(persistedPayload as Omit<
              Parameters<typeof updateInspectionFinding>[1],
              "resultId" | "findingId" | "findingIndex"
            >),
            resultId: composerFinding.resultId,
            findingId: composerFinding.id,
            findingIndex: composerFinding.findingIndex,
          });

          setData((current) => {
            previous = current;
            return updateFindingInSummary(
              current,
              composerFinding.id,
              draftToSummaryFinding(persistedDraft, {
                id: composerFinding.id,
                roomName: composerFinding.roomName,
                resultId: composerFinding.resultId,
                findingIndex: composerFinding.findingIndex,
                status: composerFinding.status,
                confidence: composerFinding.confidence,
              }),
            );
          });
          setComposerVisible(false);
        } catch (err) {
          try {
            const queuedDraft = await buildDraftFromComposer(result, {
              existingFinding: composerFinding,
              roomName: composerFinding.roomName,
              uploadLocalAttachment: false,
            });

            await enqueueFindingMutation(
              "edit",
              inspectionId,
              buildQueuedPayload(composerFinding.resultId, queuedDraft, {
                findingId: composerFinding.id,
                findingIndex: composerFinding.findingIndex,
                localFindingId: composerFinding.id,
              }),
            );

            setData((current) => {
              previous = current;
              return updateFindingInSummary(
                current,
                composerFinding.id,
                draftToSummaryFinding(queuedDraft, {
                  id: composerFinding.id,
                  roomName: composerFinding.roomName,
                  resultId: composerFinding.resultId,
                  findingIndex: composerFinding.findingIndex,
                  status: composerFinding.status,
                  confidence: composerFinding.confidence,
                }),
              );
            });
            setComposerVisible(false);
            Alert.alert(
              "Saved offline",
              "Edit will sync when connection is restored.",
            );
          } catch {
            if (previous) {
              setData(previous);
            }
            Alert.alert(
              "Update failed",
              err instanceof Error ? err.message : "Failed to update item",
            );
          }
        }
      } else if (composerMode === "add") {
        // Find target room — prefer first room with results, fallback to first room
        const roomWithResult = data.rooms.find((room) => room.resultId);
        const targetRoomId = roomWithResult?.roomId || data.rooms[0]?.roomId || "";
        const targetRoomName =
          roomWithResult?.roomName || data.rooms[0]?.roomName || "General";

        if (!targetRoomId) {
          Alert.alert(
            "Cannot Add Item",
            "No rooms are available to attach an item to.",
          );
          return;
        }

        try {
          // Resolve room anchor — get-or-create a dedicated result row for manual items
          const { anchorId } = await resolveRoomAnchor(inspectionId, targetRoomId);

          const persistedDraft = await buildDraftFromComposer(result, {
            roomId: targetRoomId,
            roomName: targetRoomName,
            uploadLocalAttachment: true,
          });
          const persistedPayload = serializeDraftForServer(persistedDraft);

          const apiResult = await addInspectionFinding(inspectionId, {
            ...(persistedPayload as Omit<
              Parameters<typeof addInspectionFinding>[1],
              "resultId"
            >),
            resultId: anchorId,
          });

          const newFinding = draftToSummaryFinding(persistedDraft, {
            id: apiResult.finding?.id || `${anchorId}-${Date.now()}`,
            roomName: targetRoomName,
            resultId: anchorId,
            findingIndex: apiResult.findingIndex,
          });

          setData((current) =>
            addFindingToSummary(current, newFinding, targetRoomId),
          );
          setComposerVisible(false);
        } catch (err) {
          // Offline fallback — use any available resultId for the queued mutation
          const fallbackResultId =
            roomWithResult?.resultId ||
            data.confirmedFindings.find((finding) => finding.resultId)?.resultId;

          try {
            const queuedDraft = await buildDraftFromComposer(result, {
              roomId: targetRoomId,
              roomName: targetRoomName,
              uploadLocalAttachment: false,
            });
            const tempId = `temp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
            const estimatedIndex = data.confirmedFindings.filter(
              (finding) => finding.resultId === (fallbackResultId || ""),
            ).length;

            await enqueueFindingMutation(
              "add",
              inspectionId,
              buildQueuedPayload(fallbackResultId || targetRoomId, queuedDraft, {
                localFindingId: tempId,
                // Store roomId so offline replay can resolve anchor when online
                roomId: targetRoomId,
              }),
            );

            const tempFinding = draftToSummaryFinding(queuedDraft, {
              id: tempId,
              roomName: targetRoomName,
              resultId: fallbackResultId || targetRoomId,
              findingIndex: estimatedIndex,
            });

            setData((current) =>
              addFindingToSummary(current, tempFinding, targetRoomId),
            );
            setComposerVisible(false);
            Alert.alert(
              "Saved offline",
              "Item will sync when connection is restored.",
            );
          } catch {
            Alert.alert(
              "Add failed",
              err instanceof Error ? err.message : "Failed to add item",
            );
          }
        }
      }
    } finally {
      setIsSubmittingComposer(false);
    }
  }, [
    composerMode,
    composerFinding,
    inspectionId,
    data.rooms,
    data.confirmedFindings,
    buildDraftFromComposer,
    buildQueuedPayload,
  ]);

  // Group confirmed findings by item type (for type-aware rendering)
  const findingsByType = useMemo(() => {
    const typeOrder: AddItemType[] = ["maintenance", "task", "restock", "note"];
    const groups: Record<string, typeof data.confirmedFindings> = {};
    for (const f of data.confirmedFindings) {
      const itemType = (f.itemType as AddItemType) || "note";
      if (!groups[itemType]) groups[itemType] = [];
      groups[itemType].push(f);
    }
    const sorted: Array<[AddItemType, typeof data.confirmedFindings]> = [];
    for (const t of typeOrder) {
      if (groups[t] && groups[t].length > 0) sorted.push([t, groups[t]]);
    }
    return sorted;
  }, [data.confirmedFindings]);

  // Extract restock items from confirmed findings
  const restockItems = useMemo(() => {
    return data.confirmedFindings.filter(
      (f) => f.category === "restock",
    );
  }, [data.confirmedFindings]);

  const [creatingOrder, setCreatingOrder] = useState(false);

  const handleCreateRestockOrder = useCallback(async () => {
    if (restockItems.length === 0) return;
    setCreatingOrder(true);
    try {
      const order = await createRestockOrder(propertyId, {
        inspectionId,
        items: restockItems.map((item) => {
          // Use structured quantity if available, fall back to regex parse from description
          const qtyMatch = item.description.match(/\(qty:\s*(\d+)\)$/);
          const quantity = item.restockQuantity || (qtyMatch ? parseInt(qtyMatch[1], 10) : 1);
          const name = qtyMatch
            ? item.description.replace(/\s*\(qty:\s*\d+\)$/, "").trim()
            : item.description;
          return {
            name,
            quantity,
            roomName: item.roomName,
            source: item.source === "ai" ? "ai" : "manual",
            supplyItemId: item.supplyItemId,
          };
        }),
      });

      if (order.amazonCartUrl) {
        Alert.alert(
          "Restock Order Created",
          "Open Amazon with all items in your cart?",
          [
            { text: "Later", style: "cancel" },
            {
              text: "Open Amazon Cart",
              onPress: () => void Linking.openURL(order.amazonCartUrl),
            },
          ],
        );
      } else {
        Alert.alert(
          "Restock Order Created",
          "Items saved. Add Amazon ASINs in the web app to generate cart links.",
        );
      }
    } catch (err) {
      reportError({
        screen: "InspectionSummary",
        action: "create restock order",
        errorMessage:
          err instanceof Error ? err.message : "Failed to create restock order",
        isAutomatic: true,
      });
      Alert.alert("Error", "Failed to create restock order. Please try again.");
    } finally {
      setCreatingOrder(false);
    }
  }, [restockItems, propertyId, inspectionId]);

  const scoreDisplay = data.overallScore !== null
    ? Math.round(data.overallScore)
    : "--";

  const scoreColor = getScoreColor(data.overallScore);

  if (loading) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.loadingState}>
          <ActivityIndicator size="large" color={colors.primary} />
          <Text style={styles.loadingText}>Loading inspection details...</Text>
        </View>
      </SafeAreaView>
    );
  }

  if (error) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.loadingState}>
          <Text style={styles.errorTitle}>Unable to load inspection details</Text>
          <Text style={styles.errorBody}>{error}</Text>
          <View style={{ flexDirection: "row", gap: spacing.content, marginTop: spacing.xs }}>
            <TouchableOpacity
              style={[styles.completeButton, { flex: 1, backgroundColor: colors.primary }]}
              onPress={() => {
                setError(null);
                setLoading(true);
                void (async () => {
                  try {
                    const payload = await getInspection(inspectionId);
                    setData(mapInspectionToSummary(payload));
                  } catch (err) {
                    setError(err instanceof Error ? err.message : "Failed to load inspection details");
                  } finally {
                    setLoading(false);
                  }
                })();
              }}
              activeOpacity={0.8}
            >
              <Text style={styles.completeButtonText}>Retry</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.completeButton, { flex: 1 }]}
              onPress={() => navigation.goBack()}
              activeOpacity={0.8}
            >
              <Text style={styles.completeButtonText}>Back</Text>
            </TouchableOpacity>
          </View>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        {/* Header */}
        <Text style={styles.title}>Inspection Complete</Text>
        <View style={styles.headerRow}>
          <View style={styles.modeBadge}>
            <Text style={styles.modeText}>
              {MODE_LABELS[data.inspectionMode] || data.inspectionMode}
            </Text>
          </View>
          {hasData && (
            <Text style={styles.durationText}>
              {formatDuration(data.durationMs)}
            </Text>
          )}
        </View>

        {/* Score Card */}
        <View style={styles.scoreCard}>
          <Text style={styles.scoreLabel}>READINESS SCORE</Text>
          <Text style={[styles.scoreValue, { color: scoreColor }]}>
            {scoreDisplay}
          </Text>
          <Text style={styles.scoreSubtext}>
            {data.overallScore !== null
              ? data.overallScore >= 90
                ? "Excellent condition"
                : data.overallScore >= 70
                  ? "Good with minor issues"
                  : data.overallScore >= 50
                    ? "Needs attention"
                    : "Significant issues found"
              : data.rooms.length > 0
                ? data.overallCoverage > 0 || data.rooms.some(r => r.anglesScanned > 0)
                  ? "Coverage captured; AI scoring unavailable"
                  : "No captured views yet"
                : "No comparisons run"}
          </Text>
          {/* Score bar */}
          {data.overallScore !== null && (
            <View style={styles.scoreBarContainer}>
              <View style={styles.scoreBar}>
                <View
                  style={[
                    styles.scoreBarFill,
                    {
                      width: `${Math.min(100, data.overallScore)}%`,
                      backgroundColor: scoreColor,
                    },
                  ]}
                />
              </View>
            </View>
          )}
        </View>

        {/* Coverage Stats */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Coverage</Text>
          <View style={styles.statsGrid}>
            <View style={styles.statItem}>
              <Text style={styles.statItemLabel}>Completion</Text>
              <Text
                style={[
                  styles.statItemValue,
                  { color: getTierColor(data.completionTier) },
                ]}
              >
                {getTierLabel(data.completionTier)}
              </Text>
            </View>
            <View style={styles.statItem}>
              <Text style={styles.statItemLabel}>Rooms</Text>
              <Text style={styles.statItemValue}>{data.rooms.length}</Text>
            </View>
            <View style={styles.statItem}>
              <Text style={styles.statItemLabel}>Coverage</Text>
              <Text style={styles.statItemValue}>{data.overallCoverage}%</Text>
            </View>
            <View style={styles.statItem}>
              <Text style={styles.statItemLabel}>Findings</Text>
              <Text
                style={[
                  styles.statItemValue,
                  data.confirmedFindings.length > 0 && { color: colors.primary },
                ]}
              >
                {data.confirmedFindings.length}
              </Text>
            </View>
          </View>
        </View>

        {/* Room-by-Room Breakdown */}
        {data.rooms.length > 0 && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Room Details</Text>
            {data.rooms.map((room) => (
              <View key={room.roomId} style={styles.roomCard}>
                <View style={styles.roomHeader}>
                  <Text style={styles.roomName}>{room.roomName}</Text>
                  {room.score !== null && (
                    <View
                      style={[
                        styles.roomScoreBadge,
                        {
                          backgroundColor: `${getScoreColor(room.score)}18`,
                          borderColor: `${getScoreColor(room.score)}40`,
                        },
                      ]}
                    >
                      <Text
                        style={[
                          styles.roomScore,
                          { color: getScoreColor(room.score) },
                        ]}
                      >
                        {Math.round(room.score)}
                      </Text>
                    </View>
                  )}
                </View>
                <View style={styles.roomStats}>
                  <Text style={styles.roomStat}>
                    {room.anglesScanned}/{room.anglesTotal} angles
                  </Text>
                  <Text style={styles.roomStatDivider}>|</Text>
                  <Text style={styles.roomStat}>{room.coverage}%</Text>
                  {room.confirmedFindings > 0 && (
                    <>
                      <Text style={styles.roomStatDivider}>|</Text>
                      <Text style={[styles.roomStat, styles.roomFindingsStat]}>
                        {room.confirmedFindings} finding
                        {room.confirmedFindings !== 1 ? "s" : ""}
                      </Text>
                    </>
                  )}
                </View>
                {/* Room coverage bar */}
                <View style={styles.roomCoverageBar}>
                  <View
                    style={[
                      styles.roomCoverageFill,
                      {
                        width: `${room.coverage}%`,
                        backgroundColor:
                          room.coverage >= 90
                            ? colors.success
                            : room.coverage >= 50
                              ? colors.primary
                              : colors.slate300,
                      },
                    ]}
                  />
                </View>
              </View>
            ))}
          </View>
        )}

        {/* Confirmed Findings — Type-Aware Rendering */}
        {findingsByType.length > 0 ? (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Action Items</Text>
            {findingsByType.map(([itemType, findings]) => {
              const typeAccent = getItemTypeAccent(itemType);
              const typeIcon = getItemTypeIcon(itemType) as keyof typeof Ionicons.glyphMap;
              const typeLabel = itemType === "maintenance" ? "Maintenance" : itemType === "task" ? "Tasks" : itemType === "restock" ? "Restock" : "Notes";
              return (
                <View key={itemType} style={styles.severityGroup}>
                  <View style={styles.severityHeader}>
                    <Ionicons name={typeIcon} size={16} color={typeAccent} />
                    <Text style={[styles.severityLabel, { color: typeAccent }]}>
                      {typeLabel}
                    </Text>
                    <View style={[styles.severityCountBadge, { backgroundColor: typeAccent + "18" }]}>
                      <Text style={[styles.severityCount, { color: typeAccent }]}>{findings.length}</Text>
                    </View>
                  </View>
                  {findings.map((finding) => {
                    const severityColor = SEVERITY_COLORS[finding.severity] || colors.slate500;
                    return (
                      <View key={finding.id} style={styles.findingRow}>
                        <View
                          style={[
                            styles.findingAccent,
                            { backgroundColor: typeAccent },
                          ]}
                        />
                        <View style={styles.findingContent}>
                          <Text style={styles.findingDescription}>
                            {finding.description}
                          </Text>
                          <View style={styles.findingMetaRow}>
                            <Text style={styles.findingRoom}>{finding.roomName}</Text>
                            {finding.severity && finding.severity !== "cosmetic" && (
                              <View style={[styles.noteBadge, { backgroundColor: severityColor + "18" }]}>
                                <Text style={[styles.noteBadgeText, { color: severityColor }]}>
                                  {SEVERITY_LABELS[finding.severity] || finding.severity}
                                </Text>
                              </View>
                            )}
                            {finding.source === "ai" && (
                              <View style={[styles.noteBadge, { backgroundColor: colors.primary + "18" }]}>
                                <Text style={[styles.noteBadgeText, { color: colors.primary }]}>AI</Text>
                              </View>
                            )}
                          </View>
                          {/* Edit/Delete actions for all items (not just manual notes) */}
                          <View style={styles.noteActions}>
                            <TouchableOpacity
                              style={styles.editNoteButton}
                              onPress={() => handleEditNote(finding)}
                            >
                              <Ionicons name="pencil-outline" size={12} color={colors.primary} style={{ marginRight: 4 }} />
                              <Text style={styles.editNoteButtonText}>Edit</Text>
                            </TouchableOpacity>
                            <TouchableOpacity
                              style={styles.deleteNoteButton}
                              onPress={() => handleDeleteNote(finding)}
                              disabled={deletingId === finding.id}
                            >
                              <Ionicons name="trash-outline" size={12} color={colors.error} style={{ marginRight: 4 }} />
                              <Text style={styles.deleteNoteButtonText}>
                                {deletingId === finding.id ? "Deleting..." : "Delete"}
                              </Text>
                            </TouchableOpacity>
                          </View>
                        </View>
                      </View>
                    );
                  })}
                </View>
              );
            })}
            <TouchableOpacity
              style={styles.addItemButton}
              onPress={handleAddItem}
              activeOpacity={0.7}
            >
              <Ionicons name="add-circle-outline" size={16} color={colors.primary} />
              <Text style={styles.addItemButtonText}>Add Item</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Action Items</Text>
            <View style={styles.emptyFindings}>
              <Text style={styles.emptyIcon}>--</Text>
              <Text style={styles.emptyText}>
                {hasData ? "No findings confirmed" : "No findings recorded"}
              </Text>
            </View>
            <TouchableOpacity
              style={styles.addItemButton}
              onPress={handleAddItem}
              activeOpacity={0.7}
            >
              <Ionicons name="add-circle-outline" size={16} color={colors.primary} />
              <Text style={styles.addItemButtonText}>Add Item</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* Restock Items Section */}
        {restockItems.length > 0 && (
          <View style={styles.section}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm, marginBottom: spacing.content }}>
              <Ionicons name="cart-outline" size={20} color={colors.success} />
              <Text style={styles.sectionTitle}>Restock Needed</Text>
              <View style={{
                backgroundColor: colors.successBg,
                paddingHorizontal: spacing.sm,
                paddingVertical: spacing.xxs,
                borderRadius: radius.md,
              }}>
                <Text style={{ color: colors.success, fontSize: 12, fontWeight: "700" }}>
                  {restockItems.length}
                </Text>
              </View>
            </View>

            {restockItems.map((item) => {
              const qtyMatch = item.description.match(/\(qty:\s*(\d+)\)$/);
              const qty = item.restockQuantity || (qtyMatch ? parseInt(qtyMatch[1], 10) : 1);
              const name = qtyMatch
                ? item.description.replace(/\s*\(qty:\s*\d+\)$/, "").trim()
                : item.description;
              return (
                <View key={item.id} style={{
                  flexDirection: "row",
                  alignItems: "center",
                  paddingVertical: spacing.element,
                  paddingHorizontal: spacing.content,
                  backgroundColor: colors.successBg,
                  borderRadius: radius.md,
                  marginBottom: spacing.tight,
                  gap: spacing.element,
                }}>
                  <View style={{
                    width: 28, height: 28, borderRadius: radius.full,
                    backgroundColor: colors.successBg,
                    alignItems: "center", justifyContent: "center",
                  }}>
                    <Text style={{ color: colors.success, fontSize: 12, fontWeight: "700" }}>{qty}</Text>
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={{ color: colors.heading, fontSize: 14, fontWeight: "500" }}>{name}</Text>
                    <Text style={{ color: colors.muted, fontSize: 12 }}>{item.roomName}</Text>
                  </View>
                </View>
              );
            })}

            <TouchableOpacity
              style={{
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "center",
                gap: spacing.sm,
                paddingVertical: spacing.card,
                paddingHorizontal: spacing.screen,
                borderRadius: radius.lg,
                backgroundColor: colors.success,
                marginTop: spacing.content,
              }}
              onPress={handleCreateRestockOrder}
              disabled={creatingOrder}
              activeOpacity={0.8}
            >
              {creatingOrder ? (
                <ActivityIndicator size="small" color={colors.primaryForeground} />
              ) : (
                <>
                  <Ionicons name="cart" size={18} color={colors.primaryForeground} />
                  <Text style={{ color: colors.primaryForeground, fontSize: 15, fontWeight: "600" }}>
                    Create Restock Order
                  </Text>
                </>
              )}
            </TouchableOpacity>
          </View>
        )}
      </ScrollView>

      <View style={styles.footer}>
        <TouchableOpacity
          style={styles.completeButton}
          onPress={() => navigation.popToTop()}
          activeOpacity={0.8}
        >
          <Text style={styles.completeButtonText}>Done</Text>
        </TouchableOpacity>
      </View>

      {/* Shared Add/Edit Item Composer */}
      <AddItemComposer
        visible={composerVisible}
        isEditing={composerMode === "edit"}
        initialValues={composerFinding
          ? (() => {
              const previewMedia = getFindingPreviewMedia(composerFinding);
              return {
                id: composerFinding.id,
                itemType: (composerFinding.itemType as AddItemType) || "note",
                description: composerFinding.description,
                quantity: composerFinding.restockQuantity || 1,
                supplyItemId: composerFinding.supplyItemId,
                imageUrl: previewMedia.imageUrl,
                videoUrl: previewMedia.videoUrl,
                evidenceItems: composerFinding.evidenceItems,
              } satisfies ComposerInitialValues;
            })()
          : undefined}
        canTakePhoto
        canRecordVideo={false}
        canPickFromLibrary
        canDictate={false}
        onCapturePhoto={async () => {
          const imagePicker = await getImagePickerModule();
          if (!imagePicker) {
            Alert.alert(
              "Update Required",
              "This build is missing the native photo picker module. Rebuild the iOS app to use summary photo capture.",
            );
            return null;
          }

          const result = await imagePicker.launchCameraAsync({
            mediaTypes: "images",
            quality: 0.7,
          });
          if (result.canceled || !result.assets?.[0]) return null;
          return { uri: result.assets[0].uri };
        }}
        onCaptureVideo={async () => {
          const imagePicker = await getImagePickerModule();
          if (!imagePicker) {
            Alert.alert(
              "Update Required",
              "This build is missing the native photo picker module. Rebuild the iOS app to use summary video capture.",
            );
            return null;
          }

          const result = await imagePicker.launchCameraAsync({
            mediaTypes: "videos",
            videoMaxDuration: 60,
          });
          if (result.canceled || !result.assets?.[0]) return null;
          return {
            uri: result.assets[0].uri,
            durationMs: result.assets[0].duration ? result.assets[0].duration * 1000 : undefined,
          };
        }}
        onPickExistingMedia={async () => {
          const imagePicker = await getImagePickerModule();
          if (!imagePicker) {
            Alert.alert(
              "Update Required",
              "This build is missing the native photo picker module. Rebuild the iOS app to attach existing media from the summary screen.",
            );
            return null;
          }

          const result = await imagePicker.launchImageLibraryAsync({
            mediaTypes: ["images", "videos"],
            quality: 0.7,
          });
          if (result.canceled || !result.assets?.[0]) return null;
          return [
            {
              uri: result.assets[0].uri,
              kind:
                result.assets[0].type === "video"
                  ? ("video" as const)
                  : ("photo" as const),
            },
          ];
        }}
        onSubmit={handleComposerSubmit}
        onCancel={() => {
          if (!isSubmittingComposer) setComposerVisible(false);
        }}
        isSubmitting={isSubmittingComposer}
        roomName={composerFinding?.roomName}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  loadingState: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    padding: spacing.lg,
    gap: spacing.content,
  },
  loadingText: {
    color: colors.muted,
    fontSize: fontSize.label,
    fontWeight: "500",
  },
  errorTitle: {
    color: colors.heading,
    fontSize: fontSize.h3,
    fontWeight: "600",
    textAlign: "center",
  },
  errorBody: {
    color: colors.error,
    fontSize: fontSize.label,
    fontWeight: "500",
    textAlign: "center",
    marginBottom: spacing.content,
  },
  content: {
    padding: spacing.screen,
    paddingTop: spacing.xl,
    paddingBottom: spacing.screen,
  },
  title: {
    fontSize: fontSize.pageTitle,
    fontWeight: "600",
    color: colors.heading,
    marginBottom: spacing.element,
    letterSpacing: -0.5,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.content,
    marginBottom: spacing.lg,
  },
  modeBadge: {
    backgroundColor: colors.primaryBg,
    paddingHorizontal: spacing.content,
    paddingVertical: 5,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.primaryBorder,
  },
  modeText: {
    color: colors.primary,
    fontSize: fontSize.sm,
    fontWeight: "600",
    letterSpacing: 0.3,
  },
  durationText: {
    color: colors.slate600,
    fontSize: fontSize.sm,
    fontWeight: "500",
  },

  // Score
  scoreCard: {
    backgroundColor: colors.card,
    borderRadius: 20,
    padding: spacing.section,
    alignItems: "center",
    marginBottom: spacing.lg,
    borderWidth: 1,
    borderColor: colors.stone,
  },
  scoreLabel: {
    color: colors.muted,
    fontSize: fontSize.caption,
    fontWeight: "600",
    letterSpacing: 1,
    marginBottom: spacing.sm,
  },
  scoreValue: {
    fontSize: 56,
    fontWeight: "600",
  },
  scoreSubtext: {
    color: colors.slate600,
    fontSize: fontSize.label,
    marginTop: spacing.xs,
    fontWeight: "500",
  },
  scoreBarContainer: {
    width: "100%",
    marginTop: spacing.md,
  },
  scoreBar: {
    height: 6,
    backgroundColor: colors.secondary,
    borderRadius: 3,
    overflow: "hidden",
  },
  scoreBarFill: {
    height: "100%",
    borderRadius: 3,
  },

  // Sections
  section: {
    marginBottom: spacing.lg,
  },
  sectionTitle: {
    fontSize: fontSize.h3,
    fontWeight: "600",
    color: colors.heading,
    marginBottom: spacing.card,
    letterSpacing: -0.2,
  },

  // Stats Grid
  statsGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.element,
  },
  statItem: {
    flex: 1,
    minWidth: "45%",
    backgroundColor: colors.card,
    borderRadius: 14,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.stone,
  },
  statItemLabel: {
    color: colors.muted,
    fontSize: fontSize.caption,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: spacing.tight,
  },
  statItemValue: {
    color: colors.heading,
    fontSize: fontSize.stat,
    fontWeight: "600",
  },

  // Room Details
  roomCard: {
    backgroundColor: colors.card,
    borderRadius: 14,
    padding: spacing.md,
    marginBottom: spacing.element,
    borderWidth: 1,
    borderColor: colors.stone,
  },
  roomHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: spacing.element,
  },
  roomName: {
    fontSize: fontSize.bodyLg,
    fontWeight: "600",
    color: colors.heading,
    flex: 1,
  },
  roomScoreBadge: {
    paddingHorizontal: spacing.content,
    paddingVertical: spacing.xs,
    borderRadius: radius.sm,
    borderWidth: 1,
  },
  roomScore: {
    fontSize: fontSize.bodyLg,
    fontWeight: "600",
  },
  roomStats: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.tight,
    marginBottom: spacing.element,
  },
  roomStat: {
    color: colors.slate600,
    fontSize: fontSize.caption,
    fontWeight: "500",
  },
  roomStatDivider: {
    color: colors.stone,
    fontSize: fontSize.caption,
  },
  roomFindingsStat: {
    color: colors.primary,
    fontWeight: "600",
  },
  roomCoverageBar: {
    height: 4,
    backgroundColor: colors.secondary,
    borderRadius: radius.xxs,
    overflow: "hidden",
  },
  roomCoverageFill: {
    height: "100%",
    borderRadius: radius.xxs,
  },

  // Findings
  severityGroup: {
    marginBottom: spacing.container,
  },
  severityHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    marginBottom: spacing.element,
  },
  severityDot: {
    width: 10,
    height: 10,
    borderRadius: radius.full,
  },
  severityLabel: {
    color: colors.heading,
    fontSize: fontSize.body,
    fontWeight: "600",
    flex: 1,
    letterSpacing: -0.2,
  },
  severityCountBadge: {
    backgroundColor: colors.secondary,
    paddingHorizontal: spacing.element,
    paddingVertical: 3,
    borderRadius: 6,
  },
  severityCount: {
    color: colors.muted,
    fontSize: fontSize.sm,
    fontWeight: "600",
  },
  findingRow: {
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    marginBottom: spacing.sm,
    marginLeft: spacing.container,
    overflow: "hidden",
    flexDirection: "row",
    borderWidth: 1,
    borderColor: colors.stone,
  },
  findingAccent: {
    width: 4,
  },
  findingContent: {
    flex: 1,
    padding: spacing.card,
  },
  findingMetaRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  findingDescription: {
    color: colors.foreground,
    fontSize: fontSize.label,
    lineHeight: 20,
    marginBottom: spacing.xs,
    fontWeight: "500",
  },
  findingRoom: {
    color: colors.slate600,
    fontSize: fontSize.caption,
    fontWeight: "500",
  },
  noteBadge: {
    backgroundColor: colors.primaryBgStrong,
    borderWidth: 1,
    borderColor: colors.primaryBorder,
    borderRadius: radius.full,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xxs,
  },
  noteBadgeText: {
    color: colors.primary,
    fontSize: fontSize.badge,
    fontWeight: "700",
    letterSpacing: 0.6,
  },
  noteActions: {
    flexDirection: "row",
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  editNoteButton: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    borderWidth: 1,
    borderColor: colors.primaryBorder,
    backgroundColor: colors.primaryBg,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.element,
    paddingVertical: 5,
  },
  editNoteButtonText: {
    color: colors.primary,
    fontSize: fontSize.caption,
    fontWeight: "600",
  },
  deleteNoteButton: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    borderWidth: 1,
    borderColor: colors.errorBorder,
    backgroundColor: colors.errorBg,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.element,
    paddingVertical: 5,
  },
  deleteNoteButtonText: {
    color: colors.error,
    fontSize: fontSize.caption,
    fontWeight: "600",
  },
  addItemButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.sm,
    marginTop: spacing.content,
    paddingVertical: spacing.card,
    borderWidth: 1,
    borderColor: colors.primaryBorder,
    borderStyle: "dashed",
    borderRadius: radius.lg,
    backgroundColor: colors.primaryBg,
  },
  addItemButtonText: {
    color: colors.primary,
    fontSize: fontSize.label,
    fontWeight: "600",
    letterSpacing: 0.2,
  },
  emptyFindings: {
    backgroundColor: colors.card,
    borderRadius: radius.xl,
    padding: spacing.xl,
    alignItems: "center",
    borderWidth: 1,
    borderColor: colors.stone,
  },
  emptyIcon: {
    fontSize: 24,
    color: colors.slate700,
    marginBottom: spacing.sm,
  },
  emptyText: {
    color: colors.slate600,
    fontSize: fontSize.body,
    fontWeight: "500",
  },

  // Footer
  footer: {
    padding: spacing.screen,
    paddingBottom: spacing.xl,
  },
  completeButton: {
    backgroundColor: colors.primary,
    borderRadius: radius.xl,
    paddingVertical: spacing.container,
    alignItems: "center",
    shadowColor: colors.primary,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 12,
    elevation: 8,
  },
  completeButtonText: {
    color: colors.primaryForeground,
    fontSize: fontSize.h3,
    fontWeight: "600",
    letterSpacing: 0.3,
  },

});

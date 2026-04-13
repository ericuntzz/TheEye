/**
 * Item Helpers — Normalize, Serialize, and Derive
 *
 * Bridges between server Finding shape and the canonical InspectionItemDraft.
 * Handles legacy evidence migration (imageUrl/videoUrl → attachments[]).
 */

import type {
  InspectionItemDraft,
  FindingEvidenceItem,
  AddItemType,
  FindingCategory,
  FindingSeverity,
  FindingSource,
  ItemOrigin,
} from "./item-types";

// ── Server Finding Shape (matches server/schema.ts Finding) ────────────

export interface ServerFinding {
  id?: string;
  category?: string;
  description?: string;
  severity?: string;
  confidence?: number;
  findingCategory?: string;
  isClaimable?: boolean;
  objectClass?: string;
  source?: string;
  roomName?: string;
  status?: string;
  createdAt?: string;
  supplyItemId?: string;
  restockQuantity?: number;
  itemType?: string;
  imageUrl?: string;
  videoUrl?: string;
  evidenceItems?: FindingEvidenceItem[];
  derivedFromFindingId?: string;
  derivedFromComparisonId?: string;
  origin?: string;
}

// ── Category ↔ ItemType Mappings ───────────────────────────────────────

const CATEGORY_TO_ITEM_TYPE: Record<string, AddItemType> = {
  restock: "restock",
  operational: "maintenance",
  safety: "maintenance",
  damage: "maintenance",
  missing: "restock",
  manual_note: "note",
  cleanliness: "maintenance",
  inventory: "restock",
  moved: "note",
  presentation: "note",
};

const ITEM_TYPE_TO_DEFAULT_CATEGORY: Record<AddItemType, FindingCategory> = {
  restock: "restock",
  maintenance: "operational",
  task: "manual_note",
  note: "manual_note",
};

const VALID_SEVERITIES: FindingSeverity[] = [
  "cosmetic",
  "maintenance",
  "safety",
  "urgent_repair",
  "guest_damage",
];

const VALID_ITEM_TYPES: AddItemType[] = ["note", "restock", "maintenance", "task"];

const VALID_SOURCES: FindingSource[] = ["manual_note", "ai"];

const VALID_ORIGINS: ItemOrigin[] = ["manual", "ai_prompt_accept", "template"];

// ── Normalize: Server Finding → InspectionItemDraft ────────────────────

/**
 * Convert a server finding into the canonical draft model.
 * Handles legacy imageUrl/videoUrl → attachments[] conversion.
 */
export function normalizeFindingFromServer(
  finding: ServerFinding,
  roomContext?: { roomId?: string; roomName?: string },
): InspectionItemDraft {
  // Build attachments from evidenceItems or legacy fields
  const attachments: FindingEvidenceItem[] = [];

  if (finding.evidenceItems && Array.isArray(finding.evidenceItems) && finding.evidenceItems.length > 0) {
    // Use new evidence array directly
    for (const item of finding.evidenceItems) {
      attachments.push({
        id: item.id || generateTempId(),
        kind: item.kind === "video" ? "video" : "photo",
        localUri: item.localUri,
        url: item.url,
        thumbnailUrl: item.thumbnailUrl,
        durationMs: item.durationMs,
        uploadState: item.url ? "uploaded" : (item.uploadState || "pending"),
        createdAt: item.createdAt || new Date().toISOString(),
      });
    }
  } else {
    // Legacy: convert imageUrl and videoUrl to attachments
    if (finding.imageUrl) {
      attachments.push({
        id: generateTempId(),
        kind: "photo",
        url: finding.imageUrl,
        uploadState: "uploaded",
        createdAt: finding.createdAt || new Date().toISOString(),
      });
    }
    if (finding.videoUrl) {
      attachments.push({
        id: generateTempId(),
        kind: "video",
        url: finding.videoUrl,
        uploadState: "uploaded",
        createdAt: finding.createdAt || new Date().toISOString(),
      });
    }
  }

  const itemType = getItemTypeFromFinding(finding);
  const source = validateSource(finding.source);
  const severity = validateSeverity(finding.severity);
  const category = validateCategory(finding.category, itemType);

  return {
    id: finding.id || generateTempId(),
    itemType,
    category,
    severity,
    description: finding.description || "",
    roomId: roomContext?.roomId,
    roomName: finding.roomName || roomContext?.roomName,
    restockQuantity: finding.restockQuantity,
    supplyItemId: finding.supplyItemId,
    source,
    attachments,
    derivedFromFindingId: finding.derivedFromFindingId,
    derivedFromComparisonId: finding.derivedFromComparisonId,
    origin: validateOrigin(finding.origin),
  };
}

// ── Serialize: InspectionItemDraft → Server Payload ────────────────────

/**
 * Convert a draft into the shape the server expects.
 * Writes evidenceItems[] AND backfills legacy imageUrl/videoUrl for compat.
 */
export function serializeDraftForServer(draft: InspectionItemDraft): Record<string, unknown> {
  const uploadedAttachments = draft.attachments.filter((a) => a.url && a.uploadState === "uploaded");

  // Backfill legacy fields from first photo/video
  const firstPhoto = uploadedAttachments.find((a) => a.kind === "photo");
  const firstVideo = uploadedAttachments.find((a) => a.kind === "video");

  return {
    description: draft.description,
    severity: draft.severity,
    category: draft.category,
    itemType: draft.itemType,
    source: draft.source,
    restockQuantity: draft.restockQuantity,
    supplyItemId: draft.supplyItemId,
    imageUrl: firstPhoto?.url || null,
    videoUrl: firstVideo?.url || null,
    evidenceItems: uploadedAttachments.map((a) => ({
      id: a.id,
      kind: a.kind,
      url: a.url,
      thumbnailUrl: a.thumbnailUrl,
      durationMs: a.durationMs,
      createdAt: a.createdAt,
    })),
    derivedFromFindingId: draft.derivedFromFindingId || null,
    derivedFromComparisonId: draft.derivedFromComparisonId || null,
    origin: draft.origin,
  };
}

// ── Derive Helpers ─────────────────────────────────────────────────────

/**
 * Infer itemType from a finding's category when itemType is missing (legacy data).
 */
export function getItemTypeFromFinding(finding: ServerFinding): AddItemType {
  if (finding.itemType && VALID_ITEM_TYPES.includes(finding.itemType as AddItemType)) {
    return finding.itemType as AddItemType;
  }
  if (finding.category && finding.category in CATEGORY_TO_ITEM_TYPE) {
    return CATEGORY_TO_ITEM_TYPE[finding.category];
  }
  return "note";
}

/**
 * Derive the default category for an item type.
 */
export function deriveCategory(itemType: AddItemType): FindingCategory {
  return ITEM_TYPE_TO_DEFAULT_CATEGORY[itemType];
}

/**
 * Create an empty draft for a given item type with proper defaults.
 */
export function createEmptyDraft(
  itemType: AddItemType,
  roomContext?: { roomId?: string; roomName?: string },
): InspectionItemDraft {
  return {
    id: generateTempId(),
    itemType,
    category: deriveCategory(itemType),
    severity: "maintenance",
    description: "",
    roomId: roomContext?.roomId,
    roomName: roomContext?.roomName,
    source: "manual_note",
    attachments: [],
    origin: "manual",
  };
}

/**
 * Create a draft pre-filled from an AI finding (for AI-to-action conversion).
 */
export function createDraftFromAiFinding(
  aiFinding: ServerFinding,
  targetItemType: AddItemType,
  roomContext?: { roomId?: string; roomName?: string },
): InspectionItemDraft {
  const draft = normalizeFindingFromServer(aiFinding, roomContext);
  return {
    ...draft,
    id: generateTempId(), // New item, not editing the AI finding
    itemType: targetItemType,
    category: deriveCategory(targetItemType),
    source: "manual_note",
    derivedFromFindingId: aiFinding.id,
    origin: "ai_prompt_accept",
  };
}

// ── Validation Helpers ─────────────────────────────────────────────────

function validateSeverity(raw?: string): FindingSeverity {
  if (raw && VALID_SEVERITIES.includes(raw as FindingSeverity)) {
    return raw as FindingSeverity;
  }
  return "maintenance";
}

function validateCategory(raw?: string, itemType?: AddItemType): FindingCategory {
  const validCategories: FindingCategory[] = [
    "missing", "moved", "cleanliness", "damage", "inventory",
    "operational", "safety", "restock", "presentation", "manual_note",
  ];
  if (raw && validCategories.includes(raw as FindingCategory)) {
    return raw as FindingCategory;
  }
  if (itemType) return deriveCategory(itemType);
  return "manual_note";
}

function validateSource(raw?: string): FindingSource {
  if (raw && VALID_SOURCES.includes(raw as FindingSource)) {
    return raw as FindingSource;
  }
  return "manual_note";
}

function validateOrigin(raw?: string): ItemOrigin {
  if (raw && VALID_ORIGINS.includes(raw as ItemOrigin)) {
    return raw as ItemOrigin;
  }
  return "manual";
}

// ── Utility ────────────────────────────────────────────────────────────

function generateTempId(): string {
  return `temp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Check if a finding ID is a temporary local ID (not yet synced).
 */
export function isTempId(id: string): boolean {
  return id.startsWith("temp-");
}

/**
 * Get display info for an item type.
 */
export function getItemTypeDisplay(itemType: AddItemType): {
  label: string;
  icon: string;
  accentKey: string;
} {
  switch (itemType) {
    case "restock":
      return { label: "Restock", icon: "cart-outline", accentKey: "restock" };
    case "maintenance":
      return { label: "Maintenance", icon: "construct-outline", accentKey: "maintenance" };
    case "task":
      return { label: "Task", icon: "checkbox-outline", accentKey: "task" };
    case "note":
    default:
      return { label: "Note", icon: "document-text-outline", accentKey: "note" };
  }
}

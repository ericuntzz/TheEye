/**
 * Canonical Item & Evidence Types — Single Source of Truth
 *
 * Every component that creates, edits, or displays inspection items
 * should use InspectionItemDraft as the working model.
 *
 * Server findings are normalized into drafts on read,
 * and drafts are serialized back to server format on write.
 */

// ── Item Type Definitions ──────────────────────────────────────────────

export type AddItemType = "note" | "restock" | "maintenance" | "task";

export type FindingCategory =
  | "missing"
  | "moved"
  | "cleanliness"
  | "damage"
  | "inventory"
  | "operational"
  | "safety"
  | "restock"
  | "presentation"
  | "manual_note";

export type FindingSeverity =
  | "cosmetic"
  | "maintenance"
  | "safety"
  | "urgent_repair"
  | "guest_damage";

export type FindingSource = "manual_note" | "ai";

export type ItemOrigin = "manual" | "ai_prompt_accept" | "template";

// ── Evidence Types ─────────────────────────────────────────────────────

export type EvidenceUploadState =
  | "pending"
  | "uploading"
  | "uploaded"
  | "failed";

export interface FindingEvidenceItem {
  /** Unique ID for this attachment */
  id: string;
  /** Photo or video */
  kind: "photo" | "video";
  /** Local file URI before upload */
  localUri?: string;
  /** Remote URL after upload */
  url?: string;
  /** Thumbnail URL (generated on upload) */
  thumbnailUrl?: string;
  /** Video duration in milliseconds */
  durationMs?: number;
  /** Current upload state */
  uploadState: EvidenceUploadState;
  /** When this attachment was created */
  createdAt: string;
}

// ── Evidence Constraints ───────────────────────────────────────────────

export const EVIDENCE_CONSTRAINTS = {
  maxPhotos: 5,
  maxVideos: 2,
  maxTotalAttachments: 5,
  maxVideoDurationMs: 60_000,
  maxPhotoFileSize: 10 * 1024 * 1024,   // 10 MB
  maxVideoFileSize: 50 * 1024 * 1024,   // 50 MB
  compressionThreshold: 3 * 1024 * 1024, // Compress photos > 3 MB
  compressionQuality: 0.8,
  thumbnailWidth: 200,
  maxConcurrentUploads: 2,
} as const;

// ── Canonical Draft Model ──────────────────────────────────────────────

export interface InspectionItemDraft {
  /** Temp UUID for new items, real server ID for edits */
  id: string;
  /** Structured item type */
  itemType: AddItemType;
  /** Finding category — derived from itemType or AI */
  category: FindingCategory;
  /** Severity level */
  severity: FindingSeverity;
  /** User-entered or AI-generated description */
  description: string;
  /** Room this item belongs to */
  roomId?: string;
  /** Room display name */
  roomName?: string;
  /** Restock quantity (restock items only) */
  restockQuantity?: number;
  /** Link to property supply catalog item */
  supplyItemId?: string;
  /** Origin: manual entry, AI prompt acceptance, or template */
  source: FindingSource;
  /** Evidence attachments (photos and videos) */
  attachments: FindingEvidenceItem[];

  // ── Provenance (for AI-to-action conversion) ──

  /** ID of the AI finding this item was derived from */
  derivedFromFindingId?: string;
  /** ID of the comparison that produced the source finding */
  derivedFromComparisonId?: string;
  /** How this item was created */
  origin: ItemOrigin;
}

// ── Room Anchor Sentinel ───────────────────────────────────────────────

/**
 * Sentinel baseline image ID for room-level anchor result rows.
 * Manual/action items attach to this anchor, not to a random baseline.
 */
export const ROOM_ANCHOR_BASELINE_ID = "__room_anchor__";

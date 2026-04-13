/** Shared types for the inspection flow */

import type { FindingEvidenceItem } from "./item-types";

export type FindingStatus = "suggested" | "confirmed" | "dismissed";

export type AddItemType = "note" | "restock" | "maintenance" | "task";

export interface Finding {
  id: string;
  description: string;
  severity: string;
  confidence: number;
  category: string;
  status: FindingStatus;
  isClaimable?: boolean;
  source?: "manual_note" | "ai";
  roomName?: string;
  resultId?: string;
  findingIndex?: number;
  /** For items added via Add Item modal */
  itemType?: AddItemType;
  /** For restock items: quantity needed */
  restockQuantity?: number;
  /** Resolved supply catalog item ID */
  supplyItemId?: string;
  /** Attached photo URL (uploaded via Add Item) — legacy single-attachment */
  imageUrl?: string;
  /** Attached video URL (uploaded via Add Item) — legacy single-attachment */
  videoUrl?: string;
  /** Multi-evidence attachments (preferred over imageUrl/videoUrl) */
  evidenceItems?: FindingEvidenceItem[];
  /** Provenance: ID of the AI finding this item was derived from */
  derivedFromFindingId?: string;
  /** Provenance: ID of the comparison that produced the source finding */
  derivedFromComparisonId?: string;
  /** How this item was created */
  origin?: "manual" | "ai_prompt_accept" | "template";
}

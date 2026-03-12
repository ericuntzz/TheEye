/** Shared types for the inspection flow */

export type FindingStatus = "suggested" | "confirmed" | "dismissed";

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
}

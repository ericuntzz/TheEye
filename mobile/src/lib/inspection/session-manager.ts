/**
 * Session Manager — Inspection State + Coverage + Event Logging
 *
 * Manages the full inspection session lifecycle:
 * - Tracks which rooms have been visited and their findings
 * - Monitors per-room and overall coverage
 * - Logs all inspection events with timestamps
 * - Supports inspection modes and progressive completion tiers
 */

import type { ComparisonFinding } from "../vision/comparison-manager";
import type { FindingEvidenceItem } from "./item-types";

export type InspectionMode =
  | "turnover"
  | "maintenance"
  | "owner_arrival"
  | "vacancy_check";
export type CompletionTier = "not_started" | "minimum" | "standard" | "thorough";

export interface InspectionEvent {
  eventType: string;
  roomId?: string;
  metadata?: Record<string, unknown>;
  timestamp: number;
}

export interface RoomFinding extends ComparisonFinding {
  id: string;
  roomId: string;
  status: "suggested" | "confirmed" | "dismissed" | "muted";
  captureUrl?: string;
  baselineImageId?: string;
  dismissReason?: string;
  timestamp: number;
  /** For restock items: quantity needed */
  restockQuantity?: number;
  /** Item type from Add Item modal */
  itemType?: "note" | "restock" | "maintenance" | "task";
  /** Multi-evidence attachments */
  evidenceItems?: FindingEvidenceItem[];
  /** Provenance: AI finding this was derived from */
  derivedFromFindingId?: string;
  /** Provenance: comparison that produced the source */
  derivedFromComparisonId?: string;
  /** How this item was created */
  origin?: "manual" | "ai_prompt_accept" | "template";
}

export interface RoomVisit {
  roomId: string;
  roomName: string;
  findings: RoomFinding[];
  bestScore: number | null;
  anglesScanned: Set<string>;
  enteredAt: number;
  exitedAt: number | null;
}

export interface SessionState {
  inspectionId: string;
  propertyId: string;
  inspectionMode: InspectionMode;
  status: "active" | "paused" | "completed";
  currentRoomId: string | null;
  visitedRooms: Map<string, RoomVisit>;
  events: InspectionEvent[];
  startedAt: number;
  pausedAt: number | null;
  totalPausedMs: number;
}

export class SessionManager {
  private state: SessionState;
  private totalAnglesPerRoom = new Map<string, number>();

  constructor(
    inspectionId: string,
    propertyId: string,
    mode: InspectionMode = "turnover",
  ) {
    this.state = {
      inspectionId,
      propertyId,
      inspectionMode: mode,
      status: "active",
      currentRoomId: null,
      visitedRooms: new Map(),
      events: [],
      startedAt: Date.now(),
      pausedAt: null,
      totalPausedMs: 0,
    };

    this.logEvent("inspection_started", undefined, { mode });
  }

  /**
   * Set the total angles per room (from baselines data).
   */
  setRoomAngles(roomAngles: Map<string, number>) {
    this.totalAnglesPerRoom = roomAngles;
  }

  /**
   * Record entering a room.
   */
  enterRoom(roomId: string, roomName: string) {
    if (this.state.currentRoomId === roomId) {
      const existingVisit = this.state.visitedRooms.get(roomId);
      if (existingVisit) {
        existingVisit.roomName = roomName;
      }
      return;
    }

    // Exit previous room if any
    if (this.state.currentRoomId && this.state.currentRoomId !== roomId) {
      this.exitRoom(this.state.currentRoomId);
    }

    this.state.currentRoomId = roomId;

    if (!this.state.visitedRooms.has(roomId)) {
      this.state.visitedRooms.set(roomId, {
        roomId,
        roomName,
        findings: [],
        bestScore: null,
        anglesScanned: new Set(),
        enteredAt: Date.now(),
        exitedAt: null,
      });
    } else {
      // Re-entering a room
      const visit = this.state.visitedRooms.get(roomId)!;
      visit.exitedAt = null;
    }

    this.logEvent("room_entered", roomId);
  }

  /**
   * Record exiting a room.
   */
  exitRoom(roomId: string) {
    const visit = this.state.visitedRooms.get(roomId);
    if (visit) {
      visit.exitedAt = Date.now();
    }
    this.logEvent("room_exited", roomId);
  }

  /**
   * Record a baseline angle as scanned.
   */
  recordAngleScan(roomId: string, baselineId: string) {
    const visit = this.state.visitedRooms.get(roomId);
    if (visit && !visit.anglesScanned.has(baselineId)) {
      visit.anglesScanned.add(baselineId);
      this.logEvent("angle_scanned", roomId, { baselineId });
    }
  }

  /**
   * Add a finding from the comparison engine.
   */
  addFinding(
    roomId: string,
    finding: ComparisonFinding,
    captureUrl?: string,
    baselineImageId?: string,
  ): string {
    const id = `finding-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const roomFinding: RoomFinding = {
      ...finding,
      id,
      roomId,
      status: "suggested",
      captureUrl,
      baselineImageId,
      timestamp: Date.now(),
    };

    const visit = this.state.visitedRooms.get(roomId);
    if (visit) {
      visit.findings.push(roomFinding);
    }

    this.logEvent("finding_suggested", roomId, {
      findingId: id,
      category: finding.category,
      severity: finding.severity,
      confidence: finding.confidence,
    });

    return id;
  }

  /**
   * Update finding status (confirm, dismiss, mute).
   * Optional dismissReason for feedback learning when status is "dismissed".
   */
  updateFindingStatus(
    findingId: string,
    status: "confirmed" | "dismissed" | "muted",
    dismissReason?: string,
  ) {
    for (const visit of this.state.visitedRooms.values()) {
      const finding = visit.findings.find((f) => f.id === findingId);
      if (finding) {
        finding.status = status;
        const eventData: Record<string, unknown> = { findingId };
        if (status === "dismissed" && dismissReason) {
          (finding as unknown as Record<string, unknown>).dismissReason = dismissReason;
          eventData.reason = dismissReason;
        }
        this.logEvent(`finding_${status}`, visit.roomId, eventData);
        return;
      }
    }
  }

  /**
   * Update finding details after manual edits in the Add Item flow.
   */
  updateFindingDetails(
    findingId: string,
    updates: Partial<
      Pick<
        RoomFinding,
        | "description"
        | "severity"
        | "category"
        | "source"
        | "findingCategory"
        | "itemType"
        | "restockQuantity"
        | "supplyItemId"
        | "imageUrl"
        | "videoUrl"
        | "objectClass"
        | "evidenceItems"
        | "derivedFromFindingId"
        | "derivedFromComparisonId"
        | "origin"
      >
    >,
  ) {
    for (const visit of this.state.visitedRooms.values()) {
      const finding = visit.findings.find((f) => f.id === findingId);
      if (finding) {
        Object.assign(finding, updates);
        this.logEvent("finding_updated", visit.roomId, {
          findingId,
          category: updates.category ?? finding.category,
          itemType: updates.itemType ?? finding.itemType,
        });
        return;
      }
    }
  }

  /**
   * Update room score from comparison result.
   */
  updateRoomScore(roomId: string, score: number) {
    const visit = this.state.visitedRooms.get(roomId);
    if (visit) {
      if (visit.bestScore === null || score > visit.bestScore) {
        visit.bestScore = score;
      }
    }
  }

  /**
   * Pause the inspection.
   */
  pause() {
    if (this.state.status === "active") {
      this.state.status = "paused";
      this.state.pausedAt = Date.now();
      this.logEvent("inspection_paused");
    }
  }

  /**
   * Check if the inspection is paused.
   */
  isPaused(): boolean {
    return this.state.status === "paused";
  }

  /**
   * Resume the inspection.
   */
  resume() {
    if (this.state.status === "paused" && this.state.pausedAt) {
      this.state.totalPausedMs += Date.now() - this.state.pausedAt;
      this.state.pausedAt = null;
      this.state.status = "active";
      this.logEvent("inspection_resumed");
    }
  }

  /**
   * Get coverage for a specific room using raw anglesScanned count.
   * @deprecated Use RoomDetector.getRoomCoverage() instead — it uses the
   * effective progress model (cluster-aware, hierarchy-excluded).
   * This method is retained only as a fallback when the detector is unavailable.
   */
  getRoomCoverage(roomId: string): number {
    const visit = this.state.visitedRooms.get(roomId);
    const total = this.totalAnglesPerRoom.get(roomId) || 0;
    if (!visit || total === 0) return 0;
    return (visit.anglesScanned.size / total) * 100;
  }

  /**
   * Get overall property coverage using raw anglesScanned counts.
   * @deprecated Use RoomDetector.getOverallCoverage() instead — it uses the
   * effective progress model. This method is retained as a fallback only.
   */
  getOverallCoverage(): number {
    if (this.totalAnglesPerRoom.size === 0) return 0;

    let totalAngles = 0;
    let scannedAngles = 0;
    for (const [roomId, roomTotal] of this.totalAnglesPerRoom) {
      totalAngles += roomTotal;
      const visit = this.state.visitedRooms.get(roomId);
      scannedAngles += visit?.anglesScanned.size || 0;
    }

    if (totalAngles === 0) return 0;
    return (scannedAngles / totalAngles) * 100;
  }

  /**
   * Determine completion tier from raw coverage.
   * @deprecated Use getEffectiveCompletionTier() in InspectionCamera instead —
   * it uses the detector's effective coverage model.
   */
  getCompletionTier(): CompletionTier {
    const coverage = this.getOverallCoverage();
    if (coverage >= 90) return "thorough";
    if (coverage >= 50) return "standard";
    return "minimum";
  }

  /**
   * Get overall readiness score (weighted average of room scores).
   */
  getOverallScore(): number | null {
    const scores: number[] = [];
    for (const visit of this.state.visitedRooms.values()) {
      if (visit.bestScore !== null) {
        scores.push(visit.bestScore);
      }
    }
    if (scores.length === 0) return null;
    return scores.reduce((a, b) => a + b, 0) / scores.length;
  }

  /**
   * Get all confirmed findings across all rooms.
   */
  getConfirmedFindings(): RoomFinding[] {
    const findings: RoomFinding[] = [];
    for (const visit of this.state.visitedRooms.values()) {
      for (const f of visit.findings) {
        if (f.status === "confirmed") {
          findings.push(f);
        }
      }
    }
    return findings;
  }

  /**
   * Get all findings (any status) across all rooms.
   */
  getAllFindings(): RoomFinding[] {
    const findings: RoomFinding[] = [];
    for (const visit of this.state.visitedRooms.values()) {
      findings.push(...visit.findings);
    }
    return findings;
  }

  /**
   * Get inspection duration in ms (excluding paused time).
   */
  getDurationMs(): number {
    const now = Date.now();
    const elapsed = now - this.state.startedAt;
    const paused =
      this.state.totalPausedMs +
      (this.state.pausedAt ? now - this.state.pausedAt : 0);
    return elapsed - paused;
  }

  /**
   * Get the full session state for serialization / API submission.
   */
  getState(): SessionState {
    return this.state;
  }

  /**
   * Get a JSON-serializable snapshot of the session for API submission.
   * Converts Maps to objects and Sets to arrays.
   */
  toJSON(): Record<string, unknown> {
    const roomVisits: Record<string, unknown>[] = [];
    for (const [, visit] of this.state.visitedRooms) {
      roomVisits.push({
        ...visit,
        anglesScanned: Array.from(visit.anglesScanned),
      });
    }

    return {
      inspectionId: this.state.inspectionId,
      propertyId: this.state.propertyId,
      inspectionMode: this.state.inspectionMode,
      status: this.state.status,
      currentRoomId: this.state.currentRoomId,
      visitedRooms: roomVisits,
      events: this.state.events,
      startedAt: this.state.startedAt,
      durationMs: this.getDurationMs(),
    };
  }

  /**
   * Get event log for API submission.
   */
  getEvents(): InspectionEvent[] {
    return this.state.events;
  }

  recordEvent(
    eventType: string,
    roomId?: string,
    metadata?: Record<string, unknown>,
  ) {
    this.logEvent(eventType, roomId, metadata);
  }

  private logEvent(
    eventType: string,
    roomId?: string,
    metadata?: Record<string, unknown>,
  ) {
    this.state.events.push({
      eventType,
      roomId,
      metadata,
      timestamp: Date.now(),
    });
  }
}

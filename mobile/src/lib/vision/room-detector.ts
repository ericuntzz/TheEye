/**
 * Room Detection + Baseline Localization Engine
 *
 * Uses MobileCLIP-S0 embeddings to identify which room the camera is seeing
 * and which baseline angle is the best visual match.
 *
 * Key behaviors:
 * - Candidate retrieval: ranks ALL baselines by embedding similarity (not "first unscanned")
 * - Temporal lock: same top candidate for 3 consecutive frames → locked baseline
 * - Room is a soft prior: if room confidence < 0.90, all baselines are searched
 * - Coverage (unscanned) is a tie-breaker only within 0.03 similarity gap
 * - Angle scanning is NOT done here — only marked after server verification
 *
 * Supports two modes:
 * - Auto mode: ONNX model generates live frame embeddings, cosine similarity matches rooms
 * - Manual mode: Room set manually via setCurrentRoom() when ONNX model unavailable
 */

import type { OnnxModelLoader } from "./onnx-model";

export interface BaselineAngle {
  id: string;
  roomId: string;
  roomName: string;
  label: string | null; // waypoint name: "sink", "stove", etc.
  imageUrl: string;
  previewUrl?: string; // 640x360 center-cropped for ghost overlay
  embedding: number[] | null; // 512-dim MobileCLIP embedding
}

export interface RoomMatch {
  roomId: string;
  roomName: string;
  confidence: number;
}

export interface AngleScanResult {
  baselineId: string;
  similarity: number;
  scanned: boolean;
}

export interface BaselineCandidate {
  baselineId: string;
  similarity: number;
}

export interface LockedBaselineInfo {
  baseline: BaselineAngle;
  similarity: number;
  isLocked: boolean;
}

export interface RoomDetectorConfig {
  /** Cosine similarity threshold for room match (default 0.85) */
  roomThreshold: number;
  /** Cosine similarity threshold for angle scan — used for diagnostic only (default 0.85) */
  angleThreshold: number;
  /** Consecutive frames needed before switching rooms (default 5) */
  hysteresisFrames: number;
  /** Consecutive frames needed before locking a baseline candidate (default 3) */
  baselineLockFrames: number;
  /** Room confidence below which ALL baselines are searched (default 0.90) */
  crossRoomFallbackThreshold: number;
  /** Similarity gap within which coverage breaks ties (default 0.03) */
  coverageTieBreakGap: number;
  /** Similarity gap within which a locked baseline stays sticky to avoid flicker */
  lockStickinessGap: number;
}

const DEFAULT_CONFIG: RoomDetectorConfig = {
  roomThreshold: 0.62,
  angleThreshold: 0.85,
  hysteresisFrames: 3,
  baselineLockFrames: 3,
  crossRoomFallbackThreshold: 0.68,
  coverageTieBreakGap: 0.03,
  lockStickinessGap: 0.04,
};

/**
 * Cosine similarity between two vectors.
 */
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

export class RoomDetector {
  private baselines: BaselineAngle[] = [];
  private config: RoomDetectorConfig;
  private modelLoader: OnnxModelLoader | null = null;

  // Room hysteresis state
  private currentRoomId: string | null = null;
  private candidateRoomId: string | null = null;
  private candidateCount = 0;

  // Baseline localization state
  private candidateBaselineId: string | null = null;
  private candidateBaselineFrameCount = 0;
  private lockedBaseline: LockedBaselineInfo | null = null;
  private currentBaselineScores: BaselineCandidate[] = [];

  // Coverage tracking: roomId -> Set of scanned baseline IDs
  // NOTE: This is only updated externally via markAngleScanned() after server verification
  private scannedAngles = new Map<string, Set<string>>();
  private totalAnglesPerRoom = new Map<string, number>();

  // Adaptive rate tracking
  private consecutiveConfidentFrames = 0;
  private readonly CONFIDENT_THRESHOLD = 0.7;
  private readonly SLOWDOWN_AFTER_FRAMES = 40; // ~20s at 2fps

  constructor(config?: Partial<RoomDetectorConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Set the ONNX model loader for auto room detection.
   * If not set or model unavailable, room detection falls back to manual mode.
   */
  setModelLoader(loader: OnnxModelLoader) {
    this.modelLoader = loader;
  }

  /**
   * Whether auto room detection is available (ONNX model loaded).
   */
  isAutoDetectAvailable(): boolean {
    return this.modelLoader?.isLoaded ?? false;
  }

  /**
   * Process a camera frame URI for auto room detection.
   * Returns null if model unavailable — caller should use manual switching.
   */
  async processFrameFromUri(imageUri: string): Promise<{
    room: RoomMatch | null;
    anglesScanned: AngleScanResult[];
    roomChanged: boolean;
  } | null> {
    if (!this.modelLoader?.isLoaded) return null;

    const embedding = await this.modelLoader.generateEmbedding(imageUri);
    if (!embedding) return null;

    return this.processFrame(Array.from(embedding));
  }

  /**
   * Get the recommended frame processing interval in ms.
   * Adaptive: 333ms (3fps) normally, 1000ms (1fps) when highly confident for extended period.
   */
  getRecommendedInterval(): number {
    if (this.consecutiveConfidentFrames >= this.SLOWDOWN_AFTER_FRAMES) {
      return 900; // ~1fps when confidently locked
    }
    return 500; // 2fps keeps guidance smooth without over-capturing
  }

  /**
   * Load baseline data at inspection start.
   */
  loadBaselines(baselines: BaselineAngle[]) {
    this.baselines = baselines;
    this.scannedAngles.clear();
    this.totalAnglesPerRoom.clear();

    // Reset baseline lock state
    this.candidateBaselineId = null;
    this.candidateBaselineFrameCount = 0;
    this.lockedBaseline = null;
    this.currentBaselineScores = [];

    // Group by room and count angles
    for (const b of baselines) {
      if (!this.totalAnglesPerRoom.has(b.roomId)) {
        this.totalAnglesPerRoom.set(b.roomId, 0);
        this.scannedAngles.set(b.roomId, new Set());
      }
      this.totalAnglesPerRoom.set(
        b.roomId,
        (this.totalAnglesPerRoom.get(b.roomId) || 0) + 1,
      );
    }
  }

  /**
   * Identify the current room from a frame embedding.
   * Applies 5-frame hysteresis to prevent flicker.
   * Also updates baseline localization (locked baseline + top-k candidates).
   *
   * NOTE: Angle scanning is NOT performed here — baselines are only marked
   * as scanned via markAngleScanned() after the server verifies a comparison.
   *
   * Returns null if ONNX model is not loaded (embeddings unavailable).
   * In that case, room must be set manually.
   */
  processFrame(frameEmbedding: number[]): {
    room: RoomMatch | null;
    anglesScanned: AngleScanResult[];
    roomChanged: boolean;
  } {
    if (this.baselines.length === 0 || frameEmbedding.length === 0) {
      return { room: null, anglesScanned: [], roomChanged: false };
    }

    // Compute similarity against all baselines
    const scores: { baseline: BaselineAngle; similarity: number }[] = [];
    for (const baseline of this.baselines) {
      if (!baseline.embedding) continue;
      const sim = cosineSimilarity(frameEmbedding, baseline.embedding);
      scores.push({ baseline, similarity: sim });
    }

    if (scores.length === 0) {
      return { room: null, anglesScanned: [], roomChanged: false };
    }

    // Find best match per room
    const roomScores = new Map<string, { maxSim: number; roomName: string }>();
    for (const { baseline, similarity } of scores) {
      const existing = roomScores.get(baseline.roomId);
      if (!existing || similarity > existing.maxSim) {
        roomScores.set(baseline.roomId, {
          maxSim: similarity,
          roomName: baseline.roomName,
        });
      }
    }

    // Get top room
    let bestRoom: RoomMatch | null = null;
    for (const [roomId, { maxSim, roomName }] of roomScores) {
      if (!bestRoom || maxSim > bestRoom.confidence) {
        bestRoom = { roomId, roomName, confidence: maxSim };
      }
    }

    // Apply room hysteresis
    let roomChanged = false;
    if (bestRoom && bestRoom.confidence >= this.config.roomThreshold) {
      if (bestRoom.roomId !== this.currentRoomId) {
        if (bestRoom.roomId === this.candidateRoomId) {
          this.candidateCount++;
          if (this.candidateCount >= this.config.hysteresisFrames) {
            this.currentRoomId = bestRoom.roomId;
            this.candidateRoomId = null;
            this.candidateCount = 0;
            roomChanged = true;

            // Reset baseline lock on room change
            this.candidateBaselineId = null;
            this.candidateBaselineFrameCount = 0;
            this.lockedBaseline = null;
            this.currentBaselineScores = [];
          }
        } else {
          this.candidateRoomId = bestRoom.roomId;
          this.candidateCount = 1;
        }
      } else {
        // Still in same room, reset candidate
        this.candidateRoomId = null;
        this.candidateCount = 0;
      }
    }

    // Update baseline localization (candidate retrieval + temporal lock)
    const currentRoomConfidence = this.currentRoomId
      ? roomScores.get(this.currentRoomId)?.maxSim ?? 0
      : bestRoom?.confidence ?? 0;
    this.updateBaselineLock(scores, currentRoomConfidence);

    // Compute diagnostic angle scan results (read-only, no state mutation)
    const anglesScanned: AngleScanResult[] = [];
    for (const { baseline, similarity } of scores) {
      const scanned = this.scannedAngles.get(baseline.roomId)?.has(baseline.id) ?? false;
      anglesScanned.push({
        baselineId: baseline.id,
        similarity,
        scanned,
      });
    }

    const currentRoom = this.currentRoomId
      ? {
          roomId: this.currentRoomId,
          roomName:
            roomScores.get(this.currentRoomId)?.roomName ||
            bestRoom?.roomName ||
            "Unknown",
          confidence: roomScores.get(this.currentRoomId)?.maxSim || 0,
        }
      : bestRoom;

    // Track adaptive rate — slow down when highly confident
    if (currentRoom && currentRoom.confidence >= this.CONFIDENT_THRESHOLD && !roomChanged) {
      this.consecutiveConfidentFrames++;
    } else {
      this.consecutiveConfidentFrames = 0;
    }

    return { room: currentRoom, anglesScanned, roomChanged };
  }

  /**
   * Update baseline localization: rank candidates, apply temporal lock.
   *
   * Similarity ranks first. Coverage (unscanned) is a tie-breaker only
   * when candidates are within coverageTieBreakGap of each other.
   *
   * Room is a soft prior: if room confidence < crossRoomFallbackThreshold,
   * all baselines are searched regardless of room assignment.
   */
  private updateBaselineLock(
    scores: Array<{ baseline: BaselineAngle; similarity: number }>,
    roomConfidence: number,
  ): void {
    // Filter to current room baselines, unless room confidence is low → search ALL
    let candidates = scores;
    if (
      this.currentRoomId &&
      roomConfidence >= this.config.crossRoomFallbackThreshold
    ) {
      const roomFiltered = scores.filter(
        (s) => s.baseline.roomId === this.currentRoomId,
      );
      // Only use room filter if it produces results
      if (roomFiltered.length > 0) {
        candidates = roomFiltered;
      }
    }

    // Sort by similarity descending
    candidates = [...candidates].sort((a, b) => b.similarity - a.similarity);

    // Store all scores for telemetry
    this.currentBaselineScores = candidates.map((c) => ({
      baselineId: c.baseline.id,
      similarity: c.similarity,
    }));

    if (candidates.length === 0) {
      this.lockedBaseline = null;
      this.candidateBaselineId = null;
      this.candidateBaselineFrameCount = 0;
      return;
    }

    // Apply coverage tie-breaking within the gap threshold
    let topCandidate = candidates[0];
    if (candidates.length > 1) {
      const gap = candidates[0].similarity - candidates[1].similarity;
      if (gap < this.config.coverageTieBreakGap) {
        const firstScanned = this.isBaselineScanned(candidates[0].baseline);
        const secondScanned = this.isBaselineScanned(candidates[1].baseline);
        // Prefer unscanned only when similarity is nearly tied
        if (firstScanned && !secondScanned) {
          topCandidate = candidates[1];
        }
      }
    }

    if (this.lockedBaseline?.isLocked) {
      const lockedCandidate = candidates.find(
        (candidate) => candidate.baseline.id === this.lockedBaseline?.baseline.id,
      );
      const gapToLocked = lockedCandidate
        ? candidates[0].similarity - lockedCandidate.similarity
        : Number.POSITIVE_INFINITY;
      if (lockedCandidate && gapToLocked <= this.config.lockStickinessGap) {
        topCandidate = lockedCandidate;
      }
    }

    // Temporal smoothing: same candidate for N frames → locked
    if (topCandidate.baseline.id === this.candidateBaselineId) {
      this.candidateBaselineFrameCount++;
    } else {
      this.candidateBaselineId = topCandidate.baseline.id;
      this.candidateBaselineFrameCount = 1;
    }

    const isLocked =
      this.candidateBaselineFrameCount >= this.config.baselineLockFrames;
    this.lockedBaseline = {
      baseline: topCandidate.baseline,
      similarity: topCandidate.similarity,
      isLocked,
    };
  }

  /**
   * Check if a baseline has been marked as scanned (server-verified).
   */
  private isBaselineScanned(baseline: BaselineAngle): boolean {
    return this.scannedAngles.get(baseline.roomId)?.has(baseline.id) ?? false;
  }

  // ─── Public API: Baseline Localization ──────────────────────────

  /**
   * Get the currently locked baseline (or best candidate if not yet locked).
   * Returns null if no baselines have any similarity.
   */
  getLockedBaseline(): LockedBaselineInfo | null {
    return this.lockedBaseline;
  }

  /**
   * Get the top-k baseline candidates by similarity.
   * Used to send candidate IDs to the server for geometric verification.
   */
  getTopCandidates(k: number): BaselineCandidate[] {
    return this.currentBaselineScores.slice(0, k);
  }

  /**
   * Get all current baseline scores for telemetry.
   */
  getCurrentBaselineScores(): BaselineCandidate[] {
    return this.currentBaselineScores;
  }

  /**
   * Manually mark a baseline angle as scanned.
   * Call this ONLY after the server has verified the comparison — never from
   * the embedding loop. This ensures coverage tracking reflects actual verified
   * comparisons, not just visual similarity.
   */
  markAngleScanned(baselineId: string, roomId: string): void {
    const roomAngles = this.scannedAngles.get(roomId);
    if (roomAngles) {
      roomAngles.add(baselineId);
    }
  }

  // ─── Public API: Room Detection ─────────────────────────────────

  /**
   * Manually set the current room (fallback when embeddings unavailable).
   */
  setCurrentRoom(roomId: string) {
    this.currentRoomId = roomId;
    this.candidateRoomId = null;
    this.candidateCount = 0;

    // Reset baseline lock when room is manually changed
    this.candidateBaselineId = null;
    this.candidateBaselineFrameCount = 0;
    this.lockedBaseline = null;
    this.currentBaselineScores = [];
  }

  /**
   * Get coverage for a specific room.
   */
  getRoomCoverage(roomId: string): {
    scanned: number;
    total: number;
    percentage: number;
  } {
    const scanned = this.scannedAngles.get(roomId)?.size || 0;
    const total = this.totalAnglesPerRoom.get(roomId) || 0;
    return {
      scanned,
      total,
      percentage: total === 0 ? 0 : (scanned / total) * 100,
    };
  }

  /**
   * Get overall property coverage.
   */
  getOverallCoverage(): {
    scannedRooms: number;
    totalRooms: number;
    averagePercentage: number;
  } {
    let totalPercentage = 0;
    let roomCount = 0;
    let scannedRooms = 0;

    for (const [roomId] of this.totalAnglesPerRoom) {
      const coverage = this.getRoomCoverage(roomId);
      totalPercentage += coverage.percentage;
      roomCount++;
      if (coverage.scanned > 0) scannedRooms++;
    }

    return {
      scannedRooms,
      totalRooms: roomCount,
      averagePercentage: roomCount === 0 ? 0 : totalPercentage / roomCount,
    };
  }

  /**
   * Get scanned angle IDs for a room.
   */
  getScannedAngles(roomId: string): string[] {
    return Array.from(this.scannedAngles.get(roomId) || []);
  }

  /**
   * Get the current detected room.
   */
  getCurrentRoom(): string | null {
    return this.currentRoomId;
  }
}

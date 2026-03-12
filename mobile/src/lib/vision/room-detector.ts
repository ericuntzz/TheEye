/**
 * Room Detection + Angle Tracking Engine
 *
 * Uses MobileCLIP-S0 embeddings to identify which room the camera is seeing
 * and track which baseline angles have been "scanned" (covered).
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

export interface RoomDetectorConfig {
  /** Cosine similarity threshold for room match (default 0.85) */
  roomThreshold: number;
  /** Cosine similarity threshold for angle scan (default 0.85) */
  angleThreshold: number;
  /** Consecutive frames needed before switching rooms (default 5) */
  hysteresisFrames: number;
}

const DEFAULT_CONFIG: RoomDetectorConfig = {
  roomThreshold: 0.85,
  angleThreshold: 0.85,
  hysteresisFrames: 5,
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

  // Hysteresis state
  private currentRoomId: string | null = null;
  private candidateRoomId: string | null = null;
  private candidateCount = 0;

  // Coverage tracking: roomId -> Set of scanned baseline IDs
  private scannedAngles = new Map<string, Set<string>>();
  private totalAnglesPerRoom = new Map<string, number>();

  // Adaptive rate tracking
  private consecutiveConfidentFrames = 0;
  private readonly CONFIDENT_THRESHOLD = 0.99;
  private readonly SLOWDOWN_AFTER_FRAMES = 90; // ~30s at 3fps

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
      return 1000; // 1fps
    }
    return 333; // 3fps
  }

  /**
   * Load baseline data at inspection start.
   */
  loadBaselines(baselines: BaselineAngle[]) {
    this.baselines = baselines;
    this.scannedAngles.clear();
    this.totalAnglesPerRoom.clear();

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
   * Also marks angles as scanned if similarity exceeds threshold.
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

    // Apply hysteresis
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

    // Mark angles as scanned (multi-room buffering at doorways)
    const anglesScanned: AngleScanResult[] = [];
    for (const { baseline, similarity } of scores) {
      const scanned = similarity >= this.config.angleThreshold;
      if (scanned) {
        const roomAngles = this.scannedAngles.get(baseline.roomId);
        if (roomAngles) {
          roomAngles.add(baseline.id);
        }
      }
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
   * Manually set the current room (fallback when embeddings unavailable).
   */
  setCurrentRoom(roomId: string) {
    this.currentRoomId = roomId;
    this.candidateRoomId = null;
    this.candidateCount = 0;
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

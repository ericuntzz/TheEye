/**
 * Batch Analyzer — Sliding Window Scene Analysis
 *
 * Accumulates frames into batches and sends them together for
 * holistic scene-graph analysis via Claude. Gives Claude full context
 * to detect changes visible across multiple angles.
 */

export interface BatchFrame {
  dataUri: string;
  baselineUrl: string;
  roomId: string;
  roomName: string;
  baselineId: string;
  capturedAt: number;
  label?: string;
}

export interface BatchAnalysisConfig {
  batchSize: number;
  maxBatchWaitMs: number;
  apiUrl: string;
  maxConcurrentBatches: number;
  getAuthToken: () => Promise<string | null>;
  /** Inspection mode for mode-specific Claude prompting */
  inspectionMode?: "turnover" | "maintenance" | "owner_arrival" | "vacancy_check";
}

const DEFAULT_CONFIG: BatchAnalysisConfig = {
  batchSize: 5,
  maxBatchWaitMs: 30000,
  apiUrl: "",
  maxConcurrentBatches: 2,
  getAuthToken: async () => null,
};

export type BatchResultCallback = (result: {
  roomId: string;
  findings: Array<{
    category: string;
    description: string;
    severity: string;
    confidence: number;
    findingCategory: string;
    isClaimable: boolean;
  }>;
  sceneChanges: string[];
  readinessScore: number | null;
}) => void;

export class BatchAnalyzer {
  private config: BatchAnalysisConfig;
  private frameBuffer: Map<string, BatchFrame[]> = new Map();
  /** Per-room timers instead of single shared timer */
  private roomTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private onResult: BatchResultCallback | null = null;
  private paused = false;
  /** Backpressure: track in-flight batch count */
  private activeBatches = 0;

  constructor(config?: Partial<BatchAnalysisConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  setResultCallback(callback: BatchResultCallback): void {
    this.onResult = callback;
  }

  addFrame(frame: BatchFrame): void {
    if (this.paused) return;

    const roomFrames = this.frameBuffer.get(frame.roomId) || [];

    // Dedup: skip if a frame with the same capturedAt already exists
    if (roomFrames.some((f) => f.capturedAt === frame.capturedAt)) return;

    roomFrames.push(frame);
    this.frameBuffer.set(frame.roomId, roomFrames);

    if (roomFrames.length >= this.config.batchSize) {
      this.flushRoom(frame.roomId);
    } else if (!this.roomTimers.has(frame.roomId)) {
      // Per-room timer
      const timer = setTimeout(() => {
        this.roomTimers.delete(frame.roomId);
        this.flushRoom(frame.roomId);
      }, this.config.maxBatchWaitMs);
      this.roomTimers.set(frame.roomId, timer);
    }
  }

  onRoomTransition(previousRoomId: string): void {
    // Clear the room's timer and flush
    const timer = this.roomTimers.get(previousRoomId);
    if (timer) {
      clearTimeout(timer);
      this.roomTimers.delete(previousRoomId);
    }
    this.flushRoom(previousRoomId);
  }

  private flushRoom(roomId: string): void {
    const frames = this.frameBuffer.get(roomId);
    if (!frames || frames.length === 0) return;

    // Clear timer for this room
    const timer = this.roomTimers.get(roomId);
    if (timer) {
      clearTimeout(timer);
      this.roomTimers.delete(roomId);
    }

    this.frameBuffer.delete(roomId); // delete instead of empty array
    void this.sendBatchWithBackpressure(roomId, frames);
  }

  flushAllRooms(): void {
    for (const [roomId, frames] of this.frameBuffer) {
      if (frames.length > 0) {
        this.frameBuffer.delete(roomId);
        void this.sendBatchWithBackpressure(roomId, frames);
      }
    }
    // Clear all room timers
    for (const [, timer] of this.roomTimers) {
      clearTimeout(timer);
    }
    this.roomTimers.clear();
  }

  /** Backpressure: queue batch if too many are in flight */
  private async sendBatchWithBackpressure(roomId: string, frames: BatchFrame[]): Promise<void> {
    if (this.activeBatches >= this.config.maxConcurrentBatches) {
      console.log(`[BatchAnalyzer] Backpressure: ${this.activeBatches} batches in flight, deferring ${roomId}`);
      // Re-queue frames for next flush
      const existing = this.frameBuffer.get(roomId) || [];
      this.frameBuffer.set(roomId, [...existing, ...frames]);
      return;
    }
    await this.sendBatch(roomId, frames);
  }

  private async sendBatch(roomId: string, frames: BatchFrame[]): Promise<void> {
    if (frames.length === 0) return;

    this.activeBatches++;
    const roomName = frames[0].roomName;

    try {
      const token = await this.config.getAuthToken();
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (token) {
        headers["Authorization"] = `Bearer ${token}`;
      }

      const response = await fetch(`${this.config.apiUrl}/api/vision/batch-analyze`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          roomId,
          roomName,
          inspectionMode: this.config.inspectionMode || "turnover",
          frames: frames.map((f) => ({
            currentImage: f.dataUri,
            baselineUrl: f.baselineUrl,
            baselineId: f.baselineId,
            label: f.label,
          })),
        }),
      });

      if (!response.ok) {
        console.warn(`[BatchAnalyzer] Batch request failed: ${response.status}`);
        return;
      }

      const result = await response.json();
      this.onResult?.({
        roomId,
        findings: result.findings || [],
        sceneChanges: result.sceneChanges || [],
        readinessScore: result.readinessScore ?? null,
      });
    } catch (err) {
      console.warn("[BatchAnalyzer] Batch analysis failed:", err);
    } finally {
      this.activeBatches = Math.max(0, this.activeBatches - 1);
    }
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
  }

  dispose(): void {
    this.paused = true;
    this.frameBuffer.clear();
    for (const [, timer] of this.roomTimers) {
      clearTimeout(timer);
    }
    this.roomTimers.clear();
    this.onResult = null;
  }

  getPendingFrameCount(roomId: string): number {
    return this.frameBuffer.get(roomId)?.length || 0;
  }

  getTotalPendingFrames(): number {
    let total = 0;
    for (const frames of this.frameBuffer.values()) {
      total += frames.length;
    }
    return total;
  }
}

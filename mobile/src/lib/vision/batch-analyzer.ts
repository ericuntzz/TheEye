/**
 * Batch Analyzer — Sliding Window Scene Analysis
 *
 * Instead of sending individual frames to Claude one at a time,
 * accumulates frames into batches and sends them together for
 * holistic scene-graph analysis. This gives Claude full context
 * to detect changes that are only visible across multiple angles.
 *
 * Two modes:
 * 1. Sliding window: every N frames, send a batch
 * 2. Room transition: when room changes, send all accumulated frames
 */

export interface BatchFrame {
  dataUri: string; // base64 data URI
  baselineUrl: string; // corresponding baseline image URL
  roomId: string;
  roomName: string;
  baselineId: string;
  capturedAt: number;
  label?: string;
}

export interface BatchAnalysisConfig {
  /** Number of frames to accumulate before sending a batch (default: 5) */
  batchSize: number;
  /** Maximum time to wait before sending an incomplete batch (ms) */
  maxBatchWaitMs: number;
  /** API base URL */
  apiUrl: string;
}

const DEFAULT_CONFIG: BatchAnalysisConfig = {
  batchSize: 5,
  maxBatchWaitMs: 30000, // 30 seconds
  apiUrl: "",
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
  private frameBuffer: Map<string, BatchFrame[]> = new Map(); // roomId -> frames
  private batchTimer: ReturnType<typeof setTimeout> | null = null;
  private onResult: BatchResultCallback | null = null;
  private paused = false;

  constructor(config?: Partial<BatchAnalysisConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  setResultCallback(callback: BatchResultCallback): void {
    this.onResult = callback;
  }

  /**
   * Add a captured frame to the buffer.
   * When the buffer reaches batchSize, automatically triggers batch analysis.
   */
  addFrame(frame: BatchFrame): void {
    if (this.paused) return;

    const roomFrames = this.frameBuffer.get(frame.roomId) || [];
    roomFrames.push(frame);
    this.frameBuffer.set(frame.roomId, roomFrames);

    // Check if we should send a batch
    if (roomFrames.length >= this.config.batchSize) {
      this.flushRoom(frame.roomId);
    } else if (!this.batchTimer) {
      // Start a timer for incomplete batches
      this.batchTimer = setTimeout(() => {
        this.batchTimer = null;
        this.flushAllRooms();
      }, this.config.maxBatchWaitMs);
    }
  }

  /**
   * Called when room transition is detected — flush the previous room's frames.
   */
  onRoomTransition(previousRoomId: string): void {
    this.flushRoom(previousRoomId);
  }

  /**
   * Flush all frames for a specific room as a batch.
   */
  private flushRoom(roomId: string): void {
    const frames = this.frameBuffer.get(roomId);
    if (!frames || frames.length === 0) return;

    // Take the frames and clear the buffer
    this.frameBuffer.set(roomId, []);
    this.sendBatch(roomId, frames);
  }

  /**
   * Flush all rooms (e.g., on inspection end or timer expiry).
   */
  flushAllRooms(): void {
    for (const [roomId, frames] of this.frameBuffer) {
      if (frames.length > 0) {
        this.frameBuffer.set(roomId, []);
        this.sendBatch(roomId, frames);
      }
    }
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }
  }

  /**
   * Send a batch of frames to the server for holistic Claude analysis.
   */
  private async sendBatch(roomId: string, frames: BatchFrame[]): Promise<void> {
    if (frames.length === 0) return;

    const roomName = frames[0].roomName;

    try {
      const response = await fetch(`${this.config.apiUrl}/api/vision/batch-analyze`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          roomId,
          roomName,
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
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }
    this.onResult = null;
  }

  /** Get pending frame count for a room */
  getPendingFrameCount(roomId: string): number {
    return this.frameBuffer.get(roomId)?.length || 0;
  }

  /** Get total pending frames across all rooms */
  getTotalPendingFrames(): number {
    let total = 0;
    for (const frames of this.frameBuffer.values()) {
      total += frames.length;
    }
    return total;
  }
}

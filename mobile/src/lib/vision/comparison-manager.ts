/**
 * Comparison Manager — "The Silent Trigger"
 *
 * Orchestrates when to send frames to the server for AI comparison.
 * Only triggers when: hasMeaningfulChange AND isStable AND cooldownElapsed.
 *
 * Features:
 * - Burst capture: 2 high-res frames 500ms apart (detects motion like running water)
 * - Change detection: only triggers when meaningful change detected vs previous frame
 * - Dynamic tiling: crops changed region instead of sending full 4K frame
 * - SSE response parsing from /api/vision/compare-stream
 */

import { MotionFilter } from "../sensors/motion-filter";
import { ChangeDetector, type ChangeDetectionResult } from "./change-detector";

export interface ComparisonFinding {
  category: string;
  description: string;
  severity: string;
  confidence: number;
  findingCategory: string;
  isClaimable: boolean;
  objectClass?: string;
}

export interface ComparisonResult {
  findings: ComparisonFinding[];
  summary: string;
  readiness_score: number;
}

export interface ComparisonManagerConfig {
  /** Minimum interval between comparisons in ms (default 5000) */
  minIntervalMs: number;
  /** Maximum concurrent comparisons (default 1) */
  maxConcurrent: number;
  /** Burst capture delay between frames in ms (default 500) */
  burstDelayMs: number;
}

const DEFAULT_CONFIG: ComparisonManagerConfig = {
  minIntervalMs: 5000,
  maxConcurrent: 1,
  burstDelayMs: 500,
};

type ComparisonCallback = (result: ComparisonResult, roomId: string) => void;
type StatusCallback = (status: "processing" | "complete" | "error") => void;

/** Capture function signature — captures a single frame, returns base64 data URI */
type CaptureFrameFn = () => Promise<string | null>;

/** Crop function signature — crops a region from a base64 image */
type CropFrameFn = (
  base64: string,
  quadrants: number[],
) => Promise<{ cropped: string; context: string } | null>;

export class ComparisonManager {
  private config: ComparisonManagerConfig;
  private motionFilter: MotionFilter;
  private changeDetector: ChangeDetector;
  private lastComparisonTime = 0;
  private activeComparisons = 0;
  private paused = false;
  private lastChangeResult: ChangeDetectionResult | null = null;

  private onFinding: ComparisonCallback | null = null;
  private onStatus: StatusCallback | null = null;

  constructor(
    motionFilter: MotionFilter,
    changeDetector: ChangeDetector,
    config?: Partial<ComparisonManagerConfig>,
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.motionFilter = motionFilter;
    this.changeDetector = changeDetector;
  }

  /**
   * Register callback for when findings are received.
   */
  onResult(callback: ComparisonCallback) {
    this.onFinding = callback;
  }

  /**
   * Register callback for comparison status updates.
   */
  onStatusChange(callback: StatusCallback) {
    this.onStatus = callback;
  }

  /**
   * Feed a grayscale thumbnail frame for change detection.
   * Call this regularly (~5fps) with a small (320x240) grayscale frame.
   * Returns the change result for use with shouldTrigger().
   */
  feedChangeFrame(grayscaleData: Uint8Array): ChangeDetectionResult {
    const result = this.changeDetector.detectChange(grayscaleData);
    this.lastChangeResult = result;
    return result;
  }

  /**
   * Check if conditions are met for triggering a comparison.
   * Uses the last change detection result from feedChangeFrame().
   */
  shouldTrigger(changeResult?: ChangeDetectionResult): boolean {
    const result = changeResult || this.lastChangeResult;

    if (this.paused) return false;
    if (this.activeComparisons >= this.config.maxConcurrent) return false;
    if (!this.motionFilter.isStable()) return false;

    const elapsed = Date.now() - this.lastComparisonTime;
    if (elapsed < this.config.minIntervalMs) return false;

    // If we have change detection data, require meaningful change
    if (result && !result.hasMeaningfulChange) return false;

    return true;
  }

  /**
   * Get the changed quadrants from the last change detection.
   * Used for dynamic tiling — only send changed regions.
   */
  getChangedQuadrants(): number[] {
    return this.lastChangeResult?.changedQuadrants || [];
  }

  /**
   * Execute a comparison with burst capture and optional dynamic tiling.
   *
   * Burst capture: captures 2 high-res frames 500ms apart to detect motion
   * (running water, flickering lights). AE/AF lock between frames prevents
   * brightness-shift false positives.
   *
   * Dynamic tiling: if change detection identified specific quadrants, crops
   * the changed region (~1024x1024) plus a context thumbnail instead of
   * sending the full 4K frame.
   *
   * @param captureFrame - Function that captures a single high-res frame
   * @param baselineUrl - URL of the baseline image for comparison
   * @param roomName - Current room name
   * @param roomId - Current room ID
   * @param options - API config, inspection context
   * @param cropFrame - Optional function for dynamic tiling
   */
  async triggerComparison(
    captureFrame: CaptureFrameFn,
    baselineUrl: string,
    roomName: string,
    roomId: string,
    options: {
      inspectionMode?: string;
      knownConditions?: string[];
      inspectionId?: string;
      baselineImageId?: string;
      apiUrl: string;
      authToken: string;
    },
    cropFrame?: CropFrameFn,
  ) {
    this.activeComparisons++;
    this.lastComparisonTime = Date.now();
    this.onStatus?.("processing");

    try {
      // Burst capture: 2 frames 500ms apart
      const frames = await this.captureBurst(captureFrame);
      if (frames.length === 0) {
        this.onStatus?.("error");
        return;
      }

      // Dynamic tiling: if change is localized, crop the changed region
      let imagesToSend = frames;
      const changedQuadrants = this.getChangedQuadrants();
      if (
        cropFrame &&
        changedQuadrants.length > 0 &&
        changedQuadrants.length < 4 // Don't crop if all quadrants changed
      ) {
        try {
          const cropped = await cropFrame(frames[0], changedQuadrants);
          if (cropped) {
            // Send cropped region as primary, context thumbnail as secondary
            imagesToSend = [cropped.cropped, cropped.context];
          }
        } catch {
          // Tiling failed — fall through to full frame
        }
      }

      // POST to SSE endpoint
      const res = await fetch(`${options.apiUrl}/api/vision/compare-stream`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${options.authToken}`,
        },
        body: JSON.stringify({
          baselineUrl,
          currentImages: imagesToSend,
          roomName,
          inspectionMode: options.inspectionMode || "turnover",
          knownConditions: options.knownConditions || [],
          inspectionId: options.inspectionId,
          roomId,
          baselineImageId: options.baselineImageId,
        }),
      });

      if (!res.ok) {
        this.onStatus?.("error");
        return;
      }

      // Parse SSE response — handle multi-line data fields
      const text = await res.text();
      const events = text.split("\n\n");
      for (const event of events) {
        const typeMatch = event.match(/^event: (\w+)/m);
        const dataMatch = event.match(/^data: (.+)$/m);
        if (typeMatch?.[1] === "result" && dataMatch?.[1]) {
          try {
            const result: ComparisonResult = JSON.parse(dataMatch[1]);
            this.onFinding?.(result, roomId);
          } catch {
            // Parse error — continue
          }
        }
      }

      this.onStatus?.("complete");
    } catch {
      this.onStatus?.("error");
    } finally {
      this.activeComparisons--;
    }
  }

  /**
   * Burst capture: 2 high-res frames separated by burstDelayMs.
   * The delay enables motion detection (running water shows specular shifts).
   */
  private async captureBurst(captureFrame: CaptureFrameFn): Promise<string[]> {
    const frames: string[] = [];

    // Frame 1
    const frame1 = await captureFrame();
    if (frame1) frames.push(frame1);

    // Wait for burst delay
    await new Promise((resolve) =>
      setTimeout(resolve, this.config.burstDelayMs),
    );

    // Frame 2
    const frame2 = await captureFrame();
    if (frame2) frames.push(frame2);

    return frames;
  }

  pause() {
    this.paused = true;
  }

  resume() {
    this.paused = false;
  }

  isPaused(): boolean {
    return this.paused;
  }
}

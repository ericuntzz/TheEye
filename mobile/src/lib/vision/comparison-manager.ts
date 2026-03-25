/**
 * Comparison Manager — "The Silent Trigger"
 *
 * Orchestrates when to send frames to the server for AI comparison.
 * Default path prefers stable frames, but can also allow slow walkthrough
 * motion when the caller has strong localization confidence.
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

export interface ComparisonDiagnostics {
  model?: string;
  aiLatencyMs?: number;
  skippedByPreflight?: boolean;
  aiDeferred?: boolean;
  aiDeferredReason?: string;
  preflight?: {
    reason?: string;
    ssim?: number;
    diffPercent?: number;
    alignment?: {
      dx: number;
      dy: number;
      score: number;
      maxShift: number;
    };
  };
}

export interface ComparisonResult {
  status:
    | "localized_changed"
    | "localized_no_change"
    | "localization_failed"
    | "comparison_unavailable"
    | "analysis_deferred";
  findings: ComparisonFinding[];
  summary: string;
  readiness_score: number | null;
  verifiedBaselineId: string | null;
  userGuidance: string;
  diagnostics?: ComparisonDiagnostics;
  /** Server-generated UUID for correlating verified → result events in split pipeline */
  comparisonId?: string;
}

export interface ComparisonManagerConfig {
  /** Minimum interval between comparisons in ms (default 3000) */
  minIntervalMs: number;
  /** Maximum concurrent comparisons (default 1) */
  maxConcurrent: number;
  /** Burst capture delay between frames in ms (default 500) */
  burstDelayMs: number;
  /** Minimum interval between explicit manual captures in ms (default 1200) */
  manualMinIntervalMs: number;
}

const DEFAULT_CONFIG: ComparisonManagerConfig = {
  minIntervalMs: 800,
  maxConcurrent: 5,
  burstDelayMs: 250,
  manualMinIntervalMs: 600,
};

export type ComparisonTriggerSource = "auto" | "manual";

export interface ComparisonContext {
  roomId: string;
  roomName: string;
  baselineImageId?: string;
  triggerSource: ComparisonTriggerSource;
}

/** Emitted when geometric verification passes (before AI analysis starts) */
export interface VerifiedEvent {
  comparisonId: string;
  verifiedBaselineId: string;
  verificationMode: "geometric" | "user_confirmed_bypass";
  diagnostics?: Record<string, unknown>;
}

export interface ComparisonErrorEvent {
  comparisonId?: string | null;
  error?: string;
}

type ComparisonCallback = (
  result: ComparisonResult,
  context: ComparisonContext,
) => void;
type VerifiedCallback = (
  event: VerifiedEvent,
  context: ComparisonContext,
) => void;
type StatusCallback = (
  status: "processing" | "complete" | "error",
  event?: ComparisonErrorEvent,
) => void;

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
  private comparisonGeneration = 0; // incremented on force-reset to invalidate stale finally blocks
  private paused = false;
  private lastChangeResult: ChangeDetectionResult | null = null;
  private consecutiveFailures = 0;
  private static readonly MAX_BACKOFF_FAILURES = 5;

  private onFinding: ComparisonCallback | null = null;
  private onVerifiedCallback: VerifiedCallback | null = null;
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
   * Register callback for when geometric verification passes (early coverage credit).
   * Fires ~1-2s into the comparison, before Claude Vision starts.
   */
  onVerified(callback: VerifiedCallback) {
    this.onVerifiedCallback = callback;
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
  shouldTrigger(
    changeResult?: ChangeDetectionResult,
    options?: {
      allowInitialStillFrame?: boolean;
      allowWalkthroughMotion?: boolean;
    },
  ): boolean {
    const result = changeResult || this.lastChangeResult;

    if (this.paused) return false;
    if (this.activeComparisons >= this.config.maxConcurrent) return false;
    // Motion gate: allow captures during steady walking (walkthrough-ready).
    // Coverage credit is now granted on-device from embeddings, so the server
    // comparison is background-only for AI damage detection.
    const motionOk =
      this.motionFilter.isStable() ||
      this.motionFilter.isWalkthroughReady();
    if (!motionOk) return false;

    // Exponential backoff on consecutive failures (3s, 6s, 12s, 24s, 48s cap)
    const backoffMultiplier = Math.min(
      Math.pow(2, this.consecutiveFailures),
      1 << ComparisonManager.MAX_BACKOFF_FAILURES,
    );
    const effectiveInterval = this.config.minIntervalMs * backoffMultiplier;

    const elapsed = Date.now() - this.lastComparisonTime;
    if (elapsed < effectiveInterval) return false;

    // If we have change detection data, require meaningful change
    if (result && !result.hasMeaningfulChange && !options?.allowInitialStillFrame) {
      return false;
    }

    return true;
  }

  /**
   * Manual capture is user intent, so it skips change-detection gating.
   * We still prevent overlap and a very tight tap-spam loop.
   */
  canTriggerManual(): boolean {
    if (this.paused) return false;
    if (this.activeComparisons >= this.config.maxConcurrent) return false;

    const elapsed = Date.now() - this.lastComparisonTime;
    return elapsed >= this.config.manualMinIntervalMs;
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
      triggerSource?: ComparisonTriggerSource;
      apiUrl: string;
      authToken: string;
      /** Telemetry only — server will verify independently */
      clientSimilarity?: number;
      /** Baseline IDs for server to resolve and verify (top-k candidates) */
      topCandidateIds?: string[];
      /** User-selected target hint — server still verifies independently */
      userSelectedCandidateId?: string;
      /** When true, user explicitly confirmed this baseline — server relaxes geometric gate */
      userConfirmed?: boolean;
      /** Token refresh function — called on 401 to get a fresh token */
      refreshToken?: () => Promise<string | null>;
      /** Skip burst capture (single frame only) — use during walking to save ~250ms */
      skipBurst?: boolean;
    },
    cropFrame?: CropFrameFn,
  ) {
    this.activeComparisons++;
    const startGeneration = this.comparisonGeneration;
    this.lastComparisonTime = Date.now();
    this.onStatus?.("processing");

    /** True if a force-reset has invalidated this comparison */
    const isStale = () => startGeneration !== this.comparisonGeneration;

    try {
      // Capture frames: single frame when walking, burst (2 frames) when stable
      const frames = options.skipBurst
        ? await captureFrame().then((f) => (f ? [f] : []))
        : await this.captureBurst(captureFrame);
      if (frames.length === 0) {
        if (!isStale()) this.onStatus?.("error");
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

      // POST to SSE endpoint with timeout and 401 refresh
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 90_000); // 90s timeout

      let authToken = options.authToken;
      let res: Response;

      try {
        res = await fetch(`${options.apiUrl}/api/vision/compare-stream`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${authToken}`,
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
            clientSimilarity: options.clientSimilarity,
            topCandidateIds: options.topCandidateIds,
            userSelectedCandidateId: options.userSelectedCandidateId,
            userConfirmed: options.userConfirmed || undefined,
          }),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeoutId);
      }

      // 401: attempt token refresh and retry once
      if (res.status === 401 && options.refreshToken) {
        const refreshedToken = await options.refreshToken();
        if (refreshedToken) {
          authToken = refreshedToken;
          const retryController = new AbortController();
          const retryTimeout = setTimeout(() => retryController.abort(), 90_000);
          try {
            res = await fetch(`${options.apiUrl}/api/vision/compare-stream`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${authToken}`,
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
                clientSimilarity: options.clientSimilarity,
                topCandidateIds: options.topCandidateIds,
                userSelectedCandidateId: options.userSelectedCandidateId,
                userConfirmed: options.userConfirmed || undefined,
              }),
              signal: retryController.signal,
            });
          } finally {
            clearTimeout(retryTimeout);
          }
        }
      }

      // If force-reset happened while we were waiting on the network, silently bail
      if (isStale()) return;

      if (!res.ok) {
        this.consecutiveFailures++;
        this.onStatus?.("error");
        return;
      }

      // Parse SSE response — use the already-fetched response body.
      // React Native's fetch does NOT support ReadableStream (res.body is null),
      // so we always use res.text() here. For true streaming, we re-request via
      // XMLHttpRequest below when the response indicates SSE content type.
      const context: ComparisonContext = {
        roomId,
        roomName,
        baselineImageId: options.baselineImageId,
        triggerSource: options.triggerSource || "auto",
      };
      let receivedResult = false;
      let resultUnavailable = false;

      // Parse SSE response. On React Native, res.body is null (no ReadableStream),
      // so we always fall back to batch parsing via res.text().
      // The on-device coverage credit (ONNX embeddings) provides the fast path;
      // SSE results from the server are for AI damage detection, not coverage timing.
      // Wrap with timeout to prevent hung server from blocking comparison slot indefinitely.
      const bodyTimeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("SSE body read timeout")), 120_000),
      );
      const text = await Promise.race([res.text(), bodyTimeout]);
      if (isStale()) return;

      const events = text.replace(/\r\n/g, "\n").split("\n\n");
      for (const event of events) {
        if (!event.trim()) continue;
        const parsed = this.parseSingleSSEEvent(event, context, isStale);
        if (parsed === "result") receivedResult = true;
        if (parsed === "result_unavailable") { receivedResult = true; resultUnavailable = true; }
        if (parsed === "error") return;
      }

      if (receivedResult) {
        if (resultUnavailable) {
          this.consecutiveFailures++;
        } else {
          this.consecutiveFailures = 0;
        }
        this.onStatus?.("complete");
      } else if (!isStale()) {
        this.consecutiveFailures++;
        this.onStatus?.("error");
      }
    } catch {
      if (!isStale()) {
        this.consecutiveFailures++;
        this.onStatus?.("error");
      }
    } finally {
      // Only decrement if this comparison hasn't been force-reset.
      // A force-reset bumps the generation and zeroes the counter;
      // decrementing after that would push it negative.
      if (startGeneration === this.comparisonGeneration) {
        this.activeComparisons--;
      }
    }
  }

  /**
   * Parse a single SSE event text block and dispatch to the appropriate callback.
   * Returns "result" if a result event was parsed, "error" for error events, null otherwise.
   */
  private parseSingleSSEEvent(
    eventText: string,
    context: ComparisonContext,
    isStale: () => boolean,
  ): "result" | "result_unavailable" | "error" | null {
    const typeMatch = eventText.match(/^event: (\w+)/m);
    const dataLines = eventText.match(/^data: (.+)$/gm);
    const dataPayload = dataLines
      ? dataLines.map((line) => line.slice(6)).join("\n")
      : null;

    if (typeMatch?.[1] === "verified" && dataPayload) {
      if (!isStale()) {
        try {
          const verified: VerifiedEvent = JSON.parse(dataPayload);
          this.onVerifiedCallback?.(verified, context);
        } catch (parseErr) {
          console.warn("[ComparisonManager] Failed to parse SSE verified:", parseErr);
        }
      }
      return null;
    }

    if (typeMatch?.[1] === "result" && dataPayload) {
      try {
        const result: ComparisonResult = JSON.parse(dataPayload);
        if (!isStale()) {
          this.onFinding?.(result, context);
        }
        // Distinguish unavailable results so caller can backoff appropriately
        if (result.status === "comparison_unavailable") return "result_unavailable";
        return "result";
      } catch (parseErr) {
        console.warn("[ComparisonManager] Failed to parse SSE result:", parseErr);
      }
      return null;
    }

    if (typeMatch?.[1] === "error") {
      if (isStale()) return "error";
      console.warn("[ComparisonManager] Server returned SSE error event");
      let errorEvent: ComparisonErrorEvent | undefined;
      if (dataPayload) {
        try {
          errorEvent = JSON.parse(dataPayload) as ComparisonErrorEvent;
        } catch (parseErr) {
          console.warn("[ComparisonManager] Failed to parse SSE error:", parseErr);
        }
      }
      this.consecutiveFailures++;
      this.onStatus?.("error", errorEvent);
      return "error";
    }

    return null;
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

  /**
   * Reset the consecutive failure counter.
   * Call on room switch or manual capture to give a fresh start.
   */
  resetBackoff() {
    this.consecutiveFailures = 0;
  }

  /**
   * Force-reset a stuck comparison slot so the capture pipeline can resume.
   * Call this only as a safety fallback when a comparison has been in-flight
   * too long (e.g. 10s+). The underlying HTTP request may still complete
   * in the background, but new captures will no longer be blocked.
   */
  forceResetStuckComparison() {
    if (this.activeComparisons > 0) {
      console.warn(
        `[ComparisonManager] Force-resetting ${this.activeComparisons} stuck comparison(s)`,
      );
      this.comparisonGeneration++;
      this.activeComparisons = 0;
      this.onStatus?.("complete");
    }
  }
}

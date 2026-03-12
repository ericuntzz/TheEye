/**
 * Pre-comparison perceptual gate.
 *
 * Runs a lightweight alignment + similarity check before sending images to Claude.
 * If no meaningful change is detected, we skip the expensive VLM call.
 */

const DEFAULT_ANALYSIS_SIZE = 160;
const DEFAULT_MAX_SHIFT = 10;
const DEFAULT_DIFF_PIXEL_THRESHOLD = 18;
const DEFAULT_MIN_ALIGNMENT_SCORE = 0.45;
const DEFAULT_DIFF_PERCENT_THRESHOLD = 2.5;
const DEFAULT_SSIM_THRESHOLD = 0.965;

export interface PreflightGateResult {
  gateVersion: "preflight-v1";
  shouldCallAi: boolean;
  reason:
    | "no_meaningful_change"
    | "diff_above_threshold"
    | "ssim_below_threshold"
    | "alignment_low_confidence";
  ssim: number;
  diffPercent: number;
  alignment: {
    dx: number;
    dy: number;
    score: number;
    maxShift: number;
  };
  thresholds: {
    ssim: number;
    diffPercent: number;
    minAlignmentScore: number;
  };
}

interface GateOptions {
  baselineBase64: string;
  currentBase64: string;
}

interface GrayFrame {
  width: number;
  height: number;
  pixels: Uint8Array;
}

export async function runPreflightGate(
  options: GateOptions,
): Promise<PreflightGateResult | null> {
  let sharp: any;
  try {
    sharp = (await import("sharp")).default;
  } catch {
    return null;
  }

  try {
    const analysisSize = envNumber(
      "VISION_PREFLIGHT_ANALYSIS_SIZE",
      DEFAULT_ANALYSIS_SIZE,
    );
    const maxShift = envNumber(
      "VISION_PREFLIGHT_MAX_SHIFT",
      DEFAULT_MAX_SHIFT,
    );
    const diffPixelThreshold = envNumber(
      "VISION_PREFLIGHT_DIFF_PIXEL_THRESHOLD",
      DEFAULT_DIFF_PIXEL_THRESHOLD,
    );
    const minAlignmentScore = envNumber(
      "VISION_PREFLIGHT_MIN_ALIGNMENT_SCORE",
      DEFAULT_MIN_ALIGNMENT_SCORE,
    );
    const diffPercentThreshold = envNumber(
      "VISION_PREFLIGHT_DIFF_PERCENT_THRESHOLD",
      DEFAULT_DIFF_PERCENT_THRESHOLD,
    );
    const ssimThreshold = envNumber(
      "VISION_PREFLIGHT_SSIM_THRESHOLD",
      DEFAULT_SSIM_THRESHOLD,
    );

    const baseline = await decodeToGray(
      sharp,
      options.baselineBase64,
      analysisSize,
    );
    const current = await decodeToGray(
      sharp,
      options.currentBase64,
      analysisSize,
    );

    if (!baseline || !current) {
      return null;
    }

    const { dx, dy, score } = estimateShift(
      baseline.pixels,
      current.pixels,
      baseline.width,
      baseline.height,
      maxShift,
    );
    const alignedCurrent = applyShift(
      current.pixels,
      baseline.width,
      baseline.height,
      dx,
      dy,
    );

    const ssim = computeGlobalSsim(baseline.pixels, alignedCurrent);
    const diffPercent = computeDiffPercent(
      baseline.pixels,
      alignedCurrent,
      diffPixelThreshold,
    );

    if (score < minAlignmentScore) {
      return {
        gateVersion: "preflight-v1",
        shouldCallAi: true,
        reason: "alignment_low_confidence",
        ssim,
        diffPercent,
        alignment: { dx, dy, score, maxShift },
        thresholds: {
          ssim: ssimThreshold,
          diffPercent: diffPercentThreshold,
          minAlignmentScore,
        },
      };
    }

    if (diffPercent >= diffPercentThreshold) {
      return {
        gateVersion: "preflight-v1",
        shouldCallAi: true,
        reason: "diff_above_threshold",
        ssim,
        diffPercent,
        alignment: { dx, dy, score, maxShift },
        thresholds: {
          ssim: ssimThreshold,
          diffPercent: diffPercentThreshold,
          minAlignmentScore,
        },
      };
    }

    if (ssim <= ssimThreshold) {
      return {
        gateVersion: "preflight-v1",
        shouldCallAi: true,
        reason: "ssim_below_threshold",
        ssim,
        diffPercent,
        alignment: { dx, dy, score, maxShift },
        thresholds: {
          ssim: ssimThreshold,
          diffPercent: diffPercentThreshold,
          minAlignmentScore,
        },
      };
    }

    return {
      gateVersion: "preflight-v1",
      shouldCallAi: false,
      reason: "no_meaningful_change",
      ssim,
      diffPercent,
      alignment: { dx, dy, score, maxShift },
      thresholds: {
        ssim: ssimThreshold,
        diffPercent: diffPercentThreshold,
        minAlignmentScore,
      },
    };
  } catch {
    return null;
  }
}

async function decodeToGray(
  sharp: any,
  base64OrDataUri: string,
  size: number,
): Promise<GrayFrame | null> {
  const bytes = base64ToBuffer(base64OrDataUri);
  if (!bytes) return null;

  const { data, info } = await sharp(bytes)
    .resize(size, size, { fit: "cover" })
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  if (!data || !info?.width || !info?.height) return null;
  return {
    width: info.width,
    height: info.height,
    pixels: new Uint8Array(data),
  };
}

function base64ToBuffer(base64OrDataUri: string): Buffer | null {
  const marker = ";base64,";
  const markerIndex = base64OrDataUri.indexOf(marker);
  const raw =
    markerIndex === -1
      ? base64OrDataUri
      : base64OrDataUri.slice(markerIndex + marker.length);

  try {
    return Buffer.from(raw, "base64");
  } catch {
    return null;
  }
}

function estimateShift(
  baseline: Uint8Array,
  current: Uint8Array,
  width: number,
  height: number,
  maxShift: number,
): { dx: number; dy: number; score: number } {
  let bestDx = 0;
  let bestDy = 0;
  let bestScore = Number.NEGATIVE_INFINITY;

  for (let dy = -maxShift; dy <= maxShift; dy++) {
    for (let dx = -maxShift; dx <= maxShift; dx++) {
      const xStart = Math.max(0, -dx);
      const xEnd = Math.min(width, width - dx);
      const yStart = Math.max(0, -dy);
      const yEnd = Math.min(height, height - dy);

      let dot = 0;
      let normA = 0;
      let normB = 0;
      let count = 0;

      for (let y = yStart; y < yEnd; y++) {
        const rowA = y * width;
        const rowB = (y + dy) * width;
        for (let x = xStart; x < xEnd; x++) {
          const a = baseline[rowA + x] - 128;
          const b = current[rowB + (x + dx)] - 128;
          dot += a * b;
          normA += a * a;
          normB += b * b;
          count++;
        }
      }

      if (count < (width * height) / 3) {
        continue;
      }

      const denom = Math.sqrt(normA * normB);
      const score = denom === 0 ? Number.NEGATIVE_INFINITY : dot / denom;
      if (score > bestScore) {
        bestScore = score;
        bestDx = dx;
        bestDy = dy;
      }
    }
  }

  if (!Number.isFinite(bestScore)) {
    return { dx: 0, dy: 0, score: 0 };
  }
  return { dx: bestDx, dy: bestDy, score: bestScore };
}

function applyShift(
  pixels: Uint8Array,
  width: number,
  height: number,
  dx: number,
  dy: number,
): Uint8Array {
  const aligned = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const srcX = x + dx;
      const srcY = y + dy;
      if (srcX < 0 || srcX >= width || srcY < 0 || srcY >= height) {
        continue;
      }
      aligned[y * width + x] = pixels[srcY * width + srcX];
    }
  }
  return aligned;
}

function computeDiffPercent(
  baseline: Uint8Array,
  current: Uint8Array,
  pixelThreshold: number,
): number {
  let changed = 0;
  for (let i = 0; i < baseline.length; i++) {
    if (Math.abs(baseline[i] - current[i]) >= pixelThreshold) {
      changed++;
    }
  }
  return (changed / baseline.length) * 100;
}

function computeGlobalSsim(baseline: Uint8Array, current: Uint8Array): number {
  const n = baseline.length;
  if (n === 0) return 0;

  let sumX = 0;
  let sumY = 0;
  for (let i = 0; i < n; i++) {
    sumX += baseline[i];
    sumY += current[i];
  }
  const muX = sumX / n;
  const muY = sumY / n;

  let varX = 0;
  let varY = 0;
  let cov = 0;
  for (let i = 0; i < n; i++) {
    const dx = baseline[i] - muX;
    const dy = current[i] - muY;
    varX += dx * dx;
    varY += dy * dy;
    cov += dx * dy;
  }

  const denom = Math.max(1, n - 1);
  varX /= denom;
  varY /= denom;
  cov /= denom;

  const c1 = (0.01 * 255) ** 2;
  const c2 = (0.03 * 255) ** 2;

  const numerator = (2 * muX * muY + c1) * (2 * cov + c2);
  const denominator = (muX * muX + muY * muY + c1) * (varX + varY + c2);
  if (denominator === 0) return 0;

  const ssim = numerator / denominator;
  return Math.min(1, Math.max(-1, ssim));
}

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

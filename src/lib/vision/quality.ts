/**
 * Image Quality Scoring — Laplacian Variance (Blur Detection)
 *
 * Computes the Laplacian variance of an image to measure sharpness.
 * Higher variance = sharper image. Blurry images have low variance.
 *
 * Threshold guidance:
 *   < 50  — very blurry, reject as baseline
 *   50-100 — borderline, warn user
 *   > 100 — acceptable quality for baselines
 *   > 200 — sharp, excellent quality
 */

import { fetchImageBuffer } from "./fetch-image";

const QUALITY_THRESHOLD = 100;
const ANALYSIS_SIZE = 640; // Resize to this width for analysis

/**
 * Compute quality score for an image via Laplacian variance.
 * Fetches the image, converts to grayscale, applies Laplacian kernel,
 * and returns the variance of the result.
 */
export async function computeQualityScore(imageUrl: string): Promise<number> {
  try {
    // Dynamic import — sharp may not be available in all environments
    const sharp = (await import("sharp")).default;

    // Fetch image bytes
    const imageBuffer = await fetchImageBuffer(imageUrl);
    if (!imageBuffer) {
      console.warn("[quality] Failed to fetch image, returning default score");
      return 150; // Fallback score
    }

    // Resize to analysis size and convert to grayscale (single channel raw pixels)
    const { data, info } = await sharp(imageBuffer)
      .resize(ANALYSIS_SIZE, null, { withoutEnlargement: true })
      .grayscale()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const { width, height } = info;

    // Apply Laplacian kernel: [[0, 1, 0], [1, -4, 1], [0, 1, 0]]
    // and compute variance of the result
    const laplacian = new Float64Array((width - 2) * (height - 2));
    let sum = 0;
    let sumSq = 0;
    let count = 0;

    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        const center = data[y * width + x];
        const top = data[(y - 1) * width + x];
        const bottom = data[(y + 1) * width + x];
        const left = data[y * width + (x - 1)];
        const right = data[y * width + (x + 1)];

        const lap = top + bottom + left + right - 4 * center;
        laplacian[count] = lap;
        sum += lap;
        sumSq += lap * lap;
        count++;
      }
    }

    if (count === 0) return 150;

    const mean = sum / count;
    const variance = sumSq / count - mean * mean;

    return Math.round(variance * 100) / 100;
  } catch (error) {
    console.error("[quality] Error computing quality score:", error);
    return 150; // Fallback
  }
}

/**
 * Check if a quality score meets the acceptable threshold.
 */
export function isQualityAcceptable(
  score: number,
  threshold: number = QUALITY_THRESHOLD,
): boolean {
  return score >= threshold;
}

// fetchImageBuffer imported from ./fetch-image

/**
 * Image preprocessing helpers used by on-device vision pipelines.
 */

export interface DecodedRgbImage {
  width: number;
  height: number;
  rgb: Uint8Array;
}

/**
 * Decode a base64 JPEG (optionally data URI) into an RGB byte buffer.
 * Returns null if decode fails.
 */
export async function decodeBase64JpegToRgb(
  base64OrDataUri: string,
): Promise<DecodedRgbImage | null> {
  try {
    const jpeg = await import("jpeg-js");
    const bytes = base64ToBytes(stripDataUriPrefix(base64OrDataUri));
    const decoded = jpeg.decode(bytes, { useTArray: true });

    if (!decoded?.data || !decoded.width || !decoded.height) {
      return null;
    }

    // jpeg-js returns RGBA; convert to compact RGB.
    const rgba = decoded.data;
    const rgb = new Uint8Array(decoded.width * decoded.height * 3);
    let rgbIdx = 0;

    for (let i = 0; i < rgba.length; i += 4) {
      rgb[rgbIdx++] = rgba[i];
      rgb[rgbIdx++] = rgba[i + 1];
      rgb[rgbIdx++] = rgba[i + 2];
    }

    return {
      width: decoded.width,
      height: decoded.height,
      rgb,
    };
  } catch (error) {
    console.warn("[image-utils] Failed to decode JPEG:", error);
    return null;
  }
}

/**
 * Convert RGB byte buffer into a grayscale image using Rec. 709 luma weights.
 */
export function rgbToGrayscale(
  rgb: Uint8Array,
  width: number,
  height: number,
): Uint8Array {
  const expected = width * height * 3;
  if (rgb.length !== expected) {
    throw new Error(
      `Invalid RGB buffer length: expected ${expected}, got ${rgb.length}`,
    );
  }

  const grayscale = new Uint8Array(width * height);
  let rgbIdx = 0;
  for (let i = 0; i < grayscale.length; i++) {
    const r = rgb[rgbIdx++];
    const g = rgb[rgbIdx++];
    const b = rgb[rgbIdx++];
    grayscale[i] = Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b);
  }
  return grayscale;
}

/**
 * Compute Laplacian variance as a sharpness score.
 * Higher values = sharper image. Works on grayscale pixels.
 * Uses a 3x3 Laplacian kernel: [[0,1,0],[1,-4,1],[0,1,0]]
 * This is the standard "variance of Laplacian" blur detection metric.
 */
export function laplacianVariance(
  grayscale: Uint8Array,
  width: number,
  height: number,
): number {
  if (width < 3 || height < 3) return 0;

  let sum = 0;
  let sumSq = 0;
  let count = 0;

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const idx = y * width + x;
      // 3x3 Laplacian: center * -4 + top + bottom + left + right
      const lap =
        -4 * grayscale[idx] +
        grayscale[(y - 1) * width + x] +
        grayscale[(y + 1) * width + x] +
        grayscale[y * width + (x - 1)] +
        grayscale[y * width + (x + 1)];
      sum += lap;
      sumSq += lap * lap;
      count++;
    }
  }

  if (count === 0) return 0;
  const mean = sum / count;
  return sumSq / count - mean * mean; // variance
}

function stripDataUriPrefix(base64OrDataUri: string): string {
  const marker = ";base64,";
  const markerIndex = base64OrDataUri.indexOf(marker);
  if (markerIndex === -1) {
    return base64OrDataUri;
  }
  return base64OrDataUri.slice(markerIndex + marker.length);
}

function base64ToBytes(base64: string): Uint8Array {
  const sanitized = base64.replace(/\s/g, "");
  const globalAtob = (globalThis as unknown as { atob?: (value: string) => string }).atob;
  if (globalAtob) {
    const binary = globalAtob(sanitized);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  const BufferCtor = (globalThis as unknown as { Buffer?: { from: (value: string, encoding: string) => Uint8Array } }).Buffer;
  if (BufferCtor?.from) {
    return Uint8Array.from(BufferCtor.from(sanitized, "base64"));
  }

  throw new Error("No base64 decoder available in runtime");
}

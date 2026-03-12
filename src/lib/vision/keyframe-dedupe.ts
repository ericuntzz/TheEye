/**
 * Keyframe/near-duplicate image dedupe for training uploads.
 *
 * Uses dHash perceptual hashing (9x8 grayscale) and Hamming distance.
 * Keeps first occurrence of each unique visual frame and drops near-duplicates.
 */

import { fetchImageBuffer } from "./fetch-image";

// Cache sharp import to avoid repeated dynamic import overhead on cold starts
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _sharpModule: any = null;
async function getSharp() {
  if (!_sharpModule) {
    _sharpModule = (await import("sharp")).default;
  }
  return _sharpModule;
}

const DEFAULT_HASH_SIZE = 8; // Produces 64-bit hash (8x8 comparisons)
const DEFAULT_HAMMING_THRESHOLD = 6; // <=6 bits difference considered near-duplicate
const DEFAULT_FETCH_TIMEOUT_MS = 5_000;
const HASH_CONCURRENCY = 6;

type DedupeCandidate = {
  url: string;
  hash: string | null;
};

export type KeyframeDedupeResult = {
  keptUrls: string[];
  droppedUrls: string[];
  hashedCount: number;
  hashFailureCount: number;
};

/**
 * Dedupe visually similar frames while preserving original order of retained URLs.
 * Fail-open behavior: if hashing fails for a frame, it is kept.
 */
export async function dedupeNearDuplicateImages(
  imageUrls: string[],
  hammingThreshold: number = DEFAULT_HAMMING_THRESHOLD,
): Promise<KeyframeDedupeResult> {
  const hashedFrames = await mapWithConcurrency(
    imageUrls,
    HASH_CONCURRENCY,
    async (url): Promise<DedupeCandidate> => ({
      url,
      hash: await computeImageDHash(url),
    }),
  );

  const kept: DedupeCandidate[] = [];
  const droppedUrls: string[] = [];

  let hashedCount = 0;
  let hashFailureCount = 0;

  for (const frame of hashedFrames) {
    if (frame.hash) {
      hashedCount++;
    } else {
      hashFailureCount++;
    }

    if (!frame.hash) {
      kept.push(frame);
      continue;
    }

    let duplicate = false;
    for (const existing of kept) {
      if (!existing.hash) continue;
      if (hammingDistanceHex(frame.hash, existing.hash) <= hammingThreshold) {
        duplicate = true;
        break;
      }
    }

    if (duplicate) {
      droppedUrls.push(frame.url);
      continue;
    }

    kept.push(frame);
  }

  return {
    keptUrls: kept.map((frame) => frame.url),
    droppedUrls,
    hashedCount,
    hashFailureCount,
  };
}

async function computeImageDHash(imageUrl: string): Promise<string | null> {
  try {
    const imageBuffer = await fetchImageBuffer(imageUrl, DEFAULT_FETCH_TIMEOUT_MS);
    if (!imageBuffer) return null;

    const sharp = await getSharp();
    const width = DEFAULT_HASH_SIZE + 1;
    const height = DEFAULT_HASH_SIZE;

    const { data, info } = await sharp(imageBuffer)
      .resize(width, height, {
        fit: "fill",
      })
      .grayscale()
      .raw()
      .toBuffer({ resolveWithObject: true });

    if (info.width !== width || info.height !== height) {
      return null;
    }

    const bits: number[] = [];
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width - 1; x++) {
        const left = data[y * width + x];
        const right = data[y * width + x + 1];
        bits.push(left > right ? 1 : 0);
      }
    }

    return bitsToHex(bits);
  } catch {
    return null;
  }
}

function bitsToHex(bits: number[]): string {
  let hex = "";
  for (let i = 0; i < bits.length; i += 4) {
    const nibble =
      ((bits[i] ?? 0) << 3) |
      ((bits[i + 1] ?? 0) << 2) |
      ((bits[i + 2] ?? 0) << 1) |
      (bits[i + 3] ?? 0);
    hex += nibble.toString(16);
  }
  return hex;
}

function hammingDistanceHex(a: string, b: string): number {
  const len = Math.min(a.length, b.length);
  let distance = Math.abs(a.length - b.length) * 4;

  for (let i = 0; i < len; i++) {
    const n1 = parseInt(a[i], 16);
    const n2 = parseInt(b[i], 16);
    if (Number.isNaN(n1) || Number.isNaN(n2)) {
      distance += 4;
      continue;
    }
    distance += bitCount4(n1 ^ n2);
  }

  return distance;
}

function bitCount4(n: number): number {
  switch (n & 0xf) {
    case 0x0:
      return 0;
    case 0x1:
    case 0x2:
    case 0x4:
    case 0x8:
      return 1;
    case 0x3:
    case 0x5:
    case 0x6:
    case 0x9:
    case 0xa:
    case 0xc:
      return 2;
    case 0x7:
    case 0xb:
    case 0xd:
    case 0xe:
      return 3;
    default:
      return 4;
  }
}

async function mapWithConcurrency<TInput, TOutput>(
  items: TInput[],
  concurrency: number,
  worker: (item: TInput, index: number) => Promise<TOutput>,
): Promise<TOutput[]> {
  if (items.length === 0) return [];

  const results: TOutput[] = new Array(items.length);
  let nextIndex = 0;

  const runWorker = async () => {
    while (true) {
      const current = nextIndex;
      nextIndex++;
      if (current >= items.length) return;
      results[current] = await worker(items[current], current);
    }
  };

  const workerCount = Math.min(Math.max(1, concurrency), items.length);
  await Promise.all(
    Array.from({ length: workerCount }, () => runWorker()),
  );

  return results;
}

/**
 * Shared image fetching utility for vision modules.
 *
 * Used by both embeddings and quality scoring to fetch images
 * from URLs with safety validation and timeout.
 */

import { isSafeUrl } from "@/lib/auth";

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Fetch an image from a URL and return as Buffer.
 * Returns null on failure (network error, timeout, unsafe URL).
 */
export async function fetchImageBuffer(
  imageUrl: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<Buffer | null> {
  try {
    if (!isSafeUrl(imageUrl)) {
      console.warn("[fetch-image] Blocked unsafe URL:", imageUrl);
      return null;
    }
    const res = await fetch(imageUrl, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const arrayBuffer = await res.arrayBuffer();
    return Buffer.from(arrayBuffer);
  } catch {
    return null;
  }
}

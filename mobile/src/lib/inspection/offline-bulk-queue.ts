import { File, Paths } from "expo-file-system";
import { submitBulkResults } from "../api";

const QUEUE_FILE_NAME = "pending-bulk-results-v1.json";

// Simple async mutex to prevent concurrent read-write races on the queue file
let queueLock: Promise<void> = Promise.resolve();
function withQueueLock<T>(fn: () => Promise<T>): Promise<T> {
  const prev = queueLock;
  let resolve: () => void;
  queueLock = new Promise<void>((r) => { resolve = r; });
  return prev.then(fn).finally(() => resolve!());
}

interface PendingBulkSubmission {
  id: string;
  inspectionId: string;
  results: unknown[];
  completionTier?: string;
  notes?: string;
  events?: unknown[];
  effectiveCoverage?: unknown;
  createdAt: number;
}

interface QueueFlushResult {
  flushed: number;
  remaining: number;
}

function getQueueFile(): File {
  return new File(Paths.document, QUEUE_FILE_NAME);
}

async function readQueue(): Promise<PendingBulkSubmission[]> {
  try {
    const file = getQueueFile();
    if (!file.exists) return [];

    const raw = await file.text();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];

    return parsed.filter(
      (entry): entry is PendingBulkSubmission =>
        Boolean(entry) &&
        typeof entry.id === "string" &&
        typeof entry.inspectionId === "string" &&
        Array.isArray(entry.results),
    );
  } catch {
    return [];
  }
}

async function writeQueue(queue: PendingBulkSubmission[]): Promise<void> {
  const file = getQueueFile();
  // withQueueLock serializes all writes, so direct overwrite is safe.
  // The tmp-file-move pattern caused "item with same name already exists"
  // because File.move(File) treats the destination as a directory and keeps
  // the original filename, so the .tmp file never actually got renamed.
  file.create({ overwrite: true });
  file.write(JSON.stringify(queue));
}

export function enqueueBulkSubmission(params: {
  inspectionId: string;
  results: unknown[];
  completionTier?: string;
  notes?: string;
  events?: unknown[];
  effectiveCoverage?: unknown;
}): Promise<void> {
  return withQueueLock(async () => {
    const queue = await readQueue();
    // Dedup: skip if this inspectionId is already queued (prevents double-enqueue on race)
    if (queue.some((entry) => entry.inspectionId === params.inspectionId)) {
      console.warn(`[offline-queue] Skipping duplicate enqueue for inspection ${params.inspectionId}`);
      return;
    }
    queue.push({
      id: `bulk-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      inspectionId: params.inspectionId,
      results: params.results,
      completionTier: params.completionTier,
      notes: params.notes,
      events: params.events,
      effectiveCoverage: params.effectiveCoverage,
      createdAt: Date.now(),
    });
    await writeQueue(queue);
  });
}

/**
 * Remove all queued submissions for a specific inspection.
 * Call after property delete to prevent orphaned submissions from retrying.
 */
export function purgeQueueByInspectionId(inspectionId: string): Promise<void> {
  return withQueueLock(async () => {
    const queue = await readQueue();
    const filtered = queue.filter((entry) => entry.inspectionId !== inspectionId);
    if (filtered.length < queue.length) {
      await writeQueue(filtered);
    }
  });
}

// Entries older than 7 days are purged — they will never succeed
const MAX_QUEUE_AGE_MS = 7 * 24 * 60 * 60 * 1000;

// HTTP status codes that will never succeed on retry
const NON_RETRYABLE_STATUSES = new Set([400, 403, 404, 409, 422]);

export function flushBulkSubmissionQueue(): Promise<QueueFlushResult> {
  return withQueueLock(async () => {
    const queue = await readQueue();
    if (queue.length === 0) {
      return { flushed: 0, remaining: 0 };
    }

    const remaining: PendingBulkSubmission[] = [];
    let flushed = 0;
    const now = Date.now();

    for (const item of queue) {
      // Purge entries older than MAX_QUEUE_AGE_MS
      if (now - item.createdAt > MAX_QUEUE_AGE_MS) {
        console.warn(`[OfflineQueue] Purging stale entry ${item.id} (age: ${Math.round((now - item.createdAt) / 86400000)}d)`);
        continue; // Drop it
      }

      try {
        await submitBulkResults(
          item.inspectionId,
          item.results,
          item.completionTier,
          item.notes,
          item.events,
          item.effectiveCoverage as Parameters<typeof submitBulkResults>[5],
        );
        flushed++;
      } catch (err) {
        // Don't retry errors that will never succeed (400, 403, 404, 409, 422)
        const status = (err as { status?: number })?.status;
        if (status && NON_RETRYABLE_STATUSES.has(status)) {
          console.warn(`[OfflineQueue] Dropping entry ${item.id}: non-retryable status ${status}`);
          continue; // Drop it
        }
        remaining.push(item);
      }
    }

    await writeQueue(remaining);
    return {
      flushed,
      remaining: remaining.length,
    };
  });
}

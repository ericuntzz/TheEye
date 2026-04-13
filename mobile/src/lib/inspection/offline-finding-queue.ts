/**
 * Offline Finding Queue — Queues individual finding CRUD operations
 * when the network is unavailable, replaying them when connectivity returns.
 *
 * Unlike the bulk queue (for whole inspection submissions), this handles
 * granular add/edit/delete operations from the summary screen.
 */

import { File, Paths } from "expo-file-system";

// ── Types ──────────────────────────────────────────────────────────────

export interface QueuedFindingMutation {
  id: string;
  type: "add" | "edit" | "delete";
  inspectionId: string;
  payload: Record<string, unknown>;
  createdAt: number;
  retryCount: number;
}

// ── Queue Storage ──────────────────────────────────────────────────────

const QUEUE_FILE_NAME = "pending-finding-mutations-v1.json";
const MAX_QUEUE_AGE_MS = 3 * 24 * 60 * 60 * 1000; // 3 days
const MAX_RETRIES = 5;
const NON_RETRYABLE_STATUSES = [400, 403, 404, 409, 422];

function getPayloadString(
  payload: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = payload[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function getPayloadNumber(
  payload: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = payload[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function getMutationTargetKey(
  type: QueuedFindingMutation["type"],
  payload: Record<string, unknown>,
): string | null {
  const localFindingId =
    getPayloadString(payload, "localFindingId") ||
    getPayloadString(payload, "findingId");
  if (localFindingId) {
    return localFindingId;
  }

  if (type === "add") {
    return null;
  }

  const resultId = getPayloadString(payload, "resultId");
  const findingIndex = getPayloadNumber(payload, "findingIndex");
  if (resultId && findingIndex !== undefined) {
    return `${resultId}:${findingIndex}`;
  }

  return null;
}

function matchesMutationTarget(
  mutation: QueuedFindingMutation,
  targetKey: string | null,
): boolean {
  return targetKey !== null && getMutationTargetKey(mutation.type, mutation.payload) === targetKey;
}

// Async mutex matching bulk queue pattern
let queueLock: Promise<void> = Promise.resolve();
function withQueueLock<T>(fn: () => Promise<T>): Promise<T> {
  const prev = queueLock;
  let resolve: () => void;
  queueLock = new Promise<void>((r) => { resolve = r; });
  return prev.then(fn).finally(() => resolve!());
}

function getQueueFile(): File {
  return new File(Paths.document, QUEUE_FILE_NAME);
}

async function readQueue(): Promise<QueuedFindingMutation[]> {
  try {
    const file = getQueueFile();
    if (!file.exists) return [];
    const raw = await file.text();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is QueuedFindingMutation =>
        Boolean(entry) &&
        typeof entry.id === "string" &&
        typeof entry.type === "string" &&
        typeof entry.inspectionId === "string",
    );
  } catch {
    return [];
  }
}

async function writeQueue(queue: QueuedFindingMutation[]): Promise<void> {
  const file = getQueueFile();
  const tmpFile = new File(Paths.cache, `${QUEUE_FILE_NAME}.tmp`);
  try {
    if (!tmpFile.exists) {
      tmpFile.create({ intermediates: true, overwrite: true });
    }
    tmpFile.write(JSON.stringify(queue));
    tmpFile.move(file);
  } catch (err) {
    try { if (tmpFile.exists) tmpFile.delete(); } catch { /* ignore */ }
    throw err;
  }
}

// ── Public API ──────────────────────────────────────────────────────────

/**
 * Enqueue a finding mutation for later replay.
 */
export async function enqueueFindingMutation(
  type: "add" | "edit" | "delete",
  inspectionId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  return withQueueLock(async () => {
    const queue = await readQueue();
    const targetKey = getMutationTargetKey(type, payload);
    const nextMutation: QueuedFindingMutation = {
      id: `fm-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      type,
      inspectionId,
      payload,
      createdAt: Date.now(),
      retryCount: 0,
    };

    if (type === "edit" && targetKey) {
      const pendingAddIndex = queue.findIndex(
        (mutation) =>
          mutation.inspectionId === inspectionId &&
          mutation.type === "add" &&
          matchesMutationTarget(mutation, targetKey),
      );
      if (pendingAddIndex !== -1) {
        queue[pendingAddIndex] = {
          ...queue[pendingAddIndex],
          payload: {
            ...queue[pendingAddIndex].payload,
            ...payload,
          },
        };
        await writeQueue(queue);
        return;
      }

      const pendingEditIndex = queue.findIndex(
        (mutation) =>
          mutation.inspectionId === inspectionId &&
          mutation.type === "edit" &&
          matchesMutationTarget(mutation, targetKey),
      );
      if (pendingEditIndex !== -1) {
        queue[pendingEditIndex] = {
          ...queue[pendingEditIndex],
          payload: {
            ...queue[pendingEditIndex].payload,
            ...payload,
          },
          createdAt: Date.now(),
        };
        await writeQueue(queue);
        return;
      }
    }

    if (type === "delete" && targetKey) {
      const hasPendingAdd = queue.some(
        (mutation) =>
          mutation.inspectionId === inspectionId &&
          mutation.type === "add" &&
          matchesMutationTarget(mutation, targetKey),
      );

      if (hasPendingAdd) {
        const filtered = queue.filter(
          (mutation) =>
            mutation.inspectionId !== inspectionId ||
            !matchesMutationTarget(mutation, targetKey),
        );
        await writeQueue(filtered);
        return;
      }

      const withoutSupersededMutations = queue.filter(
        (mutation) =>
          mutation.inspectionId !== inspectionId ||
          !matchesMutationTarget(mutation, targetKey) ||
          mutation.type === "add",
      );

      if (
        withoutSupersededMutations.some(
          (mutation) =>
            mutation.inspectionId === inspectionId &&
            mutation.type === "delete" &&
            matchesMutationTarget(mutation, targetKey),
        )
      ) {
        await writeQueue(withoutSupersededMutations);
        return;
      }

      withoutSupersededMutations.push(nextMutation);
      await writeQueue(withoutSupersededMutations);
      return;
    }

    queue.push(nextMutation);
    await writeQueue(queue);
  });
}

/**
 * Try to flush all queued mutations. Returns count of successful and remaining.
 */
export async function flushFindingMutationQueue(
  executor: (mutation: QueuedFindingMutation) => Promise<void>,
): Promise<{ flushed: number; remaining: number; failed: number }> {
  return withQueueLock(async () => {
    const queue = await readQueue();
    if (queue.length === 0) return { flushed: 0, remaining: 0, failed: 0 };

    const now = Date.now();
    const remaining: QueuedFindingMutation[] = [];
    let flushed = 0;
    let failed = 0;

    for (const mutation of queue) {
      // Drop stale entries
      if (now - mutation.createdAt > MAX_QUEUE_AGE_MS) {
        failed += 1;
        continue;
      }
      // Drop entries that exceeded retry limit
      if (mutation.retryCount >= MAX_RETRIES) {
        failed += 1;
        continue;
      }

      try {
        await executor(mutation);
        flushed += 1;
      } catch (err: unknown) {
        // Drop non-retryable errors
        const status = (err as { status?: number })?.status;
        if (status && NON_RETRYABLE_STATUSES.includes(status)) {
          failed += 1;
          continue;
        }
        // Keep for retry
        remaining.push({ ...mutation, retryCount: mutation.retryCount + 1 });
      }
    }

    await writeQueue(remaining);
    return { flushed, remaining: remaining.length, failed };
  });
}

/**
 * Get the current queue size (for UI indicators).
 */
export async function getFindingMutationQueueSize(): Promise<number> {
  return withQueueLock(async () => {
    const queue = await readQueue();
    return queue.length;
  });
}

/**
 * Clear all queued mutations for a specific inspection.
 */
export async function purgeFindingMutationsByInspection(
  inspectionId: string,
): Promise<void> {
  return withQueueLock(async () => {
    const queue = await readQueue();
    const filtered = queue.filter((m) => m.inspectionId !== inspectionId);
    if (filtered.length !== queue.length) {
      await writeQueue(filtered);
    }
  });
}

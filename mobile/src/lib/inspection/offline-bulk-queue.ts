import { File, Paths } from "expo-file-system";
import { submitBulkResults } from "../api";

const QUEUE_FILE_NAME = "pending-bulk-results-v1.json";

interface PendingBulkSubmission {
  id: string;
  inspectionId: string;
  results: unknown[];
  completionTier?: string;
  notes?: string;
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
  if (!file.exists) {
    file.create({ intermediates: true, overwrite: true });
  }
  file.write(JSON.stringify(queue));
}

export async function enqueueBulkSubmission(params: {
  inspectionId: string;
  results: unknown[];
  completionTier?: string;
  notes?: string;
}): Promise<void> {
  const queue = await readQueue();
  queue.push({
    id: `bulk-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    inspectionId: params.inspectionId,
    results: params.results,
    completionTier: params.completionTier,
    notes: params.notes,
    createdAt: Date.now(),
  });
  await writeQueue(queue);
}

export async function flushBulkSubmissionQueue(): Promise<QueueFlushResult> {
  const queue = await readQueue();
  if (queue.length === 0) {
    return { flushed: 0, remaining: 0 };
  }

  const remaining: PendingBulkSubmission[] = [];
  let flushed = 0;

  for (const item of queue) {
    try {
      await submitBulkResults(
        item.inspectionId,
        item.results,
        item.completionTier,
        item.notes,
      );
      flushed++;
    } catch {
      remaining.push(item);
    }
  }

  await writeQueue(remaining);
  return {
    flushed,
    remaining: remaining.length,
  };
}

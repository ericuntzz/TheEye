/**
 * useOfflineQueueSync — Cold-launch rehydration for the offline finding mutation queue.
 *
 * Listens for foreground transitions (AppState "active") and automatically
 * flushes pending mutations when the network is reachable.
 *
 * Designed to be lightweight and safe to mount in any screen. The consumer
 * provides an `executor` callback that knows how to replay a single mutation
 * (including hydration, API calls, etc.). If no executor is provided the hook
 * still tracks the pending count but will not attempt to flush.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, type AppStateStatus } from "react-native";

import {
  type QueuedFindingMutation,
  flushFindingMutationQueue,
  getFindingMutationQueueSize,
} from "./offline-finding-queue";

// ── Network probe ─────────────────────────────────────────────────────

/**
 * Lightweight connectivity check. Sends a HEAD request to a highly-available
 * endpoint and treats any response (even an error status) as "online". Only a
 * network failure (timeout / DNS / socket error) counts as offline.
 */
async function isNetworkReachable(): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5_000);
    await fetch("https://clients3.google.com/generate_204", {
      method: "HEAD",
      signal: controller.signal,
    });
    clearTimeout(timeout);
    return true;
  } catch {
    return false;
  }
}

// ── Types ─────────────────────────────────────────────────────────────

export type FindingMutationExecutor = (
  mutation: QueuedFindingMutation,
) => Promise<void>;

export interface OfflineQueueSyncResult {
  /** Number of mutations still waiting in the queue. */
  pendingCount: number;
  /** Whether a flush is currently in progress. */
  isFlushing: boolean;
  /** Manually trigger a flush attempt (e.g. from a "Retry" button). */
  flushNow: () => void;
}

// ── Hook ──────────────────────────────────────────────────────────────

export function useOfflineQueueSync(
  executor?: FindingMutationExecutor,
): OfflineQueueSyncResult {
  const [pendingCount, setPendingCount] = useState(0);
  const [isFlushing, setIsFlushing] = useState(false);
  const isFlushingRef = useRef(false);
  const executorRef = useRef(executor);

  // Keep the executor ref up-to-date without re-running effects.
  useEffect(() => {
    executorRef.current = executor;
  }, [executor]);

  // ── Core flush routine ──────────────────────────────────────────────

  const attemptFlush = useCallback(async () => {
    // Guard against concurrent flushes.
    if (isFlushingRef.current) return;

    // Refresh the pending count first.
    const size = await getFindingMutationQueueSize();
    setPendingCount(size);

    if (size === 0) return;
    if (!executorRef.current) return;

    const online = await isNetworkReachable();
    if (!online) return;

    isFlushingRef.current = true;
    setIsFlushing(true);

    try {
      const result = await flushFindingMutationQueue(executorRef.current);
      setPendingCount(result.remaining);
    } catch {
      // Flush itself failed (e.g. lock contention). Refresh count so the UI
      // stays accurate; next foreground event will retry.
      const refreshed = await getFindingMutationQueueSize();
      setPendingCount(refreshed);
    } finally {
      isFlushingRef.current = false;
      setIsFlushing(false);
    }
  }, []);

  // ── Manual trigger ──────────────────────────────────────────────────

  const flushNow = useCallback(() => {
    void attemptFlush();
  }, [attemptFlush]);

  // ── AppState listener (foreground transition) ───────────────────────

  useEffect(() => {
    // Run once on mount (cold launch).
    void attemptFlush();

    const handleAppStateChange = (nextState: AppStateStatus) => {
      if (nextState === "active") {
        void attemptFlush();
      }
    };

    const subscription = AppState.addEventListener(
      "change",
      handleAppStateChange,
    );

    return () => {
      subscription.remove();
    };
  }, [attemptFlush]);

  return { pendingCount, isFlushing, flushNow };
}

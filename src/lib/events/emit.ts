import { db } from "../../../server/db";
import { events } from "../../../server/schema";
import {
  EventType,
  EventPayloadMap,
  EVENT_AGGREGATE_MAP,
  EventMetadata,
} from "./types";
import { emitMissionControlDomainEvent } from "@/lib/mission-control";

interface EmitEventOptions<T extends EventType> {
  eventType: T;
  aggregateId: string;
  payload: EventPayloadMap[T];
  propertyId?: string;
  userId?: string;
  metadata?: EventMetadata;
  version?: number;
}

/**
 * Emit an event to the append-only events table.
 *
 * This is the single entry point for writing events. All state-changing
 * operations should call emitEvent alongside updating materialized state tables.
 *
 * Events are immutable once written — they form the audit trail and
 * source of truth for property timeline, damage attribution, and agent orchestration.
 */
export async function emitEvent<T extends EventType>(
  options: EmitEventOptions<T>,
): Promise<string> {
  const {
    eventType,
    aggregateId,
    payload,
    propertyId,
    userId,
    metadata,
    version = 1,
  } = options;

  const aggregateType = EVENT_AGGREGATE_MAP[eventType];

  const [inserted] = await db
    .insert(events)
    .values({
      eventType,
      aggregateType,
      aggregateId,
      propertyId,
      userId,
      payload: payload as Record<string, unknown>,
      metadata: metadata as Record<string, unknown> | undefined,
      version,
    })
    .returning({ id: events.id });

  const missionControlSourceId =
    metadata &&
    typeof metadata.missionControlSourceId === "string" &&
    metadata.missionControlSourceId.trim()
      ? metadata.missionControlSourceId.trim()
      : inserted.id;

  // Mirror selected domain events to Mission Control for ops/support awareness.
  void emitMissionControlDomainEvent(eventType, payload, {
    propertyId,
    sourceId: missionControlSourceId,
  });

  return inserted.id;
}

/**
 * Safely emit an event — catches errors and logs them without throwing.
 * Use this when event emission should not block the primary API response.
 * The main state-changing operation has already succeeded; losing the
 * event is acceptable (it can be reconciled later).
 */
export async function emitEventSafe<T extends EventType>(
  options: EmitEventOptions<T>,
): Promise<string | null> {
  try {
    return await emitEvent(options);
  } catch (error) {
    console.error(`[emitEventSafe] Failed to emit ${options.eventType}:`, error);
    return null;
  }
}

/**
 * Emit multiple events in a single transaction.
 * Useful when a single action produces multiple events (e.g., inspection completion).
 */
export async function emitEvents(
  eventList: EmitEventOptions<EventType>[],
): Promise<string[]> {
  if (eventList.length === 0) return [];

  const values = eventList.map((options) => ({
    eventType: options.eventType,
    aggregateType: EVENT_AGGREGATE_MAP[options.eventType],
    aggregateId: options.aggregateId,
    propertyId: options.propertyId,
    userId: options.userId,
    payload: options.payload as Record<string, unknown>,
    metadata: options.metadata as Record<string, unknown> | undefined,
    version: options.version ?? 1,
  }));

  const inserted = await db
    .insert(events)
    .values(values)
    .returning({ id: events.id });

  for (let i = 0; i < eventList.length; i++) {
    const options = eventList[i];
    const row = inserted[i];
    if (!options || !row) continue;
    const missionControlSourceId =
      options.metadata &&
      typeof options.metadata.missionControlSourceId === "string" &&
      options.metadata.missionControlSourceId.trim()
        ? options.metadata.missionControlSourceId.trim()
        : row.id;
    void emitMissionControlDomainEvent(options.eventType, options.payload, {
      propertyId: options.propertyId,
      sourceId: missionControlSourceId,
    });
  }

  return inserted.map((row) => row.id);
}

/**
 * Safely emit multiple events — catches errors and logs them without throwing.
 * Use this when batch event emission should not block the primary API response.
 */
export async function emitEventsSafe(
  eventList: EmitEventOptions<EventType>[],
): Promise<string[]> {
  try {
    return await emitEvents(eventList);
  } catch (error) {
    console.error(`[emitEventsSafe] Failed to emit ${eventList.length} events:`, error);
    return [];
  }
}

import type { EventPayloadMap, EventType } from "./events/types";

type MissionEventType = "support_ticket" | "incident" | "ci_failure" | "release_request";
type MissionSeverity = "low" | "medium" | "high" | "critical";

interface MissionEvent {
  type: MissionEventType;
  title: string;
  description: string;
  severity?: MissionSeverity;
  reporter?: string;
  source?: string;
  sourceId?: string;
}

interface MissionEventContext {
  propertyId?: string;
  sourceId?: string;
}

const DEFAULT_MISSION_URL = "http://127.0.0.1:4310";

function missionControlUrl(): string {
  return (process.env.MISSION_CONTROL_URL || DEFAULT_MISSION_URL).replace(/\/+$/, "");
}

function missionControlEnabled(): boolean {
  return process.env.MISSION_CONTROL_ENABLED !== "false";
}

function normalizeSeverity(value: unknown, fallback: MissionSeverity = "medium"): MissionSeverity {
  const raw = String(value || "").toLowerCase().trim();
  if (raw === "low" || raw === "medium" || raw === "high" || raw === "critical") {
    return raw;
  }
  return fallback;
}

export async function postMissionControlEvent(event: MissionEvent): Promise<boolean> {
  if (!missionControlEnabled()) return false;

  const url = `${missionControlUrl()}/api/integrations/events`;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(2500),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      console.error(`[mission-control] Event post failed (${response.status}):`, body.slice(0, 400));
      return false;
    }

    return true;
  } catch (error) {
    console.error("[mission-control] Event post error:", error);
    return false;
  }
}

function mapDomainEventToMissionEvent<T extends EventType>(
  eventType: T,
  payload: EventPayloadMap[T],
  ctx: MissionEventContext = {},
): MissionEvent | null {
  const source = "atria-domain-event";
  const sourceId = ctx.sourceId;

  if (eventType === "TicketCreated") {
    const eventPayload = payload as EventPayloadMap["TicketCreated"];
    return {
      type: "support_ticket",
      title: `Ticket created: ${eventPayload.ticketId}`,
      description: eventPayload.description || "Maintenance ticket created from Atria.",
      severity: normalizeSeverity(eventPayload.severity, "medium"),
      reporter: "ops@atria.so",
      source,
      sourceId: sourceId || eventPayload.ticketId,
    };
  }

  if (eventType === "TicketReopened") {
    const eventPayload = payload as EventPayloadMap["TicketReopened"];
    return {
      type: "support_ticket",
      title: `Ticket reopened: ${eventPayload.ticketId}`,
      description: eventPayload.reason || "Ticket reopened in Atria.",
      severity: "high",
      reporter: "ops@atria.so",
      source,
      sourceId: sourceId || eventPayload.ticketId,
    };
  }

  if (eventType === "FindingTicketed") {
    const eventPayload = payload as EventPayloadMap["FindingTicketed"];
    return {
      type: "support_ticket",
      title: `Finding ticketed: ${eventPayload.ticketId}`,
      description: `Finding ${eventPayload.findingId} escalated to ticket ${eventPayload.ticketId}.`,
      severity: "medium",
      reporter: "ops@atria.so",
      source,
      sourceId: sourceId || eventPayload.ticketId,
    };
  }

  if (eventType === "DamageDetected") {
    const eventPayload = payload as EventPayloadMap["DamageDetected"];
    return {
      type: "incident",
      title: `Damage detected in room ${eventPayload.roomId}`,
      description: eventPayload.description || "Damage event detected during inspection.",
      severity: normalizeSeverity(eventPayload.severity, "high"),
      source,
      sourceId: sourceId || eventPayload.findingId,
    };
  }

  if (eventType === "BaselineDeviationFlagged") {
    const eventPayload = payload as EventPayloadMap["BaselineDeviationFlagged"];
    return {
      type: "incident",
      title: `Baseline deviation flagged (${eventPayload.roomId})`,
      description: `Deviation at ${eventPayload.deviationPercentage}% in room ${eventPayload.roomId}.`,
      severity: "medium",
      source,
      sourceId: sourceId || `${ctx.propertyId || "property"}:${eventPayload.roomId}`,
    };
  }

  if (eventType === "BaselineRefreshRequested") {
    return {
      type: "release_request",
      title: "Baseline refresh approval requested",
      description: "Atria requested baseline refresh approval.",
      source,
      sourceId: sourceId || ctx.propertyId || "baseline-refresh",
    };
  }

  return null;
}

export async function emitMissionControlDomainEvent<T extends EventType>(
  eventType: T,
  payload: EventPayloadMap[T],
  ctx: MissionEventContext = {},
): Promise<boolean> {
  const event = mapDomainEventToMissionEvent(eventType, payload, ctx);
  if (!event) return false;
  return postMissionControlEvent(event);
}

export async function emitMissionControlIncident(input: {
  title: string;
  description: string;
  severity?: MissionSeverity;
  sourceId?: string;
}): Promise<boolean> {
  return postMissionControlEvent({
    type: "incident",
    title: input.title,
    description: input.description,
    severity: normalizeSeverity(input.severity, "high"),
    source: "atria-api",
    sourceId: input.sourceId,
  });
}

export async function emitMissionControlCiFailure(input: {
  title: string;
  description: string;
  sourceId?: string;
}): Promise<boolean> {
  return postMissionControlEvent({
    type: "ci_failure",
    title: input.title,
    description: input.description,
    severity: "high",
    source: "atria-ci",
    sourceId: input.sourceId,
  });
}

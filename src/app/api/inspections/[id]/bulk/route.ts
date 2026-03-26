import { NextRequest, NextResponse } from "next/server";
import { getDbUser, isValidUUID, isSafeUrl } from "@/lib/auth";
import { db } from "@/server/db";
import { routeFindings, generateAutomationEvents } from "@/lib/automation/lanes";
import {
  inspections,
  inspectionEvents,
  inspectionResults,
  rooms,
  baselineImages,
  type Finding,
} from "@/server/schema";
import { eq, and, inArray } from "drizzle-orm";
import { emitEventSafe } from "@/lib/events/emit";
import { emitMissionControlIncident } from "@/lib/mission-control";

interface BulkRoomResult {
  roomId: string;
  baselineImageId: string;
  currentImageUrl?: string;
  status?: "passed" | "flagged";
  score?: number | null;
  findings?: Finding[];
  rawResponse?: string;
}

interface BulkInspectionEvent {
  eventType: string;
  roomId?: string | null;
  metadata?: Record<string, unknown>;
  timestamp?: number | string;
}

// POST /api/inspections/[id]/bulk - Submit multiple room results at once
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
  const { id } = await params;
  if (!isValidUUID(id)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const dbUser = await getDbUser();
  if (!dbUser) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const [inspection] = await db
    .select()
    .from(inspections)
    .where(
      and(eq(inspections.id, id), eq(inspections.inspectorId, dbUser.id)),
    );

  if (!inspection) {
    return NextResponse.json(
      { error: "Inspection not found" },
      { status: 404 },
    );
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { results, completionTier, notes, events, effectiveCoverage } = body;

  if (!results || !Array.isArray(results)) {
    return NextResponse.json(
      { error: "results array is required" },
      { status: 400 },
    );
  }

  // Limit results array size to prevent abuse
  const MAX_BULK_RESULTS = 200;
  if (results.length > MAX_BULK_RESULTS) {
    return NextResponse.json(
      { error: `results array must not exceed ${MAX_BULK_RESULTS} items` },
      { status: 400 },
    );
  }
  const MAX_BULK_EVENTS = 5000;
  if (events && (!Array.isArray(events) || events.length > MAX_BULK_EVENTS)) {
    return NextResponse.json(
      {
        error: `events must be an array and must not exceed ${MAX_BULK_EVENTS} items`,
      },
      { status: 400 },
    );
  }

  const roomResults = results as BulkRoomResult[];
  const inspectionEventRows: BulkInspectionEvent[] = Array.isArray(events)
    ? (events as BulkInspectionEvent[])
    : [];

  // Validate all room IDs and baseline image IDs belong to this property
  const propertyRooms = await db
    .select({ id: rooms.id, name: rooms.name })
    .from(rooms)
    .where(eq(rooms.propertyId, inspection.propertyId));

  const validRoomIds = new Set(propertyRooms.map((r) => r.id));

  for (const result of roomResults) {
    if (!result.roomId || !result.baselineImageId) {
      return NextResponse.json(
        {
          error:
            "Each result must include roomId and baselineImageId",
        },
        { status: 400 },
      );
    }
    if (typeof result.roomId !== "string" || typeof result.baselineImageId !== "string") {
      return NextResponse.json(
        { error: "roomId and baselineImageId must be strings" },
        { status: 400 },
      );
    }
    if (!isValidUUID(result.roomId) || !isValidUUID(result.baselineImageId)) {
      return NextResponse.json(
        { error: "roomId and baselineImageId must be valid UUIDs" },
        { status: 400 },
      );
    }
    // Validate score if provided
    if (result.score !== undefined && result.score !== null && typeof result.score !== "number") {
      return NextResponse.json(
        { error: "score must be a number" },
        { status: 400 },
      );
    }
    // Validate findings array structure if provided
    if (result.findings !== undefined && result.findings !== null) {
      if (!Array.isArray(result.findings)) {
        return NextResponse.json(
          { error: "findings must be an array" },
          { status: 400 },
        );
      }
      for (const finding of result.findings) {
        if (typeof finding !== "object" || finding === null) {
          return NextResponse.json(
            { error: "Each finding must be an object" },
            { status: 400 },
          );
        }
      }
    }
    // Validate currentImageUrl if provided
    if (result.currentImageUrl !== undefined && result.currentImageUrl !== null) {
      if (typeof result.currentImageUrl !== "string") {
        return NextResponse.json(
          { error: "currentImageUrl must be a string" },
          { status: 400 },
        );
      }
      if (!isSafeUrl(result.currentImageUrl)) {
        return NextResponse.json(
          { error: "Invalid or unsafe currentImageUrl" },
          { status: 400 },
        );
      }
    }
    if (!validRoomIds.has(result.roomId)) {
      return NextResponse.json(
        { error: `Room ${result.roomId} does not belong to this property` },
        { status: 400 },
      );
    }
  }

  for (const event of inspectionEventRows) {
    if (!event || typeof event !== "object") {
      return NextResponse.json(
        { error: "Each event must be an object" },
        { status: 400 },
      );
    }
    if (typeof event.eventType !== "string" || !event.eventType.trim()) {
      return NextResponse.json(
        { error: "Each event must include an eventType string" },
        { status: 400 },
      );
    }
    if (event.roomId !== undefined && event.roomId !== null) {
      if (typeof event.roomId !== "string" || !isValidUUID(event.roomId)) {
        return NextResponse.json(
          { error: "event roomId must be a valid UUID when provided" },
          { status: 400 },
        );
      }
      if (!validRoomIds.has(event.roomId)) {
        return NextResponse.json(
          { error: `Event roomId ${event.roomId} does not belong to this property` },
          { status: 400 },
        );
      }
    }
    if (
      event.metadata !== undefined &&
      event.metadata !== null &&
      (typeof event.metadata !== "object" || Array.isArray(event.metadata))
    ) {
      return NextResponse.json(
        { error: "event metadata must be an object when provided" },
        { status: 400 },
      );
    }
    if (event.timestamp !== undefined && event.timestamp !== null) {
      const parsed =
        typeof event.timestamp === "number"
          ? new Date(event.timestamp)
          : new Date(event.timestamp);
      if (Number.isNaN(parsed.getTime())) {
        return NextResponse.json(
          { error: "event timestamp must be a valid date or epoch milliseconds" },
          { status: 400 },
        );
      }
    }
  }

  // Validate baseline images belong to correct rooms in this property (scoped to this property's rooms)
  const roomIds = propertyRooms.map((r) => r.id);
  const validBaselineRows = roomIds.length > 0
    ? await db
        .select({ id: baselineImages.id, roomId: baselineImages.roomId })
        .from(baselineImages)
        .where(inArray(baselineImages.roomId, roomIds))
    : [];
  const baselineToRoom = new Map(validBaselineRows.map((b) => [b.id, b.roomId]));

  for (const result of roomResults) {
    const baselineRoomId = baselineToRoom.get(result.baselineImageId);
    if (!baselineRoomId) {
      return NextResponse.json(
        { error: `Baseline image ${result.baselineImageId} not found` },
        { status: 400 },
      );
    }
    if (baselineRoomId !== result.roomId) {
      return NextResponse.json(
        { error: `Baseline image ${result.baselineImageId} does not belong to room ${result.roomId}` },
        { status: 400 },
      );
    }
  }

  // Validate completionTier
  const VALID_TIERS = ["minimum", "standard", "thorough"];
  const validatedTier = typeof completionTier === "string" && VALID_TIERS.includes(completionTier)
    ? completionTier
    : undefined;

  // Calculate overall readiness score
  const scores = roomResults.map((r) => r.score).filter((s) => s != null);
  const overallScore =
    scores.length > 0
      ? scores.reduce((a, b) => a + b, 0) / scores.length
      : null;

  // Transaction: atomically insert results + update inspection status
  const insertedResults = await db.transaction(async (tx) => {
    const inserted =
      roomResults.length > 0
        ? await tx
            .insert(inspectionResults)
            .values(
              roomResults.map((result) => ({
                inspectionId: id,
                roomId: result.roomId,
                baselineImageId: result.baselineImageId,
                currentImageUrl: result.currentImageUrl || "",
                status:
                  result.status ||
                  (result.score === null
                    ? "flagged"
                    : ((result.findings?.length ?? 0) === 0 ? "passed" : "flagged")),
                score: result.score ?? null,
                findings: result.findings || [],
                rawResponse: result.rawResponse,
              })),
            )
            .returning()
        : [];

    await tx
      .update(inspections)
      .set({
        status: "completed",
        completionTier: validatedTier,
        readinessScore: overallScore,
        notes: (notes as string) || undefined,
        effectiveCoverage: effectiveCoverage && typeof effectiveCoverage === "object"
          ? effectiveCoverage
          : undefined,
        completedAt: new Date(),
      })
      .where(eq(inspections.id, id));

    if (inspectionEventRows.length > 0) {
      await tx.insert(inspectionEvents).values(
        inspectionEventRows.map((event) => ({
          inspectionId: id,
          eventType: event.eventType.trim(),
          roomId: event.roomId || undefined,
          metadata: event.metadata || undefined,
          timestamp:
            event.timestamp !== undefined && event.timestamp !== null
              ? new Date(event.timestamp)
              : new Date(),
        })),
      );
    }

    return inserted;
  });

  // Emit InspectionCompleted event
  const totalFindings = roomResults.reduce(
    (sum, r) => sum + (r.findings?.length || 0),
    0,
  );
  const visitedRoomCount = new Set(roomResults.map((result) => result.roomId))
    .size;
  await emitEventSafe({
    eventType: "InspectionCompleted",
    aggregateId: id,
    propertyId: inspection.propertyId,
    userId: dbUser.id,
    payload: {
      completionTier: (validatedTier || "minimum") as "minimum" | "standard" | "thorough",
      overallScore: overallScore ?? 0,
      roomsVisited: visitedRoomCount,
      totalRooms: propertyRooms.length,
      durationMs: 0,
      findingsCount: totalFindings,
    },
  });

  // Route confirmed findings to automation lanes (non-blocking)
  try {
    const confirmedFindings = roomResults.flatMap((r) =>
      (r.findings || [])
        .filter((f) => f.status !== "dismissed")
        .map((f) => ({
          id: f.id,
          description: f.description || "",
          severity: f.severity || "maintenance",
          category: f.category || "condition",
          findingCategory: f.findingCategory,
          isClaimable: f.isClaimable,
          roomId: r.roomId,
          roomName: propertyRooms.find((rm) => rm.id === r.roomId)?.name,
        })),
    );

    if (confirmedFindings.length > 0) {
      const routing = routeFindings(inspection.propertyId, id, confirmedFindings);
      const automationEvents = generateAutomationEvents(routing.actions);

      // Emit automation events for downstream agents
      for (const event of automationEvents) {
        await emitEventSafe({
          eventType: event.eventType as "DamageClaimCreated" | "MaintenanceTicketCreated" | "RestockTaskCreated" | "PresentationTaskCreated",
          aggregateId: event.aggregateId,
          propertyId: event.propertyId,
          userId: dbUser.id,
          payload: event.payload,
        });
      }

      console.log(
        `[automation] Routed ${confirmedFindings.length} findings: ` +
        `${routing.summary.damageClaimCount} claims, ${routing.summary.maintenanceCount} maintenance, ` +
        `${routing.summary.restockCount} restock, ${routing.summary.presentationCount} presentation`,
      );
    }
  } catch (automationErr) {
    // Non-critical — don't fail the inspection submission
    console.warn("[automation] Failed to route findings:", automationErr);
  }

  return NextResponse.json(
    {
      inspection: {
        id,
        status: "completed",
        completionTier: validatedTier || null,
        readinessScore: overallScore,
      },
      results: insertedResults,
    },
    { status: 201 },
  );
  } catch (error) {
    console.error("[inspections/[id]/bulk] POST error:", error);
    void emitMissionControlIncident({
      title: "Inspection bulk submission error",
      description: error instanceof Error ? error.message : "Unknown error in /api/inspections/[id]/bulk",
      severity: "high",
      sourceId: "api:inspections_bulk",
    });
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}

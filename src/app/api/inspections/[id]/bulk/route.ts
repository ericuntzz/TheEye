import { NextRequest, NextResponse } from "next/server";
import { getDbUser, isValidUUID, isSafeUrl } from "@/lib/auth";
import { db } from "@/server/db";
import {
  inspections,
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

  const { results, completionTier, notes } = body;

  if (!results || !Array.isArray(results) || results.length === 0) {
    return NextResponse.json(
      { error: "results array is required and must not be empty" },
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

  const roomResults = results as BulkRoomResult[];

  // Validate all room IDs and baseline image IDs belong to this property
  const propertyRooms = await db
    .select({ id: rooms.id })
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
    const inserted = await tx
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
      .returning();

    await tx
      .update(inspections)
      .set({
        status: "completed",
        completionTier: validatedTier,
        readinessScore: overallScore,
        notes: (notes as string) || undefined,
        completedAt: new Date(),
      })
      .where(eq(inspections.id, id));

    return inserted;
  });

  // Emit InspectionCompleted event
  const totalFindings = roomResults.reduce(
    (sum, r) => sum + (r.findings?.length || 0),
    0,
  );
  await emitEventSafe({
    eventType: "InspectionCompleted",
    aggregateId: id,
    propertyId: inspection.propertyId,
    userId: dbUser.id,
    payload: {
      completionTier: (validatedTier || "minimum") as "minimum" | "standard" | "thorough",
      overallScore: overallScore ?? 0,
      roomsVisited: roomResults.length,
      totalRooms: propertyRooms.length,
      durationMs: 0,
      findingsCount: totalFindings,
    },
  });

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

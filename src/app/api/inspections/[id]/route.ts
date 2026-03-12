import { NextRequest, NextResponse } from "next/server";
import { getDbUser, isValidUUID, isSafeUrl } from "@/lib/auth";
import { db } from "@/server/db";
import {
  inspections,
  inspectionResults,
  rooms,
  baselineImages,
  properties,
} from "@/server/schema";
import { eq, and, inArray } from "drizzle-orm";
import { compareImages } from "@/lib/vision/compare";

// GET /api/inspections/[id] - Get inspection details with rooms
export async function GET(
  _request: NextRequest,
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

    // Get property info
    const [property] = await db
      .select()
      .from(properties)
      .where(eq(properties.id, inspection.propertyId));

    // Get rooms for this property
    const propertyRooms = await db
      .select()
      .from(rooms)
      .where(eq(rooms.propertyId, inspection.propertyId))
      .orderBy(rooms.sortOrder);

    // Batch-fetch all baselines for all rooms in one query (fixes N+1)
    const roomIds = propertyRooms.map((r) => r.id);
    const allBaselines = roomIds.length > 0
      ? await db.select().from(baselineImages).where(inArray(baselineImages.roomId, roomIds))
      : [];

    const baselinesByRoom = new Map<string, typeof allBaselines>();
    for (const bl of allBaselines) {
      const list = baselinesByRoom.get(bl.roomId) || [];
      list.push(bl);
      baselinesByRoom.set(bl.roomId, list);
    }

    const roomsWithBaselines = propertyRooms.map((room) => ({
      ...room,
      baselineImages: baselinesByRoom.get(room.id) || [],
    }));

    // Get existing results
    const results = await db
      .select()
      .from(inspectionResults)
      .where(eq(inspectionResults.inspectionId, id));

    return NextResponse.json({
      ...inspection,
      property,
      rooms: roomsWithBaselines,
      results,
    });
  } catch (error) {
    console.error("[inspections/[id]] GET error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}

// POST /api/inspections/[id] - Submit room comparison for inspection
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

    const { roomId, baselineImageId, currentImageUrl } = body;

    if (!roomId || !baselineImageId || !currentImageUrl) {
      return NextResponse.json(
        { error: "roomId, baselineImageId, and currentImageUrl are required" },
        { status: 400 },
      );
    }

    // Validate types and formats
    if (typeof roomId !== "string" || !isValidUUID(roomId)) {
      return NextResponse.json(
        { error: "Invalid roomId format" },
        { status: 400 },
      );
    }

    if (typeof baselineImageId !== "string" || !isValidUUID(baselineImageId)) {
      return NextResponse.json(
        { error: "Invalid baselineImageId format" },
        { status: 400 },
      );
    }

    if (typeof currentImageUrl !== "string" || !isSafeUrl(currentImageUrl)) {
      return NextResponse.json(
        { error: "Invalid or unsafe image URL" },
        { status: 400 },
      );
    }

    // Verify room belongs to the inspection's property
    const [room] = await db
      .select()
      .from(rooms)
      .where(
        and(
          eq(rooms.id, roomId),
          eq(rooms.propertyId, inspection.propertyId),
        ),
      );

    if (!room) {
      return NextResponse.json(
        { error: "Room not found for this property" },
        { status: 404 },
      );
    }

    // Get baseline info — verify it belongs to the same room
    const [baseline] = await db
      .select()
      .from(baselineImages)
      .where(
        and(
          eq(baselineImages.id, baselineImageId),
          eq(baselineImages.roomId, roomId),
        ),
      );

    if (!baseline) {
      return NextResponse.json(
        { error: "Baseline image not found for this room" },
        { status: 404 },
      );
    }

    // Compare images with Claude Vision API
    const comparisonResult = await compareImages({
      baselineImage: baseline.imageUrl,
      currentImages: [currentImageUrl],
      roomName: room.name,
    });
    const findings = comparisonResult.findings || [];
    // Null score means AI was unavailable; keep it null so downstream can detect "not evaluated".
    const aiUnavailable = comparisonResult.readiness_score === null;
    const score = comparisonResult.readiness_score;
    const rawResponse = JSON.stringify(comparisonResult);

    // Store full ComparisonFinding data as JSON
    const [result] = await db
      .insert(inspectionResults)
      .values({
        inspectionId: id,
        roomId,
        baselineImageId,
        currentImageUrl,
        status:
          aiUnavailable ? "flagged" : (findings.length === 0 ? "passed" : "flagged"),
        score,
        findings,
        rawResponse,
      })
      .returning();

    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    console.error("[inspections/[id]] POST error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}

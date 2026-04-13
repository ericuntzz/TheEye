import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { getDbUser, isValidUUID } from "@/lib/auth";
import { db } from "@/server/db";
import { inspections, inspectionResults, rooms } from "@/server/schema";

interface ResolveAnchorBody {
  roomId: string;
}

/**
 * POST /api/inspections/[id]/room-anchor
 *
 * Get-or-create a room-level anchor inspectionResult row.
 * Room anchors are used as the canonical target for manual/action items
 * instead of attaching them to random baseline-comparison results.
 *
 * Returns { anchorId, isNew } — the UUID of the anchor result row.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id: inspectionId } = await params;
    if (!isValidUUID(inspectionId)) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const dbUser = await getDbUser();
    if (!dbUser) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Verify inspection ownership
    const [inspection] = await db
      .select({ id: inspections.id })
      .from(inspections)
      .where(
        and(
          eq(inspections.id, inspectionId),
          eq(inspections.inspectorId, dbUser.id),
        ),
      );

    if (!inspection) {
      return NextResponse.json(
        { error: "Inspection not found" },
        { status: 404 },
      );
    }

    let body: ResolveAnchorBody;
    try {
      body = (await request.json()) as ResolveAnchorBody;
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const { roomId } = body;
    if (!roomId || !isValidUUID(roomId)) {
      return NextResponse.json(
        { error: "roomId is required and must be a valid UUID" },
        { status: 400 },
      );
    }

    // Verify room exists
    const [room] = await db
      .select({ id: rooms.id })
      .from(rooms)
      .where(eq(rooms.id, roomId));

    if (!room) {
      return NextResponse.json(
        { error: "Room not found" },
        { status: 404 },
      );
    }

    // Try to find existing room anchor
    const [existingAnchor] = await db
      .select({
        id: inspectionResults.id,
        findings: inspectionResults.findings,
      })
      .from(inspectionResults)
      .where(
        and(
          eq(inspectionResults.inspectionId, inspectionId),
          eq(inspectionResults.roomId, roomId),
          eq(inspectionResults.isRoomAnchor, true),
        ),
      );

    if (existingAnchor) {
      return NextResponse.json({
        ok: true,
        anchorId: existingAnchor.id,
        isNew: false,
        findingsCount: Array.isArray(existingAnchor.findings)
          ? existingAnchor.findings.length
          : 0,
      });
    }

    // Create new room anchor
    const [newAnchor] = await db
      .insert(inspectionResults)
      .values({
        inspectionId,
        roomId,
        baselineImageId: null,
        currentImageUrl: null,
        status: "passed", // No findings yet
        score: null,
        findings: [],
        isRoomAnchor: true,
      })
      .returning({
        id: inspectionResults.id,
      });

    return NextResponse.json({
      ok: true,
      anchorId: newAnchor.id,
      isNew: true,
      findingsCount: 0,
    });
  } catch (error) {
    console.error("[inspections/[id]/room-anchor] POST error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}

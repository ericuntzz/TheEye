import { NextRequest, NextResponse } from "next/server";
import { getDbUser, isValidUUID } from "@/lib/auth";
import { db } from "@/server/db";
import {
  inspections,
  rooms,
  baselineImages,
  baselineVersions,
  items,
  propertyConditions,
} from "@/server/schema";
import { eq, and, inArray, isNotNull } from "drizzle-orm";
import { isPlaceholderModelVersion } from "@/lib/vision/embedding-model-version";

// GET /api/inspections/[id]/baselines - Load all rooms with baseline images,
// embeddings, items, and known conditions for inspection start
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

    // Get all rooms for this property
    const propertyRooms = await db
      .select()
      .from(rooms)
      .where(eq(rooms.propertyId, inspection.propertyId))
      .orderBy(rooms.sortOrder);

    const roomIds = propertyRooms.map((r) => r.id);
    const activeBaselineVersions = await db
      .select({ id: baselineVersions.id })
      .from(baselineVersions)
      .where(
        and(
          eq(baselineVersions.propertyId, inspection.propertyId),
          eq(baselineVersions.isActive, true),
        ),
      );
    const activeBaselineVersionIds = activeBaselineVersions.map((row) => row.id);

    // Batch-fetch baselines and items in 2 queries (fixes N+1)
    const allBaselines = roomIds.length > 0
      ? await db
          .select({
            id: baselineImages.id,
            roomId: baselineImages.roomId,
            imageUrl: baselineImages.imageUrl,
            previewUrl: baselineImages.previewUrl,
            label: baselineImages.label,
            embedding: baselineImages.embedding,
            qualityScore: baselineImages.qualityScore,
            embeddingModelVersion: baselineImages.embeddingModelVersion,
            metadata: baselineImages.metadata,
          })
          .from(baselineImages)
          .where(
            and(
              inArray(baselineImages.roomId, roomIds),
              eq(baselineImages.isActive, true),
              isNotNull(baselineImages.embedding),
              activeBaselineVersionIds.length > 0
                ? inArray(
                    baselineImages.baselineVersionId,
                    activeBaselineVersionIds,
                  )
                : isNotNull(baselineImages.baselineVersionId),
            ),
          )
      : [];

    const allItems = roomIds.length > 0
      ? await db
          .select()
          .from(items)
          .where(inArray(items.roomId, roomIds))
      : [];

    // Group by roomId in memory
    const baselinesByRoom = new Map<string, typeof allBaselines>();
    for (const bl of allBaselines) {
      const list = baselinesByRoom.get(bl.roomId) || [];
      list.push(
        isPlaceholderModelVersion(bl.embeddingModelVersion)
          ? { ...bl, embedding: null }
          : bl,
      );
      baselinesByRoom.set(bl.roomId, list);
    }

    const itemsByRoom = new Map<string, typeof allItems>();
    for (const item of allItems) {
      const list = itemsByRoom.get(item.roomId) || [];
      list.push(item);
      itemsByRoom.set(item.roomId, list);
    }

    const roomsWithData = propertyRooms.map((room) => ({
      ...room,
      baselineImages: baselinesByRoom.get(room.id) || [],
      items: itemsByRoom.get(room.id) || [],
    }));

    // Load active property conditions (known issues to suppress)
    const conditions = await db
      .select()
      .from(propertyConditions)
      .where(
        and(
          eq(propertyConditions.propertyId, inspection.propertyId),
          eq(propertyConditions.isActive, true),
        ),
      );

    return NextResponse.json({
      inspectionId: id,
      propertyId: inspection.propertyId,
      inspectionMode: inspection.inspectionMode,
      rooms: roomsWithData,
      knownConditions: conditions,
    });
  } catch (error) {
    console.error("[inspections/[id]/baselines] GET error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}

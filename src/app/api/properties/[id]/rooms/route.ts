import { NextRequest, NextResponse } from "next/server";
import { getDbUser } from "@/lib/auth";
import { db } from "@/server/db";
import { properties, rooms, items, baselineImages } from "@/server/schema";
import { eq, and } from "drizzle-orm";

// GET /api/properties/[id]/rooms - List all rooms with items and baselines
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const dbUser = await getDbUser();
  if (!dbUser) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Verify property belongs to user
  const [property] = await db
    .select()
    .from(properties)
    .where(and(eq(properties.id, id), eq(properties.userId, dbUser.id)));

  if (!property) {
    return NextResponse.json({ error: "Property not found" }, { status: 404 });
  }

  const propertyRooms = await db
    .select()
    .from(rooms)
    .where(eq(rooms.propertyId, id))
    .orderBy(rooms.sortOrder);

  const roomsWithDetails = await Promise.all(
    propertyRooms.map(async (room) => {
      const [roomItems, roomBaselines] = await Promise.all([
        db.select().from(items).where(eq(items.roomId, room.id)),
        db
          .select()
          .from(baselineImages)
          .where(eq(baselineImages.roomId, room.id)),
      ]);

      return {
        ...room,
        items: roomItems,
        baselineImages: roomBaselines,
      };
    }),
  );

  return NextResponse.json(roomsWithDetails);
}

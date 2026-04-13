import { NextRequest, NextResponse } from "next/server";
import { getDbUser, isValidUUID } from "@/lib/auth";
import { db } from "@/server/db";
import { properties, propertySupplyItems, rooms } from "@/server/schema";
import { eq, and, asc } from "drizzle-orm";
import { emitEventSafe } from "@/lib/events/emit";

// GET /api/properties/[id]/supplies - List supply catalog for a property
export async function GET(
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

    const [property] = await db
      .select()
      .from(properties)
      .where(and(eq(properties.id, id), eq(properties.userId, dbUser.id)));

    if (!property) {
      return NextResponse.json({ error: "Property not found" }, { status: 404 });
    }

    const category = request.nextUrl.searchParams.get("category");
    const activeOnly = request.nextUrl.searchParams.get("active") !== "false";

    let query = db
      .select()
      .from(propertySupplyItems)
      .where(
        activeOnly
          ? and(
              eq(propertySupplyItems.propertyId, id),
              eq(propertySupplyItems.isActive, true),
            )
          : eq(propertySupplyItems.propertyId, id),
      )
      .orderBy(asc(propertySupplyItems.category), asc(propertySupplyItems.name));

    const items = await query;

    // Filter by category in JS if requested (avoids dynamic query building)
    const filtered = category
      ? items.filter((item) => item.category === category)
      : items;

    return NextResponse.json(filtered);
  } catch (error) {
    console.error("[supplies] GET error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// POST /api/properties/[id]/supplies - Add a supply item to the catalog
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

    const [property] = await db
      .select()
      .from(properties)
      .where(and(eq(properties.id, id), eq(properties.userId, dbUser.id)));

    if (!property) {
      return NextResponse.json({ error: "Property not found" }, { status: 404 });
    }

    let body: Record<string, unknown>;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const { name, category, amazonAsin, amazonUrl, defaultQuantity, parLevel, unit, vendor, notes, roomId } = body;

    if (typeof name !== "string" || !name.trim()) {
      return NextResponse.json({ error: "name is required" }, { status: 400 });
    }

    const validCategories = ["toiletry", "cleaning", "linen", "kitchen", "amenity", "maintenance", "other"];
    if (typeof category !== "string" || !validCategories.includes(category)) {
      return NextResponse.json(
        { error: `category must be one of: ${validCategories.join(", ")}` },
        { status: 400 },
      );
    }

    // Validate roomId if provided
    if (roomId !== undefined && roomId !== null) {
      if (typeof roomId !== "string" || !isValidUUID(roomId)) {
        return NextResponse.json({ error: "Invalid roomId format" }, { status: 400 });
      }
      const [room] = await db
        .select({ id: rooms.id })
        .from(rooms)
        .where(and(eq(rooms.id, roomId), eq(rooms.propertyId, id)));
      if (!room) {
        return NextResponse.json({ error: "Room not found for this property" }, { status: 404 });
      }
    }

    const [item] = await db
      .insert(propertySupplyItems)
      .values({
        propertyId: id,
        roomId: (roomId as string) || undefined,
        name: (name as string).trim(),
        category: category as string,
        amazonAsin: (amazonAsin as string) || undefined,
        amazonUrl: (amazonUrl as string) || undefined,
        defaultQuantity: typeof defaultQuantity === "number" ? defaultQuantity : 1,
        parLevel: typeof parLevel === "number" ? parLevel : undefined,
        unit: (unit as string) || "each",
        vendor: (vendor as string) || undefined,
        notes: (notes as string) || undefined,
      })
      .returning();

    void emitEventSafe({
      eventType: "SupplyItemAdded",
      aggregateId: item.id,
      propertyId: id,
      userId: dbUser.id,
      payload: {
        supplyItemId: item.id,
        name: item.name,
        category: item.category,
        amazonAsin: item.amazonAsin ?? undefined,
        roomId: item.roomId ?? undefined,
      },
    });

    return NextResponse.json(item, { status: 201 });
  } catch (error) {
    console.error("[supplies] POST error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// PATCH /api/properties/[id]/supplies - Update a supply item
export async function PATCH(
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

    const [property] = await db
      .select()
      .from(properties)
      .where(and(eq(properties.id, id), eq(properties.userId, dbUser.id)));

    if (!property) {
      return NextResponse.json({ error: "Property not found" }, { status: 404 });
    }

    let body: Record<string, unknown>;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const { supplyItemId, ...updates } = body;

    if (!supplyItemId || typeof supplyItemId !== "string" || !isValidUUID(supplyItemId as string)) {
      return NextResponse.json({ error: "Valid supplyItemId is required" }, { status: 400 });
    }

    // Verify the supply item belongs to this property
    const [existing] = await db
      .select()
      .from(propertySupplyItems)
      .where(
        and(
          eq(propertySupplyItems.id, supplyItemId as string),
          eq(propertySupplyItems.propertyId, id),
        ),
      );

    if (!existing) {
      return NextResponse.json({ error: "Supply item not found" }, { status: 404 });
    }

    // Handle roomId update: validate if provided, allow null/empty to clear
    if ("roomId" in updates) {
      if (updates.roomId === null || updates.roomId === "" || updates.roomId === undefined) {
        // Clear room assignment — allowed
      } else if (typeof updates.roomId === "string" && isValidUUID(updates.roomId)) {
        const [room] = await db
          .select({ id: rooms.id })
          .from(rooms)
          .where(and(eq(rooms.id, updates.roomId), eq(rooms.propertyId, id)));
        if (!room) {
          return NextResponse.json({ error: "Room not found for this property" }, { status: 404 });
        }
      } else {
        return NextResponse.json({ error: "Invalid roomId format" }, { status: 400 });
      }
    }

    // Build update object with only valid fields
    const updateData: Record<string, unknown> = { updatedAt: new Date() };
    if (typeof updates.name === "string" && updates.name.trim()) updateData.name = (updates.name as string).trim();
    if (typeof updates.category === "string") updateData.category = updates.category;
    if (typeof updates.amazonAsin === "string") updateData.amazonAsin = updates.amazonAsin || null;
    if (typeof updates.amazonUrl === "string") updateData.amazonUrl = updates.amazonUrl || null;
    if (typeof updates.defaultQuantity === "number") updateData.defaultQuantity = updates.defaultQuantity;
    if (typeof updates.parLevel === "number") updateData.parLevel = updates.parLevel;
    if (typeof updates.currentStock === "number") updateData.currentStock = updates.currentStock;
    if (typeof updates.unit === "string") updateData.unit = updates.unit;
    if (typeof updates.vendor === "string") updateData.vendor = updates.vendor || null;
    if (typeof updates.notes === "string") updateData.notes = updates.notes || null;
    if (typeof updates.isActive === "boolean") updateData.isActive = updates.isActive;
    if ("roomId" in updates) updateData.roomId = updates.roomId || null;

    const [updated] = await db
      .update(propertySupplyItems)
      .set(updateData)
      .where(eq(propertySupplyItems.id, supplyItemId as string))
      .returning();

    void emitEventSafe({
      eventType: "SupplyItemUpdated",
      aggregateId: supplyItemId as string,
      propertyId: id,
      userId: dbUser.id,
      payload: {
        supplyItemId: supplyItemId as string,
        changes: updateData,
      },
    });

    return NextResponse.json(updated);
  } catch (error) {
    console.error("[supplies] PATCH error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// DELETE /api/properties/[id]/supplies - Soft-delete a supply item
export async function DELETE(
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

    const [property] = await db
      .select()
      .from(properties)
      .where(and(eq(properties.id, id), eq(properties.userId, dbUser.id)));

    if (!property) {
      return NextResponse.json({ error: "Property not found" }, { status: 404 });
    }

    let body: Record<string, unknown>;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const { supplyItemId } = body;

    if (!supplyItemId || typeof supplyItemId !== "string" || !isValidUUID(supplyItemId as string)) {
      return NextResponse.json({ error: "Valid supplyItemId is required" }, { status: 400 });
    }

    const [existing] = await db
      .select()
      .from(propertySupplyItems)
      .where(
        and(
          eq(propertySupplyItems.id, supplyItemId as string),
          eq(propertySupplyItems.propertyId, id),
        ),
      );

    if (!existing) {
      return NextResponse.json({ error: "Supply item not found" }, { status: 404 });
    }

    // Soft delete
    await db
      .update(propertySupplyItems)
      .set({ isActive: false, updatedAt: new Date() })
      .where(eq(propertySupplyItems.id, supplyItemId as string));

    void emitEventSafe({
      eventType: "SupplyItemRemoved",
      aggregateId: supplyItemId as string,
      propertyId: id,
      userId: dbUser.id,
      payload: {
        supplyItemId: supplyItemId as string,
        name: existing.name,
      },
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("[supplies] DELETE error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

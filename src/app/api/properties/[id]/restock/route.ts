import { NextRequest, NextResponse } from "next/server";
import { getDbUser, isValidUUID } from "@/lib/auth";
import { db } from "@/server/db";
import {
  properties,
  restockOrders,
  restockOrderItems,
  propertySupplyItems,
} from "@/server/schema";
import { eq, and, desc, ilike, inArray } from "drizzle-orm";
import { emitEventSafe } from "@/lib/events/emit";

// GET /api/properties/[id]/restock - List restock orders for a property
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

    const status = request.nextUrl.searchParams.get("status");

    const orders = await db
      .select()
      .from(restockOrders)
      .where(
        status
          ? and(eq(restockOrders.propertyId, id), eq(restockOrders.status, status))
          : eq(restockOrders.propertyId, id),
      )
      .orderBy(desc(restockOrders.createdAt));

    // Batch-fetch items for all orders (avoids N+1)
    const orderIds = orders.map((o) => o.id);
    const allItems = orderIds.length > 0
      ? await db
          .select()
          .from(restockOrderItems)
          .where(inArray(restockOrderItems.orderId, orderIds))
      : [];

    const itemsByOrder = new Map<string, typeof allItems>();
    for (const item of allItems) {
      if (!itemsByOrder.has(item.orderId)) itemsByOrder.set(item.orderId, []);
      itemsByOrder.get(item.orderId)!.push(item);
    }

    const ordersWithItems = orders.map((order) => ({
      ...order,
      items: itemsByOrder.get(order.id) || [],
    }));

    return NextResponse.json(ordersWithItems);
  } catch (error) {
    console.error("[restock] GET error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// POST /api/properties/[id]/restock - Create a restock order (from inspection or manual)
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

    const { inspectionId, items, notes } = body;
    const normalizedInspectionId = typeof inspectionId === "string" ? inspectionId : undefined;
    const normalizedNotes =
      typeof notes === "string" && notes.trim().length > 0
        ? notes.trim()
        : undefined;

    if (!Array.isArray(items) || items.length === 0) {
      return NextResponse.json({ error: "items array is required and must not be empty" }, { status: 400 });
    }

    if (items.length > 100) {
      return NextResponse.json({ error: "Maximum 100 items per restock order" }, { status: 400 });
    }

    // Validate inspectionId if provided
    if (inspectionId && (typeof inspectionId !== "string" || !isValidUUID(inspectionId))) {
      return NextResponse.json({ error: "Invalid inspectionId" }, { status: 400 });
    }

    if (notes !== undefined && typeof notes !== "string") {
      return NextResponse.json({ error: "notes must be a string" }, { status: 400 });
    }

    // Validate all items before inserting anything
    const typedItems = items as Array<{
      name: string;
      supplyItemId?: string;
      amazonAsin?: string;
      quantity?: number;
      roomName?: string;
      source?: string;
    }>;

    for (const item of typedItems) {
      if (!item.name || typeof item.name !== "string" || !item.name.trim()) {
        return NextResponse.json({ error: "Each item must have a non-empty name" }, { status: 400 });
      }
      if (item.quantity !== undefined && (typeof item.quantity !== "number" || !Number.isInteger(item.quantity) || item.quantity < 1)) {
        return NextResponse.json({ error: `Invalid quantity for "${item.name}": must be a positive integer` }, { status: 400 });
      }
    }

    // Pre-fetch the property's full supply catalog for name-based matching
    const supplyCatalog = await db
      .select()
      .from(propertySupplyItems)
      .where(
        and(
          eq(propertySupplyItems.propertyId, id),
          eq(propertySupplyItems.isActive, true),
        ),
      );

    // Build a case-insensitive lookup map: lowercase name → supply item
    const catalogByName = new Map<string, typeof supplyCatalog[number]>();
    for (const s of supplyCatalog) {
      catalogByName.set(s.name.toLowerCase().trim(), s);
    }

    // Run the entire order + items creation in a transaction
    const result = await db.transaction(async (tx) => {
      // Create the order
      const [order] = await tx
        .insert(restockOrders)
        .values({
          propertyId: id,
          inspectionId: normalizedInspectionId,
          userId: dbUser.id,
          status: "draft",
          totalItems: typedItems.length,
          notes: normalizedNotes,
        })
        .returning();

      // Create order items, resolving catalog matches
      const orderItems = [];
      for (const item of typedItems) {
        let resolvedSupplyId = item.supplyItemId || undefined;
        let asin = item.amazonAsin || undefined;

        // If supplyItemId is explicitly provided, verify it belongs to this property's catalog
        if (resolvedSupplyId && isValidUUID(resolvedSupplyId)) {
          const match = supplyCatalog.find((s) => s.id === resolvedSupplyId);
          if (match) {
            // Valid catalog item — enrich ASIN
            if (match.amazonAsin) {
              asin = match.amazonAsin;
            }
          } else {
            // Foreign or stale ID — discard it so we don't write a bad FK
            resolvedSupplyId = undefined;
          }
        }

        // If no (valid) supplyItemId, try to match by name against the property's supply catalog
        if (!resolvedSupplyId) {
          const nameKey = item.name.toLowerCase().trim();
          const match = catalogByName.get(nameKey);
          if (match) {
            resolvedSupplyId = match.id;
            if (match.amazonAsin) {
              asin = match.amazonAsin;
            }
          }
        }

        const [orderItem] = await tx
          .insert(restockOrderItems)
          .values({
            orderId: order.id,
            supplyItemId: resolvedSupplyId,
            name: item.name.trim(),
            amazonAsin: asin || undefined,
            quantity: item.quantity || 1,
            roomName: item.roomName || undefined,
            source: item.source || "manual",
          })
          .returning();

        orderItems.push(orderItem);
      }

      // Generate Amazon cart URL from resolved ASINs
      const amazonCartUrl = generateAmazonCartUrl(orderItems);
      if (amazonCartUrl) {
        await tx
          .update(restockOrders)
          .set({ amazonCartUrl })
          .where(eq(restockOrders.id, order.id));
        order.amazonCartUrl = amazonCartUrl;
      }

      return { order, orderItems };
    });

    void emitEventSafe({
      eventType: "RestockOrderCreated",
      aggregateId: result.order.id,
      propertyId: id,
      userId: dbUser.id,
      payload: {
        orderId: result.order.id,
        itemCount: result.orderItems.length,
        inspectionId: normalizedInspectionId,
        amazonCartUrl: result.order.amazonCartUrl ?? undefined,
        source: normalizedInspectionId ? "inspection" : "manual",
      },
    });

    return NextResponse.json({ ...result.order, items: result.orderItems }, { status: 201 });
  } catch (error) {
    console.error("[restock] POST error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

/**
 * Generate an Amazon cart deep link URL from order items with ASINs.
 * Format: https://www.amazon.com/gp/aws/cart/add.html?ASIN.1=B0xxx&Quantity.1=2&ASIN.2=B0yyy&Quantity.2=6
 */
function generateAmazonCartUrl(
  items: Array<{ amazonAsin?: string | null; quantity: number }>,
): string | null {
  const itemsWithAsin = items.filter((item) => item.amazonAsin);
  if (itemsWithAsin.length === 0) return null;

  const params = itemsWithAsin
    .map((item, index) => {
      const i = index + 1;
      return `ASIN.${i}=${encodeURIComponent(item.amazonAsin!)}&Quantity.${i}=${item.quantity}`;
    })
    .join("&");

  return `https://www.amazon.com/gp/aws/cart/add.html?${params}`;
}

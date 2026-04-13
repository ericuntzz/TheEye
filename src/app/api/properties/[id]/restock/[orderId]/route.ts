import { NextRequest, NextResponse } from "next/server";
import { getDbUser, isValidUUID } from "@/lib/auth";
import { db } from "@/server/db";
import {
  properties,
  restockOrders,
  restockOrderItems,
} from "@/server/schema";
import { eq, and } from "drizzle-orm";
import { emitEventSafe } from "@/lib/events/emit";

// GET /api/properties/[id]/restock/[orderId] - Get a single restock order with items
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; orderId: string }> },
) {
  try {
    const { id, orderId } = await params;
    if (!isValidUUID(id) || !isValidUUID(orderId)) {
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

    const [order] = await db
      .select()
      .from(restockOrders)
      .where(
        and(
          eq(restockOrders.id, orderId),
          eq(restockOrders.propertyId, id),
        ),
      );

    if (!order) {
      return NextResponse.json({ error: "Order not found" }, { status: 404 });
    }

    const items = await db
      .select()
      .from(restockOrderItems)
      .where(eq(restockOrderItems.orderId, orderId));

    return NextResponse.json({ ...order, items });
  } catch (error) {
    console.error("[restock/orderId] GET error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// PATCH /api/properties/[id]/restock/[orderId] - Update order status, confirm items, regenerate cart URL
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; orderId: string }> },
) {
  try {
    const { id, orderId } = await params;
    if (!isValidUUID(id) || !isValidUUID(orderId)) {
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

    const [order] = await db
      .select()
      .from(restockOrders)
      .where(
        and(
          eq(restockOrders.id, orderId),
          eq(restockOrders.propertyId, id),
        ),
      );

    if (!order) {
      return NextResponse.json({ error: "Order not found" }, { status: 404 });
    }

    let body: Record<string, unknown>;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const { status, itemUpdates, notes } = body;

    // Validate status transitions
    const validStatuses = ["draft", "confirmed", "ordered", "delivered", "cancelled"];
    const VALID_TRANSITIONS: Record<string, string[]> = {
      draft: ["confirmed", "cancelled"],
      confirmed: ["ordered", "cancelled"],
      ordered: ["delivered", "cancelled"],
      delivered: [], // terminal
      cancelled: [], // terminal
    };

    if (typeof status === "string" && validStatuses.includes(status)) {
      const allowed = VALID_TRANSITIONS[order.status] || [];
      if (!allowed.includes(status)) {
        return NextResponse.json(
          { error: `Cannot transition from "${order.status}" to "${status}"` },
          { status: 400 },
        );
      }
    }

    // Run item updates + order update in a transaction
    const updated = await db.transaction(async (tx) => {
      // Update individual item statuses if provided
      if (Array.isArray(itemUpdates)) {
        for (const update of itemUpdates as Array<{ itemId: string; status?: string; quantity?: number }>) {
          if (!update.itemId || typeof update.itemId !== "string" || !isValidUUID(update.itemId)) continue;

          const setData: Record<string, unknown> = {};
          if (typeof update.status === "string" && ["pending", "confirmed", "removed"].includes(update.status)) {
            setData.status = update.status;
          }
          if (typeof update.quantity === "number" && Number.isInteger(update.quantity) && update.quantity > 0) {
            setData.quantity = update.quantity;
          }

          if (Object.keys(setData).length > 0) {
            await tx
              .update(restockOrderItems)
              .set(setData)
              .where(
                and(
                  eq(restockOrderItems.id, update.itemId),
                  eq(restockOrderItems.orderId, orderId),
                ),
              );
          }
        }
      }

      // Build order update
      const orderUpdates: Record<string, unknown> = { updatedAt: new Date() };

      if (typeof status === "string" && validStatuses.includes(status)) {
        orderUpdates.status = status;
        if (status === "confirmed") orderUpdates.confirmedAt = new Date();
        if (status === "ordered") orderUpdates.orderedAt = new Date();
        if (status === "delivered") orderUpdates.deliveredAt = new Date();
      }

      if (typeof notes === "string") {
        orderUpdates.notes = notes;
      }

      // Regenerate Amazon cart URL from confirmed/pending items
      const currentItems = await tx
        .select()
        .from(restockOrderItems)
        .where(eq(restockOrderItems.orderId, orderId));

      const activeItems = currentItems.filter((item) => item.status !== "removed");
      orderUpdates.totalItems = activeItems.length;

      const amazonCartUrl = generateAmazonCartUrl(activeItems);
      orderUpdates.amazonCartUrl = amazonCartUrl;

      const [result] = await tx
        .update(restockOrders)
        .set(orderUpdates)
        .where(eq(restockOrders.id, orderId))
        .returning();

      return { order: result, items: currentItems, activeItemCount: activeItems.length, cartUrl: amazonCartUrl };
    });

    const previousStatus = order.status;
    const newStatus = typeof status === "string" && validStatuses.includes(status) ? status : order.status;

    void emitEventSafe({
      eventType: "RestockOrderUpdated",
      aggregateId: orderId,
      propertyId: id,
      userId: dbUser.id,
      payload: {
        orderId,
        status: newStatus,
        previousStatus,
      },
    });

    if (newStatus === "confirmed" && previousStatus !== "confirmed") {
      void emitEventSafe({
        eventType: "RestockOrderConfirmed",
        aggregateId: orderId,
        propertyId: id,
        userId: dbUser.id,
        payload: {
          orderId,
          itemCount: updated.activeItemCount,
          amazonCartUrl: updated.cartUrl ?? undefined,
          confirmedBy: dbUser.id,
        },
      });
    }

    return NextResponse.json({ ...updated.order, items: updated.items });
  } catch (error) {
    console.error("[restock/orderId] PATCH error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// DELETE /api/properties/[id]/restock/[orderId] - Cancel/delete a restock order
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; orderId: string }> },
) {
  try {
    const { id, orderId } = await params;
    if (!isValidUUID(id) || !isValidUUID(orderId)) {
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

    const [order] = await db
      .select()
      .from(restockOrders)
      .where(
        and(
          eq(restockOrders.id, orderId),
          eq(restockOrders.propertyId, id),
        ),
      );

    if (!order) {
      return NextResponse.json({ error: "Order not found" }, { status: 404 });
    }

    // Only allow deletion of draft orders; cancel others
    if (order.status === "draft") {
      // Hard delete draft orders and their items (cascade handles items)
      await db.delete(restockOrders).where(eq(restockOrders.id, orderId));
      return NextResponse.json({ success: true, action: "deleted" });
    } else {
      // Mark non-draft orders as cancelled
      await db
        .update(restockOrders)
        .set({ status: "cancelled", updatedAt: new Date() })
        .where(eq(restockOrders.id, orderId));
      return NextResponse.json({ success: true, action: "cancelled" });
    }
  } catch (error) {
    console.error("[restock/orderId] DELETE error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

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

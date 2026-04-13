import { NextRequest, NextResponse } from "next/server";
import { getDbUser, isValidUUID } from "@/lib/auth";
import { db } from "@/server/db";
import {
  properties,
  restockOrders,
  restockOrderItems,
  propertyVendors,
} from "@/server/schema";
import { eq, and } from "drizzle-orm";
import { emitEventSafe } from "@/lib/events/emit";

/**
 * POST /api/properties/[id]/restock/[orderId]/dispatch
 *
 * Send a restock order to a vendor via email or SMS.
 * This is the non-Amazon path: for vendors who receive orders
 * via direct communication rather than Amazon cart links.
 *
 * Body: { vendorId: string, method: "email" | "sms", message?: string }
 */
export async function POST(
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
      .select({ id: properties.id, name: properties.name })
      .from(properties)
      .where(and(eq(properties.id, id), eq(properties.userId, dbUser.id)));

    if (!property) {
      return NextResponse.json({ error: "Property not found" }, { status: 404 });
    }

    // Verify order belongs to this property
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

    const { vendorId, method, message } = body;

    if (!vendorId || typeof vendorId !== "string" || !isValidUUID(vendorId)) {
      return NextResponse.json({ error: "Valid vendorId is required" }, { status: 400 });
    }

    if (method !== "email" && method !== "sms") {
      return NextResponse.json({ error: "method must be 'email' or 'sms'" }, { status: 400 });
    }

    // Verify vendor belongs to this property
    const [vendor] = await db
      .select()
      .from(propertyVendors)
      .where(
        and(
          eq(propertyVendors.id, vendorId),
          eq(propertyVendors.propertyId, id),
          eq(propertyVendors.isActive, true),
        ),
      );

    if (!vendor) {
      return NextResponse.json({ error: "Vendor not found" }, { status: 404 });
    }

    // Validate vendor has the required contact method
    if (method === "email" && !vendor.email) {
      return NextResponse.json({ error: "Vendor has no email address" }, { status: 400 });
    }
    if (method === "sms" && !vendor.phone) {
      return NextResponse.json({ error: "Vendor has no phone number" }, { status: 400 });
    }

    // Fetch order items for the message
    const items = await db
      .select()
      .from(restockOrderItems)
      .where(eq(restockOrderItems.orderId, orderId));

    // Build the dispatch message
    const itemList = items
      .map((item) => `• ${item.name} (×${item.quantity})${item.roomName ? ` — ${item.roomName}` : ""}`)
      .join("\n");

    const defaultMessage = [
      `Restock order for ${property.name}:`,
      "",
      itemList,
      "",
      `${items.length} item${items.length !== 1 ? "s" : ""} total.`,
      order.notes ? `\nNotes: ${order.notes}` : "",
    ].join("\n").trim();

    const finalMessage = typeof message === "string" && message.trim() ? message.trim() : defaultMessage;

    // Dispatch via the appropriate channel
    // For now, we store the dispatch record and return the message for client-side handling.
    // In production, this would integrate with Twilio (SMS) or SendGrid/Resend (email).
    const dispatchRecord = {
      orderId,
      vendorId: vendor.id,
      vendorName: vendor.name,
      method: method as "email" | "sms",
      destination: method === "email" ? vendor.email : vendor.phone,
      message: finalMessage,
      status: "prepared" as const,
      createdAt: new Date().toISOString(),
    };

    // Do NOT flip order status or emit events here.
    // The user hasn't actually sent anything yet — we're just preparing the deep links.
    // The client should call PATCH /dispatch with { confirmed: true } after the user
    // actually sends via the compose sheet.

    return NextResponse.json({
      dispatch: dispatchRecord,
      // Return deep links for client-side dispatch (open mail app / SMS app)
      deepLinks: {
        email: method === "email"
          ? `mailto:${vendor.email}?subject=${encodeURIComponent(`Restock Order — ${property.name}`)}&body=${encodeURIComponent(finalMessage)}`
          : undefined,
        sms: method === "sms"
          ? `sms:${vendor.phone}?body=${encodeURIComponent(finalMessage)}`
          : undefined,
      },
    }, { status: 200 });
  } catch (error) {
    console.error("[dispatch] POST error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

/**
 * PATCH /api/properties/[id]/restock/[orderId]/dispatch
 *
 * Confirm that a dispatch was actually sent by the user.
 * Called after the user returns from the compose sheet (mail/SMS app).
 *
 * Body: { confirmed: true, vendorId: string, method: "email" | "sms" }
 */
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
      .select({ id: properties.id })
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

    const { confirmed, vendorId, method } = body;

    if (confirmed !== true) {
      return NextResponse.json({ error: "confirmed must be true" }, { status: 400 });
    }

    if (!vendorId || typeof vendorId !== "string" || !isValidUUID(vendorId)) {
      return NextResponse.json({ error: "Valid vendorId is required" }, { status: 400 });
    }

    if (method !== "email" && method !== "sms") {
      return NextResponse.json({ error: "method must be 'email' or 'sms'" }, { status: 400 });
    }

    if (order.status === "draft") {
      return NextResponse.json(
        { error: "Order must be confirmed before dispatching to a vendor" },
        { status: 400 },
      );
    }

    if (order.status === "cancelled") {
      return NextResponse.json({ error: "Cancelled orders cannot be dispatched" }, { status: 400 });
    }

    if (order.status === "ordered" || order.status === "delivered") {
      return NextResponse.json({
        success: true,
        status: order.status,
        alreadyConfirmed: true,
      });
    }

    const [vendor] = await db
      .select({ id: propertyVendors.id, name: propertyVendors.name })
      .from(propertyVendors)
      .where(
        and(
          eq(propertyVendors.id, vendorId),
          eq(propertyVendors.propertyId, id),
          eq(propertyVendors.isActive, true),
        ),
      );

    if (!vendor) {
      return NextResponse.json({ error: "Vendor not found" }, { status: 404 });
    }

    await db
      .update(restockOrders)
      .set({
        status: "ordered",
        orderedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(restockOrders.id, orderId));

    void emitEventSafe({
      eventType: "VendorDispatchSent",
      aggregateId: orderId,
      propertyId: id,
      userId: dbUser.id,
      payload: {
        orderId,
        vendorName: vendor.name,
        method,
        itemCount: order.totalItems ?? 0,
      },
    });

    return NextResponse.json({ success: true, status: "ordered" });
  } catch (error) {
    console.error("[dispatch] PATCH error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

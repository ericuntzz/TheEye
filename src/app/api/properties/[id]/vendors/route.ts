import { NextRequest, NextResponse } from "next/server";
import { getDbUser, isValidUUID } from "@/lib/auth";
import { db } from "@/server/db";
import { properties, propertyVendors } from "@/server/schema";
import { eq, and, asc } from "drizzle-orm";
import { emitEventSafe } from "@/lib/events/emit";

const VALID_CATEGORIES = [
  "cleaning",
  "maintenance",
  "supplies",
  "linen",
  "landscaping",
  "pool",
  "pest_control",
  "other",
];

// GET /api/properties/[id]/vendors - List vendor contacts
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
      .select({ id: properties.id })
      .from(properties)
      .where(and(eq(properties.id, id), eq(properties.userId, dbUser.id)));

    if (!property) {
      return NextResponse.json({ error: "Property not found" }, { status: 404 });
    }

    const activeOnly = request.nextUrl.searchParams.get("active") !== "false";
    const category = request.nextUrl.searchParams.get("category");

    const vendors = await db
      .select()
      .from(propertyVendors)
      .where(
        activeOnly
          ? and(
              eq(propertyVendors.propertyId, id),
              eq(propertyVendors.isActive, true),
            )
          : eq(propertyVendors.propertyId, id),
      )
      .orderBy(asc(propertyVendors.category), asc(propertyVendors.name));

    const filtered = category
      ? vendors.filter((v) => v.category === category)
      : vendors;

    return NextResponse.json(filtered);
  } catch (error) {
    console.error("[vendors] GET error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// POST /api/properties/[id]/vendors - Add a vendor contact
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
      .select({ id: properties.id })
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

    const { name, category, email, phone, notes, isPreferred } = body;

    if (typeof name !== "string" || !name.trim()) {
      return NextResponse.json({ error: "name is required" }, { status: 400 });
    }

    if (typeof category !== "string" || !VALID_CATEGORIES.includes(category)) {
      return NextResponse.json(
        { error: `category must be one of: ${VALID_CATEGORIES.join(", ")}` },
        { status: 400 },
      );
    }

    if (!email && !phone) {
      return NextResponse.json(
        { error: "At least one of email or phone is required" },
        { status: 400 },
      );
    }

    const [vendor] = await db
      .insert(propertyVendors)
      .values({
        propertyId: id,
        name: (name as string).trim(),
        category: category as string,
        email: typeof email === "string" && email.trim() ? email.trim() : undefined,
        phone: typeof phone === "string" && phone.trim() ? phone.trim() : undefined,
        notes: typeof notes === "string" && notes.trim() ? notes.trim() : undefined,
        isPreferred: typeof isPreferred === "boolean" ? isPreferred : false,
      })
      .returning();

    void emitEventSafe({
      eventType: "VendorCreated",
      aggregateId: vendor.id,
      propertyId: id,
      userId: dbUser.id,
      payload: {
        vendorId: vendor.id,
        name: vendor.name,
        category: vendor.category,
      },
    });

    return NextResponse.json(vendor, { status: 201 });
  } catch (error) {
    console.error("[vendors] POST error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// PATCH /api/properties/[id]/vendors - Update a vendor contact
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
      .select({ id: properties.id })
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

    const { vendorId, ...updates } = body;

    if (!vendorId || typeof vendorId !== "string" || !isValidUUID(vendorId as string)) {
      return NextResponse.json({ error: "Valid vendorId is required" }, { status: 400 });
    }

    const [existing] = await db
      .select()
      .from(propertyVendors)
      .where(
        and(
          eq(propertyVendors.id, vendorId as string),
          eq(propertyVendors.propertyId, id),
        ),
      );

    if (!existing) {
      return NextResponse.json({ error: "Vendor not found" }, { status: 404 });
    }

    const updateData: Record<string, unknown> = { updatedAt: new Date() };
    if (typeof updates.name === "string" && updates.name.trim()) updateData.name = (updates.name as string).trim();
    if (typeof updates.category === "string" && VALID_CATEGORIES.includes(updates.category as string)) updateData.category = updates.category;
    if (typeof updates.email === "string") updateData.email = updates.email || null;
    if (typeof updates.phone === "string") updateData.phone = updates.phone || null;
    if (typeof updates.notes === "string") updateData.notes = updates.notes || null;
    if (typeof updates.isPreferred === "boolean") updateData.isPreferred = updates.isPreferred;
    if (typeof updates.isActive === "boolean") updateData.isActive = updates.isActive;

    const [updated] = await db
      .update(propertyVendors)
      .set(updateData)
      .where(eq(propertyVendors.id, vendorId as string))
      .returning();

    void emitEventSafe({
      eventType: "VendorUpdated",
      aggregateId: vendorId as string,
      propertyId: id,
      userId: dbUser.id,
      payload: {
        vendorId: vendorId as string,
        changes: updateData,
      },
    });

    return NextResponse.json(updated);
  } catch (error) {
    console.error("[vendors] PATCH error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// DELETE /api/properties/[id]/vendors - Soft-delete a vendor
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
      .select({ id: properties.id })
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

    const { vendorId } = body;

    if (!vendorId || typeof vendorId !== "string" || !isValidUUID(vendorId as string)) {
      return NextResponse.json({ error: "Valid vendorId is required" }, { status: 400 });
    }

    const [existing] = await db
      .select()
      .from(propertyVendors)
      .where(
        and(
          eq(propertyVendors.id, vendorId as string),
          eq(propertyVendors.propertyId, id),
        ),
      );

    if (!existing) {
      return NextResponse.json({ error: "Vendor not found" }, { status: 404 });
    }

    await db
      .update(propertyVendors)
      .set({ isActive: false, updatedAt: new Date() })
      .where(eq(propertyVendors.id, vendorId as string));

    void emitEventSafe({
      eventType: "VendorRemoved",
      aggregateId: vendorId as string,
      propertyId: id,
      userId: dbUser.id,
      payload: {
        vendorId: vendorId as string,
        name: existing.name,
      },
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("[vendors] DELETE error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

import { NextRequest, NextResponse } from "next/server";
import { getDbUser, isValidUUID } from "@/lib/auth";
import { db } from "@/server/db";
import { properties } from "@/server/schema";
import { eq, and, inArray } from "drizzle-orm";
import { emitEventSafe } from "@/lib/events/emit";

const MAX_BULK_DELETE = 50;

// DELETE /api/properties/bulk - Delete multiple properties
export async function DELETE(request: NextRequest) {
  try {
    const dbUser = await getDbUser();
    if (!dbUser) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    let body: Record<string, unknown>;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const { ids } = body;

    if (!Array.isArray(ids) || ids.length === 0) {
      return NextResponse.json(
        { error: "ids must be a non-empty array" },
        { status: 400 },
      );
    }

    if (ids.length > MAX_BULK_DELETE) {
      return NextResponse.json(
        { error: `Cannot delete more than ${MAX_BULK_DELETE} properties at once` },
        { status: 400 },
      );
    }

    // Validate all IDs are valid UUIDs
    const validIds = ids.filter(
      (id): id is string => typeof id === "string" && isValidUUID(id),
    );

    if (validIds.length === 0) {
      return NextResponse.json({ error: "No valid IDs provided" }, { status: 400 });
    }

    // Fetch properties to confirm ownership and get names for audit
    const userProperties = await db
      .select({ id: properties.id, name: properties.name })
      .from(properties)
      .where(
        and(inArray(properties.id, validIds), eq(properties.userId, dbUser.id)),
      );

    if (userProperties.length === 0) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const confirmedIds = userProperties.map((p) => p.id);

    // Delete all confirmed properties (cascade handles related data)
    await db
      .delete(properties)
      .where(inArray(properties.id, confirmedIds));

    // Emit audit events (non-blocking)
    for (const prop of userProperties) {
      void emitEventSafe({
        eventType: "PropertyUpdated",
        aggregateId: prop.id,
        propertyId: prop.id,
        userId: dbUser.id,
        payload: {
          action: "deleted",
          propertyName: prop.name,
          deletedAt: new Date().toISOString(),
        },
      });
    }

    return NextResponse.json({
      success: true,
      deletedCount: confirmedIds.length,
      deletedNames: userProperties.map((p) => p.name),
      warning: "This action is permanent and cannot be undone.",
    });
  } catch (error) {
    console.error("[properties/bulk] DELETE error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}

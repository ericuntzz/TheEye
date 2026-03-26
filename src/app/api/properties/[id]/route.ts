import { NextRequest, NextResponse } from "next/server";
import { getDbUser, isValidUUID } from "@/lib/auth";
import { db } from "@/server/db";
import { properties } from "@/server/schema";
import { eq, and } from "drizzle-orm";
import { emitEventSafe } from "@/lib/events/emit";
import { deleteOwnedPropertyGraph } from "@/lib/properties/delete-property-graph";
import {
  normalizePropertyName,
  normalizePropertyNameForComparison,
} from "@/lib/properties/name-utils";

// GET /api/properties/[id] - Get a single property
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const dbUser = await getDbUser();
    if (!dbUser) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id } = await params;

    if (!isValidUUID(id)) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const [property] = await db
      .select()
      .from(properties)
      .where(and(eq(properties.id, id), eq(properties.userId, dbUser.id)));

    if (!property) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    return NextResponse.json(property);
  } catch (error) {
    console.error("[properties/[id]] GET error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}

// Allowed fields for PATCH update (prevents mass assignment)
const ALLOWED_UPDATE_FIELDS = new Set([
  "name",
  "address",
  "city",
  "state",
  "zipCode",
  "propertyType",
  "bedrooms",
  "bathrooms",
  "squareFeet",
  "estimatedValue",
  "notes",
  "coverImageUrl",
]);

// PATCH /api/properties/[id] - Update a property
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const dbUser = await getDbUser();
    if (!dbUser) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id } = await params;

    if (!isValidUUID(id)) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    let body: Record<string, unknown>;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    // Validate property name if included
    if (body.name != null) {
      const name = normalizePropertyName(String(body.name));
      if (!name || name.length < 2 || name.length > 120) {
        return NextResponse.json(
          { error: "Property name must be between 2 and 120 characters" },
          { status: 400 },
        );
      }
      const SAFE_NAME_RE = /^[a-zA-Z0-9\s\-'.,#&()]+$/;
      if (!SAFE_NAME_RE.test(name)) {
        return NextResponse.json(
          { error: "Property name contains invalid characters" },
          { status: 400 },
        );
      }
      body.name = name;

      const normalizedRequestedName = normalizePropertyNameForComparison(name);
      const existingProperties = await db
        .select({ id: properties.id, name: properties.name })
        .from(properties)
        .where(eq(properties.userId, dbUser.id));

      const duplicateProperty = existingProperties.find(
        (property) =>
          property.id !== id &&
          normalizePropertyNameForComparison(property.name) === normalizedRequestedName,
      );

      if (duplicateProperty) {
        return NextResponse.json(
          { error: "You already have a property with this name. Choose a different name." },
          { status: 409 },
        );
      }
    }

    // Only allow whitelisted fields
    const updates: Record<string, unknown> = { updatedAt: new Date() };
    for (const [key, value] of Object.entries(body)) {
      if (ALLOWED_UPDATE_FIELDS.has(key)) {
        updates[key] = value;
      }
    }

    const [property] = await db
      .update(properties)
      .set(updates)
      .where(and(eq(properties.id, id), eq(properties.userId, dbUser.id)))
      .returning();

    if (!property) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    return NextResponse.json(property);
  } catch (error) {
    console.error("[properties/[id]] PATCH error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}

// DELETE /api/properties/[id] - Delete a property
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const dbUser = await getDbUser();
    if (!dbUser) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id } = await params;

    if (!isValidUUID(id)) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    // Fetch property before deletion for the audit event
    const [property] = await db
      .select()
      .from(properties)
      .where(and(eq(properties.id, id), eq(properties.userId, dbUser.id)));

    if (!property) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const deletedIds = await deleteOwnedPropertyGraph(dbUser.id, [id]);
    if (deletedIds.length === 0) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    // Emit audit event for property deletion
    await emitEventSafe({
      eventType: "PropertyUpdated",
      aggregateId: id,
      propertyId: id,
      userId: dbUser.id,
      payload: {
        action: "deleted",
        propertyName: property.name,
        deletedAt: new Date().toISOString(),
      },
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("[properties/[id]] DELETE error:", error);
    return NextResponse.json(
      {
        error:
          process.env.NODE_ENV === "development" && error instanceof Error
            ? error.message
            : "Internal server error",
      },
      { status: 500 },
    );
  }
}

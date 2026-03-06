import { NextRequest, NextResponse } from "next/server";
import { getDbUser } from "@/lib/auth";
import { db } from "@/server/db";
import { properties } from "@/server/schema";
import { eq, and } from "drizzle-orm";

// GET /api/properties/[id] - Get a single property
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const dbUser = await getDbUser();
  if (!dbUser) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  const [property] = await db
    .select()
    .from(properties)
    .where(and(eq(properties.id, id), eq(properties.userId, dbUser.id)));

  if (!property) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.json(property);
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
  const dbUser = await getDbUser();
  if (!dbUser) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
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
}

// DELETE /api/properties/[id] - Delete a property
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const dbUser = await getDbUser();
  if (!dbUser) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  const [property] = await db
    .delete(properties)
    .where(and(eq(properties.id, id), eq(properties.userId, dbUser.id)))
    .returning();

  if (!property) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.json({ success: true });
}

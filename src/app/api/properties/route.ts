import { NextRequest, NextResponse } from "next/server";
import { getDbUser } from "@/lib/auth";
import { db } from "@/server/db";
import { properties } from "@/server/schema";
import { eq } from "drizzle-orm";

// GET /api/properties - List all properties for the current user
export async function GET() {
  const dbUser = await getDbUser();
  if (!dbUser) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const userProperties = await db
    .select()
    .from(properties)
    .where(eq(properties.userId, dbUser.id));

  return NextResponse.json(userProperties);
}

// POST /api/properties - Create a new property
export async function POST(request: NextRequest) {
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

  if (!body.name || typeof body.name !== "string" || body.name.trim() === "") {
    return NextResponse.json(
      { error: "Property name is required" },
      { status: 400 },
    );
  }

  const parseIntSafe = (val: unknown): number | null => {
    if (val == null || val === "") return null;
    const n = parseInt(String(val), 10);
    return Number.isNaN(n) ? null : n;
  };

  const [property] = await db
    .insert(properties)
    .values({
      userId: dbUser.id,
      name: String(body.name).trim(),
      address: body.address ? String(body.address) : null,
      city: body.city ? String(body.city) : null,
      state: body.state ? String(body.state) : null,
      zipCode: body.zipCode ? String(body.zipCode) : null,
      propertyType: body.propertyType ? String(body.propertyType) : null,
      bedrooms: parseIntSafe(body.bedrooms),
      bathrooms: parseIntSafe(body.bathrooms),
      squareFeet: parseIntSafe(body.squareFeet),
      estimatedValue: body.estimatedValue ? String(body.estimatedValue) : null,
      notes: body.notes ? String(body.notes) : null,
    })
    .returning();

  return NextResponse.json(property, { status: 201 });
}

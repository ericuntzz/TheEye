import { NextRequest, NextResponse } from "next/server";
import { getDbUser } from "@/lib/auth";
import { db } from "@/server/db";
import { properties } from "@/server/schema";
import { eq } from "drizzle-orm";
import {
  normalizePropertyName,
  normalizePropertyNameForComparison,
} from "@/lib/properties/name-utils";

// GET /api/properties - List all properties for the current user (paginated)
export async function GET(request: NextRequest) {
  try {
    const dbUser = await getDbUser();
    if (!dbUser) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Parse pagination params (default: limit 50, offset 0)
    const url = request.nextUrl;
    const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") || "50", 10) || 50, 1), 100);
    const offset = Math.max(parseInt(url.searchParams.get("offset") || "0", 10) || 0, 0);

    const userProperties = await db
      .select()
      .from(properties)
      .where(eq(properties.userId, dbUser.id))
      .limit(limit)
      .offset(offset);

    return NextResponse.json(userProperties);
  } catch (error) {
    console.error("[properties] GET error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}

// POST /api/properties - Create a new property
export async function POST(request: NextRequest) {
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

    if (!body.name || typeof body.name !== "string" || body.name.trim() === "") {
      return NextResponse.json(
        { error: "Property name is required" },
        { status: 400 },
      );
    }
    const trimmedName = normalizePropertyName(String(body.name));
    if (trimmedName.length < 2 || trimmedName.length > 120) {
      return NextResponse.json(
        { error: "Property name must be between 2 and 120 characters" },
        { status: 400 },
      );
    }
    const SAFE_NAME_RE = /^[a-zA-Z0-9\s\-'.,#&()]+$/;
    if (!SAFE_NAME_RE.test(trimmedName)) {
      return NextResponse.json(
        { error: "Property name contains invalid characters" },
        { status: 400 },
      );
    }
    body.name = trimmedName;

    const normalizedRequestedName = normalizePropertyNameForComparison(trimmedName);
    const existingProperties = await db
      .select({ name: properties.name })
      .from(properties)
      .where(eq(properties.userId, dbUser.id));

    const duplicateProperty = existingProperties.find(
      (property) =>
        normalizePropertyNameForComparison(property.name) === normalizedRequestedName,
    );

    if (duplicateProperty) {
      return NextResponse.json(
        { error: "You already have a property with this name. Choose a different name." },
        { status: 409 },
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
        name: trimmedName,
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
  } catch (error) {
    console.error("[properties] POST error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}

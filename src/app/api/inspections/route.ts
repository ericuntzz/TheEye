import { NextRequest, NextResponse } from "next/server";
import { getDbUser, isValidUUID } from "@/lib/auth";
import { db } from "@/server/db";
import { properties, inspections } from "@/server/schema";
import { eq, and, desc } from "drizzle-orm";

// POST /api/inspections - Start a new inspection
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

  const { propertyId, inspectionMode } = body;

  if (!propertyId || typeof propertyId !== "string") {
    return NextResponse.json(
      { error: "propertyId is required" },
      { status: 400 },
    );
  }

  if (!isValidUUID(propertyId)) {
    return NextResponse.json({ error: "Property not found" }, { status: 404 });
  }

  const VALID_MODES = ["turnover", "maintenance", "owner_arrival", "vacancy_check"];
  if (inspectionMode !== undefined && (typeof inspectionMode !== "string" || !VALID_MODES.includes(inspectionMode))) {
    return NextResponse.json(
      { error: `Invalid inspectionMode. Must be one of: ${VALID_MODES.join(", ")}` },
      { status: 400 },
    );
  }
  const mode = (inspectionMode as string) || "turnover";

  // Verify property belongs to user and is trained
  const [property] = await db
    .select()
    .from(properties)
    .where(
      and(
        eq(properties.id, propertyId),
        eq(properties.userId, dbUser.id),
      ),
    );

  if (!property) {
    return NextResponse.json({ error: "Property not found" }, { status: 404 });
  }

  if (property.trainingStatus !== "trained") {
    return NextResponse.json(
      { error: "Property must be trained before inspection" },
      { status: 400 },
    );
  }

  const [inspection] = await db
    .insert(inspections)
    .values({
      propertyId,
      inspectorId: dbUser.id,
      status: "in_progress",
      inspectionMode: mode,
    })
    .returning();

  return NextResponse.json(inspection, { status: 201 });
  } catch (error) {
    console.error("[inspections] POST error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}

// GET /api/inspections - List inspections (newest first, paginated)
export async function GET(request: NextRequest) {
  try {
    const dbUser = await getDbUser();
    if (!dbUser) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Parse filters + pagination params (default: limit 50, offset 0)
    const url = request.nextUrl;
    const propertyId = url.searchParams.get("propertyId");
    const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") || "50", 10) || 50, 1), 100);
    const offset = Math.max(parseInt(url.searchParams.get("offset") || "0", 10) || 0, 0);
    if (propertyId && !isValidUUID(propertyId)) {
      return NextResponse.json(
        { error: "Invalid propertyId filter" },
        { status: 400 },
      );
    }

    const where = propertyId
      ? and(
          eq(inspections.inspectorId, dbUser.id),
          eq(inspections.propertyId, propertyId),
        )
      : eq(inspections.inspectorId, dbUser.id);

    const userInspections = await db
      .select()
      .from(inspections)
      .where(where)
      .orderBy(desc(inspections.startedAt))
      .limit(limit)
      .offset(offset);

    return NextResponse.json(userInspections);
  } catch (error) {
    console.error("[inspections] GET error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}

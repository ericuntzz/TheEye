import { NextRequest, NextResponse } from "next/server";
import { getDbUser } from "@/lib/auth";
import { db } from "@/server/db";
import { properties, inspections } from "@/server/schema";
import { eq, and, desc } from "drizzle-orm";

// POST /api/inspections - Start a new inspection
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

  const { propertyId } = body;

  if (!propertyId || typeof propertyId !== "string") {
    return NextResponse.json(
      { error: "propertyId is required" },
      { status: 400 },
    );
  }

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
    })
    .returning();

  return NextResponse.json(inspection, { status: 201 });
}

// GET /api/inspections - List inspections (newest first)
export async function GET() {
  const dbUser = await getDbUser();
  if (!dbUser) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const userInspections = await db
    .select()
    .from(inspections)
    .where(eq(inspections.inspectorId, dbUser.id))
    .orderBy(desc(inspections.startedAt));

  return NextResponse.json(userInspections);
}

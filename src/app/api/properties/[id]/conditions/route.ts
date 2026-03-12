import { NextRequest, NextResponse } from "next/server";
import { getDbUser, isValidUUID, isSafeUrl } from "@/lib/auth";
import { db } from "@/server/db";
import { properties, propertyConditions, rooms } from "@/server/schema";
import { eq, and } from "drizzle-orm";
import { emitEventSafe } from "@/lib/events/emit";

// GET /api/properties/[id]/conditions - List property conditions
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
    .select()
    .from(properties)
    .where(and(eq(properties.id, id), eq(properties.userId, dbUser.id)));

  if (!property) {
    return NextResponse.json(
      { error: "Property not found" },
      { status: 404 },
    );
  }

  const activeOnly =
    request.nextUrl.searchParams.get("active") !== "false";

  let conditions;
  if (activeOnly) {
    conditions = await db
      .select()
      .from(propertyConditions)
      .where(
        and(
          eq(propertyConditions.propertyId, id),
          eq(propertyConditions.isActive, true),
        ),
      );
  } else {
    conditions = await db
      .select()
      .from(propertyConditions)
      .where(eq(propertyConditions.propertyId, id));
  }

  return NextResponse.json(conditions);
  } catch (error) {
    console.error("[conditions] GET error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}

// POST /api/properties/[id]/conditions - Add a known condition
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
    .select()
    .from(properties)
    .where(and(eq(properties.id, id), eq(properties.userId, dbUser.id)));

  if (!property) {
    return NextResponse.json(
      { error: "Property not found" },
      { status: 404 },
    );
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { description, category, severity, roomId, imageUrl } = body;

  if (typeof description !== "string" || typeof category !== "string" || typeof severity !== "string") {
    return NextResponse.json(
      { error: "description, category, and severity must be strings" },
      { status: 400 },
    );
  }

  if (!description || !category || !severity) {
    return NextResponse.json(
      { error: "description, category, and severity are required" },
      { status: 400 },
    );
  }

  const validCategories = [
    "accepted_wear",
    "deferred_maintenance",
    "owner_approved",
    "known_defect",
  ];
  if (!validCategories.includes(category as string)) {
    return NextResponse.json(
      {
        error: `Invalid category. Must be one of: ${validCategories.join(", ")}`,
      },
      { status: 400 },
    );
  }

  const validSeverities = [
    "cosmetic",
    "maintenance",
    "safety",
    "urgent_repair",
    "guest_damage",
  ];
  if (!validSeverities.includes(severity as string)) {
    return NextResponse.json(
      {
        error: `Invalid severity. Must be one of: ${validSeverities.join(", ")}`,
      },
      { status: 400 },
    );
  }

  // Validate optional roomId if provided — must be a valid UUID and belong to this property
  if (roomId !== undefined && roomId !== null) {
    if (typeof roomId !== "string" || !isValidUUID(roomId)) {
      return NextResponse.json(
        { error: "Invalid roomId format" },
        { status: 400 },
      );
    }
    const [room] = await db
      .select({ id: rooms.id })
      .from(rooms)
      .where(and(eq(rooms.id, roomId), eq(rooms.propertyId, id)));
    if (!room) {
      return NextResponse.json(
        { error: "Room not found for this property" },
        { status: 404 },
      );
    }
  }

  // Validate optional imageUrl if provided
  if (imageUrl !== undefined && imageUrl !== null) {
    if (typeof imageUrl !== "string") {
      return NextResponse.json(
        { error: "imageUrl must be a string" },
        { status: 400 },
      );
    }
    if (!isSafeUrl(imageUrl)) {
      return NextResponse.json(
        { error: "Invalid or unsafe imageUrl" },
        { status: 400 },
      );
    }
  }

  const [condition] = await db
    .insert(propertyConditions)
    .values({
      propertyId: id,
      roomId: (roomId as string) || undefined,
      description: description as string,
      category: category as string,
      severity: severity as string | undefined,
      imageUrl: imageUrl as string | undefined,
      acknowledgedBy: dbUser.id,
    })
    .returning();

  await emitEventSafe({
    eventType: "ConditionRegistered",
    aggregateId: condition.id,
    propertyId: id,
    userId: dbUser.id,
    payload: {
      conditionId: condition.id,
      description: description as string,
      category: category as string,
      severity: (severity as string) || "unknown",
      roomId: roomId as string | undefined,
    },
  });

  return NextResponse.json(condition, { status: 201 });
  } catch (error) {
    console.error("[conditions] POST error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}

// PATCH /api/properties/[id]/conditions - Resolve a condition
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
    .select()
    .from(properties)
    .where(and(eq(properties.id, id), eq(properties.userId, dbUser.id)));

  if (!property) {
    return NextResponse.json(
      { error: "Property not found" },
      { status: 404 },
    );
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { conditionId, resolution } = body;

  if (!conditionId || typeof conditionId !== "string") {
    return NextResponse.json(
      { error: "conditionId is required" },
      { status: 400 },
    );
  }

  if (!isValidUUID(conditionId)) {
    return NextResponse.json(
      { error: "Invalid conditionId format" },
      { status: 400 },
    );
  }

  const [condition] = await db
    .select()
    .from(propertyConditions)
    .where(
      and(
        eq(propertyConditions.id, conditionId as string),
        eq(propertyConditions.propertyId, id),
      ),
    );

  if (!condition) {
    return NextResponse.json(
      { error: "Condition not found" },
      { status: 404 },
    );
  }

  await db
    .update(propertyConditions)
    .set({
      isActive: false,
      resolvedAt: new Date(),
    })
    .where(eq(propertyConditions.id, conditionId as string));

  await emitEventSafe({
    eventType: "ConditionResolved",
    aggregateId: conditionId,
    propertyId: id,
    userId: dbUser.id,
    payload: {
      conditionId,
      resolvedBy: dbUser.id,
      resolution: (resolution as string) || "Resolved",
    },
  });

  return NextResponse.json({ success: true });
  } catch (error) {
    console.error("[conditions] PATCH error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}

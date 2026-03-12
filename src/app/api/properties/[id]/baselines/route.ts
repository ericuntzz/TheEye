import { NextRequest, NextResponse } from "next/server";
import { getDbUser, isValidUUID } from "@/lib/auth";
import { db } from "@/server/db";
import {
  properties,
  baselineVersions,
} from "@/server/schema";
import { eq, and, sql } from "drizzle-orm";
import { emitEventSafe } from "@/lib/events/emit";

// GET /api/properties/[id]/baselines - List all baseline versions
export async function GET(
  _request: NextRequest,
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

    const versions = await db
      .select()
      .from(baselineVersions)
      .where(eq(baselineVersions.propertyId, id))
      .orderBy(baselineVersions.versionNumber);

    return NextResponse.json(versions);
  } catch (error) {
    console.error("[baselines] GET error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}

// POST /api/properties/[id]/baselines - Create a new baseline version
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

  const { label } = body;

  // Validate label if provided
  if (label !== undefined && label !== null && typeof label !== "string") {
    return NextResponse.json(
      { error: "label must be a string" },
      { status: 400 },
    );
  }

  // Transaction: atomically get next version, deactivate old, create new
  const version = await db.transaction(async (tx) => {
    // Serialize version creation per property to avoid duplicate versionNumber under concurrent writes.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${id}))`);

    const [maxRow] = await tx
      .select({
        maxVersion: sql<number>`COALESCE(MAX(${baselineVersions.versionNumber}), 0)`,
      })
      .from(baselineVersions)
      .where(eq(baselineVersions.propertyId, id));

    const nextVersion = (maxRow?.maxVersion ?? 0) + 1;

    // Deactivate all existing active versions
    await tx
      .update(baselineVersions)
      .set({ isActive: false })
      .where(
        and(
          eq(baselineVersions.propertyId, id),
          eq(baselineVersions.isActive, true),
        ),
      );

    // Create new active version
    const [created] = await tx
      .insert(baselineVersions)
      .values({
        propertyId: id,
        versionNumber: nextVersion,
        label: (label as string) || `Version ${nextVersion}`,
        isActive: true,
      })
      .returning();

    return created;
  });

  await emitEventSafe({
    eventType: "BaselineVersionCreated",
    aggregateId: id,
    propertyId: id,
    userId: dbUser.id,
    payload: {
      versionNumber: version.versionNumber,
      label: version.label || `Version ${version.versionNumber}`,
      roomCount: 0,
      baselineImageCount: 0,
    },
  });

  return NextResponse.json(version, { status: 201 });
  } catch (error) {
    console.error("[baselines] POST error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}

// PATCH /api/properties/[id]/baselines - Set active version
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

  const { versionId } = body;
  if (!versionId || typeof versionId !== "string") {
    return NextResponse.json(
      { error: "versionId is required" },
      { status: 400 },
    );
  }

  if (!isValidUUID(versionId)) {
    return NextResponse.json(
      { error: "Invalid versionId format" },
      { status: 400 },
    );
  }

  // Verify version belongs to property
  const [version] = await db
    .select()
    .from(baselineVersions)
    .where(
      and(
        eq(baselineVersions.id, versionId as string),
        eq(baselineVersions.propertyId, id),
      ),
    );

  if (!version) {
    return NextResponse.json(
      { error: "Version not found" },
      { status: 404 },
    );
  }

  // Transaction: atomically deactivate all, then activate target
  await db.transaction(async (tx) => {
    await tx
      .update(baselineVersions)
      .set({ isActive: false })
      .where(
        and(
          eq(baselineVersions.propertyId, id),
          eq(baselineVersions.isActive, true),
        ),
      );

    await tx
      .update(baselineVersions)
      .set({ isActive: true })
      .where(eq(baselineVersions.id, versionId as string));
  });

  await emitEventSafe({
    eventType: "BaselineVersionActivated",
    aggregateId: id,
    propertyId: id,
    userId: dbUser.id,
    payload: {
      versionId: versionId as string,
      versionNumber: version.versionNumber,
    },
  });

  return NextResponse.json({ success: true, activeVersionId: versionId });
  } catch (error) {
    console.error("[baselines] PATCH error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}

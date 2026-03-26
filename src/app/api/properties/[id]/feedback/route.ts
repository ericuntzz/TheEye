import { NextRequest, NextResponse } from "next/server";
import { getDbUser, isValidUUID } from "@/lib/auth";
import { db } from "@/server/db";
import { findingFeedback, properties } from "@/server/schema";
import { eq, and, sql } from "drizzle-orm";

/**
 * GET /api/properties/[id]/feedback
 *
 * Returns finding feedback for a property — used by mobile to seed
 * suppression rules at inspection start. Only returns dismissed findings
 * with their fingerprints and dismiss counts.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const dbUser = await getDbUser();
    if (!dbUser) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id: propertyId } = await params;
    if (!isValidUUID(propertyId)) {
      return NextResponse.json({ error: "Invalid property ID" }, { status: 400 });
    }

    // Verify ownership
    const [property] = await db
      .select({ id: properties.id })
      .from(properties)
      .where(and(eq(properties.id, propertyId), eq(properties.userId, dbUser.id)));

    if (!property) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    // Fetch all feedback for this property
    const feedback = await db
      .select({
        id: findingFeedback.id,
        findingFingerprint: findingFeedback.findingFingerprint,
        findingDescription: findingFeedback.findingDescription,
        findingCategory: findingFeedback.findingCategory,
        action: findingFeedback.action,
        dismissReason: findingFeedback.dismissReason,
        dismissCount: findingFeedback.dismissCount,
        roomId: findingFeedback.roomId,
        baselineImageId: findingFeedback.baselineImageId,
        createdAt: findingFeedback.createdAt,
      })
      .from(findingFeedback)
      .where(eq(findingFeedback.propertyId, propertyId))
      .orderBy(findingFeedback.createdAt);

    return NextResponse.json({ feedback });
  } catch (error) {
    console.error("[properties/[id]/feedback] GET error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

/**
 * POST /api/properties/[id]/feedback
 *
 * Records finding feedback (confirm/dismiss) for cross-inspection learning.
 * If the same fingerprint was already dismissed, increments the dismiss count.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const dbUser = await getDbUser();
    if (!dbUser) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id: propertyId } = await params;
    if (!isValidUUID(propertyId)) {
      return NextResponse.json({ error: "Invalid property ID" }, { status: 400 });
    }

    // Verify ownership
    const [property] = await db
      .select({ id: properties.id })
      .from(properties)
      .where(and(eq(properties.id, propertyId), eq(properties.userId, dbUser.id)));

    if (!property) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const body = await request.json().catch(() => null);
    if (!body) {
      return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
    }

    const {
      inspectionId,
      roomId,
      baselineImageId,
      findingFingerprint: fingerprint,
      findingDescription: description,
      findingCategory: category,
      findingSeverity: severity,
      action,
      dismissReason,
    } = body;

    if (typeof fingerprint !== "string" || typeof description !== "string" || typeof action !== "string") {
      return NextResponse.json(
        { error: "findingFingerprint, findingDescription, and action must be strings" },
        { status: 400 },
      );
    }
    if (!fingerprint || !description || !action) {
      return NextResponse.json(
        { error: "findingFingerprint, findingDescription, and action are required" },
        { status: 400 },
      );
    }
    // Validate optional UUIDs
    if (inspectionId && !isValidUUID(inspectionId)) {
      return NextResponse.json({ error: "Invalid inspectionId" }, { status: 400 });
    }
    if (roomId && !isValidUUID(roomId)) {
      return NextResponse.json({ error: "Invalid roomId" }, { status: 400 });
    }
    if (baselineImageId && !isValidUUID(baselineImageId)) {
      return NextResponse.json({ error: "Invalid baselineImageId" }, { status: 400 });
    }
    // Length validation
    if (fingerprint.length > 200 || description.length > 1000) {
      return NextResponse.json({ error: "Field too long" }, { status: 400 });
    }

    if (!["confirmed", "dismissed"].includes(action)) {
      return NextResponse.json(
        { error: "action must be 'confirmed' or 'dismissed'" },
        { status: 400 },
      );
    }

    // Upsert logic: one row per (propertyId, findingFingerprint).
    // - Dismiss: increment dismissCount, update action to "dismissed"
    // - Confirm after dismiss: update action to "confirmed", reset dismissCount to 0
    //   (removes suppression — the user is saying "this IS a real issue")
    const [existing] = await db
      .select({
        id: findingFeedback.id,
        dismissCount: findingFeedback.dismissCount,
        action: findingFeedback.action,
      })
      .from(findingFeedback)
      .where(
        and(
          eq(findingFeedback.propertyId, propertyId),
          eq(findingFeedback.findingFingerprint, fingerprint),
        ),
      )
      .limit(1);

    if (existing) {
      const newDismissCount = action === "dismissed"
        ? (existing.dismissCount ?? 0) + 1
        : 0; // Confirm resets dismiss count — removes suppression

      await db
        .update(findingFeedback)
        .set({
          action,
          dismissCount: newDismissCount,
          dismissReason: action === "dismissed" ? (dismissReason || null) : null,
          findingDescription: description, // Update to latest description
          findingCategory: category || null,
          findingSeverity: severity || null,
          updatedAt: new Date(),
          inspectionId: inspectionId || null,
        })
        .where(eq(findingFeedback.id, existing.id));

      return NextResponse.json({
        id: existing.id,
        dismissCount: newDismissCount,
        upserted: true,
      });
    }

    // Insert new feedback
    const [inserted] = await db
      .insert(findingFeedback)
      .values({
        propertyId,
        inspectionId: inspectionId || null,
        roomId: roomId || null,
        baselineImageId: baselineImageId || null,
        findingFingerprint: fingerprint,
        findingDescription: description,
        findingCategory: category || null,
        findingSeverity: severity || null,
        action,
        dismissReason: action === "dismissed" ? (dismissReason || null) : null,
        dismissCount: action === "dismissed" ? 1 : 0,
      })
      .returning({ id: findingFeedback.id });

    return NextResponse.json({
      id: inserted?.id,
      dismissCount: action === "dismissed" ? 1 : 0,
      upserted: false,
    }, { status: 201 });
  } catch (error) {
    console.error("[properties/[id]/feedback] POST error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

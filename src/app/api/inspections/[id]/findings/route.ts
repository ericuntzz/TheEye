import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { getDbUser, isValidUUID } from "@/lib/auth";
import { db } from "@/server/db";
import { inspections, inspectionResults, type Finding } from "@/server/schema";

interface DeleteFindingBody {
  resultId?: string;
  findingId?: string;
  findingIndex?: number;
}

interface PatchFindingBody {
  resultId: string;
  findingId?: string;
  findingIndex?: number;
  description: string;
  severity?: string;
  category?: string;
  itemType?: string;
  restockQuantity?: number;
  supplyItemId?: string;
  imageUrl?: string | null;
  videoUrl?: string | null;
  evidenceItems?: Array<{
    id: string;
    kind: "photo" | "video";
    url: string;
    thumbnailUrl?: string;
    durationMs?: number;
    createdAt?: string;
  }>;
  source?: string;
  derivedFromFindingId?: string | null;
  derivedFromComparisonId?: string | null;
  origin?: string;
}

interface PostFindingBody {
  resultId: string;
  description: string;
  severity?: string;
  category?: string;
  itemType?: string;
  restockQuantity?: number;
  supplyItemId?: string;
  imageUrl?: string;
  videoUrl?: string;
  evidenceItems?: Array<{
    id: string;
    kind: "photo" | "video";
    url: string;
    thumbnailUrl?: string;
    durationMs?: number;
    createdAt?: string;
  }>;
  source?: string;
  derivedFromFindingId?: string;
  derivedFromComparisonId?: string;
  origin?: string;
}

// DELETE /api/inspections/[id]/findings - Remove one finding/note from an inspection result
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id: inspectionId } = await params;
    if (!isValidUUID(inspectionId)) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const dbUser = await getDbUser();
    if (!dbUser) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const [inspection] = await db
      .select({ id: inspections.id })
      .from(inspections)
      .where(
        and(
          eq(inspections.id, inspectionId),
          eq(inspections.inspectorId, dbUser.id),
        ),
      );

    if (!inspection) {
      return NextResponse.json(
        { error: "Inspection not found" },
        { status: 404 },
      );
    }

    let body: DeleteFindingBody = {};
    try {
      body = (await request.json()) as DeleteFindingBody;
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const { resultId, findingId, findingIndex } = body;
    if (!resultId || typeof resultId !== "string" || !isValidUUID(resultId)) {
      return NextResponse.json(
        { error: "resultId is required and must be a valid UUID" },
        { status: 400 },
      );
    }

    if (
      (findingId === undefined || findingId === "") &&
      !Number.isInteger(findingIndex)
    ) {
      return NextResponse.json(
        { error: "Either findingId or findingIndex is required" },
        { status: 400 },
      );
    }

    const [result] = await db
      .select({
        id: inspectionResults.id,
        findings: inspectionResults.findings,
      })
      .from(inspectionResults)
      .where(
        and(
          eq(inspectionResults.id, resultId),
          eq(inspectionResults.inspectionId, inspectionId),
        ),
      );

    if (!result) {
      return NextResponse.json(
        { error: "Inspection result not found" },
        { status: 404 },
      );
    }

    const findings = Array.isArray(result.findings)
      ? [...(result.findings as Finding[])]
      : [];

    let removeIndex = -1;
    if (typeof findingId === "string" && findingId.length > 0) {
      removeIndex = findings.findIndex(
        (finding) =>
          typeof finding === "object" &&
          finding !== null &&
          "id" in finding &&
          (finding as { id?: string }).id === findingId,
      );
    }
    if (
      removeIndex === -1 &&
      Number.isInteger(findingIndex) &&
      (findingIndex as number) >= 0 &&
      (findingIndex as number) < findings.length
    ) {
      removeIndex = findingIndex as number;
    }

    if (removeIndex === -1) {
      return NextResponse.json(
        { error: "Finding not found in result" },
        { status: 404 },
      );
    }

    const [removed] = findings.splice(removeIndex, 1);

    const [updated] = await db
      .update(inspectionResults)
      .set({
        findings,
        status: findings.length > 0 ? "flagged" : "passed",
      })
      .where(eq(inspectionResults.id, resultId))
      .returning({
        id: inspectionResults.id,
        findings: inspectionResults.findings,
        status: inspectionResults.status,
      });

    return NextResponse.json({
      ok: true,
      removed,
      result: updated,
    });
  } catch (error) {
    console.error("[inspections/[id]/findings] DELETE error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}

// PATCH /api/inspections/[id]/findings - Update description of an existing finding
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id: inspectionId } = await params;
    if (!isValidUUID(inspectionId)) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const dbUser = await getDbUser();
    if (!dbUser) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const [inspection] = await db
      .select({ id: inspections.id })
      .from(inspections)
      .where(
        and(
          eq(inspections.id, inspectionId),
          eq(inspections.inspectorId, dbUser.id),
        ),
      );

    if (!inspection) {
      return NextResponse.json(
        { error: "Inspection not found" },
        { status: 404 },
      );
    }

    let body: PatchFindingBody;
    try {
      body = (await request.json()) as PatchFindingBody;
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const { resultId, findingId, findingIndex, description, ...optionalFields } = body;
    if (!resultId || typeof resultId !== "string" || !isValidUUID(resultId)) {
      return NextResponse.json(
        { error: "resultId is required and must be a valid UUID" },
        { status: 400 },
      );
    }
    if (!description || typeof description !== "string" || description.trim().length === 0) {
      return NextResponse.json(
        { error: "description is required" },
        { status: 400 },
      );
    }

    if (
      (findingId === undefined || findingId === "") &&
      !Number.isInteger(findingIndex)
    ) {
      return NextResponse.json(
        { error: "Either findingId or findingIndex is required" },
        { status: 400 },
      );
    }

    const [result] = await db
      .select({
        id: inspectionResults.id,
        findings: inspectionResults.findings,
      })
      .from(inspectionResults)
      .where(
        and(
          eq(inspectionResults.id, resultId),
          eq(inspectionResults.inspectionId, inspectionId),
        ),
      );

    if (!result) {
      return NextResponse.json(
        { error: "Inspection result not found" },
        { status: 404 },
      );
    }

    const findings = Array.isArray(result.findings)
      ? [...(result.findings as Finding[])]
      : [];

    let updateIndex = -1;
    if (typeof findingId === "string" && findingId.length > 0) {
      updateIndex = findings.findIndex(
        (finding) =>
          typeof finding === "object" &&
          finding !== null &&
          "id" in finding &&
          (finding as { id?: string }).id === findingId,
      );
    }
    if (
      updateIndex === -1 &&
      Number.isInteger(findingIndex) &&
      (findingIndex as number) >= 0 &&
      (findingIndex as number) < findings.length
    ) {
      updateIndex = findingIndex as number;
    }

    if (updateIndex === -1) {
      return NextResponse.json(
        { error: "Finding not found in result" },
        { status: 404 },
      );
    }

    // Build update object — apply all provided fields
    const VALID_SEVERITIES = ["cosmetic", "maintenance", "safety", "urgent_repair", "guest_damage"] as const;
    const VALID_CATEGORIES = [
      "missing", "moved", "cleanliness", "damage", "inventory",
      "operational", "safety", "restock", "presentation", "manual_note",
    ] as const;
    const VALID_ITEM_TYPES = ["note", "restock", "maintenance", "task"] as const;
    const VALID_ORIGINS = ["manual", "ai_prompt_accept", "template"] as const;

    const updates: Record<string, unknown> = { description: description.trim() };

    if (optionalFields.severity && (VALID_SEVERITIES as readonly string[]).includes(optionalFields.severity)) {
      updates.severity = optionalFields.severity;
    }
    if (optionalFields.category && (VALID_CATEGORIES as readonly string[]).includes(optionalFields.category)) {
      updates.category = optionalFields.category;
    }
    if (optionalFields.itemType && (VALID_ITEM_TYPES as readonly string[]).includes(optionalFields.itemType)) {
      updates.itemType = optionalFields.itemType;
    }
    if (optionalFields.source === "manual_note" || optionalFields.source === "ai") {
      updates.source = optionalFields.source;
    }
    if (optionalFields.origin && (VALID_ORIGINS as readonly string[]).includes(optionalFields.origin)) {
      updates.origin = optionalFields.origin;
    }
    if (optionalFields.restockQuantity !== undefined) {
      updates.restockQuantity = optionalFields.restockQuantity;
    }
    if (optionalFields.supplyItemId !== undefined) {
      updates.supplyItemId = optionalFields.supplyItemId;
    }
    if (optionalFields.imageUrl !== undefined) {
      updates.imageUrl = optionalFields.imageUrl;
    }
    if (optionalFields.videoUrl !== undefined) {
      updates.videoUrl = optionalFields.videoUrl;
    }
    if (optionalFields.evidenceItems !== undefined) {
      updates.evidenceItems = optionalFields.evidenceItems;
    }
    if (optionalFields.derivedFromFindingId !== undefined) {
      updates.derivedFromFindingId = optionalFields.derivedFromFindingId;
    }
    if (optionalFields.derivedFromComparisonId !== undefined) {
      updates.derivedFromComparisonId = optionalFields.derivedFromComparisonId;
    }

    findings[updateIndex] = {
      ...findings[updateIndex],
      ...updates,
    };

    const [updated] = await db
      .update(inspectionResults)
      .set({ findings })
      .where(eq(inspectionResults.id, resultId))
      .returning({
        id: inspectionResults.id,
        findings: inspectionResults.findings,
        status: inspectionResults.status,
      });

    return NextResponse.json({
      ok: true,
      finding: findings[updateIndex],
      result: updated,
    });
  } catch (error) {
    console.error("[inspections/[id]/findings] PATCH error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}

// POST /api/inspections/[id]/findings - Add a new manual note finding to an inspection result
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id: inspectionId } = await params;
    if (!isValidUUID(inspectionId)) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const dbUser = await getDbUser();
    if (!dbUser) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const [inspection] = await db
      .select({ id: inspections.id })
      .from(inspections)
      .where(
        and(
          eq(inspections.id, inspectionId),
          eq(inspections.inspectorId, dbUser.id),
        ),
      );

    if (!inspection) {
      return NextResponse.json(
        { error: "Inspection not found" },
        { status: 404 },
      );
    }

    let body: PostFindingBody;
    try {
      body = (await request.json()) as PostFindingBody;
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const {
      resultId, description, severity: rawSeverity,
      category: rawCategory, itemType: rawItemType,
      restockQuantity, supplyItemId, imageUrl, videoUrl,
      evidenceItems, source: rawSource,
      derivedFromFindingId, derivedFromComparisonId, origin: rawOrigin,
    } = body;

    const POST_VALID_SEVERITIES = ["cosmetic", "maintenance", "safety", "urgent_repair", "guest_damage"] as const;
    const POST_VALID_CATEGORIES = [
      "missing", "moved", "cleanliness", "damage", "inventory",
      "operational", "safety", "restock", "presentation", "manual_note",
    ] as const;
    const POST_VALID_ITEM_TYPES = ["note", "restock", "maintenance", "task"] as const;
    const POST_VALID_ORIGINS = ["manual", "ai_prompt_accept", "template"] as const;

    const severity = typeof rawSeverity === "string" && (POST_VALID_SEVERITIES as readonly string[]).includes(rawSeverity)
      ? rawSeverity
      : "maintenance";

    // Derive category: explicit > derived from itemType > default
    const itemType = typeof rawItemType === "string" && (POST_VALID_ITEM_TYPES as readonly string[]).includes(rawItemType)
      ? rawItemType
      : undefined;
    const ITEM_TYPE_TO_CATEGORY: Record<string, string> = {
      restock: "restock", maintenance: "operational", task: "manual_note", note: "manual_note",
    };
    const category = typeof rawCategory === "string" && (POST_VALID_CATEGORIES as readonly string[]).includes(rawCategory)
      ? rawCategory
      : (itemType ? ITEM_TYPE_TO_CATEGORY[itemType] || "manual_note" : "manual_note");

    const source = rawSource === "ai" ? "ai" : "manual_note";
    const origin = typeof rawOrigin === "string" && (POST_VALID_ORIGINS as readonly string[]).includes(rawOrigin)
      ? rawOrigin
      : "manual";
    if (!resultId || typeof resultId !== "string" || !isValidUUID(resultId)) {
      return NextResponse.json(
        { error: "resultId is required and must be a valid UUID" },
        { status: 400 },
      );
    }
    if (!description || typeof description !== "string" || description.trim().length === 0) {
      return NextResponse.json(
        { error: "description is required" },
        { status: 400 },
      );
    }

    const [result] = await db
      .select({
        id: inspectionResults.id,
        findings: inspectionResults.findings,
      })
      .from(inspectionResults)
      .where(
        and(
          eq(inspectionResults.id, resultId),
          eq(inspectionResults.inspectionId, inspectionId),
        ),
      );

    if (!result) {
      return NextResponse.json(
        { error: "Inspection result not found" },
        { status: 404 },
      );
    }

    const findings = Array.isArray(result.findings)
      ? [...(result.findings as Finding[])]
      : [];

    const newId = crypto.randomUUID();
    const newFinding: Finding = {
      id: newId,
      category: category as Finding["category"],
      description: description.trim(),
      severity: severity as Finding["severity"],
      confidence: 1,
      source: source as Finding["source"],
      status: "confirmed",
      createdAt: new Date().toISOString(),
      ...(itemType && { itemType: itemType as Finding["itemType"] }),
      ...(restockQuantity !== undefined && { restockQuantity }),
      ...(supplyItemId && { supplyItemId }),
      ...(imageUrl && { imageUrl }),
      ...(videoUrl && { videoUrl }),
      ...(evidenceItems && { evidenceItems }),
      ...(derivedFromFindingId && { derivedFromFindingId }),
      ...(derivedFromComparisonId && { derivedFromComparisonId }),
      ...(origin !== "manual" && { origin: origin as Finding["origin"] }),
    };

    findings.push(newFinding);

    const [updated] = await db
      .update(inspectionResults)
      .set({
        findings,
        status: "flagged",
      })
      .where(eq(inspectionResults.id, resultId))
      .returning({
        id: inspectionResults.id,
        findings: inspectionResults.findings,
        status: inspectionResults.status,
      });

    return NextResponse.json({
      ok: true,
      finding: newFinding,
      findingIndex: findings.length - 1,
      result: updated,
    });
  } catch (error) {
    console.error("[inspections/[id]/findings] POST error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}

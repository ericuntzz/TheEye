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

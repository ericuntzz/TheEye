import { NextRequest } from "next/server";
import { getDbUser, isValidUUID, isSafeUrl } from "@/lib/auth";
import { verifyGeometry, analyzeWithAI, type InspectionMode, type GeometryOutcome } from "@/lib/vision/compare";
import { rerankCandidateBaselinesByServerEmbedding } from "@/lib/vision/candidate-rerank";
import { db } from "@/server/db";
import { baselineImages, baselineVersions, inspections, rooms } from "@/server/schema";
import { eq, and, inArray } from "drizzle-orm";
import { emitEventSafe } from "@/lib/events/emit";

/**
 * POST /api/vision/compare-stream
 *
 * SSE endpoint for real-time image comparison. Used by the mobile app
 * to stream findings back during live inspection walkthroughs.
 *
 * Body: {
 *   baselineUrl: string,
 *   currentImages: string[] (1-2 base64 images),
 *   roomName: string,
 *   inspectionMode?: InspectionMode,
 *   knownConditions?: string[],
 *   inspectionId?: string,
 *   roomId?: string,
 *   baselineImageId?: string,
 * }
 *
 * Returns SSE:
 *   event: status (processing started)
 *   event: verified (geometric verification passed — client can grant early coverage credit)
 *   event: result (findings + score from AI, or localization_failed)
 *   event: done (stream complete)
 */
export async function POST(request: NextRequest) {
  try {
  const dbUser = await getDbUser();
  if (!dbUser) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const {
    baselineUrl,
    currentImages,
    roomName,
    inspectionMode,
    knownConditions,
    inspectionId,
    roomId,
    baselineImageId,
    clientSimilarity,
    topCandidateIds,
    userSelectedCandidateId,
    userConfirmed,
  } = body;

  if (!baselineUrl || !currentImages || !roomName) {
    return new Response(
      JSON.stringify({
        error: "baselineUrl, currentImages, and roomName are required",
      }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  if (!Array.isArray(currentImages) || currentImages.length === 0 || currentImages.length > 2) {
    return new Response(
      JSON.stringify({ error: "currentImages must be an array of 1-2 base64 strings" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  const images = currentImages as string[];

  // Validate knownConditions if provided
  const validatedConditions: string[] = Array.isArray(knownConditions)
    ? knownConditions.filter((c): c is string => typeof c === "string")
    : [];

  // Validate types for string params
  if (typeof baselineUrl !== "string" || typeof roomName !== "string") {
    return new Response(
      JSON.stringify({ error: "baselineUrl and roomName must be strings" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  // Validate URL safety (prevent SSRF)
  if (!isSafeUrl(baselineUrl)) {
    return new Response(
      JSON.stringify({ error: "Invalid baseline URL" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  // Validate optional UUIDs if provided
  if (inspectionId && (typeof inspectionId !== "string" || !isValidUUID(inspectionId))) {
    return new Response(
      JSON.stringify({ error: "Invalid inspectionId format" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }
  if (roomId && (typeof roomId !== "string" || !isValidUUID(roomId))) {
    return new Response(
      JSON.stringify({ error: "Invalid roomId format" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }
  if (baselineImageId && (typeof baselineImageId !== "string" || !isValidUUID(baselineImageId))) {
    return new Response(
      JSON.stringify({ error: "Invalid baselineImageId format" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }
  if (
    userSelectedCandidateId &&
    (typeof userSelectedCandidateId !== "string" || !isValidUUID(userSelectedCandidateId))
  ) {
    return new Response(
      JSON.stringify({ error: "Invalid userSelectedCandidateId format" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  // Validate ownership if persisting results
  let inspectionPropertyId: string | undefined;
  if (inspectionId) {
    const [inspection] = await db
      .select()
      .from(inspections)
      .where(
        and(
          eq(inspections.id, inspectionId as string),
          eq(inspections.inspectorId, dbUser.id),
        ),
      );

    if (!inspection) {
      return new Response(
        JSON.stringify({ error: "Inspection not found or not owned by user" }),
        { status: 404, headers: { "Content-Type": "application/json" } },
      );
    }

    inspectionPropertyId = inspection.propertyId;
  }

  // Validate inspectionMode if provided
  const VALID_MODES: InspectionMode[] = ["turnover", "maintenance", "owner_arrival", "vacancy_check"];
  const validatedMode: InspectionMode = typeof inspectionMode === "string" && VALID_MODES.includes(inspectionMode as InspectionMode)
    ? (inspectionMode as InspectionMode)
    : "turnover";

  const validatedClientSimilarity =
    typeof clientSimilarity === "number" && clientSimilarity >= 0 && clientSimilarity <= 1
      ? clientSimilarity
      : undefined;
  const validatedTopCandidateIds =
    Array.isArray(topCandidateIds) &&
    topCandidateIds.every((id: unknown) => typeof id === "string" && isValidUUID(id as string)) &&
    topCandidateIds.length <= 5
      ? (topCandidateIds as string[])
      : undefined;
  const validatedUserSelectedCandidateId =
    typeof userSelectedCandidateId === "string" && isValidUUID(userSelectedCandidateId)
      ? userSelectedCandidateId
      : undefined;

  let scopedCandidateBaselines:
    | Array<{
        id: string;
        imageUrl: string;
        verificationImageUrl?: string | null;
        embedding?: number[] | null;
      }>
    | undefined;
  if (validatedTopCandidateIds?.length && inspectionPropertyId) {
    const scopedRows = await db
      .select({
        id: baselineImages.id,
        imageUrl: baselineImages.imageUrl,
        verificationImageUrl: baselineImages.verificationImageUrl,
        embedding: baselineImages.embedding,
      })
      .from(baselineImages)
      .innerJoin(rooms, eq(baselineImages.roomId, rooms.id))
      .innerJoin(
        baselineVersions,
        eq(baselineImages.baselineVersionId, baselineVersions.id),
      )
      .where(
        and(
          inArray(baselineImages.id, validatedTopCandidateIds),
          eq(baselineImages.isActive, true),
          eq(rooms.propertyId, inspectionPropertyId),
          eq(baselineVersions.propertyId, inspectionPropertyId),
          eq(baselineVersions.isActive, true),
        ),
      );

    if (scopedRows.length !== validatedTopCandidateIds.length) {
      return new Response(
        JSON.stringify({ error: "One or more candidate baselines were out of scope" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    const byId = new Map(scopedRows.map((row) => [row.id, row]));
    scopedCandidateBaselines = validatedTopCandidateIds
      .map((id) => byId.get(id))
      .filter((row): row is NonNullable<typeof row> => Boolean(row));

    if (
      validatedUserSelectedCandidateId &&
      !scopedCandidateBaselines.some((candidate) => candidate.id === validatedUserSelectedCandidateId)
    ) {
      return new Response(
        JSON.stringify({ error: "Selected candidate was out of scope" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }
  }

  let orderedCandidateBaselines = scopedCandidateBaselines;
  if (
    scopedCandidateBaselines?.length &&
    scopedCandidateBaselines.some(
      (candidate) => Array.isArray(candidate.embedding) && candidate.embedding.length > 0,
    )
  ) {
    try {
      orderedCandidateBaselines =
        await rerankCandidateBaselinesByServerEmbedding(
          Buffer.from(images[0], "base64"),
          scopedCandidateBaselines,
          {
            allowPlaceholder: process.env.ALLOW_PLACEHOLDER_EMBEDDINGS === "1",
          },
        );
    } catch (error) {
      console.warn(
        "[compare-stream] Server embedding reranking unavailable; using client candidate order:",
        error,
      );
    }
  }

  // Create SSE stream
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      // Send status event
      controller.enqueue(
        encoder.encode(
          `event: status\ndata: ${JSON.stringify({ status: "processing", roomName })}\n\n`,
        ),
      );

      try {
        const compareStartedAt = Date.now();
        const comparisonId = crypto.randomUUID();

        if (inspectionId && roomId && baselineImageId) {
          await emitEventSafe({
            eventType: "ComparisonSent",
            aggregateId: inspectionId as string,
            propertyId: inspectionPropertyId,
            userId: dbUser.id,
            payload: {
              roomId: roomId as string,
              baselineImageId: baselineImageId as string,
              source: "mobile",
              mode: images.length > 1 ? "burst" : "single",
            },
            metadata: {
              source: "mobile",
              inspectionMode: validatedMode,
              action: "vision_compare_stream",
            },
          });
        }

        const compareOptions = {
          baselineImage: baselineUrl as string,
          currentImages: images,
          roomName: roomName as string,
          inspectionMode: validatedMode,
          knownConditions: validatedConditions,
          baselineIsBase64: false,
          currentImagesAreBase64: true,
          topCandidateIds: validatedTopCandidateIds,
          clientSimilarity: validatedClientSimilarity,
          userSelectedCandidateId: validatedUserSelectedCandidateId,
          candidateBaselines: orderedCandidateBaselines,
          userConfirmed: userConfirmed === true,
        };

        // Phase 1: Geometric verification (~500ms-2s)
        const geometry = await verifyGeometry(compareOptions);

        if (!geometry.verified) {
          // Localization failed — emit result directly (no verified event)
          const failedResult = {
            status: "localization_failed" as const,
            findings: [],
            summary: "Could not verify this view.",
            readiness_score: null,
            verifiedBaselineId: geometry.verifiedCandidateId,
            userGuidance: "Try a slightly different angle.",
            comparisonId,
            diagnostics: {
              skippedByPreflight: true,
              model: "geometric-verify",
              geometricVerification: geometry.diagnostics,
            },
          };

          controller.enqueue(
            encoder.encode(
              `event: result\ndata: ${JSON.stringify(failedResult)}\n\n`,
            ),
          );
        } else {
          // Emit fast "verified" event — client can grant coverage credit NOW
          controller.enqueue(
            encoder.encode(
              `event: verified\ndata: ${JSON.stringify({
                comparisonId,
                verifiedBaselineId: geometry.verifiedCandidateId,
                verificationMode: geometry.verificationMode,
                diagnostics: geometry.diagnostics,
              })}\n\n`,
            ),
          );

          // Phase 2: Preflight + Claude Vision (~100ms-30s)
          const result = await analyzeWithAI(geometry, compareOptions);

          // Attach comparisonId for client-side correlation
          const resultWithId = { ...result, comparisonId };

          controller.enqueue(
            encoder.encode(
              `event: result\ndata: ${JSON.stringify(resultWithId)}\n\n`,
            ),
          );
        }

        // Emit telemetry event
        if (inspectionId && roomId && baselineImageId) {
          const geometricDiagnostics = geometry.diagnostics;
          await emitEventSafe({
            eventType: "ComparisonReceived",
            aggregateId: inspectionId as string,
            propertyId: inspectionPropertyId,
            userId: dbUser.id,
            payload: {
              roomId: roomId as string,
              baselineImageId: baselineImageId as string,
              findingsCount: 0,
              latencyMs: Date.now() - compareStartedAt,
              clientSimilarity: validatedClientSimilarity,
              topCandidateIds: validatedTopCandidateIds,
              verifiedCandidateId: geometry.verifiedCandidateId ?? undefined,
              gateDecision: geometry.verified ? "localized_changed" : "localization_failed",
              serverEmbeddingSimilarity:
                geometricDiagnostics?.serverEmbeddingSimilarity,
              candidatesAttempted: geometricDiagnostics?.candidatesAttempted,
              geometricVerified: geometricDiagnostics?.verified,
              geometricInliers: geometricDiagnostics?.inlierCount,
              geometricInlierRatio: geometricDiagnostics?.inlierRatio,
              geometricInlierSpread: geometricDiagnostics?.inlierSpread,
              geometricOverlapArea: geometricDiagnostics?.overlapArea,
              rejectionReasons: geometricDiagnostics?.rejectionReasons,
            },
            metadata: {
              source: "mobile",
              inspectionMode: validatedMode,
              action: "vision_compare_stream",
            },
          });
        }

        // Send done event
        controller.enqueue(
          encoder.encode(
            `event: done\ndata: ${JSON.stringify({ comparisonId, status: "complete" })}\n\n`,
          ),
        );
      } catch (streamErr) {
        console.error("[compare-stream] Comparison failed:", streamErr);
        controller.enqueue(
          encoder.encode(
            `event: error\ndata: ${JSON.stringify({ error: "Comparison failed" })}\n\n`,
          ),
        );
      }

      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
  } catch (error) {
    console.error("[vision/compare-stream] POST error:", error);
    return new Response(JSON.stringify({ error: "Internal server error" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}

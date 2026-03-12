import { NextRequest } from "next/server";
import { getDbUser, isValidUUID, isSafeUrl } from "@/lib/auth";
import { compareImages, type InspectionMode } from "@/lib/vision/compare";
import { db } from "@/server/db";
import { inspectionResults, inspections } from "@/server/schema";
import { eq, and } from "drizzle-orm";
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
 *   event: result (findings + score)
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

        // Run comparison
        const result = await compareImages({
          baselineImage: baselineUrl as string,
          currentImages: images,
          roomName: roomName as string,
          inspectionMode: validatedMode,
          knownConditions: validatedConditions,
          baselineIsBase64: false,
          currentImagesAreBase64: true,
        });

        if (inspectionId && roomId && baselineImageId) {
          await emitEventSafe({
            eventType: "ComparisonReceived",
            aggregateId: inspectionId as string,
            propertyId: inspectionPropertyId,
            userId: dbUser.id,
            payload: {
              roomId: roomId as string,
              baselineImageId: baselineImageId as string,
              findingsCount: result.findings.length,
              score: result.readiness_score ?? undefined,
              latencyMs: Date.now() - compareStartedAt,
              skippedByPreflight: result.diagnostics?.skippedByPreflight,
              preflightReason: result.diagnostics?.preflight?.reason,
              preflightSsim: result.diagnostics?.preflight?.ssim,
              preflightDiffPercent:
                result.diagnostics?.preflight?.diffPercent,
              preflightAlignmentScore:
                result.diagnostics?.preflight?.alignment.score,
            },
            metadata: {
              source: "mobile",
              inspectionMode: validatedMode,
              action: "vision_compare_stream",
            },
          });
        }

        // Send result event
        controller.enqueue(
          encoder.encode(
            `event: result\ndata: ${JSON.stringify(result)}\n\n`,
          ),
        );

        // Optionally persist to inspectionResults
        if (inspectionId && roomId && baselineImageId) {
          try {
            const aiUnavailable = result.readiness_score === null;
            await db.insert(inspectionResults).values({
              inspectionId: inspectionId as string,
              roomId: roomId as string,
              baselineImageId: baselineImageId as string,
              currentImageUrl: "base64-capture",
              status: aiUnavailable
                ? "flagged"
                : (result.findings.length === 0 ? "passed" : "flagged"),
              score: result.readiness_score,
              findings: result.findings,
              rawResponse: JSON.stringify(result),
            });
          } catch (dbError) {
            console.error("Failed to persist comparison result:", dbError);
          }
        }

        // Send done event
        controller.enqueue(
          encoder.encode(
            `event: done\ndata: ${JSON.stringify({ status: "complete" })}\n\n`,
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

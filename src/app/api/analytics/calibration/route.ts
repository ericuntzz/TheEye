import { NextRequest, NextResponse } from "next/server";
import { getDbUser } from "@/lib/auth";
import { generateCalibrationReport } from "@/lib/analytics/calibration";

/**
 * GET /api/analytics/calibration
 *
 * Generates a calibration report analyzing inspection feedback,
 * false positive patterns, stubborn baselines, and category accuracy.
 * Used by the admin dashboard and nightly calibration jobs.
 *
 * Query params:
 *   days?: number (default 30) — analysis window in days
 */
export async function GET(request: NextRequest) {
  try {
    const dbUser = await getDbUser();
    if (!dbUser) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const searchParams = request.nextUrl.searchParams;
    const days = Math.min(
      90,
      Math.max(1, parseInt(searchParams.get("days") || "30", 10) || 30),
    );

    const report = await generateCalibrationReport(dbUser.id, days);

    return NextResponse.json(report);
  } catch (error) {
    console.error("[analytics/calibration] GET error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

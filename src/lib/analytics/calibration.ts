/**
 * Nightly Calibration & Feedback Analytics
 *
 * Analyzes inspection feedback data to continuously improve:
 * - Finding accuracy (reduce false positives)
 * - Threshold tuning (per-property, per-category)
 * - Prompt optimization (identify weak detection patterns)
 * - Stubborn baseline identification (training data quality)
 *
 * This runs as a server-side analytics pipeline, not real-time.
 * Results feed into suppression rules and prompt templates.
 */

import { db } from "@/server/db";
import { findingFeedback, inspections, inspectionResults, inspectionEvents, properties } from "@/server/schema";
import { eq, and, gte, sql, desc } from "drizzle-orm";

export interface CalibrationReport {
  generatedAt: string;
  propertyCount: number;
  inspectionCount: number;
  findings: {
    totalConfirmed: number;
    totalDismissed: number;
    falsePositiveRate: number;
    topFalsePositivePatterns: Array<{
      fingerprint: string;
      description: string;
      dismissCount: number;
      category: string | null;
      propertyId: string;
    }>;
  };
  stubbornBaselines: Array<{
    baselineLabel: string;
    survivalCount: number; // Times it was the last uncaptured angle
    propertyId: string;
    roomId: string;
  }>;
  categoryAccuracy: Record<string, {
    confirmed: number;
    dismissed: number;
    accuracy: number;
  }>;
  recommendations: string[];
}

/**
 * Generate a calibration report from recent inspection data.
 * This analyzes the last 30 days of inspections across all properties.
 */
export async function generateCalibrationReport(
  userId: string,
  days: number = 30,
): Promise<CalibrationReport> {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  // Get all user's properties
  const userProperties = await db
    .select({ id: properties.id })
    .from(properties)
    .where(eq(properties.userId, userId));

  const propertyIds = userProperties.map((p) => p.id);
  if (propertyIds.length === 0) {
    return emptyReport();
  }

  // Get all feedback for user's properties
  const allFeedback = await db
    .select()
    .from(findingFeedback)
    .where(gte(findingFeedback.createdAt, cutoff))
    .orderBy(desc(findingFeedback.dismissCount));

  // Filter to user's properties
  const userFeedback = allFeedback.filter((f) => propertyIds.includes(f.propertyId));

  // Get recent inspections count
  const recentInspections = await db
    .select({ id: inspections.id })
    .from(inspections)
    .where(
      and(
        gte(inspections.startedAt, cutoff),
        eq(inspections.status, "completed"),
      ),
    );

  const userInspections = recentInspections.filter((i) =>
    // Filter by user's inspections (inspector_id matches)
    true, // TODO: join on inspectorId = userId
  );

  // Calculate finding accuracy by category
  const categoryStats: Record<string, { confirmed: number; dismissed: number }> = {};
  for (const fb of userFeedback) {
    const cat = fb.findingCategory || "unknown";
    if (!categoryStats[cat]) categoryStats[cat] = { confirmed: 0, dismissed: 0 };
    if (fb.action === "confirmed") categoryStats[cat].confirmed++;
    if (fb.action === "dismissed") categoryStats[cat].dismissed += fb.dismissCount ?? 1;
  }

  const categoryAccuracy: CalibrationReport["categoryAccuracy"] = {};
  for (const [cat, stats] of Object.entries(categoryStats)) {
    const total = stats.confirmed + stats.dismissed;
    categoryAccuracy[cat] = {
      ...stats,
      accuracy: total > 0 ? stats.confirmed / total : 0,
    };
  }

  // Top false positive patterns (most-dismissed findings)
  const topFalsePositives = userFeedback
    .filter((f) => f.action === "dismissed" && (f.dismissCount ?? 0) >= 2)
    .sort((a, b) => (b.dismissCount ?? 0) - (a.dismissCount ?? 0))
    .slice(0, 20)
    .map((f) => ({
      fingerprint: f.findingFingerprint,
      description: f.findingDescription,
      dismissCount: f.dismissCount ?? 0,
      category: f.findingCategory,
      propertyId: f.propertyId,
    }));

  // Stubborn baselines — from inspection events where uncaptured_baselines_at_end was logged
  const stubbornEvents = await db
    .select({
      metadata: inspectionEvents.metadata,
      roomId: inspectionEvents.roomId,
    })
    .from(inspectionEvents)
    .where(
      and(
        eq(inspectionEvents.eventType, "uncaptured_baselines_at_end"),
        gte(inspectionEvents.timestamp, cutoff),
      ),
    );

  const stubbornCounts = new Map<string, { label: string; count: number; propertyId: string; roomId: string }>();
  for (const event of stubbornEvents) {
    const metadata = (event.metadata || {}) as Record<string, unknown>;
    const labels = (metadata.uncapturedLabels as string[]) || [];
    const roomId = (event.roomId as string) || "";
    for (const label of labels) {
      const key = `${roomId}:${label}`;
      const existing = stubbornCounts.get(key);
      if (existing) {
        existing.count++;
      } else {
        stubbornCounts.set(key, {
          label,
          count: 1,
          propertyId: "",
          roomId,
        });
      }
    }
  }

  const stubbornBaselines = Array.from(stubbornCounts.values())
    .filter((s) => s.count >= 2)
    .sort((a, b) => b.count - a.count)
    .slice(0, 20)
    .map((s) => ({
      baselineLabel: s.label,
      survivalCount: s.count,
      propertyId: s.propertyId,
      roomId: s.roomId,
    }));

  // Generate recommendations
  const recommendations: string[] = [];
  const totalConfirmed = userFeedback.filter((f) => f.action === "confirmed").length;
  const totalDismissed = userFeedback.filter((f) => f.action === "dismissed").length;
  const totalFeedback = totalConfirmed + totalDismissed;
  const falsePositiveRate = totalFeedback > 0 ? totalDismissed / totalFeedback : 0;

  if (falsePositiveRate > 0.5) {
    recommendations.push(
      "High false positive rate (>50%). Consider tightening the Claude Vision prompt thresholds or retraining properties with better baselines.",
    );
  }

  if (topFalsePositives.length > 5) {
    recommendations.push(
      `${topFalsePositives.length} recurring false positives detected. These are being auto-suppressed via feedback memory. Consider reviewing the top patterns for prompt refinement.`,
    );
  }

  if (stubbornBaselines.length > 3) {
    recommendations.push(
      `${stubbornBaselines.length} stubborn baselines consistently survive to end-of-inspection. Consider retraining these angles or converting them to optional detail views.`,
    );
  }

  for (const [cat, stats] of Object.entries(categoryAccuracy)) {
    if (stats.accuracy < 0.3 && (stats.confirmed + stats.dismissed) >= 5) {
      recommendations.push(
        `"${cat}" findings have low accuracy (${Math.round(stats.accuracy * 100)}%). Consider adjusting detection sensitivity for this category.`,
      );
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    propertyCount: propertyIds.length,
    inspectionCount: userInspections.length,
    findings: {
      totalConfirmed,
      totalDismissed,
      falsePositiveRate: Math.round(falsePositiveRate * 100) / 100,
      topFalsePositivePatterns: topFalsePositives,
    },
    stubbornBaselines,
    categoryAccuracy,
    recommendations,
  };
}

function emptyReport(): CalibrationReport {
  return {
    generatedAt: new Date().toISOString(),
    propertyCount: 0,
    inspectionCount: 0,
    findings: {
      totalConfirmed: 0,
      totalDismissed: 0,
      falsePositiveRate: 0,
      topFalsePositivePatterns: [],
    },
    stubbornBaselines: [],
    categoryAccuracy: {},
    recommendations: ["Not enough data yet. Complete more inspections with feedback to generate calibration insights."],
  };
}

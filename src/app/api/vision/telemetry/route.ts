import { NextRequest, NextResponse } from "next/server";
import { getDbUser, isValidUUID } from "@/lib/auth";
import { db } from "@/server/db";
import { events, properties } from "@/server/schema";
import { and, desc, eq, gte, inArray } from "drizzle-orm";

const DEFAULT_DAYS = 14;
const MAX_DAYS = 90;

interface ComparePayload {
  latencyMs?: number;
  score?: number;
  skippedByPreflight?: boolean;
  preflightReason?: string;
}

export async function GET(request: NextRequest) {
  try {
    const dbUser = await getDbUser();
    if (!dbUser) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const daysParam = Number(request.nextUrl.searchParams.get("days"));
    const days =
      Number.isFinite(daysParam) && daysParam > 0
        ? Math.min(daysParam, MAX_DAYS)
        : DEFAULT_DAYS;

    const propertyIdFilter = request.nextUrl.searchParams.get("propertyId");
    if (propertyIdFilter && !isValidUUID(propertyIdFilter)) {
      return NextResponse.json({ error: "Invalid propertyId" }, { status: 400 });
    }

    const userProperties = await db
      .select({ id: properties.id })
      .from(properties)
      .where(eq(properties.userId, dbUser.id));

    let propertyIds = userProperties.map((row) => row.id);
    if (propertyIdFilter) {
      propertyIds = propertyIds.filter((id) => id === propertyIdFilter);
    }

    if (propertyIds.length === 0) {
      return NextResponse.json({
        rangeDays: days,
        totalComparisons: 0,
        claudeCalls: 0,
        preflightSkipped: 0,
        skipRate: 0,
        averageLatencyMs: null,
        p95LatencyMs: null,
      });
    }

    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const rows = await db
      .select({
        payload: events.payload,
        timestamp: events.timestamp,
      })
      .from(events)
      .where(
        and(
          eq(events.eventType, "ComparisonReceived"),
          inArray(events.propertyId, propertyIds),
          gte(events.timestamp, since),
        ),
      )
      .orderBy(desc(events.timestamp));

    const payloads = rows.map((row) => (row.payload || {}) as ComparePayload);
    const totalComparisons = payloads.length;
    const preflightSkipped = payloads.filter((p) => p.skippedByPreflight).length;
    const claudeCalls = Math.max(0, totalComparisons - preflightSkipped);
    const latencies = payloads
      .map((p) => p.latencyMs)
      .filter((v): v is number => typeof v === "number" && Number.isFinite(v))
      .sort((a, b) => a - b);

    const averageLatencyMs =
      latencies.length > 0
        ? Math.round(latencies.reduce((sum, value) => sum + value, 0) / latencies.length)
        : null;
    const p95LatencyMs =
      latencies.length > 0
        ? latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * 0.95))]
        : null;

    const preflightReasons = payloads.reduce<Record<string, number>>((acc, p) => {
      if (!p.preflightReason) return acc;
      acc[p.preflightReason] = (acc[p.preflightReason] || 0) + 1;
      return acc;
    }, {});

    return NextResponse.json({
      rangeDays: days,
      totalComparisons,
      claudeCalls,
      preflightSkipped,
      skipRate:
        totalComparisons === 0
          ? 0
          : Math.round((preflightSkipped / totalComparisons) * 1000) / 10,
      averageLatencyMs,
      p95LatencyMs,
      preflightReasons,
    });
  } catch (error) {
    console.error("[vision/telemetry] GET error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}

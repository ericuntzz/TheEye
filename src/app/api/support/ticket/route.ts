import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { getDbUser, isValidUUID } from "@/lib/auth";
import { emitEventSafe } from "@/lib/events/emit";
import { postMissionControlEvent } from "@/lib/mission-control";

const VALID_SEVERITIES = new Set(["low", "medium", "high", "critical"]);
const VALID_CATEGORIES = new Set(["bug", "feature_request", "other"]);

export async function POST(request: NextRequest) {
  try {
    const dbUser = await getDbUser();
    if (!dbUser) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    let body: Record<string, unknown>;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const {
      title,
      description,
      severity,
      source,
      action,
      screen,
      errorCode,
      propertyId,
      category,
      deviceInfo,
    } = body;

    // Validate required fields
    if (!title || typeof title !== "string") {
      return NextResponse.json(
        { error: "title is required and must be a string" },
        { status: 400 },
      );
    }

    if (!description || typeof description !== "string") {
      return NextResponse.json(
        { error: "description is required and must be a string" },
        { status: 400 },
      );
    }

    // Normalize severity
    const normalizedSeverity = VALID_SEVERITIES.has(severity as string)
      ? (severity as string)
      : "medium";

    // Normalize category
    const normalizedCategory = VALID_CATEGORIES.has(category as string)
      ? (category as string)
      : "bug";

    // Normalize source
    const normalizedSource =
      source === "auto" || source === "manual" ? source : "manual";

    // Validate propertyId if provided
    if (propertyId && (typeof propertyId !== "string" || !isValidUUID(propertyId))) {
      return NextResponse.json(
        { error: "Invalid propertyId format" },
        { status: 400 },
      );
    }

    // Generate external ticket reference and UUID aggregate key for event log
    const ticketId = `ST-${Date.now()}`;
    const ticketAggregateId = randomUUID();

    const device = deviceInfo as Record<string, unknown> | undefined;

    const normalizedAction = typeof action === "string" ? action.slice(0, 200) : null;

    // Emit domain event (async, non-blocking — also mirrors to Mission Control)
    void emitEventSafe({
      eventType: "TicketCreated",
      aggregateId: ticketAggregateId,
      payload: {
        ticketId,
        description: [
          `${(title as string).slice(0, 200)}`,
          "",
          (description as string).slice(0, 2000),
          normalizedAction ? `Action: ${normalizedAction}` : null,
        ]
          .filter(Boolean)
          .join("\n"),
        severity: normalizedSeverity,
      },
      propertyId: (propertyId as string) || undefined,
      userId: dbUser.id,
      metadata: {
        source: normalizedSource,
        action: normalizedAction || undefined,
        device: device?.platform as string,
        appVersion: device?.appVersion as string,
      },
    });

    // Direct MC post for immediate visibility with richer context
    void postMissionControlEvent({
      type: "support_ticket",
      title: `[${normalizedSource === "auto" ? "Auto" : "User"}] ${(title as string).slice(0, 200)}`,
      description: [
        (description as string).slice(0, 2000),
        normalizedAction ? `Action: ${normalizedAction}` : null,
        screen ? `Screen: ${screen}` : null,
        errorCode ? `Error code: ${errorCode}` : null,
        normalizedCategory !== "bug" ? `Category: ${normalizedCategory}` : null,
        device?.platform ? `Device: ${device.platform}` : null,
        device?.appVersion ? `App version: ${device.appVersion}` : null,
      ]
        .filter(Boolean)
        .join("\n"),
      severity: normalizedSeverity as "low" | "medium" | "high" | "critical",
      reporter: dbUser.email,
      source: "atria-mobile",
      sourceId: ticketId,
    });

    return NextResponse.json({ success: true, ticketId }, { status: 201 });
  } catch (error) {
    console.error("[support/ticket] POST error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}

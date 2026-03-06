import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { db } from "@/server/db";
import {
  users,
  inspections,
  inspectionResults,
  rooms,
  baselineImages,
  properties,
} from "@/server/schema";
import { eq, and } from "drizzle-orm";

async function getDbUser() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return null;

  const [dbUser] = await db
    .select()
    .from(users)
    .where(eq(users.supabaseId, user.id));

  return dbUser || null;
}

// GET /api/inspections/[id] - Get inspection details with rooms
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const dbUser = await getDbUser();
  if (!dbUser) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const [inspection] = await db
    .select()
    .from(inspections)
    .where(
      and(eq(inspections.id, id), eq(inspections.inspectorId, dbUser.id)),
    );

  if (!inspection) {
    return NextResponse.json(
      { error: "Inspection not found" },
      { status: 404 },
    );
  }

  // Get property info
  const [property] = await db
    .select()
    .from(properties)
    .where(eq(properties.id, inspection.propertyId));

  // Get rooms with baselines
  const propertyRooms = await db
    .select()
    .from(rooms)
    .where(eq(rooms.propertyId, inspection.propertyId))
    .orderBy(rooms.sortOrder);

  const roomsWithBaselines = await Promise.all(
    propertyRooms.map(async (room) => {
      const baselines = await db
        .select()
        .from(baselineImages)
        .where(eq(baselineImages.roomId, room.id));

      return { ...room, baselineImages: baselines };
    }),
  );

  // Get existing results
  const results = await db
    .select()
    .from(inspectionResults)
    .where(eq(inspectionResults.inspectionId, id));

  return NextResponse.json({
    ...inspection,
    property,
    rooms: roomsWithBaselines,
    results,
  });
}

// POST /api/inspections/[id] - Submit room comparison for inspection
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const dbUser = await getDbUser();
  if (!dbUser) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const [inspection] = await db
    .select()
    .from(inspections)
    .where(
      and(eq(inspections.id, id), eq(inspections.inspectorId, dbUser.id)),
    );

  if (!inspection) {
    return NextResponse.json(
      { error: "Inspection not found" },
      { status: 404 },
    );
  }

  const body = await request.json();
  const { roomId, baselineImageId, currentImageUrl } = body;

  if (!roomId || !baselineImageId || !currentImageUrl) {
    return NextResponse.json(
      { error: "roomId, baselineImageId, and currentImageUrl are required" },
      { status: 400 },
    );
  }

  // Get baseline info
  const [baseline] = await db
    .select()
    .from(baselineImages)
    .where(eq(baselineImages.id, baselineImageId));

  if (!baseline) {
    return NextResponse.json(
      { error: "Baseline image not found" },
      { status: 404 },
    );
  }

  // Get room info
  const [room] = await db.select().from(rooms).where(eq(rooms.id, roomId));

  // Compare images with Claude Vision API
  const comparisonResult = await compareImages(
    baseline.imageUrl,
    currentImageUrl,
    room?.name || "Unknown Room",
  );
  const findings = comparisonResult.findings || [];
  const score = comparisonResult.readiness_score ?? 100;
  const rawResponse = JSON.stringify(comparisonResult);

  const hasCritical = findings.some(
    (f: any) => f.severity === "critical" || f.severity === "high",
  );

  const [result] = await db
    .insert(inspectionResults)
    .values({
      inspectionId: id,
      roomId,
      baselineImageId,
      currentImageUrl,
      status: findings.length === 0 ? "passed" : hasCritical ? "flagged" : "passed",
      score,
      findings,
      rawResponse,
    })
    .returning();

  return NextResponse.json(result, { status: 201 });
}

async function compareImages(
  baselineUrl: string,
  currentUrl: string,
  roomName: string,
): Promise<any> {
  const anthropicKey = process.env.ANTHROPIC_API_KEY;

  if (!anthropicKey) {
    return { findings: [], readiness_score: 100, summary: "AI unavailable" };
  }

  try {
    // Fetch both images
    const [baseImg, currImg] = await Promise.all([
      fetch(baselineUrl).then((r) => r.arrayBuffer()),
      fetch(currentUrl).then((r) => r.arrayBuffer()),
    ]);

    const baseB64 = Buffer.from(baseImg).toString("base64");
    const currB64 = Buffer.from(currImg).toString("base64");

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": anthropicKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-5-20250514",
        max_tokens: 4096,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: `BASELINE IMAGE (how "${roomName}" should look):`,
              },
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: "image/jpeg",
                  data: baseB64,
                },
              },
              {
                type: "text",
                text: `CURRENT IMAGE (how "${roomName}" looks now):`,
              },
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: "image/jpeg",
                  data: currB64,
                },
              },
              {
                type: "text",
                text: `Compare these images and identify discrepancies. Return ONLY valid JSON:
{
  "findings": [
    {
      "category": "missing|moved|cleanliness|damage|inventory",
      "description": "Specific description",
      "severity": "low|medium|high|critical",
      "confidence": 0.0-1.0
    }
  ],
  "summary": "Brief assessment",
  "readiness_score": 0-100
}
If the room looks perfect, return empty findings and score 100.`,
              },
            ],
          },
        ],
      }),
    });

    if (!res.ok) {
      return { findings: [], readiness_score: 100, summary: "Comparison unavailable" };
    }

    const data = await res.json();
    const rawText = data.content[0].text;

    try {
      return JSON.parse(rawText);
    } catch {
      const start = rawText.indexOf("{");
      const end = rawText.lastIndexOf("}") + 1;
      if (start !== -1 && end > start) {
        return JSON.parse(rawText.substring(start, end));
      }
      return { findings: [], readiness_score: 100, summary: "Parse error" };
    }
  } catch {
    return { findings: [], readiness_score: 100, summary: "Comparison failed" };
  }
}

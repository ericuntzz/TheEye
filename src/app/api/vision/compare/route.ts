import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) {
    return NextResponse.json(
      { error: "ANTHROPIC_API_KEY not configured" },
      { status: 500 },
    );
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { baseline_image_url, current_image_url, room_name } = body;

  if (!baseline_image_url || !current_image_url) {
    return NextResponse.json(
      { error: "baseline_image_url and current_image_url are required" },
      { status: 400 },
    );
  }

  try {
    // Fetch both images with error checking
    const [baseRes, currRes] = await Promise.all([
      fetch(baseline_image_url as string),
      fetch(current_image_url as string),
    ]);

    if (!baseRes.ok || !currRes.ok) {
      return NextResponse.json(
        { error: "Failed to fetch one or both images" },
        { status: 400 },
      );
    }

    const baseContentType =
      baseRes.headers.get("content-type")?.split(";")[0].trim() ||
      "image/jpeg";
    const currContentType =
      currRes.headers.get("content-type")?.split(";")[0].trim() ||
      "image/jpeg";

    const [baseImg, currImg] = await Promise.all([
      baseRes.arrayBuffer(),
      currRes.arrayBuffer(),
    ]);

    const baseB64 = Buffer.from(baseImg).toString("base64");
    const currB64 = Buffer.from(currImg).toString("base64");

    const roomLabel = (room_name as string) || "the room";

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
                text: `BASELINE IMAGE (how "${roomLabel}" should look):`,
              },
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: baseContentType,
                  data: baseB64,
                },
              },
              {
                type: "text",
                text: `CURRENT IMAGE (how "${roomLabel}" looks now):`,
              },
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: currContentType,
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
      return NextResponse.json(
        { error: "AI comparison failed" },
        { status: 500 },
      );
    }

    const data = await res.json();
    const rawText = data.content?.[0]?.text;

    if (!rawText) {
      return NextResponse.json(
        { findings: [], readiness_score: 100, summary: "Empty AI response" },
      );
    }

    let result;
    try {
      result = JSON.parse(rawText);
    } catch {
      const start = rawText.indexOf("{");
      const end = rawText.lastIndexOf("}") + 1;
      if (start !== -1 && end > start) {
        result = JSON.parse(rawText.substring(start, end));
      } else {
        result = {
          findings: [],
          readiness_score: 100,
          summary: "Parse error",
        };
      }
    }

    return NextResponse.json(result);
  } catch (error) {
    console.error("Vision comparison error:", error);
    return NextResponse.json(
      { error: "Failed to process comparison" },
      { status: 500 },
    );
  }
}

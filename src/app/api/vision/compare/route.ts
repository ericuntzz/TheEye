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

  try {
    const body = await request.json();
    const { baseline_image_url, current_image_url, room_name } = body;

    // Fetch both images as base64
    const [baseImg, currImg] = await Promise.all([
      fetch(baseline_image_url).then((r) => r.arrayBuffer()),
      fetch(current_image_url).then((r) => r.arrayBuffer()),
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
                text: `BASELINE IMAGE (how "${room_name || "the room"}" should look):`,
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
                text: `CURRENT IMAGE (how "${room_name || "the room"}" looks now):`,
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
      return NextResponse.json(
        { error: "AI comparison failed" },
        { status: 500 },
      );
    }

    const data = await res.json();
    const rawText = data.content[0].text;

    let result;
    try {
      result = JSON.parse(rawText);
    } catch {
      const start = rawText.indexOf("{");
      const end = rawText.lastIndexOf("}") + 1;
      if (start !== -1 && end > start) {
        result = JSON.parse(rawText.substring(start, end));
      } else {
        result = { findings: [], readiness_score: 100, summary: "Parse error" };
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

import { NextRequest, NextResponse } from "next/server";
import { getDbUser, isSafeUrl } from "@/lib/auth";

/**
 * POST /api/vision/batch-analyze
 *
 * Batch scene analysis endpoint. Accepts multiple frames from a room
 * and sends them all to Claude in a single call for holistic analysis.
 * This gives Claude full spatial context to detect changes that are
 * only visible when comparing across multiple angles simultaneously.
 *
 * Body: {
 *   roomId: string,
 *   roomName: string,
 *   frames: Array<{
 *     currentImage: string (base64 data URI),
 *     baselineUrl: string,
 *     baselineId: string,
 *     label?: string,
 *   }>,
 *   inspectionMode?: string,
 *   knownConditions?: string[],
 * }
 */
export async function POST(request: NextRequest) {
  try {
    const dbUser = await getDbUser();
    if (!dbUser) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    let body: {
      roomId?: string;
      roomName?: string;
      frames?: Array<{
        currentImage: string;
        baselineUrl: string;
        baselineId: string;
        label?: string;
      }>;
      inspectionMode?: string;
      knownConditions?: string[];
    };

    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    const { roomName, frames, inspectionMode = "turnover", knownConditions = [] } = body;

    if (!roomName || !frames || !Array.isArray(frames) || frames.length === 0) {
      return NextResponse.json(
        { error: "roomName and frames array are required" },
        { status: 400 },
      );
    }

    // Validate payload size — reject oversized requests early
    const maxFrames = 10;
    if (frames.length > maxFrames) {
      return NextResponse.json(
        { error: `Too many frames (${frames.length}). Maximum is ${maxFrames}.` },
        { status: 400 },
      );
    }
    const batchFrames = frames;

    const anthropicKey = process.env.CLAUDE_API_KEY;
    if (!anthropicKey) {
      return NextResponse.json(
        { error: "AI unavailable" },
        { status: 503 },
      );
    }

    // Mode-specific prompt additions
    const modeInstructions: Record<string, string> = {
      turnover: "This is a post-checkout TURNOVER inspection. Prioritize damage detection, missing items, and claim-ready evidence. Presentation findings are lower priority.",
      maintenance: "This is a MAINTENANCE inspection. Focus on the specific reported issue and verify repair quality. Broad room scanning is secondary.",
      owner_arrival: "This is an OWNER ARRIVAL inspection. ELEVATE presentation findings to primary importance — staging, cleanliness, premium readiness. The property must be perfect.",
      vacancy_check: "This is a VACANCY CHECK. Apply higher tolerance for dust, minor cobwebs, seasonal debris. Focus on leaks, pests, HVAC, environmental issues.",
    };

    // Build multi-image prompt for Claude
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const content: any[] = [
      {
        type: "text",
        text: `You are a Master Home Inspector analyzing ${batchFrames.length} views of "${roomName}" in a luxury vacation rental. You have BOTH baseline images (how the room should look) AND current images (how it looks now) for each angle.

${modeInstructions[inspectionMode] || modeInstructions.turnover}

ANALYZE ALL IMAGES HOLISTICALLY. Look for:
1. Items that moved between angles (visible in one baseline but in a different position in current)
2. Items that are missing entirely (present in baselines but absent in all current images)
3. New items that appeared (not in any baseline but visible in current images)
4. Damage, wear, or condition changes visible across any angle
5. Cleanliness and presentation issues

For each angle pair, compare the baseline and current images. Then cross-reference findings across ALL angles for consistency.

${knownConditions.length > 0 ? `\nKNOWN CONDITIONS (do NOT re-alert on these):\n${knownConditions.map(c => `- ${c}`).join("\n")}` : ""}

Return ONLY valid JSON:
{
  "findings": [
    {
      "category": "missing|moved|cleanliness|damage|inventory|operational|safety|restock|presentation",
      "description": "Detailed description of the issue",
      "severity": "cosmetic|maintenance|safety|urgent_repair|guest_damage",
      "confidence": 0.0-1.0,
      "findingCategory": "condition|presentation|restock",
      "isClaimable": true/false,
      "visibleInAngles": ["label1", "label2"]
    }
  ],
  "sceneChanges": ["Brief description of each notable scene change"],
  "readinessScore": 0-100,
  "summary": "One sentence overall assessment"
}`,
      },
    ];

    // Fetch all baseline images in parallel (P1 fix: was sequential)
    const ALLOWED_MEDIA_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
    const baselineResults = await Promise.allSettled(
      batchFrames.map(async (frame) => {
        try {
          if (!isSafeUrl(frame.baselineUrl)) {
            console.warn(`[batch-analyze] Rejected unsafe baseline URL: ${frame.baselineUrl.slice(0, 80)}`);
            return null;
          }
          // Defense-in-depth: only fetch from expected Supabase storage origin
          const supabaseHost = process.env.NEXT_PUBLIC_SUPABASE_URL
            ? new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).hostname
            : null;
          if (supabaseHost) {
            try {
              const urlHost = new URL(frame.baselineUrl).hostname;
              if (!urlHost.endsWith(supabaseHost) && !urlHost.endsWith(".supabase.co")) {
                console.warn(`[batch-analyze] Baseline URL not from Supabase: ${urlHost}`);
                return null;
              }
            } catch { return null; }
          }
          // Disable redirect following to prevent SSRF via 302 to internal IPs
          const res = await fetch(frame.baselineUrl, {
            signal: AbortSignal.timeout(15000),
            redirect: "error",
          });
          if (!res.ok) return null;
          const buffer = await res.arrayBuffer();
          const rawType = (res.headers.get("content-type") || "image/jpeg").split(";")[0].trim();
          const mediaType = ALLOWED_MEDIA_TYPES.has(rawType) ? rawType : "image/jpeg";
          return { base64: Buffer.from(buffer).toString("base64"), mediaType };
        } catch { return null; }
      }),
    );

    // Add baseline + current image pairs
    for (let i = 0; i < batchFrames.length; i++) {
      const frame = batchFrames[i];
      const angleLabel = frame.label || `Angle ${i + 1}`;
      const settled = baselineResults[i];
      const baselineData = settled.status === "fulfilled" ? settled.value : null;

      if (baselineData) {
        content.push(
          { type: "text", text: `\n--- ${angleLabel} (BASELINE - how it should look) ---` },
          {
            type: "image",
            source: { type: "base64", media_type: baselineData.mediaType, data: baselineData.base64 },
          },
        );
      } else {
        content.push(
          { type: "text", text: `\n--- ${angleLabel} (BASELINE unavailable — analyze current image only) ---` },
        );
      }

      // Add current image
      const currentBase64 = frame.currentImage.replace(/^data:image\/\w+;base64,/, "");
      content.push(
        { type: "text", text: `--- ${angleLabel} (CURRENT - how it looks now) ---` },
        {
          type: "image",
          source: { type: "base64", media_type: "image/jpeg", data: currentBase64 },
        },
      );
    }

    // Call Claude with all images
    const aiModel = process.env.ANTHROPIC_VISION_MODEL || "claude-sonnet-4-20250514";
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: AbortSignal.timeout(180000), // 3 minute timeout for batch
      headers: {
        "Content-Type": "application/json",
        "x-api-key": anthropicKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: aiModel,
        max_tokens: 4096,
        messages: [{ role: "user", content }],
      }),
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      console.error(`[batch-analyze] Claude API error: ${res.status}`, errBody.slice(0, 200));
      return NextResponse.json(
        { error: "AI analysis failed", findings: [], sceneChanges: [], readinessScore: null },
        { status: 502 },
      );
    }

    const data = await res.json();
    const rawText = data.content?.[0]?.text;

    if (!rawText) {
      return NextResponse.json({
        findings: [],
        sceneChanges: [],
        readinessScore: null,
        summary: "No analysis returned",
      });
    }

    // Parse response
    try {
      const parsed = JSON.parse(rawText);
      return NextResponse.json({
        findings: parsed.findings || [],
        sceneChanges: parsed.sceneChanges || parsed.scene_changes || [],
        readinessScore: parsed.readinessScore ?? parsed.readiness_score ?? null,
        summary: parsed.summary || "",
      });
    } catch {
      // Try to extract JSON from markdown
      const start = rawText.indexOf("{");
      const end = rawText.lastIndexOf("}") + 1;
      if (start !== -1 && end > start) {
        try {
          const parsed = JSON.parse(rawText.substring(start, end));
          return NextResponse.json({
            findings: parsed.findings || [],
            sceneChanges: parsed.sceneChanges || parsed.scene_changes || [],
            readinessScore: parsed.readinessScore ?? parsed.readiness_score ?? null,
            summary: parsed.summary || "",
          });
        } catch {
          // Fall through
        }
      }
      return NextResponse.json({
        findings: [],
        sceneChanges: [],
        readinessScore: null,
        summary: "Failed to parse AI response",
      });
    }
  } catch (error) {
    console.error("[batch-analyze] Error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}

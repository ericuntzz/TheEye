// ============================================================================
// Shared Vision Comparison Module
// Extracts comparison logic from API routes into a reusable module.
// Supports both URL-based and base64 image inputs.
// ============================================================================

import { isSafeUrl } from "@/lib/auth";
import {
  runPreflightGate,
  type PreflightGateResult,
} from "@/lib/vision/preflight-gate";

export interface ComparisonFinding {
  category: "missing" | "moved" | "cleanliness" | "damage" | "inventory" | "operational" | "safety" | "restock" | "presentation";
  description: string;
  severity: "cosmetic" | "maintenance" | "safety" | "urgent_repair" | "guest_damage";
  confidence: number; // 0-1
  findingCategory: "condition" | "presentation" | "restock";
  isClaimable: boolean;
  objectClass?: "fixed" | "durable_movable" | "decorative" | "consumable";
}

export interface ComparisonResult {
  findings: ComparisonFinding[];
  summary: string;
  readiness_score: number | null;
  diagnostics?: {
    model?: string;
    aiLatencyMs?: number;
    skippedByPreflight?: boolean;
    preflight?: PreflightGateResult;
  };
}

export type InspectionMode = "turnover" | "maintenance" | "owner_arrival" | "vacancy_check";

export interface CompareImagesOptions {
  /** Baseline image — either a URL or base64 string */
  baselineImage: string;
  /** Current image(s) — either URLs or base64 strings. If 2 images provided, treated as burst capture. */
  currentImages: string[];
  /** Room name for prompt context */
  roomName: string;
  /** Inspection mode affects prompt behavior */
  inspectionMode?: InspectionMode;
  /** Known conditions to suppress (descriptions of pre-existing issues) */
  knownConditions?: string[];
  /**
   * Legacy flag: if true, treats both baseline and current images as base64.
   * Prefer baselineIsBase64/currentImagesAreBase64 for mixed-input flows.
   */
  isBase64?: boolean;
  /** Override for baseline image source format */
  baselineIsBase64?: boolean;
  /** Override for current image source format */
  currentImagesAreBase64?: boolean;
}

// Failure result: null score signals "not evaluated" (never confused with a pass)
const EMPTY_RESULT: ComparisonResult = {
  findings: [],
  readiness_score: null,
  summary: "Not evaluated",
};

/**
 * Build the expert inspection prompt based on inspection mode and context.
 */
function buildExpertPrompt(
  roomName: string,
  inspectionMode: InspectionMode,
  knownConditions: string[],
  imageCount: number,
): string {
  const modeInstructions = getModeInstructions(inspectionMode);
  const knownConditionsBlock = knownConditions.length > 0
    ? `\n\nKNOWN CONDITIONS (do NOT re-alert on these pre-existing issues):\n${knownConditions.map(c => `- ${c}`).join("\n")}`
    : "";

  const burstNote = imageCount > 1
    ? "\n\nNOTE: Two current images are provided 500ms apart. Use both to detect motion (running water, flickering lights, moving objects). If specular highlights or shimmer appear in one but not the other, flag as potential running water."
    : "";

  return `You are a Master Home Inspector specializing in luxury vacation rentals ($3M–$20M+ properties). Compare the BASELINE image(s) against the CURRENT image(s) of "${roomName}".

## OBJECT CATEGORIZATION (Four-Class Inventory Doctrine)
Classify all detected objects into one of four categories:
1. **Fixed/structural** (cabinets, sinks, appliances, built-in shelves, windows, doors, countertops, mounted decor, built-ins) — deviations ALWAYS trigger alerts
2. **Durable movable** (chairs, stools, coffee tables, lamps, cookware, remote controls, hair dryers) — tolerance for repositioning; only alert if missing entirely or damaged
3. **Decorative objects** (pillows, throws, small decor, artwork, table settings) — high tolerance; only alert if baseline inventory item is completely absent
4. **Consumables/replenishable** (coffee pods, soaps, tissues, paper goods, cleaning supplies, firewood, welcome basket items, pool towels) — do NOT treat depletion as damage. Route to restock lane.

## THREE OUTPUT LANES
Every detection routes to exactly ONE lane:
- **condition** — damage, safety, maintenance, guest damage (core inspection output)
- **presentation** — staging, reset, premium-readiness (only relevant in owner_arrival mode)
- **restock** — consumable depletion, amenity replenishment (separate operational output, never mixed into condition findings)

## DETECTION PRIORITIES
Focus especially on:
- **Kitchen**: refrigerator/freezer status, dishwasher status, oven/stove knobs position, trash left behind, sink/faucet issues, countertop stains/scratches
- **Bathrooms**: running water (look for specular highlights/shimmer), slow drain indicators, mold/mildew, broken towel bars, shower door state
- **Bedrooms**: stained linens, missing/broken bulbs, damaged shades/blinds, wall damage near luggage areas
- **Outdoor**: hot tub cover condition, water level/clarity, grill condition, furniture damage, exterior lighting

## FINE DAMAGE DETECTION
Look for: hairline cracks, nail holes, small stains, scuff marks, paint chips, chipped tile, scratched surfaces, water rings. Zoom and enhance on subtle details.

## WHAT TO IGNORE
- **Lighting differences**: Focus on structural/object changes, not shadow/brightness/color temperature differences
- **Smart home states**: Screens on/off, Lutron/Control4 lights different colors, motorized blinds different positions — these are automated behaviors, not issues
- **Minor repositioning**: Durable movable items shifted slightly are normal
- **Vacancy artifacts** (if long vacancy): Minor dust, small cobwebs, seasonal pollen, dead insects — NOT damage unless severe
- **Pet tolerance**: Pet hair, nose prints on glass, paw prints — classify as temporary surface mess, NOT scratches/stains/damage
- **Lens distortion**: Ignore geometric warping at frame edges from wide-angle lens
- **Reflections**: Ignore reflections in mirrors or glass surfaces when identifying missing items

## OPERATIONAL STATE CHECKS
Check: faucet positions (on/off), window open/closed, blinds position, oven/stove knobs, thermostat visible settings, light switches, toilet seats, shower doors. Only flag open windows/doors if they create risk (weather, security).

## STAGING AWARENESS
If property appears staged (photography-ready layout), detect baseline mismatch but categorize as "staging difference," not damage.

${modeInstructions}${knownConditionsBlock}${burstNote}

Return ONLY valid JSON in this exact format:
{
  "findings": [
    {
      "category": "missing|moved|cleanliness|damage|inventory|operational|safety|restock|presentation",
      "description": "Specific, actionable description",
      "severity": "cosmetic|maintenance|safety|urgent_repair|guest_damage",
      "confidence": 0.0-1.0,
      "findingCategory": "condition|presentation|restock",
      "isClaimable": true/false,
      "objectClass": "fixed|durable_movable|decorative|consumable"
    }
  ],
  "summary": "Brief overall assessment",
  "readiness_score": 0-100
}

If the room looks perfect with no issues, return empty findings array and score 100.`;
}

function getModeInstructions(mode: InspectionMode): string {
  switch (mode) {
    case "turnover":
      return `## MODE: TURNOVER (Post-Checkout)
Optimize for: exception detection, claim evidence, completion speed.
Prioritize guest_damage classification for claimable findings.
Presentation findings are lower priority than condition findings.`;
    case "maintenance":
      return `## MODE: MAINTENANCE
Optimize for: issue-specific capture, before/after repair evidence.
Focus on the specific maintenance concern — fewer room changes expected.`;
    case "owner_arrival":
      return `## MODE: OWNER ARRIVAL
Optimize for: cleanliness, staging, operational settings, premium presentation.
Presentation findings are ELEVATED to primary importance.
Check: pillow arrangement, throw blankets, dining staging, blinds alignment, toiletry presentation, patio furniture symmetry.`;
    case "vacancy_check":
      return `## MODE: VACANCY CHECK
Optimize for: leaks, pests, HVAC, environmental conditions, storm/weather effects.
HIGH vacancy tolerance — dust, cobwebs, minor environmental artifacts are EXPECTED. Focus on actual damage, water intrusion, pest signs, and system failures.`;
    default:
      return `## MODE: TURNOVER (Post-Checkout)
Optimize for: exception detection, claim evidence, completion speed.
Prioritize guest_damage classification for claimable findings.
Presentation findings are lower priority than condition findings.`;
  }
}

/**
 * Fetch an image from a URL and convert to base64.
 * Returns null if fetch fails.
 */
async function fetchImageAsBase64(
  url: string,
): Promise<{ base64: string; mediaType: string } | null> {
  try {
    // SSRF protection: validate URL is not targeting internal/private networks
    if (!isSafeUrl(url)) {
      console.warn(`[compare] Blocked unsafe URL: ${url}`);
      return null;
    }
    const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (!res.ok) return null;
    const mediaType =
      res.headers.get("content-type")?.split(";")[0].trim() || "image/jpeg";
    const buffer = await res.arrayBuffer();
    const base64 = Buffer.from(buffer).toString("base64");
    return { base64, mediaType };
  } catch {
    return null;
  }
}

/**
 * Compare baseline and current images using Claude Vision API.
 *
 * This is the core comparison engine used by both the inspection API
 * and the SSE streaming endpoint. Accepts either URLs or base64 images.
 */
export async function compareImages(
  options: CompareImagesOptions,
): Promise<ComparisonResult> {
  const {
    baselineImage,
    currentImages,
    roomName,
    inspectionMode = "turnover",
    knownConditions = [],
    isBase64 = false,
    baselineIsBase64,
    currentImagesAreBase64,
  } = options;
  const baselineInputIsBase64 = baselineIsBase64 ?? isBase64;
  const currentInputAreBase64 = currentImagesAreBase64 ?? isBase64;

  try {
    // Prepare baseline image
    let baselineData: { base64: string; mediaType: string };
    if (baselineInputIsBase64) {
      baselineData = {
        base64: stripDataUriPrefix(baselineImage),
        mediaType: inferMediaTypeFromDataUri(baselineImage) || "image/jpeg",
      };
    } else {
      const fetched = await fetchImageAsBase64(baselineImage);
      if (!fetched) {
        return { ...EMPTY_RESULT, summary: "Failed to fetch baseline image" };
      }
      baselineData = fetched;
    }

    // Prepare current image(s)
    const currentData: { base64: string; mediaType: string }[] = [];
    for (const img of currentImages) {
      if (currentInputAreBase64) {
        currentData.push({
          base64: stripDataUriPrefix(img),
          mediaType: inferMediaTypeFromDataUri(img) || "image/jpeg",
        });
      } else {
        const fetched = await fetchImageAsBase64(img);
        if (!fetched) {
          return { ...EMPTY_RESULT, summary: "Failed to fetch current image" };
        }
        currentData.push(fetched);
      }
    }

    // Run preflight alignment + perceptual gate on baseline vs first current frame.
    const preflight = await runPreflightGate({
      baselineBase64: baselineData.base64,
      currentBase64: currentData[0].base64,
    });

    if (preflight && !preflight.shouldCallAi) {
      return {
        findings: [],
        summary: "No meaningful visual change detected",
        readiness_score: 100,
        diagnostics: {
          skippedByPreflight: true,
          preflight,
          model: "preflight-gate",
        },
      };
    }

    const anthropicKey = process.env.ANTHROPIC_API_KEY;
    if (!anthropicKey) {
      return {
        ...EMPTY_RESULT,
        summary: "AI unavailable",
        diagnostics: {
          skippedByPreflight: false,
          preflight: preflight || undefined,
        },
      };
    }

    // Build message content
    const content: any[] = [
      {
        type: "text",
        text: `BASELINE IMAGE (how "${roomName}" should look):`,
      },
      {
        type: "image",
        source: {
          type: "base64",
          media_type: baselineData.mediaType,
          data: baselineData.base64,
        },
      },
    ];

    // Add current image(s)
    for (let i = 0; i < currentData.length; i++) {
      const label = currentData.length > 1
        ? `CURRENT IMAGE ${i + 1} of ${currentData.length} (captured ${i * 500}ms apart):`
        : `CURRENT IMAGE (how "${roomName}" looks now):`;

      content.push(
        { type: "text", text: label },
        {
          type: "image",
          source: {
            type: "base64",
            media_type: currentData[i].mediaType,
            data: currentData[i].base64,
          },
        },
      );
    }

    // Add expert prompt
    content.push({
      type: "text",
      text: buildExpertPrompt(roomName, inspectionMode, knownConditions, currentData.length),
    });

    const aiModel = process.env.ANTHROPIC_VISION_MODEL || "claude-sonnet-4-5-20250514";
    const aiStartedAt = Date.now();
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: AbortSignal.timeout(120000), // 2 minute timeout for AI comparison
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
      return {
        ...EMPTY_RESULT,
        summary: "Comparison unavailable",
        diagnostics: {
          model: aiModel,
          aiLatencyMs: Date.now() - aiStartedAt,
          preflight: preflight || undefined,
          skippedByPreflight: false,
        },
      };
    }

    const data = await res.json();
    const rawText = data.content?.[0]?.text;

    if (!rawText) {
      return {
        ...EMPTY_RESULT,
        summary: "Empty AI response",
        diagnostics: {
          model: aiModel,
          aiLatencyMs: Date.now() - aiStartedAt,
          preflight: preflight || undefined,
          skippedByPreflight: false,
        },
      };
    }

    const parsed = parseComparisonResponse(rawText);
    return {
      ...parsed,
      diagnostics: {
        ...(parsed.diagnostics || {}),
        model: aiModel,
        aiLatencyMs: Date.now() - aiStartedAt,
        preflight: preflight || undefined,
        skippedByPreflight: false,
      },
    };
  } catch {
    return { ...EMPTY_RESULT, summary: "Comparison failed" };
  }
}

/**
 * Parse the AI response text into a ComparisonResult.
 * Handles both clean JSON and JSON embedded in markdown/text.
 */
function parseComparisonResponse(rawText: string): ComparisonResult {
  try {
    return JSON.parse(rawText);
  } catch {
    // Try to extract JSON from surrounding text
    const start = rawText.indexOf("{");
    const end = rawText.lastIndexOf("}") + 1;
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(rawText.substring(start, end));
      } catch {
        // Fall through
      }
    }
    return { ...EMPTY_RESULT, summary: "Parse error" };
  }
}

function stripDataUriPrefix(base64OrDataUri: string): string {
  const marker = ";base64,";
  const markerIndex = base64OrDataUri.indexOf(marker);
  if (markerIndex === -1) return base64OrDataUri;
  return base64OrDataUri.slice(markerIndex + marker.length);
}

function inferMediaTypeFromDataUri(base64OrDataUri: string): string | null {
  if (!base64OrDataUri.startsWith("data:")) return null;
  const end = base64OrDataUri.indexOf(";");
  if (end === -1) return null;
  const mediaType = base64OrDataUri.slice(5, end).trim();
  return mediaType || null;
}

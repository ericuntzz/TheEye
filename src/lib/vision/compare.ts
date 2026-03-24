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
import {
  JsfeatVerifier,
  imageToGrayscale,
  runVerificationCascade,
  type GeometricVerifyResult,
} from "@/lib/vision/geometric-verify";

export interface ComparisonFinding {
  category: "missing" | "moved" | "cleanliness" | "damage" | "inventory" | "operational" | "safety" | "restock" | "presentation";
  description: string;
  severity: "cosmetic" | "maintenance" | "safety" | "urgent_repair" | "guest_damage";
  confidence: number; // 0-1
  findingCategory: "condition" | "presentation" | "restock";
  isClaimable: boolean;
  objectClass?: "fixed" | "durable_movable" | "decorative" | "consumable";
}

export type ComparisonStatus =
  | "localized_changed"
  | "localized_no_change"
  | "localization_failed"
  | "comparison_unavailable";

export interface ComparisonResult {
  status: ComparisonStatus;
  findings: ComparisonFinding[];
  summary: string;
  readiness_score: number | null;
  verifiedBaselineId: string | null;
  userGuidance: string;
  diagnostics?: {
    model?: string;
    aiLatencyMs?: number;
    skippedByPreflight?: boolean;
    preflight?: PreflightGateResult;
    geometricVerification?: {
      verified: boolean;
      verifiedCandidateId: string | null;
      candidatesAttempted: number;
      serverEmbeddingSimilarity?: number;
      inlierCount: number;
      inlierRatio: number;
      inlierSpread: number;
      overlapArea: number;
      rejectionReasons: string[];
    };
  };
}

export type InspectionMode = "turnover" | "maintenance" | "owner_arrival" | "vacancy_check";

/**
 * Outcome of the fast geometric verification phase.
 * Emitted as a `verified` SSE event so the client can grant coverage credit early.
 */
export interface GeometryOutcome {
  verified: boolean;
  verifiedCandidateId: string | null;
  verificationMode: "geometric" | "user_confirmed_bypass";
  diagnostics: NonNullable<ComparisonResult["diagnostics"]>["geometricVerification"];
  /** Internal: prepared data for the AI phase (not serialized to client) */
  _prepared?: {
    verifiedBaselineData: PreparedImageData;
    bestCurrentFrame: PreparedCurrentFrame;
    validCurrentData: PreparedImageData[];
    verifiedBaselineId: string | null;
    effectiveCandidate: VerificationCandidate;
  };
}

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
  /** Baseline IDs for server to resolve and verify (top-k candidates from mobile) */
  topCandidateIds?: string[];
  /** Client-side embedding similarity — telemetry only, never used for gating */
  clientSimilarity?: number;
  /** User-selected candidate hint from the client — never bypasses verification */
  userSelectedCandidateId?: string;
  /** When true, user explicitly confirmed this baseline via target-assist tap.
   *  Relaxes geometric verification: proceeds to AI even if verification fails,
   *  using the best-scoring candidate instead of requiring full geometric match. */
  userConfirmed?: boolean;
  /** Scoped baseline candidates resolved by the API route for server reranking */
  candidateBaselines?: Array<{
    id: string;
    imageUrl: string;
    verificationImageUrl?: string | null;
    embedding?: number[] | null;
    serverEmbeddingSimilarity?: number;
  }>;
}

// Failure result: null score signals "not evaluated" (never confused with a pass)
const EMPTY_RESULT: ComparisonResult = {
  status: "comparison_unavailable",
  findings: [],
  readiness_score: null,
  summary: "Not evaluated",
  verifiedBaselineId: null,
  userGuidance: "Try again in a moment.",
};

const FALLBACK_CANDIDATE_ID = "__requested_baseline__";

interface ParsedAiResponse {
  findings: ComparisonFinding[];
  summary: string;
  readiness_score: number | null;
}

type PreparedImageData = {
  base64: string;
  mediaType: string;
};

type VerificationCandidate = {
  id: string;
  imageUrl: string;
  verificationImageUrl?: string | null;
  embedding?: number[] | null;
  serverEmbeddingSimilarity?: number;
  verificationGray?: {
    gray: Buffer;
    width: number;
    height: number;
  };
};

type PreparedCurrentFrame = {
  data: PreparedImageData;
  buffer: Buffer;
  gray: {
    gray: Buffer;
    width: number;
    height: number;
  };
};

// Geometric verifier singleton (lazy-init, reused across requests)
let verifierInstance: JsfeatVerifier | null = null;
function getVerifier(): JsfeatVerifier {
  if (!verifierInstance) {
    verifierInstance = new JsfeatVerifier();
  }
  return verifierInstance;
}

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

## CRITICAL: FIELD-OF-VIEW AWARENESS
The current image may show only ONE ANGLE of the room. The inspector walks through and captures multiple angles over time.

**NEVER flag an item as "missing" just because it is not visible in the current frame.** The camera may simply not be pointed at that area yet. Items can only be considered "missing" when:
1. The current image is clearly showing the SAME area/wall/surface where the item appears in the baseline, AND
2. The item is definitively absent from that specific location.

If an item from the baseline is simply outside the current camera's field of view, it is NOT missing — it just hasn't been inspected yet. **When in doubt, do NOT flag it.** Err heavily on the side of NOT reporting a finding rather than creating a false positive.

## CATEGORY ACCURACY
Use the correct category for each finding:
- **"missing"** — item is GONE from the location where it clearly should be (NOT "damage")
- **"damage"** — item IS present but is broken, scratched, cracked, stained, or physically degraded
- **"moved"** — item is present but in a noticeably different position than baseline
- **"cleanliness"** — dirt, dust, debris, stains on surfaces
- **"restock"** — consumable items depleted (coffee pods, soap, tissues)
- **"operational"** — appliance/setting in wrong state (oven knob on, window open)

NEVER label an absent item as "damage". Absent = "missing". Broken/degraded = "damage". These are different categories.

## CONFIDENCE CALIBRATION
Be conservative with confidence scores:
- **0.9-1.0**: Only for obvious, unmistakable issues visible in the image (broken glass, large stain, clearly empty shelf)
- **0.7-0.89**: Clear issues but with some ambiguity (item appears missing from its spot, moderate damage)
- **0.5-0.69**: Possible issues that need verification (might be angle/lighting, subtle change)
- **Below 0.5**: Do NOT report. If you're less than 50% confident, skip it entirely.

## OBJECT CATEGORIZATION (Four-Class Inventory Doctrine)
Classify all detected objects into one of four categories:
1. **Fixed/structural** (cabinets, sinks, appliances, built-in shelves, windows, doors, countertops, mounted decor, built-ins) — deviations ALWAYS trigger alerts
2. **Durable movable** (chairs, stools, coffee tables, lamps, cookware, remote controls, hair dryers) — tolerance for repositioning; only alert if missing entirely or damaged
3. **Decorative objects** (pillows, throws, small decor, artwork, table settings) — high tolerance; only alert if baseline inventory item is completely absent from the SAME visible area
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
- **Out-of-frame items**: Anything in the baseline that is simply not in the current camera view — NOT missing
- **Lighting differences**: Focus on structural/object changes, not shadow/brightness/color temperature differences
- **Smart home states**: Screens on/off, Lutron/Control4 lights different colors, motorized blinds different positions — these are automated behaviors, not issues
- **Minor repositioning**: Durable movable items shifted slightly are normal
- **Vacancy artifacts** (if long vacancy): Minor dust, small cobwebs, seasonal pollen, dead insects — NOT damage unless severe
- **Pet tolerance**: Pet hair, nose prints on glass, paw prints — classify as temporary surface mess, NOT scratches/stains/damage
- **Lens distortion**: Ignore geometric warping at frame edges from wide-angle lens
- **Reflections**: Ignore reflections in mirrors or glass surfaces when identifying missing items
- **Different camera angles**: If baseline and current are shot from different positions, account for parallax — objects may appear shifted but are actually in the same place

## VISIBILITY + ANGLE GUARDRAILS
- Before marking anything as missing, moved, damaged, or absent, confirm the SAME baseline zone is clearly visible in the current image(s)
- If the current framing is tighter, wider, cropped, occluded, blurred, or shot from a materially different angle, do NOT guess
- Never convert "not visible" into "missing"
- Only flag a moved item when the same item is clearly visible in both views with a materially different position relative to stable anchors
- If the comparison is not reliable because the angle does not match the baseline well enough, return no findings and a null readiness_score

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
  "readiness_score": 0-100 or null
}

Prefer FEWER, HIGH-CONFIDENCE findings over many uncertain ones. Quality over quantity. If the room looks good from this angle, return empty findings array and score 100.`;
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

async function prepareImageData(
  input: string,
  inputIsBase64: boolean,
): Promise<PreparedImageData | null> {
  if (inputIsBase64) {
    return {
      base64: stripDataUriPrefix(input),
      mediaType: inferMediaTypeFromDataUri(input) || "image/jpeg",
    };
  }

  return fetchImageAsBase64(input);
}

function scoreVerificationAttempt(result: GeometricVerifyResult | null): number {
  if (!result) return Number.NEGATIVE_INFINITY;
  return (
    (result.verified ? 1000 : 0) +
    result.inlierCount * 5 +
    result.inlierRatio * 100 +
    result.inlierSpread * 25 +
    result.overlapArea * 20
  );
}

function buildLocalizationFailedResult(
  verificationResult: GeometricVerifyResult | null,
  options: {
    verifiedCandidateId?: string | null;
    candidatesAttempted?: number;
    serverEmbeddingSimilarity?: number;
    preflight?: PreflightGateResult;
  } = {},
): ComparisonResult {
  return {
    ...EMPTY_RESULT,
    status: "localization_failed",
    summary: verificationResult?.userGuidance || "Could not verify this view.",
    userGuidance:
      verificationResult?.userGuidance || "Try a slightly different angle.",
    verifiedBaselineId:
      options.verifiedCandidateId && options.verifiedCandidateId !== FALLBACK_CANDIDATE_ID
        ? options.verifiedCandidateId
        : null,
    diagnostics: {
      skippedByPreflight: true,
      preflight: options.preflight,
      model: "geometric-verify",
      geometricVerification: {
        verified: false,
        verifiedCandidateId:
          options.verifiedCandidateId && options.verifiedCandidateId !== FALLBACK_CANDIDATE_ID
            ? options.verifiedCandidateId
            : null,
        candidatesAttempted: options.candidatesAttempted || 0,
        serverEmbeddingSimilarity: options.serverEmbeddingSimilarity,
        inlierCount: verificationResult?.inlierCount || 0,
        inlierRatio: verificationResult?.inlierRatio || 0,
        inlierSpread: verificationResult?.inlierSpread || 0,
        overlapArea: verificationResult?.overlapArea || 0,
        rejectionReasons: verificationResult?.rejectionReasons || ["localization_failed"],
      },
    },
  };
}

function buildComparisonUnavailableResult(
  summary: string,
  userGuidance: string,
  options: {
    verifiedBaselineId?: string | null;
    preflight?: PreflightGateResult;
    geometricVerification?: ComparisonResult["diagnostics"] extends infer D
      ? D extends { geometricVerification?: infer G }
        ? G
        : never
      : never;
    model?: string;
    aiLatencyMs?: number;
  } = {},
): ComparisonResult {
  return {
    ...EMPTY_RESULT,
    status: "comparison_unavailable",
    summary,
    userGuidance,
    verifiedBaselineId: options.verifiedBaselineId || null,
    diagnostics: {
      skippedByPreflight: false,
      preflight: options.preflight,
      model: options.model,
      aiLatencyMs: options.aiLatencyMs,
      geometricVerification: options.geometricVerification,
    },
  };
}

/**
 * Phase 1: Fast geometric verification (~500ms-2s).
 * Prepares images, runs embedding reranking, and geometric verification cascade.
 * Returns a GeometryOutcome that can be emitted as an early SSE event.
 */
export async function verifyGeometry(
  options: CompareImagesOptions,
): Promise<GeometryOutcome> {
  const {
    baselineImage,
    currentImages,
    isBase64 = false,
    baselineIsBase64,
    currentImagesAreBase64,
    candidateBaselines = [],
    userSelectedCandidateId,
    userConfirmed = false,
  } = options;
  const baselineInputIsBase64 = baselineIsBase64 ?? isBase64;
  const currentInputAreBase64 = currentImagesAreBase64 ?? isBase64;

  const baselineData = await prepareImageData(baselineImage, baselineInputIsBase64);
  if (!baselineData) {
    return {
      verified: false,
      verifiedCandidateId: null,
      verificationMode: "geometric",
      diagnostics: undefined,
    };
  }

  const currentData: PreparedImageData[] = [];
  for (const img of currentImages) {
    const prepared = await prepareImageData(img, currentInputAreBase64);
    if (!prepared) continue;
    currentData.push(prepared);
  }

  if (currentData.length === 0) {
    return {
      verified: false,
      verifiedCandidateId: null,
      verificationMode: "geometric",
      diagnostics: undefined,
    };
  }

  if (!baselineData.base64 || baselineData.base64.length < 100) {
    return {
      verified: false,
      verifiedCandidateId: null,
      verificationMode: "geometric",
      diagnostics: undefined,
    };
  }
  const validCurrentData = currentData.filter(d => d.base64 && d.base64.length >= 100);
  if (validCurrentData.length === 0) {
    return {
      verified: false,
      verifiedCandidateId: null,
      verificationMode: "geometric",
      diagnostics: undefined,
    };
  }

  const currentFrames = await Promise.all(
    validCurrentData.map(async (data): Promise<PreparedCurrentFrame> => {
      const buffer = Buffer.from(data.base64, "base64");
      return {
        data,
        buffer,
        gray: await imageToGrayscale(buffer),
      };
    }),
  );

  const unresolvedCandidates: VerificationCandidate[] =
    candidateBaselines.length > 0
      ? candidateBaselines.map((candidate) => ({
            id: candidate.id,
            imageUrl: candidate.imageUrl,
            verificationImageUrl: candidate.verificationImageUrl,
            embedding: candidate.embedding,
            serverEmbeddingSimilarity: candidate.serverEmbeddingSimilarity,
          }))
      : [
            {
              id: FALLBACK_CANDIDATE_ID,
              imageUrl: baselineImage,
              verificationImageUrl: null,
              embedding: null,
            },
          ];

  if (userSelectedCandidateId) {
    const selectedIdx = unresolvedCandidates.findIndex(
      (candidate) => candidate.id === userSelectedCandidateId,
    );
    if (selectedIdx > 0) {
      const [selected] = unresolvedCandidates.splice(selectedIdx, 1);
      unresolvedCandidates.unshift(selected);
    }
  }

  const preparedCandidates = (
    await Promise.all(
      unresolvedCandidates.slice(0, 5).map(async (candidate) => {
        if (candidate.id === FALLBACK_CANDIDATE_ID) {
          return {
            ...candidate,
            verificationGray: await imageToGrayscale(
              Buffer.from(baselineData.base64, "base64"),
            ),
          };
        }

        const attemptUrls = [
          candidate.verificationImageUrl,
          candidate.imageUrl,
        ].filter(
          (url, index, urls): url is string =>
            typeof url === "string" &&
            url.length > 0 &&
            urls.indexOf(url) === index,
        );

        for (const attemptUrl of attemptUrls) {
          const verificationData = await prepareImageData(attemptUrl, false);
          if (!verificationData) continue;

          try {
            return {
              ...candidate,
              verificationGray: await imageToGrayscale(
                Buffer.from(verificationData.base64, "base64"),
              ),
            };
          } catch (error) {
            console.warn(
              `[compare] Failed to prepare verification asset for candidate ${candidate.id} from ${attemptUrl}:`,
              error,
            );
          }
        }

        return null;
      }),
    )
  ).filter(
    (
      candidate,
    ): candidate is VerificationCandidate & {
      verificationGray: NonNullable<VerificationCandidate["verificationGray"]>;
    } => Boolean(candidate?.verificationGray),
  );

  if (preparedCandidates.length === 0) {
    return {
      verified: false,
      verifiedCandidateId: null,
      verificationMode: "geometric",
      diagnostics: {
        verified: false,
        verifiedCandidateId: null,
        candidatesAttempted: 0,
        inlierCount: 0,
        inlierRatio: 0,
        inlierSpread: 0,
        overlapArea: 0,
        rejectionReasons: ["no_candidates_prepared"],
      },
    };
  }

  let bestCascade: Awaited<ReturnType<typeof runVerificationCascade>> | null = null;
  let bestCurrentFrame = currentFrames[0];

  for (const currentFrame of currentFrames) {
    const cascadeAttempt = await runVerificationCascade(
      getVerifier(),
      preparedCandidates.map((candidate) => ({
        id: candidate.id,
        gray: candidate.verificationGray.gray,
        width: candidate.verificationGray.width,
        height: candidate.verificationGray.height,
      })),
      currentFrame.gray.gray,
      currentFrame.gray.width,
      currentFrame.gray.height,
    );

    if (
      !bestCascade ||
      scoreVerificationAttempt(cascadeAttempt.verificationResult) >
        scoreVerificationAttempt(bestCascade.verificationResult)
    ) {
      bestCascade = cascadeAttempt;
      bestCurrentFrame = currentFrame;
    }

    if (cascadeAttempt.verifiedCandidateId && cascadeAttempt.verificationResult?.verified) {
      bestCascade = cascadeAttempt;
      bestCurrentFrame = currentFrame;
      break;
    }
  }

  const cascade =
    bestCascade ||
    ({
      verifiedCandidateId: null,
      verificationResult: null,
      candidatesAttempted: 0,
      allResults: [],
    } satisfies Awaited<ReturnType<typeof runVerificationCascade>>);
  const geometricResult = cascade.verificationResult;
  const verifiedCandidate = cascade.verifiedCandidateId
    ? preparedCandidates.find((candidate) => candidate.id === cascade.verifiedCandidateId) || null
    : null;

  const userBypassedVerification =
    userConfirmed &&
    (!verifiedCandidate || !geometricResult?.verified) &&
    preparedCandidates.length > 0;

  if (userBypassedVerification) {
    const selectedMatch = userSelectedCandidateId
      ? preparedCandidates.find((c) => c.id === userSelectedCandidateId)
      : null;
    if (userSelectedCandidateId && !selectedMatch) {
      console.warn(
        `[compare] userSelectedCandidateId ${userSelectedCandidateId} not found in preparedCandidates, falling back to first candidate`,
      );
    }
    const fallbackCandidate = selectedMatch || preparedCandidates[0];
    Object.assign(cascade, { verifiedCandidateId: fallbackCandidate.id });
  } else if (!verifiedCandidate || !geometricResult?.verified) {
    // Localization failed
    return {
      verified: false,
      verifiedCandidateId: cascade.verifiedCandidateId && cascade.verifiedCandidateId !== FALLBACK_CANDIDATE_ID
        ? cascade.verifiedCandidateId
        : null,
      verificationMode: "geometric",
      diagnostics: {
        verified: false,
        verifiedCandidateId: cascade.verifiedCandidateId && cascade.verifiedCandidateId !== FALLBACK_CANDIDATE_ID
          ? cascade.verifiedCandidateId
          : null,
        candidatesAttempted: cascade.candidatesAttempted,
        serverEmbeddingSimilarity:
          preparedCandidates.find((c) => c.id === cascade.verifiedCandidateId)?.serverEmbeddingSimilarity,
        inlierCount: geometricResult?.inlierCount ?? 0,
        inlierRatio: geometricResult?.inlierRatio ?? 0,
        inlierSpread: geometricResult?.inlierSpread ?? 0,
        overlapArea: geometricResult?.overlapArea ?? 0,
        rejectionReasons: geometricResult?.rejectionReasons ?? ["localization_failed"],
      },
    };
  }

  // Re-resolve after potential user-confirmed promotion
  const effectiveCandidate = userBypassedVerification
    ? (preparedCandidates.find((c) => c.id === cascade.verifiedCandidateId) || preparedCandidates[0])
    : verifiedCandidate!;

  const verifiedBaselineId =
    effectiveCandidate.id === FALLBACK_CANDIDATE_ID ? null : effectiveCandidate.id;

  const geometricDiagnostics = {
    verified: geometricResult?.verified ?? false,
    userConfirmedBypass: userBypassedVerification || undefined,
    verifiedCandidateId: verifiedBaselineId,
    candidatesAttempted: cascade.candidatesAttempted,
    serverEmbeddingSimilarity: effectiveCandidate.serverEmbeddingSimilarity,
    inlierCount: geometricResult?.inlierCount ?? 0,
    inlierRatio: geometricResult?.inlierRatio ?? 0,
    inlierSpread: geometricResult?.inlierSpread ?? 0,
    overlapArea: geometricResult?.overlapArea ?? 0,
    rejectionReasons: geometricResult?.rejectionReasons ?? [],
  };

  // Fetch the verified baseline's display image for the AI phase
  let verifiedBaselineData = baselineData;
  if (effectiveCandidate.id !== FALLBACK_CANDIDATE_ID) {
    const fetchedVerifiedBaseline = await prepareImageData(
      effectiveCandidate.imageUrl,
      false,
    );
    if (fetchedVerifiedBaseline) {
      verifiedBaselineData = fetchedVerifiedBaseline;
    }
    // If fetch fails, fall back to the original baselineData
  }

  return {
    verified: true,
    verifiedCandidateId: verifiedBaselineId,
    verificationMode: userBypassedVerification ? "user_confirmed_bypass" : "geometric",
    diagnostics: geometricDiagnostics,
    _prepared: {
      verifiedBaselineData,
      bestCurrentFrame,
      validCurrentData,
      verifiedBaselineId,
      effectiveCandidate,
    },
  };
}

/**
 * Phase 2: AI analysis (~100ms for preflight short-circuit, 5-30s for Claude).
 * Requires a successful GeometryOutcome from verifyGeometry().
 */
export async function analyzeWithAI(
  geometry: GeometryOutcome,
  options: Pick<CompareImagesOptions, "roomName" | "inspectionMode" | "knownConditions">,
): Promise<ComparisonResult> {
  const {
    roomName,
    inspectionMode = "turnover",
    knownConditions = [],
  } = options;

  if (!geometry.verified || !geometry._prepared) {
    // Should not be called with a failed geometry outcome
    return buildLocalizationFailedResult(null, {
      candidatesAttempted: geometry.diagnostics?.candidatesAttempted ?? 0,
    });
  }

  const {
    verifiedBaselineData,
    bestCurrentFrame,
    validCurrentData,
    verifiedBaselineId,
  } = geometry._prepared;
  const geometricDiagnostics = geometry.diagnostics;

  // Preflight gate: fast "no change" detection before expensive Claude call
  const preflight = await runPreflightGate({
    baselineBase64: verifiedBaselineData.base64,
    currentBase64: bestCurrentFrame.data.base64,
  });

  if (preflight && !preflight.shouldCallAi) {
    return {
      status: "localized_no_change",
      findings: [],
      summary: "No meaningful visual change detected",
      readiness_score: 100,
      verifiedBaselineId,
      userGuidance: "No action needed.",
      diagnostics: {
        skippedByPreflight: true,
        preflight,
        model: "preflight-gate",
        geometricVerification: geometricDiagnostics,
      },
    };
  }

  const anthropicKey = process.env.CLAUDE_API_KEY;
  if (!anthropicKey) {
    return buildComparisonUnavailableResult(
      "AI unavailable",
      "AI is unavailable right now. Try again shortly.",
      {
        verifiedBaselineId,
        preflight: preflight || undefined,
        geometricVerification: geometricDiagnostics,
      },
    );
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
        media_type: verifiedBaselineData.mediaType,
        data: verifiedBaselineData.base64,
      },
    },
  ];

  for (let i = 0; i < validCurrentData.length; i++) {
    const label = validCurrentData.length > 1
      ? `CURRENT IMAGE ${i + 1} of ${validCurrentData.length} (captured ${i * 500}ms apart):`
      : `CURRENT IMAGE (how "${roomName}" looks now):`;

    content.push(
      { type: "text", text: label },
      {
        type: "image",
        source: {
          type: "base64",
          media_type: validCurrentData[i].mediaType,
          data: validCurrentData[i].base64,
        },
      },
    );
  }

  content.push({
    type: "text",
    text: buildExpertPrompt(roomName, inspectionMode, knownConditions, validCurrentData.length),
  });

  const aiModel = process.env.ANTHROPIC_VISION_MODEL || "claude-sonnet-4-20250514";
  const aiStartedAt = Date.now();
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    signal: AbortSignal.timeout(120000),
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
    console.error(`[compare] Anthropic API error: ${res.status} ${res.statusText}`, errBody.slice(0, 300));
    return buildComparisonUnavailableResult(
      "Comparison unavailable",
      "Try again in a moment.",
      {
        verifiedBaselineId,
        preflight: preflight || undefined,
        geometricVerification: geometricDiagnostics,
        model: aiModel,
        aiLatencyMs: Date.now() - aiStartedAt,
      },
    );
  }

  const data = await res.json();
  const rawText = data.content?.[0]?.text;

  if (!rawText) {
    return buildComparisonUnavailableResult(
      "Empty AI response",
      "Try again in a moment.",
      {
        verifiedBaselineId,
        preflight: preflight || undefined,
        geometricVerification: geometricDiagnostics,
        model: aiModel,
        aiLatencyMs: Date.now() - aiStartedAt,
      },
    );
  }

  const parsed = parseComparisonResponse(rawText);
  return {
    status: "localized_changed",
    findings: parsed.findings,
    summary: parsed.summary,
    readiness_score: parsed.readiness_score,
    verifiedBaselineId,
    userGuidance:
      parsed.findings.length > 0 ? "Review the findings." : "Angle captured.",
    diagnostics: {
      model: aiModel,
      aiLatencyMs: Date.now() - aiStartedAt,
      preflight: preflight || undefined,
      skippedByPreflight: false,
      geometricVerification: geometricDiagnostics,
    },
  };
}

/**
 * Compare baseline and current images using Claude Vision API.
 *
 * Convenience wrapper that calls verifyGeometry() + analyzeWithAI() sequentially.
 * Used by callers that don't need the intermediate verified event.
 */
export async function compareImages(
  options: CompareImagesOptions,
): Promise<ComparisonResult> {
  try {
    const geometry = await verifyGeometry(options);

    if (!geometry.verified) {
      return buildLocalizationFailedResult(null, {
        verifiedCandidateId: geometry.verifiedCandidateId,
        candidatesAttempted: geometry.diagnostics?.candidatesAttempted ?? 0,
        serverEmbeddingSimilarity: geometry.diagnostics?.serverEmbeddingSimilarity,
      });
    }

    return await analyzeWithAI(geometry, options);
  } catch (error) {
    console.error("[compare] Comparison failed:", error);
    return buildComparisonUnavailableResult(
      "Comparison failed",
      "Try again in a moment.",
    );
  }
}

/**
 * Parse the AI response text into a ComparisonResult.
 * Handles both clean JSON and JSON embedded in markdown/text.
 */
function parseComparisonResponse(rawText: string): ParsedAiResponse {
  try {
    return normalizeParsedAiResponse(JSON.parse(rawText));
  } catch {
    // Try to extract JSON from surrounding text
    const start = rawText.indexOf("{");
    const end = rawText.lastIndexOf("}") + 1;
    if (start !== -1 && end > start) {
      try {
        return normalizeParsedAiResponse(JSON.parse(rawText.substring(start, end)));
      } catch {
        // Fall through
      }
    }
    return {
      findings: [],
      summary: "Parse error",
      readiness_score: null,
    };
  }
}

function normalizeParsedAiResponse(raw: unknown): ParsedAiResponse {
  if (!raw || typeof raw !== "object") {
    return {
      findings: [],
      summary: "Invalid AI response",
      readiness_score: null,
    };
  }

  const record = raw as Record<string, unknown>;
  const findings = Array.isArray(record.findings)
    ? record.findings.filter((finding): finding is ComparisonFinding => {
        if (!finding || typeof finding !== "object") return false;
        const candidate = finding as Partial<ComparisonFinding>;
        return (
          typeof candidate.description === "string" &&
          typeof candidate.category === "string" &&
          typeof candidate.severity === "string" &&
          typeof candidate.confidence === "number"
        );
      })
    : [];

  return {
    findings,
    summary:
      typeof record.summary === "string" && record.summary.trim()
        ? record.summary.trim()
        : findings.length > 0
          ? "Findings detected"
          : "No issues detected",
    readiness_score:
      typeof record.readiness_score === "number"
        ? record.readiness_score
        : record.readiness_score === null
          ? null
          : findings.length === 0
            ? 100
            : null,
  };
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

function envNumber(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

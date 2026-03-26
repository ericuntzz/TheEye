/**
 * Scene Graph — Object-Level Change Detection
 *
 * Builds a structured representation of objects and their relationships
 * from baseline and current images, then compares the graphs to detect
 * changes that are independent of camera angle.
 *
 * This enables detection of:
 * - Moved objects (same object, different position)
 * - Missing objects (in baseline, not in current)
 * - Added objects (not in baseline, in current)
 * - Changed state (door open/closed, lights on/off)
 * - Relationship changes (items grouped differently)
 *
 * Architecture:
 * - Graph construction happens server-side via Claude Vision
 * - Graphs are stored as JSON alongside inspection results
 * - Comparison is structural (object identity + position + state)
 * - This supplements per-angle comparison, not replaces it
 */

export interface SceneObject {
  /** Unique identifier within the graph */
  id: string;
  /** Object class/type (e.g., "chair", "lamp", "book") */
  objectClass: string;
  /** Specific description (e.g., "brown leather armchair") */
  description: string;
  /** Approximate position in the image (normalized 0-1) */
  position?: { x: number; y: number };
  /** Current state (e.g., "open", "closed", "on", "off") */
  state?: string;
  /** Condition assessment */
  condition?: "excellent" | "good" | "fair" | "damaged";
  /** Confidence that this object was correctly identified */
  confidence: number;
}

export interface SceneRelationship {
  /** Source object ID */
  from: string;
  /** Target object ID */
  to: string;
  /** Relationship type */
  type: "on_top_of" | "next_to" | "inside" | "part_of" | "facing" | "near";
  /** Description of the relationship */
  description?: string;
}

export interface SceneGraph {
  /** Room/area this graph represents */
  roomId: string;
  roomName: string;
  /** All detected objects */
  objects: SceneObject[];
  /** Relationships between objects */
  relationships: SceneRelationship[];
  /** Overall room description */
  summary: string;
  /** Timestamp of graph construction */
  createdAt: number;
  /** Source image info */
  sourceType: "baseline" | "current";
  sourceImageCount: number;
}

export interface SceneChange {
  /** Type of change detected */
  changeType: "missing" | "added" | "moved" | "state_changed" | "condition_changed" | "relationship_changed";
  /** The object(s) involved */
  objectDescription: string;
  /** Severity of the change */
  severity: "cosmetic" | "maintenance" | "safety" | "urgent_repair";
  /** Confidence in the change detection (0-1) */
  confidence: number;
  /** Detailed description of what changed */
  description: string;
  /** Which finding category this maps to */
  findingCategory: "condition" | "presentation" | "restock";
  /** Whether this change is potentially claimable as guest damage */
  isClaimable: boolean;
  /** Baseline object (if applicable) */
  baselineObject?: SceneObject;
  /** Current object (if applicable) */
  currentObject?: SceneObject;
}

export interface SceneComparisonResult {
  /** Changes detected between baseline and current graphs */
  changes: SceneChange[];
  /** Objects that match between baseline and current */
  matchedObjects: number;
  /** Total baseline objects */
  baselineObjectCount: number;
  /** Total current objects */
  currentObjectCount: number;
  /** Summary of the comparison */
  summary: string;
}

/**
 * Build a scene graph prompt for Claude Vision.
 * This constructs the prompt that asks Claude to identify objects
 * and their relationships in a set of images.
 */
export function buildSceneGraphPrompt(
  roomName: string,
  imageType: "baseline" | "current",
): string {
  return `You are analyzing ${imageType} images of "${roomName}" in a luxury property.

Identify every significant object visible and their spatial relationships.

Return ONLY valid JSON with this structure:
{
  "objects": [
    {
      "id": "obj_1",
      "objectClass": "chair",
      "description": "Brown leather armchair with wooden legs",
      "position": { "x": 0.3, "y": 0.6 },
      "state": null,
      "condition": "good",
      "confidence": 0.95
    }
  ],
  "relationships": [
    {
      "from": "obj_1",
      "to": "obj_2",
      "type": "next_to",
      "description": "Chair is next to the side table"
    }
  ],
  "summary": "A reading corner with an armchair, side table, and floor lamp"
}

Be thorough — identify every item that an inspector would care about:
- Furniture (chairs, tables, beds, sofas)
- Decor (art, vases, plants, throw pillows)
- Electronics (TV, speakers, lamps)
- Fixtures (light switches, outlets, hardware)
- Textiles (curtains, rugs, bedding)
- Consumables (toiletries, paper products)

For each object, assess its visible condition and note any state (doors open/closed, lights on/off, curtains open/closed).`;
}

/**
 * Compare two scene graphs to detect changes.
 * This is a structural comparison — matches objects by class + description
 * similarity, then checks for position/state/condition changes.
 */
export function compareSceneGraphs(
  baseline: SceneGraph,
  current: SceneGraph,
): SceneComparisonResult {
  const changes: SceneChange[] = [];
  const matchedCurrentIds = new Set<string>();

  // Match baseline objects to current objects
  for (const baseObj of baseline.objects) {
    const candidates = current.objects.filter(
      (curObj) =>
        !matchedCurrentIds.has(curObj.id) &&
        (curObj.objectClass === baseObj.objectClass ||
          normalizeDescription(curObj.description).includes(
            normalizeDescription(baseObj.description).slice(0, 20),
          )),
    );

    if (candidates.length === 0) {
      // Object missing in current
      changes.push({
        changeType: "missing",
        objectDescription: baseObj.description,
        severity: getSeverityForMissing(baseObj),
        confidence: baseObj.confidence * 0.8,
        description: `"${baseObj.description}" was present in baseline but not found in current images`,
        findingCategory: "condition",
        isClaimable: true,
        baselineObject: baseObj,
      });
      continue;
    }

    // Best match by description similarity
    const bestMatch = candidates[0];
    matchedCurrentIds.add(bestMatch.id);

    // Check for state changes
    if (baseObj.state && bestMatch.state && baseObj.state !== bestMatch.state) {
      changes.push({
        changeType: "state_changed",
        objectDescription: baseObj.description,
        severity: "cosmetic",
        confidence: Math.min(baseObj.confidence, bestMatch.confidence) * 0.9,
        description: `"${baseObj.description}" state changed: ${baseObj.state} → ${bestMatch.state}`,
        findingCategory: "presentation",
        isClaimable: false,
        baselineObject: baseObj,
        currentObject: bestMatch,
      });
    }

    // Check for condition changes
    if (
      baseObj.condition &&
      bestMatch.condition &&
      baseObj.condition !== bestMatch.condition &&
      conditionWorsened(baseObj.condition, bestMatch.condition)
    ) {
      changes.push({
        changeType: "condition_changed",
        objectDescription: baseObj.description,
        severity: bestMatch.condition === "damaged" ? "maintenance" : "cosmetic",
        confidence: Math.min(baseObj.confidence, bestMatch.confidence) * 0.85,
        description: `"${baseObj.description}" condition changed: ${baseObj.condition} → ${bestMatch.condition}`,
        findingCategory: "condition",
        isClaimable: bestMatch.condition === "damaged",
        baselineObject: baseObj,
        currentObject: bestMatch,
      });
    }

    // Check for position changes (significant movement)
    if (baseObj.position && bestMatch.position) {
      const distance = Math.sqrt(
        (baseObj.position.x - bestMatch.position.x) ** 2 +
          (baseObj.position.y - bestMatch.position.y) ** 2,
      );
      if (distance > 0.15) {
        // Moved more than 15% of image dimensions
        changes.push({
          changeType: "moved",
          objectDescription: baseObj.description,
          severity: "cosmetic",
          confidence: Math.min(baseObj.confidence, bestMatch.confidence) * 0.7,
          description: `"${baseObj.description}" appears to have been moved`,
          findingCategory: "presentation",
          isClaimable: false,
          baselineObject: baseObj,
          currentObject: bestMatch,
        });
      }
    }
  }

  // Check for added objects (in current but not matched to baseline)
  for (const curObj of current.objects) {
    if (!matchedCurrentIds.has(curObj.id)) {
      changes.push({
        changeType: "added",
        objectDescription: curObj.description,
        severity: "cosmetic",
        confidence: curObj.confidence * 0.7,
        description: `"${curObj.description}" found in current images but not in baseline`,
        findingCategory: "presentation",
        isClaimable: false,
        currentObject: curObj,
      });
    }
  }

  return {
    changes,
    matchedObjects: matchedCurrentIds.size,
    baselineObjectCount: baseline.objects.length,
    currentObjectCount: current.objects.length,
    summary: changes.length === 0
      ? "No significant changes detected between baseline and current scene"
      : `${changes.length} change(s) detected: ${changes.map((c) => c.changeType).join(", ")}`,
  };
}

// ── Helpers ──────────────────────────────────────────────────

function normalizeDescription(desc: string): string {
  return desc.toLowerCase().replace(/[^a-z0-9 ]/g, "").trim();
}

function getSeverityForMissing(
  obj: SceneObject,
): "cosmetic" | "maintenance" | "safety" | "urgent_repair" {
  const cls = obj.objectClass.toLowerCase();
  if (["fire extinguisher", "smoke detector", "carbon monoxide detector"].includes(cls)) {
    return "safety";
  }
  if (["refrigerator", "oven", "washer", "dryer", "dishwasher"].includes(cls)) {
    return "urgent_repair";
  }
  return "maintenance";
}

function conditionWorsened(
  baseline: string,
  current: string,
): boolean {
  const order = ["excellent", "good", "fair", "damaged"];
  return order.indexOf(current) > order.indexOf(baseline);
}

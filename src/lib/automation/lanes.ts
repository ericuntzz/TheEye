/**
 * Downstream Automation Lanes
 *
 * Converts inspection findings into operational actions automatically.
 * Each finding is routed to one of four lanes based on its category,
 * severity, and the four-class inventory doctrine.
 *
 * Lanes:
 * 1. Damage/Claims — guest damage evidence for claim processing
 * 2. Maintenance — repairs and maintenance tickets
 * 3. Restock — consumable replenishment tasks
 * 4. Presentation — staging and appearance tasks
 *
 * Architecture:
 * - Findings arrive from inspection completion (bulk submission)
 * - Each finding is classified into a lane
 * - Lane-specific handlers create the appropriate downstream action
 * - Actions are stored in the events table for the multi-agent system
 */

export type AutomationLane = "damage_claim" | "maintenance" | "restock" | "presentation";

export interface AutomationAction {
  /** Unique action ID */
  id: string;
  /** Which lane this action belongs to */
  lane: AutomationLane;
  /** Priority level */
  priority: "urgent" | "high" | "normal" | "low";
  /** Action title */
  title: string;
  /** Detailed description */
  description: string;
  /** Property and room context */
  propertyId: string;
  roomId?: string;
  roomName?: string;
  /** Source finding info */
  findingId?: string;
  findingCategory: string;
  findingSeverity: string;
  /** Whether this requires immediate attention */
  requiresImmediate: boolean;
  /** Suggested assignee role */
  suggestedAssignee: "property_manager" | "cleaning_team" | "maintenance_team" | "claims_team";
  /** Evidence for claims */
  evidence?: {
    baselineImageUrl?: string;
    currentImageUrl?: string;
    inspectionId: string;
    timestamp: string;
  };
  /** Created timestamp */
  createdAt: string;
}

export interface LaneRoutingResult {
  actions: AutomationAction[];
  /** Summary of what was generated */
  summary: {
    damageClaimCount: number;
    maintenanceCount: number;
    restockCount: number;
    presentationCount: number;
  };
}

/**
 * Route inspection findings to automation lanes.
 * This is called after inspection completion with confirmed findings.
 */
export function routeFindings(
  propertyId: string,
  inspectionId: string,
  findings: Array<{
    id?: string;
    description: string;
    severity: string;
    category: string;
    findingCategory?: string;
    isClaimable?: boolean;
    roomId?: string;
    roomName?: string;
    baselineImageUrl?: string;
    currentImageUrl?: string;
  }>,
): LaneRoutingResult {
  const actions: AutomationAction[] = [];
  const now = new Date().toISOString();

  for (const finding of findings) {
    const lane = classifyLane(finding);
    const priority = classifyPriority(finding);

    actions.push({
      id: crypto.randomUUID(),
      lane,
      priority,
      title: generateActionTitle(lane, finding),
      description: finding.description,
      propertyId,
      roomId: finding.roomId,
      roomName: finding.roomName,
      findingId: finding.id,
      findingCategory: finding.category,
      findingSeverity: finding.severity,
      requiresImmediate: priority === "urgent",
      suggestedAssignee: getAssignee(lane),
      evidence: finding.isClaimable
        ? {
            baselineImageUrl: finding.baselineImageUrl,
            currentImageUrl: finding.currentImageUrl,
            inspectionId,
            timestamp: now,
          }
        : undefined,
      createdAt: now,
    });
  }

  return {
    actions,
    summary: {
      damageClaimCount: actions.filter((a) => a.lane === "damage_claim").length,
      maintenanceCount: actions.filter((a) => a.lane === "maintenance").length,
      restockCount: actions.filter((a) => a.lane === "restock").length,
      presentationCount: actions.filter((a) => a.lane === "presentation").length,
    },
  };
}

/**
 * Generate automation events for the event-driven architecture.
 * These events can be consumed by downstream agents (Claims Agent,
 * Maintenance Agent, etc.)
 */
export function generateAutomationEvents(
  actions: AutomationAction[],
): Array<{
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  propertyId: string;
  payload: Record<string, unknown>;
}> {
  return actions.map((action) => ({
    eventType: laneToEventType(action.lane),
    aggregateType: "automation_action",
    aggregateId: action.id,
    propertyId: action.propertyId,
    payload: {
      lane: action.lane,
      priority: action.priority,
      title: action.title,
      description: action.description,
      roomId: action.roomId,
      roomName: action.roomName,
      findingId: action.findingId,
      findingCategory: action.findingCategory,
      findingSeverity: action.findingSeverity,
      requiresImmediate: action.requiresImmediate,
      suggestedAssignee: action.suggestedAssignee,
      hasEvidence: !!action.evidence,
    },
  }));
}

// ── Classification Helpers ──────────────────────────────────

function classifyLane(finding: {
  category: string;
  findingCategory?: string;
  severity: string;
  isClaimable?: boolean;
}): AutomationLane {
  // Claimable damage goes to claims lane
  if (finding.isClaimable || finding.severity === "guest_damage") {
    return "damage_claim";
  }

  // Use findingCategory if available (from Claude's three-lane classification)
  if (finding.findingCategory === "restock") return "restock";
  if (finding.findingCategory === "presentation") return "presentation";

  // Fall back to category + severity heuristics
  const cat = finding.category.toLowerCase();
  if (cat === "restock" || cat === "consumable") return "restock";
  if (cat === "presentation" || cat === "moved") return "presentation";
  if (cat === "safety" || finding.severity === "safety" || finding.severity === "urgent_repair") {
    return "maintenance";
  }
  if (cat === "damage" || cat === "cleanliness" || cat === "operational") {
    return "maintenance";
  }

  return "maintenance"; // Default
}

function classifyPriority(finding: {
  severity: string;
  category: string;
}): "urgent" | "high" | "normal" | "low" {
  if (finding.severity === "safety" || finding.severity === "urgent_repair") return "urgent";
  if (finding.severity === "guest_damage") return "high";
  if (finding.severity === "maintenance") return "normal";
  if (finding.category === "restock") return "normal";
  return "low";
}

function generateActionTitle(
  lane: AutomationLane,
  finding: { description: string; roomName?: string },
): string {
  const room = finding.roomName ? ` in ${finding.roomName}` : "";
  const desc = finding.description.length > 60
    ? finding.description.slice(0, 57) + "..."
    : finding.description;

  switch (lane) {
    case "damage_claim":
      return `Damage evidence${room}: ${desc}`;
    case "maintenance":
      return `Maintenance needed${room}: ${desc}`;
    case "restock":
      return `Restock needed${room}: ${desc}`;
    case "presentation":
      return `Presentation fix${room}: ${desc}`;
  }
}

function getAssignee(
  lane: AutomationLane,
): "property_manager" | "cleaning_team" | "maintenance_team" | "claims_team" {
  switch (lane) {
    case "damage_claim": return "claims_team";
    case "maintenance": return "maintenance_team";
    case "restock": return "cleaning_team";
    case "presentation": return "cleaning_team";
  }
}

function laneToEventType(lane: AutomationLane): string {
  switch (lane) {
    case "damage_claim": return "DamageClaimCreated";
    case "maintenance": return "MaintenanceTicketCreated";
    case "restock": return "RestockTaskCreated";
    case "presentation": return "PresentationTaskCreated";
  }
}

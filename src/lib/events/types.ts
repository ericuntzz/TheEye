// ============================================================================
// Event Type Definitions — Atria Event-Driven Architecture
// ============================================================================

// All aggregate types that can emit events
export type AggregateType =
  | "property"
  | "inspection"
  | "finding"
  | "maintenance"
  | "claim"
  | "guest"
  | "condition"
  | "system";

// ============================================================================
// Property Events
// ============================================================================

export type PropertyEventType =
  | "PropertyCreated"
  | "PropertyUpdated"
  | "BaselineVersionCreated"
  | "BaselineVersionActivated"
  | "BaselineRefreshRequested"
  | "BaselineRefreshApproved"
  | "BaselineRefreshRejected";

export interface PropertyCreatedPayload {
  name?: string;
  propertyName?: string;
  address?: string;
  propertyType?: string;
  roomCount?: number;
  totalItems?: number;
  baselineCount?: number;
}

export interface PropertyUpdatedPayload {
  changes?: Record<string, unknown>;
  action?: "updated" | "deleted";
  propertyName?: string;
  deletedAt?: string;
}

export interface BaselineVersionCreatedPayload {
  versionId?: string;
  versionNumber: number;
  label: string;
  roomCount?: number;
  baselineCount?: number;
  baselineImageCount?: number;
}

export interface BaselineVersionActivatedPayload {
  versionId: string;
  versionNumber: number;
  previousVersionId?: string;
}

export interface BaselineRefreshRequestedPayload {
  reason: string;
  deviationPercentage: number;
  affectedRooms: string[];
}

export interface BaselineRefreshApprovedPayload {
  reason: "post_renovation" | "owner_update" | "seasonal_setup" | "furniture_replacement" | "staging_change";
  approvedBy: string;
  newVersionId: string;
}

export interface BaselineRefreshRejectedPayload {
  rejectedBy: string;
  reason: string;
}

// ============================================================================
// Inspection Events
// ============================================================================

export type InspectionEventType =
  | "InspectionStarted"
  | "InspectionPaused"
  | "InspectionResumed"
  | "InspectionCompleted"
  | "RoomEntered"
  | "RoomExited"
  | "AngleScanned"
  | "ComparisonSent"
  | "ComparisonReceived";

export interface InspectionStartedPayload {
  inspectionMode: "turnover" | "maintenance" | "owner_arrival" | "vacancy_check";
  baselineVersionId?: string;
}

export interface InspectionPausedPayload {
  reason?: string;
  roomId?: string;
}

export interface InspectionResumedPayload {
  pauseDurationMs: number;
}

export interface InspectionCompletedPayload {
  completionTier: "minimum" | "standard" | "thorough";
  overallScore?: number;
  roomsVisited: number;
  totalRooms: number;
  durationMs: number;
  findingsCount: number;
}

export interface RoomEnteredPayload {
  roomId: string;
  roomName: string;
  confidence: number;
}

export interface RoomExitedPayload {
  roomId: string;
  roomName: string;
  anglesCovered: number;
  totalAngles: number;
  durationMs: number;
}

export interface AngleScannedPayload {
  roomId: string;
  baselineImageId: string;
  similarity: number;
}

export interface ComparisonSentPayload {
  roomId: string;
  baselineImageId: string;
}

export interface ComparisonReceivedPayload {
  roomId: string;
  baselineImageId: string;
  findingsCount: number;
  score?: number;
  latencyMs: number;
}

// ============================================================================
// Finding Events
// ============================================================================

export type FindingEventType =
  | "FindingSuggested"
  | "FindingConfirmed"
  | "FindingDismissed"
  | "FindingMuted"
  | "FindingTicketed"
  | "FindingMarkedKnownCondition"
  | "FindingResolved";

export interface FindingSuggestedPayload {
  description: string;
  category: string;
  severity: string;
  confidence: number;
  roomId: string;
  roomName: string;
  baselineImageId?: string;
  currentImageUrl?: string;
  findingCategory: "condition" | "presentation";
  isClaimable: boolean;
}

export interface FindingConfirmedPayload {
  findingId: string;
  confirmedBy: string;
}

export interface FindingDismissedPayload {
  findingId: string;
  dismissedBy: string;
  reason?: string;
}

export interface FindingMutedPayload {
  findingId: string;
  mutedBy: string;
  suppressionType: "session_mute" | "stay_mute";
}

export interface FindingTicketedPayload {
  findingId: string;
  ticketId: string;
}

export interface FindingMarkedKnownConditionPayload {
  findingId: string;
  conditionId: string;
  markedBy: string;
}

export interface FindingResolvedPayload {
  findingId: string;
  resolvedBy: string;
  resolution: string;
}

// ============================================================================
// Maintenance Events
// ============================================================================

export type MaintenanceEventType =
  | "TicketCreated"
  | "TicketAssigned"
  | "TicketInProgress"
  | "TicketResolved"
  | "TicketReopened";

export interface TicketCreatedPayload {
  ticketId: string;
  description: string;
  severity: string;
  roomId?: string;
  findingId?: string;
}

export interface TicketAssignedPayload {
  ticketId: string;
  assignedTo: string;
}

export interface TicketInProgressPayload {
  ticketId: string;
}

export interface TicketResolvedPayload {
  ticketId: string;
  resolvedBy: string;
  resolution: string;
  proofImageUrl?: string;
}

export interface TicketReopenedPayload {
  ticketId: string;
  reason: string;
}

// ============================================================================
// Claims Events
// ============================================================================

export type ClaimsEventType =
  | "DamageDetected"
  | "AttributionCalculated"
  | "ClaimPrepared"
  | "ClaimApproved"
  | "ClaimFiled"
  | "ClaimResolved";

export interface DamageDetectedPayload {
  findingId: string;
  description: string;
  severity: string;
  roomId: string;
}

export interface AttributionCalculatedPayload {
  findingId: string;
  confidence: number;
  guestStayId?: string;
  lastCleanInspectionId?: string;
}

export interface ClaimPreparedPayload {
  findingIds: string[];
  totalEstimate?: number;
  platform?: string;
}

export interface ClaimApprovedPayload {
  claimId: string;
  approvedBy: string;
}

export interface ClaimFiledPayload {
  claimId: string;
  platform: string;
  filedAt: string;
}

export interface ClaimResolvedPayload {
  claimId: string;
  outcome: "approved" | "denied" | "partial";
  amount?: number;
}

// ============================================================================
// Guest Events
// ============================================================================

export type GuestEventType = "GuestStayRecorded" | "GuestStayUpdated";

export interface GuestStayRecordedPayload {
  guestStayId: string;
  guestName?: string;
  platform: string;
  checkIn: string;
  checkOut: string;
}

export interface GuestStayUpdatedPayload {
  guestStayId: string;
  changes: Record<string, unknown>;
}

// ============================================================================
// Condition Events
// ============================================================================

export type ConditionEventType =
  | "ConditionRegistered"
  | "ConditionAcknowledged"
  | "ConditionResolved";

export interface ConditionRegisteredPayload {
  conditionId: string;
  description: string;
  category: string;
  severity: string;
  roomId?: string;
}

export interface ConditionAcknowledgedPayload {
  conditionId: string;
  acknowledgedBy: string;
}

export interface ConditionResolvedPayload {
  conditionId: string;
  resolvedBy: string;
  resolution: string;
}

// ============================================================================
// System Events
// ============================================================================

export type SystemEventType =
  | "RestockItemDetected"
  | "PresentationFindingDetected"
  | "BaselineDeviationFlagged"
  | "CoverageThresholdReached";

export interface RestockItemDetectedPayload {
  item: string;
  roomId: string;
  roomName: string;
}

export interface PresentationFindingDetectedPayload {
  description: string;
  roomId: string;
  roomName: string;
}

export interface BaselineDeviationFlaggedPayload {
  roomId: string;
  deviationPercentage: number;
}

export interface CoverageThresholdReachedPayload {
  tier: "minimum" | "standard" | "thorough";
  coverage: number;
}

// ============================================================================
// Union Types
// ============================================================================

export type EventType =
  | PropertyEventType
  | InspectionEventType
  | FindingEventType
  | MaintenanceEventType
  | ClaimsEventType
  | GuestEventType
  | ConditionEventType
  | SystemEventType;

// Payload type map for type-safe event emission
export type EventPayloadMap = {
  // Property
  PropertyCreated: PropertyCreatedPayload;
  PropertyUpdated: PropertyUpdatedPayload;
  BaselineVersionCreated: BaselineVersionCreatedPayload;
  BaselineVersionActivated: BaselineVersionActivatedPayload;
  BaselineRefreshRequested: BaselineRefreshRequestedPayload;
  BaselineRefreshApproved: BaselineRefreshApprovedPayload;
  BaselineRefreshRejected: BaselineRefreshRejectedPayload;
  // Inspection
  InspectionStarted: InspectionStartedPayload;
  InspectionPaused: InspectionPausedPayload;
  InspectionResumed: InspectionResumedPayload;
  InspectionCompleted: InspectionCompletedPayload;
  RoomEntered: RoomEnteredPayload;
  RoomExited: RoomExitedPayload;
  AngleScanned: AngleScannedPayload;
  ComparisonSent: ComparisonSentPayload;
  ComparisonReceived: ComparisonReceivedPayload;
  // Finding
  FindingSuggested: FindingSuggestedPayload;
  FindingConfirmed: FindingConfirmedPayload;
  FindingDismissed: FindingDismissedPayload;
  FindingMuted: FindingMutedPayload;
  FindingTicketed: FindingTicketedPayload;
  FindingMarkedKnownCondition: FindingMarkedKnownConditionPayload;
  FindingResolved: FindingResolvedPayload;
  // Maintenance
  TicketCreated: TicketCreatedPayload;
  TicketAssigned: TicketAssignedPayload;
  TicketInProgress: TicketInProgressPayload;
  TicketResolved: TicketResolvedPayload;
  TicketReopened: TicketReopenedPayload;
  // Claims
  DamageDetected: DamageDetectedPayload;
  AttributionCalculated: AttributionCalculatedPayload;
  ClaimPrepared: ClaimPreparedPayload;
  ClaimApproved: ClaimApprovedPayload;
  ClaimFiled: ClaimFiledPayload;
  ClaimResolved: ClaimResolvedPayload;
  // Guest
  GuestStayRecorded: GuestStayRecordedPayload;
  GuestStayUpdated: GuestStayUpdatedPayload;
  // Condition
  ConditionRegistered: ConditionRegisteredPayload;
  ConditionAcknowledged: ConditionAcknowledgedPayload;
  ConditionResolved: ConditionResolvedPayload;
  // System
  RestockItemDetected: RestockItemDetectedPayload;
  PresentationFindingDetected: PresentationFindingDetectedPayload;
  BaselineDeviationFlagged: BaselineDeviationFlaggedPayload;
  CoverageThresholdReached: CoverageThresholdReachedPayload;
};

// Map event types to their aggregate type
export const EVENT_AGGREGATE_MAP: Record<EventType, AggregateType> = {
  PropertyCreated: "property",
  PropertyUpdated: "property",
  BaselineVersionCreated: "property",
  BaselineVersionActivated: "property",
  BaselineRefreshRequested: "property",
  BaselineRefreshApproved: "property",
  BaselineRefreshRejected: "property",
  InspectionStarted: "inspection",
  InspectionPaused: "inspection",
  InspectionResumed: "inspection",
  InspectionCompleted: "inspection",
  RoomEntered: "inspection",
  RoomExited: "inspection",
  AngleScanned: "inspection",
  ComparisonSent: "inspection",
  ComparisonReceived: "inspection",
  FindingSuggested: "finding",
  FindingConfirmed: "finding",
  FindingDismissed: "finding",
  FindingMuted: "finding",
  FindingTicketed: "finding",
  FindingMarkedKnownCondition: "finding",
  FindingResolved: "finding",
  TicketCreated: "maintenance",
  TicketAssigned: "maintenance",
  TicketInProgress: "maintenance",
  TicketResolved: "maintenance",
  TicketReopened: "maintenance",
  DamageDetected: "claim",
  AttributionCalculated: "claim",
  ClaimPrepared: "claim",
  ClaimApproved: "claim",
  ClaimFiled: "claim",
  ClaimResolved: "claim",
  GuestStayRecorded: "guest",
  GuestStayUpdated: "guest",
  ConditionRegistered: "condition",
  ConditionAcknowledged: "condition",
  ConditionResolved: "condition",
  RestockItemDetected: "system",
  PresentationFindingDetected: "system",
  BaselineDeviationFlagged: "system",
  CoverageThresholdReached: "system",
};

// Event metadata context
export interface EventMetadata {
  device?: string;
  appVersion?: string;
  networkState?: string;
  batteryLevel?: number;
  thermalState?: string;
  inspectionMode?: string;
  source?: string; // "mobile" | "web" | "system"
}

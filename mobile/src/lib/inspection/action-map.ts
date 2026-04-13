// action-map.ts — Normalizes finding categories to downstream actions

import { colors } from "../tokens";

export type ActionType =
  | "restock"
  | "maintenance"
  | "claim"
  | "presentation"
  | "note"
  | "safety";

export interface ActionConfig {
  type: ActionType;
  label: string;
  actionLabel: string;
  icon: string;
  color: string;
  bgColor: string;
  borderColor: string;
}

export const ACTION_CONFIGS: Record<ActionType, ActionConfig> = {
  restock: {
    type: "restock",
    label: "Add to Restock",
    actionLabel: "\u2192 Restock list",
    icon: "cart-outline",
    color: colors.success,
    bgColor: colors.successBg,
    borderColor: colors.successBorder,
  },
  claim: {
    type: "claim",
    label: "File Claim",
    actionLabel: "\u2192 Claims queue",
    icon: "document-text-outline",
    color: colors.destructive,
    bgColor: colors.errorBg,
    borderColor: colors.errorBorder,
  },
  maintenance: {
    type: "maintenance",
    label: "Request Maintenance",
    actionLabel: "\u2192 Maintenance queue",
    icon: "construct-outline",
    color: colors.primary,
    bgColor: colors.primaryBgStrong,
    borderColor: colors.primaryBorder,
  },
  presentation: {
    type: "presentation",
    label: "Flag Presentation",
    actionLabel: "\u2192 Presentation log",
    icon: "flag-outline",
    color: colors.warning,
    bgColor: colors.warningBg,
    borderColor: colors.warningBorder,
  },
  safety: {
    type: "safety",
    label: "Report Safety Issue",
    actionLabel: "\u2192 Safety report",
    icon: "shield-outline",
    color: colors.destructive,
    bgColor: colors.errorBg,
    borderColor: colors.errorBorder,
  },
  note: {
    type: "note",
    label: "Confirm",
    actionLabel: "\u2192 Noted",
    icon: "checkmark-circle-outline",
    color: colors.slate600,
    bgColor: colors.mutedBg,
    borderColor: colors.mutedBorder,
  },
};

export function getActionConfig(finding: {
  category: string;
  itemType?: string;
  isClaimable?: boolean;
  severity?: string;
}): ActionConfig {
  const cat = finding.category.toLowerCase();
  const item = finding.itemType?.toLowerCase();

  // Safety takes highest priority
  if (cat === "safety" || finding.severity === "safety") {
    return ACTION_CONFIGS.safety;
  }

  // Restock
  if (cat === "restock" || item === "restock") {
    return ACTION_CONFIGS.restock;
  }

  // Claimable damage
  if (cat === "damage" && finding.isClaimable) {
    return ACTION_CONFIGS.claim;
  }

  // Maintenance / operational
  if (cat === "operational" || cat === "maintenance" || item === "maintenance") {
    return ACTION_CONFIGS.maintenance;
  }

  // Presentation / moved items
  if (cat === "presentation" || cat === "moved") {
    return ACTION_CONFIGS.presentation;
  }

  // Default — generic note/confirm
  return ACTION_CONFIGS.note;
}

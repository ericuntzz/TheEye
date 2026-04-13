/**
 * Composer Utilities — Shared constants, helpers, and templates
 * for the AddItemComposer component.
 */

import type { AddItemType } from "./item-types";
import { colors } from "../tokens";

// ── Types ──────────────────────────────────────────────────────────────

export type AddItemAttachmentDraft = {
  kind: "photo" | "video";
  localUri: string;
};

export interface QuickAddTemplate {
  id: string;
  itemType: AddItemType;
  label: string;
  value: string;
  icon: string;
  roomKeywords?: string[];
}

export interface AddItemTypeOption {
  key: AddItemType;
  label: string;
  icon: string;
}

// ── Constants ──────────────────────────────────────────────────────────

export const ADD_ITEM_TYPE_OPTIONS: AddItemTypeOption[] = [
  { key: "restock", label: "Restock", icon: "cart-outline" },
  { key: "maintenance", label: "Maintenance", icon: "construct-outline" },
  { key: "task", label: "Task", icon: "checkbox-outline" },
  { key: "note", label: "Note", icon: "document-text-outline" },
];

export const QUICK_ADD_TEMPLATES: QuickAddTemplate[] = [
  {
    id: "maint-faucet",
    itemType: "maintenance",
    label: "Leaky faucet",
    value: "Leaky faucet needs repair",
    icon: "water-outline",
    roomKeywords: ["bath", "kitchen", "laundry"],
  },
  {
    id: "maint-bulb",
    itemType: "maintenance",
    label: "Light out",
    value: "Light fixture needs a new bulb",
    icon: "bulb-outline",
  },
  {
    id: "maint-hardware",
    itemType: "maintenance",
    label: "Loose hardware",
    value: "Loose handle or hardware needs tightening",
    icon: "hammer-outline",
  },
  {
    id: "task-air-filter",
    itemType: "task",
    label: "Replace air filter",
    value: "Replace HVAC air filter",
    icon: "swap-horizontal-outline",
  },
  {
    id: "task-smoke",
    itemType: "task",
    label: "Check detectors",
    value: "Check smoke and CO detectors",
    icon: "shield-checkmark-outline",
  },
  {
    id: "task-staging",
    itemType: "task",
    label: "Reset staging",
    value: "Reset room staging before guest arrival",
    icon: "color-wand-outline",
  },
  {
    id: "task-touchup",
    itemType: "task",
    label: "Touch-point clean",
    value: "Do a touch-point clean in this room",
    icon: "sparkles-outline",
  },
  {
    id: "task-outdoor",
    itemType: "task",
    label: "Reset outdoor setup",
    value: "Reset patio and outdoor seating setup",
    icon: "sunny-outline",
    roomKeywords: ["patio", "deck", "balcony", "outdoor"],
  },
];

// ── Helpers ─────────────────────────────────────────────────────────────

export function stripRestockQuantitySuffix(description: string): string {
  return description.replace(/\s*\(qty:\s*\d+\)\s*$/i, "").trim();
}

export function buildItemDescription(
  text: string,
  itemType: AddItemType,
  quantity: number,
): string {
  if (itemType === "restock" && quantity > 1) {
    return `${text} (qty: ${quantity})`;
  }
  return text;
}

export function getItemTypeAccent(
  itemType: AddItemType | undefined,
): string {
  switch (itemType) {
    case "restock":
      return colors.success;
    case "maintenance":
      return colors.warning;
    case "task":
      return colors.primary;
    case "note":
    default:
      return colors.muted;
  }
}

export function getItemTypeIcon(
  itemType: AddItemType | undefined,
): string {
  switch (itemType) {
    case "restock":
      return "cart-outline";
    case "maintenance":
      return "construct-outline";
    case "task":
      return "checkbox-outline";
    case "note":
    default:
      return "document-text-outline";
  }
}

export function getQuickAddTemplates(
  itemType: AddItemType,
  roomName?: string | null,
): QuickAddTemplate[] {
  const normalizedRoom = roomName?.toLowerCase() || "";
  return QUICK_ADD_TEMPLATES.filter((template) => {
    if (template.itemType !== itemType) return false;
    if (!template.roomKeywords?.length) return true;
    return template.roomKeywords.some((keyword) =>
      normalizedRoom.includes(keyword),
    );
  });
}

/**
 * Get item type config for submission — maps itemType to
 * category, findingCategory, and default severity.
 */
export function getItemTypeConfig(itemType: AddItemType) {
  const config = {
    note: {
      category: "manual_note" as const,
      findingCategory: "condition" as const,
      severity: "maintenance" as const,
    },
    restock: {
      category: "restock" as const,
      findingCategory: "restock" as const,
      severity: "cosmetic" as const,
    },
    maintenance: {
      category: "operational" as const,
      findingCategory: "condition" as const,
      severity: "maintenance" as const,
    },
    task: {
      category: "manual_note" as const,
      findingCategory: "condition" as const,
      severity: "cosmetic" as const,
    },
  };
  return config[itemType];
}

import React, { useEffect, useRef } from "react";
import { Animated, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { colors, fontSize, radius, shadows, spacing } from "../lib/tokens";
import type { AddItemType } from "../lib/inspection/item-types";

// ── Props ────────────────────────────────────────────────────────────────

export interface AISuggestionCardProps {
  description: string;
  suggestedItemType: AddItemType;
  confidence: number;
  onAccept: (itemType: AddItemType) => void;
  onDismiss: () => void;
}

// ── Category → Item Type Mapping ─────────────────────────────────────────

/**
 * Maps common AI detection categories (inferred from description keywords)
 * to the most appropriate AddItemType.
 *
 * Consumable/supply detections → "restock"
 * Damage/wear detections → "maintenance"
 * Cleanliness/order issues → "task"
 * Everything else → "note"
 */
const DETECTION_PATTERNS: { pattern: RegExp; itemType: AddItemType }[] = [
  // Consumable / supply
  { pattern: /\b(soap|shampoo|conditioner|towel|tissue|toilet\s*paper|paper\s*towel|amenit|minibar|restock|refill|replenish|supply|low|empty|depleted|out\s+of)\b/i, itemType: "restock" },
  // Damage / wear
  { pattern: /\b(crack|chip|scratch|stain|dent|tear|broken|damage|worn|peel|rust|corrode|leak|warped|discolor|fade|fray)\b/i, itemType: "maintenance" },
  // Cleanliness / order
  { pattern: /\b(dirt|dust|smudge|fingerprint|streak|mold|mildew|grime|mess|clutter|untidy|disorganiz|unclean|debris|spill|spot|residue|hair|cobweb)\b/i, itemType: "task" },
];

export function inferItemType(description: string): AddItemType {
  for (const { pattern, itemType } of DETECTION_PATTERNS) {
    if (pattern.test(description)) return itemType;
  }
  return "note";
}

// ── Item Type Display Config ─────────────────────────────────────────────

interface ItemTypeConfig {
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
  accentColor: string;
  accentBg: string;
  accentBorder: string;
}

const ITEM_TYPE_CONFIG: Record<AddItemType, ItemTypeConfig> = {
  restock: {
    label: "Add to restock",
    icon: "cart-outline",
    accentColor: colors.category.restock,
    accentBg: colors.successBg,
    accentBorder: colors.successBorder,
  },
  maintenance: {
    label: "Flag for maintenance",
    icon: "construct-outline",
    accentColor: colors.severity.maintenance,
    accentBg: colors.warningBg,
    accentBorder: colors.warningBorder,
  },
  task: {
    label: "Create task",
    icon: "checkbox-outline",
    accentColor: colors.primary,
    accentBg: colors.primaryBg,
    accentBorder: colors.primaryBorder,
  },
  note: {
    label: "Add note",
    icon: "document-text-outline",
    accentColor: colors.slate500,
    accentBg: colors.mutedBg,
    accentBorder: colors.mutedBorder,
  },
};

// ── Component ────────────────────────────────────────────────────────────

export default function AISuggestionCard({
  description,
  suggestedItemType,
  confidence,
  onAccept,
  onDismiss,
}: AISuggestionCardProps) {
  const config = ITEM_TYPE_CONFIG[suggestedItemType];

  // ── Entrance animation ──
  const slideY = useRef(new Animated.Value(24)).current;
  const opacity = useRef(new Animated.Value(0)).current;
  const scale = useRef(new Animated.Value(0.97)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.spring(slideY, {
        toValue: 0,
        damping: 20,
        stiffness: 260,
        mass: 0.8,
        useNativeDriver: true,
      }),
      Animated.timing(opacity, {
        toValue: 1,
        duration: 280,
        useNativeDriver: true,
      }),
      Animated.spring(scale, {
        toValue: 1,
        damping: 18,
        stiffness: 240,
        mass: 0.7,
        useNativeDriver: true,
      }),
    ]).start();
  }, [slideY, opacity, scale]);

  const confidencePercent = Math.round(confidence * 100);

  return (
    <Animated.View
      style={[
        styles.container,
        {
          opacity,
          transform: [{ translateY: slideY }, { scale }],
        },
      ]}
      accessibilityRole="alert"
      accessibilityLabel={`AI suggestion: ${description}. ${config.label}?`}
    >
      {/* Top accent bar */}
      <View style={[styles.accentBar, { backgroundColor: config.accentColor }]} />

      <View style={styles.body}>
        {/* Header row: AI badge + confidence */}
        <View style={styles.headerRow}>
          <View style={styles.aiBadge}>
            <Ionicons
              name="sparkles"
              size={10}
              color={colors.camera.textAccent}
            />
            <Text style={styles.aiBadgeText}>AI Detected</Text>
          </View>
          <Text style={styles.confidenceText}>
            {confidencePercent}% confidence
          </Text>
        </View>

        {/* Description */}
        <Text style={styles.description} numberOfLines={2}>
          {description}
        </Text>

        {/* Action buttons */}
        <View style={styles.actions}>
          <TouchableOpacity
            style={[
              styles.acceptButton,
              {
                backgroundColor: config.accentBg,
                borderColor: config.accentBorder,
              },
            ]}
            onPress={() => onAccept(suggestedItemType)}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel={config.label}
          >
            <Ionicons
              name={config.icon}
              size={15}
              color={config.accentColor}
              style={styles.acceptIcon}
            />
            <Text style={[styles.acceptText, { color: config.accentColor }]}>
              {config.label}
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.dismissButton}
            onPress={onDismiss}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel="Dismiss suggestion"
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Ionicons
              name="close"
              size={18}
              color={colors.camera.textMuted}
            />
          </TouchableOpacity>
        </View>
      </View>
    </Animated.View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: {
    backgroundColor: colors.camera.overlayCard,
    borderRadius: radius.xl,
    borderWidth: 1,
    borderColor: colors.camera.panelBorder,
    overflow: "hidden",
    ...shadows.elevated,
  },
  accentBar: {
    height: 3,
    width: "100%",
  },
  body: {
    paddingHorizontal: spacing.card,
    paddingTop: spacing.content,
    paddingBottom: spacing.card,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: spacing.sm,
  },
  aiBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    backgroundColor: colors.camera.pillBg,
    borderRadius: radius.full,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xxs + 1,
    borderWidth: 1,
    borderColor: colors.camera.pillBorder,
  },
  aiBadgeText: {
    color: colors.camera.textAccent,
    fontSize: fontSize.micro,
    fontWeight: "700",
    letterSpacing: 0.4,
    textTransform: "uppercase",
  },
  confidenceText: {
    color: colors.camera.textSubtle,
    fontSize: fontSize.micro,
    fontWeight: "600",
  },
  description: {
    color: colors.camera.textHigh,
    fontSize: fontSize.body,
    fontWeight: "500",
    lineHeight: 22,
    marginBottom: spacing.content,
  },
  actions: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  acceptButton: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.tight,
    borderRadius: radius.lg,
    borderWidth: 1,
    paddingVertical: spacing.content,
    minHeight: 44,
  },
  acceptIcon: {
    marginTop: 1,
  },
  acceptText: {
    fontSize: fontSize.label,
    fontWeight: "700",
  },
  dismissButton: {
    width: 44,
    height: 44,
    borderRadius: radius.lg,
    backgroundColor: colors.camera.itemBg,
    borderWidth: 1,
    borderColor: colors.camera.itemBorder,
    alignItems: "center",
    justifyContent: "center",
  },
});

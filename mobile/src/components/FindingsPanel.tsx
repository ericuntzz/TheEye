import React, { useCallback, useMemo, useRef, useState } from "react";
import { Alert, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import BottomSheet, {
  BottomSheetScrollView,
  BottomSheetView,
} from "@gorhom/bottom-sheet";
import { Ionicons } from "@expo/vector-icons";
import type { Finding } from "../lib/inspection/types";
import { getActionConfig as getSharedActionConfig } from "../lib/inspection/action-map";
import { colors, radius, fontSize, spacing } from "../lib/tokens";

export type DismissReason =
  | "not_accurate"
  | "still_there"
  | "known_issue"
  | null;

interface Props {
  findings: Finding[];
  onConfirm: (id: string) => void;
  onDismiss: (id: string, reason?: DismissReason) => void;
  bottomInset?: number;
}

// Smaller initial snap so bottom controls remain accessible. User can swipe up to review.
const SNAP_POINTS = ["12%", "45%", "85%"];

const SEVERITY_COLORS: Record<string, string> = {
  cosmetic: colors.severity.cosmetic,
  maintenance: colors.severity.maintenance,
  safety: colors.severity.safety,
  urgent_repair: colors.severity.urgentRepair,
  guest_damage: colors.severity.guestDamage,
};

const CATEGORY_LABELS: Record<string, string> = {
  missing: "Missing Item",
  moved: "Repositioned",
  cleanliness: "Cleanliness",
  damage: "Damage",
  inventory: "Inventory",
  operational: "Operational Issue",
  safety: "Safety Risk",
  restock: "Restock",
  presentation: "Presentation",
  manual_note: "Note",
};

const CATEGORY_COLORS: Record<string, string> = {
  missing: colors.category.missing,
  moved: colors.category.moved,
  cleanliness: colors.category.cleanliness,
  damage: colors.category.damage,
  inventory: colors.category.inventory,
  operational: colors.category.operational,
  safety: colors.category.safety,
  restock: colors.category.restock,
  presentation: colors.category.presentation,
  manual_note: colors.category.manualNote,
};

/* ------------------------------------------------------------------ */
/*  Action button config — delegates to shared action-map.ts          */
/* ------------------------------------------------------------------ */

interface PanelActionConfig {
  label: string;
  routeHint: string;
  icon: keyof typeof Ionicons.glyphMap;
  color: string;
  bgColor: string;
  borderColor: string;
}

function getActionConfig(finding: Finding): PanelActionConfig {
  const shared = getSharedActionConfig(finding);
  return {
    label: shared.label,
    routeHint: shared.actionLabel === "→ Noted" ? "" : shared.actionLabel,
    icon: shared.icon as keyof typeof Ionicons.glyphMap,
    color: shared.color,
    bgColor: shared.bgColor,
    borderColor: shared.borderColor,
  };
}

export default function FindingsPanel({
  findings,
  onConfirm,
  onDismiss,
  bottomInset = 0,
}: Props) {
  const processingRef = useRef<Set<string>>(new Set());
  const [sheetIndex, setSheetIndex] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const sheetRef = useRef<BottomSheet>(null);
  const lastVisibleSignatureRef = useRef<string>("");
  const findingSignature = findings
    .map((finding) => finding.id)
    .sort()
    .join("|");

  // Re-show the sheet when the finding set actually changes, not just the count.
  React.useEffect(() => {
    if (findings.length === 0) {
      lastVisibleSignatureRef.current = "";
      if (dismissed) {
        setDismissed(false);
      }
      return;
    }

    const hasNewFindings = findingSignature !== lastVisibleSignatureRef.current;
    if (dismissed && hasNewFindings) {
      setDismissed(false);
      sheetRef.current?.snapToIndex(0);
      return;
    }

    if (!dismissed) {
      lastVisibleSignatureRef.current = findingSignature;
    }
  }, [dismissed, findingSignature, findings.length]);

  const handleConfirm = useCallback(
    (id: string) => {
      if (processingRef.current.has(id)) return;
      processingRef.current.add(id);
      onConfirm(id);
    },
    [onConfirm],
  );

  const handleDismiss = useCallback(
    (id: string) => {
      if (processingRef.current.has(id)) return;

      Alert.alert(
        "Dismiss this finding?",
        "Choose a reason so we can improve future inspections.",
        [
          {
            text: "Incorrect finding",
            onPress: () => {
              processingRef.current.add(id);
              onDismiss(id, "not_accurate");
            },
          },
          {
            text: "Item is still there",
            onPress: () => {
              processingRef.current.add(id);
              onDismiss(id, "still_there");
            },
          },
          {
            text: "Known issue",
            onPress: () => {
              processingRef.current.add(id);
              onDismiss(id, "known_issue");
            },
          },
          { text: "Cancel", style: "cancel" },
        ],
      );
    },
    [onDismiss],
  );

  if (findings.length === 0 || dismissed) return null;

  const expanded = sheetIndex >= SNAP_POINTS.length - 1;
  const showHelperText = sheetIndex > 0;

  return (
    <BottomSheet
      ref={sheetRef}
      index={0}
      snapPoints={SNAP_POINTS}
      topInset={24}
      bottomInset={bottomInset}
      detached={bottomInset > 0}
      enablePanDownToClose={true}
      onClose={() => setDismissed(true)}
      backgroundStyle={[
        styles.sheetBackground,
        bottomInset > 0 && styles.sheetBackgroundDetached,
      ]}
      handleIndicatorStyle={styles.handleIndicator}
      style={[styles.sheet, bottomInset > 0 && styles.sheetDetached]}
      onChange={(index) => setSheetIndex(index)}
    >
      <BottomSheetView style={styles.content}>
        <View style={styles.headerRow}>
          <Text style={styles.header}>
            {findings.length} finding{findings.length !== 1 ? "s" : ""}
          </Text>
          <Text style={styles.expandHint}>
            {expanded ? "Swipe down to continue scanning" : "Swipe up to review"}
          </Text>
        </View>

        {showHelperText ? (
          <Text style={styles.helperText}>
            AI confidence shows how certain the model is, not how severe the issue is.
          </Text>
        ) : null}

        <BottomSheetScrollView
          showsVerticalScrollIndicator={false}
          contentContainerStyle={styles.listContent}
        >
          {findings.map((finding) => {
            const categoryColor = CATEGORY_COLORS[finding.category] || colors.slate500;
            const severityColor = SEVERITY_COLORS[finding.severity] || colors.slate500;
            const action = getActionConfig(finding);

            return (
              <View key={finding.id} style={styles.findingCard}>
                <View style={styles.findingHeader}>
                  <View style={styles.findingLabelRow}>
                    <View
                      style={[
                        styles.categoryDot,
                        { backgroundColor: categoryColor },
                      ]}
                    />
                    <Text
                      style={[styles.categoryText, { color: categoryColor }]}
                    >
                      {CATEGORY_LABELS[finding.category] || finding.category}
                    </Text>
                    {(finding.severity === "urgent_repair" ||
                      finding.severity === "safety") && (
                      <View
                        style={[
                          styles.severityPill,
                          { backgroundColor: severityColor },
                        ]}
                      >
                        <Text style={styles.severityPillText}>
                          {finding.severity === "safety" ? "SAFETY" : "URGENT"}
                        </Text>
                      </View>
                    )}
                  </View>

                  <Text style={styles.confidenceText}>
                    AI confidence {Math.round(finding.confidence * 100)}%
                  </Text>
                </View>

                <Text
                  style={styles.findingDescription}
                  numberOfLines={expanded ? 5 : 3}
                  accessibilityRole="text"
                >
                  {finding.description}
                </Text>

                {/* Action route hint */}
                {action.routeHint !== "" && (
                  <Text style={[styles.routeHint, { color: action.color }]}>
                    {action.routeHint}
                  </Text>
                )}

                <View style={styles.actions}>
                  <TouchableOpacity
                    style={[
                      styles.actionButton,
                      styles.confirmButton,
                      {
                        backgroundColor: action.bgColor,
                        borderColor: action.borderColor,
                      },
                    ]}
                    onPress={() => handleConfirm(finding.id)}
                    activeOpacity={0.7}
                    accessibilityRole="button"
                    accessibilityLabel={`${action.label}: ${finding.description}`}
                  >
                    <View style={styles.confirmInner}>
                      <Ionicons
                        name={action.icon}
                        size={16}
                        color={action.color}
                        style={styles.confirmIcon}
                      />
                      <Text
                        style={[
                          styles.actionText,
                          styles.confirmText,
                          { color: action.color },
                        ]}
                      >
                        {action.label}
                      </Text>
                    </View>
                  </TouchableOpacity>

                  <TouchableOpacity
                    style={[styles.actionButton, styles.dismissButton]}
                    onPress={() => handleDismiss(finding.id)}
                    activeOpacity={0.7}
                    accessibilityRole="button"
                    accessibilityLabel={`Mark finding inaccurate: ${finding.description}`}
                  >
                    <Text style={[styles.actionText, styles.dismissText]}>
                      Dismiss
                    </Text>
                  </TouchableOpacity>
                </View>
              </View>
            );
          })}
        </BottomSheetScrollView>
      </BottomSheetView>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  sheet: {
    zIndex: 20,
  },
  sheetDetached: {
    marginHorizontal: spacing.content,
  },
  sheetBackground: {
    backgroundColor: colors.camera.sheetBg,
    borderTopLeftRadius: 26,
    borderTopRightRadius: 26,
    borderWidth: 1,
    borderBottomWidth: 0,
    borderColor: colors.camera.border,
  },
  sheetBackgroundDetached: {
    borderBottomLeftRadius: 26,
    borderBottomRightRadius: 26,
  },
  handleIndicator: {
    backgroundColor: colors.camera.textSubtle,
    width: 40,
    height: 4,
  },
  content: {
    flex: 1,
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.section,
  },
  headerRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: spacing.content,
  },
  header: {
    color: colors.primary,
    fontSize: fontSize.body,
    fontWeight: "700",
    letterSpacing: 0.2,
  },
  expandHint: {
    color: colors.camera.textSubtle,
    fontSize: fontSize.micro,
    fontWeight: "600",
  },
  helperText: {
    color: colors.camera.textSubtle,
    fontSize: fontSize.caption,
    lineHeight: 18,
    marginTop: spacing.sm,
    marginBottom: spacing.content,
  },
  listContent: {
    paddingBottom: spacing.lg,
    gap: spacing.element,
  },
  findingCard: {
    backgroundColor: colors.camera.overlayCardLight,
    borderRadius: radius.xl,
    padding: spacing.card,
    borderWidth: 1,
    borderColor: colors.camera.borderSubtle,
  },
  findingHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    gap: spacing.content,
    marginBottom: spacing.sm,
  },
  findingLabelRow: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: spacing.tight,
  },
  categoryDot: {
    width: 8,
    height: 8,
    borderRadius: radius.full,
  },
  categoryText: {
    fontSize: fontSize.caption,
    fontWeight: "700",
    letterSpacing: 0.35,
    textTransform: "uppercase",
  },
  severityPill: {
    borderRadius: radius.full,
    paddingHorizontal: spacing.tight,
    paddingVertical: spacing.xxs,
  },
  severityPillText: {
    color: colors.camera.text,
    fontSize: fontSize.micro,
    fontWeight: "700",
    letterSpacing: 0.4,
  },
  confidenceText: {
    color: colors.camera.textSubtle,
    fontSize: fontSize.micro,
    fontWeight: "600",
  },
  findingDescription: {
    color: colors.camera.textBody,
    fontSize: fontSize.body,
    lineHeight: 22,
    marginBottom: spacing.element,
    fontWeight: "500",
  },
  routeHint: {
    fontSize: fontSize.micro,
    fontWeight: "600",
    letterSpacing: 0.3,
    marginBottom: spacing.sm,
    opacity: 0.72,
  },
  actions: {
    flexDirection: "row",
    gap: spacing.element,
  },
  actionButton: {
    flex: 1,
    borderRadius: radius.lg,
    paddingVertical: spacing.content,
    minHeight: 44,
    justifyContent: "center",
    alignItems: "center",
    borderWidth: 1,
  },
  confirmButton: {
    // Base colors overridden inline per action config
  },
  confirmInner: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.tight,
  },
  confirmIcon: {
    marginTop: 1,
  },
  dismissButton: {
    backgroundColor: colors.errorBg,
    borderColor: colors.errorBorder,
  },
  actionText: {
    fontSize: fontSize.label,
    fontWeight: "700",
  },
  confirmText: {
    // Color set inline per action config
  },
  dismissText: {
    color: colors.severity.urgentRepair,
  },
});

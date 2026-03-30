import React, { useCallback, useRef, useState } from "react";
import { Alert, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import BottomSheet, {
  BottomSheetScrollView,
  BottomSheetView,
} from "@gorhom/bottom-sheet";
import type { Finding } from "../lib/inspection/types";

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
  cosmetic: "#64748b",
  maintenance: "#eab308",
  safety: "#4DA6FF",
  urgent_repair: "#ef4444",
  guest_damage: "#a855f7",
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
  missing: "#f97316",
  moved: "#eab308",
  cleanliness: "#06b6d4",
  damage: "#ef4444",
  inventory: "#a855f7",
  operational: "#3b82f6",
  safety: "#ef4444",
  restock: "#22c55e",
  presentation: "#64748b",
  manual_note: "#4DA6FF",
};

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
            const categoryColor = CATEGORY_COLORS[finding.category] || "#64748b";
            const severityColor = SEVERITY_COLORS[finding.severity] || "#64748b";

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

                <View style={styles.actions}>
                  <TouchableOpacity
                    style={[styles.actionButton, styles.confirmButton]}
                    onPress={() => handleConfirm(finding.id)}
                    activeOpacity={0.7}
                    accessibilityRole="button"
                    accessibilityLabel={`Confirm finding: ${finding.description}`}
                  >
                    <Text style={[styles.actionText, styles.confirmText]}>
                      Confirm
                    </Text>
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
    marginHorizontal: 12,
  },
  sheetBackground: {
    backgroundColor: "rgba(10, 14, 23, 0.97)",
    borderTopLeftRadius: 26,
    borderTopRightRadius: 26,
    borderWidth: 1,
    borderBottomWidth: 0,
    borderColor: "rgba(148, 163, 184, 0.08)",
  },
  sheetBackgroundDetached: {
    borderBottomLeftRadius: 26,
    borderBottomRightRadius: 26,
  },
  handleIndicator: {
    backgroundColor: "rgba(148, 163, 184, 0.35)",
    width: 40,
    height: 4,
  },
  content: {
    flex: 1,
    paddingHorizontal: 16,
    paddingBottom: 28,
  },
  headerRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 12,
  },
  header: {
    color: "#2372B8",
    fontSize: 15,
    fontWeight: "700",
    letterSpacing: 0.2,
  },
  expandHint: {
    color: "rgba(148, 163, 184, 0.72)",
    fontSize: 11,
    fontWeight: "600",
  },
  helperText: {
    color: "rgba(203, 213, 225, 0.72)",
    fontSize: 12,
    lineHeight: 18,
    marginTop: 8,
    marginBottom: 12,
  },
  listContent: {
    paddingBottom: 24,
    gap: 10,
  },
  findingCard: {
    backgroundColor: "rgba(27, 42, 74, 0.88)",
    borderRadius: 14,
    padding: 14,
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.08)",
  },
  findingHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    gap: 12,
    marginBottom: 8,
  },
  findingLabelRow: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: 6,
  },
  categoryDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  categoryText: {
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 0.35,
    textTransform: "uppercase",
  },
  severityPill: {
    borderRadius: 999,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  severityPillText: {
    color: "#fff",
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.4,
  },
  confidenceText: {
    color: "rgba(148, 163, 184, 0.82)",
    fontSize: 11,
    fontWeight: "600",
  },
  findingDescription: {
    color: "#e2e8f0",
    fontSize: 15,
    lineHeight: 22,
    marginBottom: 14,
    fontWeight: "500",
  },
  actions: {
    flexDirection: "row",
    gap: 10,
  },
  actionButton: {
    flex: 1,
    borderRadius: 12,
    paddingVertical: 12,
    minHeight: 44,
    justifyContent: "center",
    alignItems: "center",
    borderWidth: 1,
  },
  confirmButton: {
    backgroundColor: "rgba(34, 197, 94, 0.08)",
    borderColor: "rgba(34, 197, 94, 0.18)",
  },
  dismissButton: {
    backgroundColor: "rgba(239, 68, 68, 0.08)",
    borderColor: "rgba(239, 68, 68, 0.18)",
  },
  actionText: {
    fontSize: 14,
    fontWeight: "700",
  },
  confirmText: {
    color: "#22c55e",
  },
  dismissText: {
    color: "#ef4444",
  },
});

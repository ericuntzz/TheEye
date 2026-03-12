import React, { useCallback, useRef } from "react";
import { View, Text, TouchableOpacity, StyleSheet, ScrollView } from "react-native";
import type { Finding } from "../lib/inspection/types";

interface Props {
  findings: Finding[];
  onConfirm: (id: string) => void;
  onDismiss: (id: string) => void;
}

const SEVERITY_COLORS: Record<string, string> = {
  cosmetic: "#64748b",
  maintenance: "#eab308",
  safety: "#4DA6FF",
  urgent_repair: "#ef4444",
  guest_damage: "#a855f7",
};

const SEVERITY_LABELS: Record<string, string> = {
  cosmetic: "Cosmetic",
  maintenance: "Maintenance",
  safety: "Safety",
  urgent_repair: "Urgent",
  guest_damage: "Damage",
};

export default function FindingsPanel({
  findings,
  onConfirm,
  onDismiss,
}: Props) {
  // Guard against double-tap on confirm/dismiss
  const processingRef = useRef<Set<string>>(new Set());

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
      processingRef.current.add(id);
      onDismiss(id);
    },
    [onDismiss],
  );

  if (findings.length === 0) return null;

  return (
    <View style={styles.container}>
      <View style={styles.handle} />
      <Text style={styles.header}>
        {findings.length} finding{findings.length !== 1 ? "s" : ""}
      </Text>
      <ScrollView
        showsVerticalScrollIndicator={false}
        bounces={false}
        nestedScrollEnabled
      >
      {findings.map((finding) => {
        const sevColor = SEVERITY_COLORS[finding.severity] || "#64748b";
        return (
          <View key={finding.id} style={styles.findingCard}>
            <View style={styles.findingHeader}>
              <View style={styles.findingSeverity}>
                <View
                  style={[styles.severityDot, { backgroundColor: sevColor }]}
                />
                <Text style={[styles.severityText, { color: sevColor }]}>
                  {SEVERITY_LABELS[finding.severity] || finding.severity}
                </Text>
              </View>
              <Text style={styles.confidence}>
                {Math.round(finding.confidence * 100)}%
              </Text>
            </View>
            <Text
              style={styles.findingDescription}
              numberOfLines={2}
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
                accessibilityLabel={`Dismiss finding: ${finding.description}`}
              >
                <Text style={[styles.actionText, styles.dismissText]}>
                  Dismiss
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        );
      })}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: "rgba(10, 14, 23, 0.96)",
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    padding: 16,
    paddingTop: 10,
    paddingBottom: 36,
    maxHeight: "40%",
    borderWidth: 1,
    borderBottomWidth: 0,
    borderColor: "rgba(148, 163, 184, 0.08)",
    zIndex: 20,
  },
  handle: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: "rgba(148, 163, 184, 0.2)",
    alignSelf: "center",
    marginBottom: 10,
  },
  header: {
    color: "#4DA6FF",
    fontSize: 14,
    fontWeight: "600",
    marginBottom: 12,
    letterSpacing: 0.3,
  },
  findingCard: {
    backgroundColor: "rgba(27, 42, 74, 0.85)",
    borderRadius: 12,
    padding: 14,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.08)",
  },
  findingHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 8,
  },
  findingSeverity: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  severityDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  severityText: {
    fontSize: 12,
    fontWeight: "600",
    letterSpacing: 0.3,
    textTransform: "uppercase",
  },
  findingDescription: {
    color: "#e2e8f0",
    fontSize: 14,
    lineHeight: 20,
    marginBottom: 12,
    fontWeight: "500",
  },
  confidence: {
    color: "#475569",
    fontSize: 12,
    fontWeight: "600",
  },
  actions: {
    flexDirection: "row",
    gap: 8,
  },
  actionButton: {
    flex: 1,
    borderRadius: 10,
    paddingVertical: 10,
    alignItems: "center",
    borderWidth: 1,
  },
  confirmButton: {
    backgroundColor: "rgba(34, 197, 94, 0.08)",
    borderColor: "rgba(34, 197, 94, 0.15)",
  },
  dismissButton: {
    backgroundColor: "rgba(239, 68, 68, 0.08)",
    borderColor: "rgba(239, 68, 68, 0.15)",
  },
  actionText: {
    fontSize: 13,
    fontWeight: "600",
  },
  confirmText: {
    color: "#22c55e",
  },
  dismissText: {
    color: "#ef4444",
  },
});

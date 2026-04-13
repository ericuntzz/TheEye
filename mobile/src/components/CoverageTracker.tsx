import React, { useState } from "react";
import { View, Text, StyleSheet, TouchableOpacity, Modal } from "react-native";
import { Image } from "expo-image";
import { colors, radius, fontSize, spacing } from "../lib/tokens";

type WaypointState = "pending" | "captured" | "analyzing" | "issue_found";

interface RoomWaypoint {
  id: string;
  label: string | null;
  scanned: boolean;
  /** Tri-state: pending → captured → analyzing → issue_found */
  state?: WaypointState;
  /** Preview image URL for last-angle mode */
  previewUrl?: string | null;
}

interface Props {
  coverage: number; // 0-100 overall
  currentRoomName?: string;
  roomWaypoints?: RoomWaypoint[];
  roomScannedCount?: number;
  roomTotalCount?: number;
  /** Number of active (non-dismissed) finding cards — used for headline count */
  activeFindingCount?: number;
}

export default function CoverageTracker({
  coverage,
  roomWaypoints,
  roomScannedCount,
  roomTotalCount,
  activeFindingCount = 0,
}: Props) {
  const [expandedPreviewUrl, setExpandedPreviewUrl] = useState<string | null>(null);
  const clampedCoverage = Math.min(100, Math.max(0, coverage));
  const barColor =
    clampedCoverage >= 90
      ? colors.category.restock
      : clampedCoverage >= 50
        ? colors.severity.safety
        : colors.slate300;

  const scannedCount =
    typeof roomScannedCount === "number"
      ? roomScannedCount
      : roomWaypoints?.filter((w) => w.scanned).length ?? 0;
  const totalCount =
    typeof roomTotalCount === "number"
      ? roomTotalCount
      : roomWaypoints?.length ?? 0;
  const roomCoverage =
    totalCount > 0 ? Math.round((scannedCount / totalCount) * 100) : null;
  const remainingCount = Math.max(totalCount - scannedCount, 0);
  const pendingWaypoints = roomWaypoints?.filter((wp) => !wp.scanned) ?? [];
  const capturedWaypoints = roomWaypoints?.filter((wp) => wp.scanned) ?? [];
  const visiblePendingWaypoints = pendingWaypoints.slice(0, 3);
  const hiddenPendingCount = Math.max(pendingWaypoints.length - visiblePendingWaypoints.length, 0);
  const analyzingCount = capturedWaypoints.filter(w => w.state === "analyzing").length;
  const issueCount = capturedWaypoints.filter(w => w.state === "issue_found").length;

  // Use activeFindingCount (actual finding cards) for headline, not waypoint issue dots
  const effectiveIssueCount = activeFindingCount > 0 ? activeFindingCount : issueCount;
  const roomCompleteSubtext =
    analyzingCount > 0 && effectiveIssueCount > 0
      ? `${analyzingCount} analyzing, ${effectiveIssueCount} issue${effectiveIssueCount > 1 ? "s" : ""} found`
      : analyzingCount > 0
        ? `${analyzingCount} analyzing`
        : effectiveIssueCount > 0
          ? `${effectiveIssueCount} issue${effectiveIssueCount > 1 ? "s" : ""} found`
          : "Keep scanning for detail or tap End";

  const trackerHeadline =
    totalCount <= 0
      ? "Scanning room"
      : remainingCount <= 0
        ? `Room covered · ${roomCompleteSubtext}`
        : remainingCount === 1
          ? "1 view left in this room"
          : `${remainingCount} views left in this room`;

  return (
    <View style={styles.container}>
      <View style={styles.headerRow}>
        <Text style={styles.headerText} numberOfLines={1}>
          {trackerHeadline}
        </Text>
        <Text style={[styles.percentText, { color: barColor }]}>
          {Math.round(clampedCoverage)}% overall
        </Text>
      </View>

      <View style={styles.barBackground}>
        <View
          style={[
            styles.barFill,
            {
              width: `${clampedCoverage}%`,
              backgroundColor: barColor,
            },
          ]}
        />
      </View>

      {totalCount > 0 ? (
        <Text style={styles.roomProgressText} numberOfLines={2}>
          {roomCoverage !== null
            ? `${roomCoverage}% of this room captured`
            : `${scannedCount}/${totalCount} angles captured`}
        </Text>
      ) : null}

      {/* Last-angle mode: when 1 effective angle remains, show tappable preview */}
      {pendingWaypoints.length === 1 && pendingWaypoints[0].previewUrl && (
        <TouchableOpacity
          style={styles.lastAngleRow}
          activeOpacity={0.7}
          onPress={() => setExpandedPreviewUrl(pendingWaypoints[0].previewUrl!)}
          accessibilityLabel="Tap to expand reference image"
          accessibilityRole="button"
        >
          <Image
            source={{ uri: pendingWaypoints[0].previewUrl }}
            style={styles.lastAnglePreview}
            contentFit="cover"
            cachePolicy="memory-disk"
          />
          <View style={styles.lastAngleTextCol}>
            <Text style={styles.sectionLabel}>Final view</Text>
            <Text style={styles.lastAngleLabel} numberOfLines={2}>
              {pendingWaypoints[0].label || "1 remaining view"}
            </Text>
            <Text style={styles.lastAngleHint}>
              Tap to see full reference image
            </Text>
          </View>
        </TouchableOpacity>
      )}

      {/* Multiple remaining: show dot list */}
      {pendingWaypoints.length > 1 && (
        <>
          <Text style={styles.sectionLabel}>Next up</Text>
          <View style={styles.waypointsRow}>
            {visiblePendingWaypoints.map((wp) => (
              <View key={wp.id} style={styles.waypointItem}>
                <View style={[styles.dot, styles.dotPending]} />
                {wp.label ? (
                  <Text style={styles.dotLabel} numberOfLines={2}>
                    {wp.label}
                  </Text>
                ) : null}
              </View>
            ))}
            {hiddenPendingCount > 0 ? (
              <View style={styles.moreRemainingPill}>
                <Text style={styles.moreRemainingText}>
                  +{hiddenPendingCount} more
                </Text>
              </View>
            ) : null}
          </View>
        </>
      )}

      {/* Single remaining without preview: simple text */}
      {pendingWaypoints.length === 1 && !pendingWaypoints[0].previewUrl && (
        <>
          <Text style={styles.sectionLabel}>Final view</Text>
          <View style={styles.waypointItem}>
            <View style={[styles.dot, styles.dotPending]} />
            <Text style={styles.dotLabel} numberOfLines={2}>
              {pendingWaypoints[0].label || "1 remaining view"}
            </Text>
          </View>
        </>
      )}

      {/* Expanded preview modal — full-screen reference image */}
      <Modal
        visible={!!expandedPreviewUrl}
        transparent
        animationType="fade"
        onRequestClose={() => setExpandedPreviewUrl(null)}
      >
        <TouchableOpacity
          style={styles.previewModalOverlay}
          activeOpacity={1}
          onPress={() => setExpandedPreviewUrl(null)}
        >
          <View style={styles.previewModalContent}>
            <Text style={styles.previewModalTitle}>Reference Image</Text>
            <Text style={styles.previewModalSubtitle}>
              Point your camera at this area to capture
            </Text>
            {expandedPreviewUrl && (
              <Image
                source={{ uri: expandedPreviewUrl }}
                style={styles.previewModalImage}
                contentFit="contain"
                cachePolicy="memory-disk"
              />
            )}
            <TouchableOpacity
              style={styles.previewModalClose}
              onPress={() => setExpandedPreviewUrl(null)}
            >
              <Text style={styles.previewModalCloseText}>Close</Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </Modal>

      {capturedWaypoints.length > 0 && (
        <View style={styles.capturedSummaryRow}>
          <Text style={styles.capturedSummaryText}>
            Captured {capturedWaypoints.length}
          </Text>
          <View style={styles.capturedDotsRow}>
            {capturedWaypoints.map((wp) => {
              const state = wp.state || "captured";
              const dotStyle =
                state === "issue_found" ? styles.dotIssue
                : state === "analyzing" ? styles.dotAnalyzing
                : styles.dotScanned;
              return <View key={wp.id} style={[styles.dot, dotStyle]} />;
            })}
          </View>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    flexDirection: "column",
    backgroundColor: colors.camera.panelBg,
    borderRadius: radius.xl,
    paddingHorizontal: spacing.card,
    paddingVertical: spacing.element,
    gap: spacing.sm,
    borderWidth: 1,
    borderColor: colors.camera.panelBorder,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.content,
  },
  headerText: {
    color: colors.camera.textBright,
    fontSize: fontSize.sm,
    fontWeight: "600",
    flex: 1,
  },
  barBackground: {
    width: "100%",
    height: 6,
    backgroundColor: colors.camera.borderLight,
    borderRadius: radius.xs,
    overflow: "hidden",
  },
  barFill: {
    height: "100%",
    borderRadius: radius.xs,
  },
  percentText: {
    fontSize: fontSize.micro,
    fontWeight: "600",
    minWidth: 0,
    textAlign: "right",
  },
  roomProgressText: {
    color: colors.camera.textBodyMuted,
    fontSize: fontSize.micro,
    fontWeight: "500",
    lineHeight: 15,
  },
  sectionLabel: {
    color: colors.camera.textAccent,
    fontSize: fontSize.badge,
    fontWeight: "700",
    letterSpacing: 0.8,
    textTransform: "uppercase",
  },
  waypointsRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: spacing.element,
    flexWrap: "wrap",
    paddingTop: spacing.xxs,
  },
  waypointItem: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: spacing.tight,
    maxWidth: "48%",
    minWidth: "48%",
    backgroundColor: colors.camera.itemBg,
    borderRadius: radius.md,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.tight,
    borderWidth: 1,
    borderColor: colors.camera.itemBorder,
  },
  dot: {
    width: 7,
    height: 7,
    borderRadius: radius.full,
    marginTop: spacing.xs,
  },
  dotScanned: {
    backgroundColor: colors.category.restock,
  },
  dotAnalyzing: {
    backgroundColor: colors.category.operational,
  },
  dotIssue: {
    backgroundColor: colors.warning,
  },
  dotPending: {
    backgroundColor: colors.camera.dotPending,
  },
  dotLabel: {
    color: colors.camera.textMedium,
    fontSize: fontSize.micro,
    fontWeight: "500",
    flexShrink: 1,
  },
  dotLabelScanned: {
    color: colors.camera.dotScannedLabel,
  },
  moreRemainingPill: {
    borderRadius: radius.full,
    paddingHorizontal: spacing.element,
    paddingVertical: spacing.tight,
    backgroundColor: colors.camera.pillBg,
    borderWidth: 1,
    borderColor: colors.camera.pillBorder,
    alignSelf: "flex-start",
  },
  moreRemainingText: {
    color: colors.camera.textMedium,
    fontSize: fontSize.badge,
    fontWeight: "600",
  },
  capturedSummaryRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingTop: spacing.xxs,
    flexWrap: "wrap",
  },
  capturedSummaryText: {
    color: colors.camera.textSuccess,
    fontSize: fontSize.badge,
    fontWeight: "700",
    letterSpacing: 0.8,
    textTransform: "uppercase",
  },
  capturedDotsRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.tight,
    flexWrap: "wrap",
    flexShrink: 1,
  },
  lastAngleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.element,
    paddingTop: spacing.xxs,
  },
  lastAnglePreview: {
    width: 56,
    height: 56,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.camera.borderPreview,
  },
  lastAngleTextCol: {
    flex: 1,
    gap: spacing.xxs,
  },
  lastAngleLabel: {
    color: colors.camera.textHigh,
    fontSize: fontSize.sm,
    fontWeight: "700",
  },
  lastAngleHint: {
    color: colors.camera.textAccentMuted,
    fontSize: fontSize.micro,
    fontWeight: "400",
  },
  previewModalOverlay: {
    flex: 1,
    backgroundColor: colors.camera.modalOverlay,
    justifyContent: "center",
    alignItems: "center",
    padding: spacing.lg,
  },
  previewModalContent: {
    width: "100%",
    maxWidth: 340,
    alignItems: "center",
    gap: spacing.content,
  },
  previewModalTitle: {
    color: colors.camera.text,
    fontSize: fontSize.h3,
    fontWeight: "700",
  },
  previewModalSubtitle: {
    color: colors.camera.textMuted,
    fontSize: fontSize.label,
    textAlign: "center",
  },
  previewModalImage: {
    width: "100%",
    aspectRatio: 4 / 3,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.camera.borderMedium,
  },
  previewModalClose: {
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.content,
    backgroundColor: colors.camera.modalButtonBg,
    borderRadius: radius.md,
    marginTop: spacing.sm,
  },
  previewModalCloseText: {
    color: colors.camera.text,
    fontSize: fontSize.bodyLg,
    fontWeight: "600",
  },
});

import React, { useState } from "react";
import { View, Text, StyleSheet, TouchableOpacity, Modal } from "react-native";
import { Image } from "expo-image";

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
}

export default function CoverageTracker({
  coverage,
  roomWaypoints,
  roomScannedCount,
  roomTotalCount,
}: Props) {
  const [expandedPreviewUrl, setExpandedPreviewUrl] = useState<string | null>(null);
  const clampedCoverage = Math.min(100, Math.max(0, coverage));
  const barColor =
    clampedCoverage >= 90
      ? "#22c55e"
      : clampedCoverage >= 50
        ? "#4DA6FF"
        : "#94a3b8";

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

  const trackerHeadline =
    totalCount <= 0
      ? "Scanning room"
      : remainingCount <= 0
        ? (analyzingCount > 0
            ? `Room covered · ${analyzingCount} analyzing`
            : issueCount > 0
              ? `Room covered · ${issueCount} issue${issueCount > 1 ? "s" : ""} found`
              : "Room covered · Keep scanning for detail or tap End")
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
    backgroundColor: "rgba(2, 6, 23, 0.72)",
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 10,
    gap: 8,
    borderWidth: 1,
    borderColor: "rgba(148,163,184,0.16)",
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  headerText: {
    color: "rgba(255,255,255,0.94)",
    fontSize: 13,
    fontWeight: "600",
    flex: 1,
  },
  barBackground: {
    width: "100%",
    height: 6,
    backgroundColor: "rgba(255,255,255,0.12)",
    borderRadius: 4,
    overflow: "hidden",
  },
  barFill: {
    height: "100%",
    borderRadius: 4,
  },
  percentText: {
    fontSize: 11,
    fontWeight: "600",
    minWidth: 0,
    textAlign: "right",
  },
  roomProgressText: {
    color: "rgba(226,232,240,0.75)",
    fontSize: 11,
    fontWeight: "500",
    lineHeight: 15,
  },
  sectionLabel: {
    color: "rgba(191,219,254,0.78)",
    fontSize: 10,
    fontWeight: "700",
    letterSpacing: 0.8,
    textTransform: "uppercase",
  },
  waypointsRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
    flexWrap: "wrap",
    paddingTop: 2,
  },
  waypointItem: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 6,
    maxWidth: "48%",
    minWidth: "48%",
    backgroundColor: "rgba(15,23,42,0.55)",
    borderRadius: 10,
    paddingHorizontal: 8,
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: "rgba(148,163,184,0.12)",
  },
  dot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    marginTop: 4,
  },
  dotScanned: {
    backgroundColor: "#22c55e", // green — captured + verified
  },
  dotAnalyzing: {
    backgroundColor: "#3b82f6", // blue — captured, AI still processing
  },
  dotIssue: {
    backgroundColor: "#f59e0b", // amber — issue found by AI
  },
  dotPending: {
    backgroundColor: "rgba(255,255,255,0.62)",
  },
  dotLabel: {
    color: "rgba(255,255,255,0.84)",
    fontSize: 11,
    fontWeight: "500",
    flexShrink: 1,
  },
  dotLabelScanned: {
    color: "rgba(34,197,94,0.7)",
  },
  moreRemainingPill: {
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 6,
    backgroundColor: "rgba(148,163,184,0.16)",
    borderWidth: 1,
    borderColor: "rgba(148,163,184,0.22)",
    alignSelf: "flex-start",
  },
  moreRemainingText: {
    color: "rgba(255,255,255,0.78)",
    fontSize: 10,
    fontWeight: "600",
  },
  capturedSummaryRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingTop: 2,
    flexWrap: "wrap",
  },
  capturedSummaryText: {
    color: "rgba(134,239,172,0.82)",
    fontSize: 10,
    fontWeight: "700",
    letterSpacing: 0.8,
    textTransform: "uppercase",
  },
  capturedDotsRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    flexWrap: "wrap",
    flexShrink: 1,
  },
  lastAngleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingTop: 2,
  },
  lastAnglePreview: {
    width: 56,
    height: 56,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.2)",
  },
  lastAngleTextCol: {
    flex: 1,
    gap: 2,
  },
  lastAngleLabel: {
    color: "rgba(255,255,255,0.92)",
    fontSize: 13,
    fontWeight: "700",
  },
  lastAngleHint: {
    color: "rgba(191,219,254,0.68)",
    fontSize: 11,
    fontWeight: "400",
  },
  previewModalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.85)",
    justifyContent: "center",
    alignItems: "center",
    padding: 24,
  },
  previewModalContent: {
    width: "100%",
    maxWidth: 340,
    alignItems: "center",
    gap: 12,
  },
  previewModalTitle: {
    color: "#fff",
    fontSize: 18,
    fontWeight: "700",
  },
  previewModalSubtitle: {
    color: "rgba(255,255,255,0.6)",
    fontSize: 14,
    textAlign: "center",
  },
  previewModalImage: {
    width: "100%",
    aspectRatio: 4 / 3,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.15)",
  },
  previewModalClose: {
    paddingHorizontal: 32,
    paddingVertical: 12,
    backgroundColor: "rgba(255,255,255,0.15)",
    borderRadius: 10,
    marginTop: 8,
  },
  previewModalCloseText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "600",
  },
});

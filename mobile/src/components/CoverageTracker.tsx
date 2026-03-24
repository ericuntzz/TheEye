import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { Image } from "expo-image";

interface RoomWaypoint {
  id: string;
  label: string | null;
  scanned: boolean;
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
  const trackerHeadline =
    totalCount <= 0
      ? "Scanning room"
      : remainingCount <= 0
        ? "Room coverage complete"
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

      {/* Last-angle mode: when 1 effective angle remains, show preview thumbnail */}
      {pendingWaypoints.length === 1 && pendingWaypoints[0].previewUrl && (
        <View style={styles.lastAngleRow}>
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
              Point the camera at this area next
            </Text>
          </View>
        </View>
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

      {capturedWaypoints.length > 0 && (
        <View style={styles.capturedSummaryRow}>
          <Text style={styles.capturedSummaryText}>
            Captured {capturedWaypoints.length}
          </Text>
          <View style={styles.capturedDotsRow}>
            {capturedWaypoints.map((wp) => (
              <View key={wp.id} style={[styles.dot, styles.dotScanned]} />
            ))}
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
    backgroundColor: "#22c55e",
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
});

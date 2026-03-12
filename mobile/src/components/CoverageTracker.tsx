import React from "react";
import { View, Text, StyleSheet } from "react-native";

interface RoomWaypoint {
  id: string;
  label: string | null;
  scanned: boolean;
}

interface Props {
  coverage: number; // 0-100 overall
  currentRoomName?: string;
  roomWaypoints?: RoomWaypoint[];
}

export default function CoverageTracker({
  coverage,
  currentRoomName,
  roomWaypoints,
}: Props) {
  const clampedCoverage = Math.min(100, Math.max(0, coverage));
  const barColor =
    clampedCoverage >= 90
      ? "#22c55e"
      : clampedCoverage >= 50
        ? "#4DA6FF"
        : "#94a3b8";

  const scannedCount = roomWaypoints?.filter((w) => w.scanned).length ?? 0;
  const totalCount = roomWaypoints?.length ?? 0;
  const roomCoverage =
    totalCount > 0 ? Math.round((scannedCount / totalCount) * 100) : null;

  return (
    <View style={styles.container}>
      {/* Overall progress bar */}
      <View style={styles.barRow}>
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
        <Text style={[styles.percentText, { color: barColor }]}>
          Overall {Math.round(clampedCoverage)}%
        </Text>
      </View>

      {totalCount > 0 && (
        <Text style={styles.roomProgressText} numberOfLines={1} ellipsizeMode="tail">
          {currentRoomName ? `${currentRoomName}: ` : ""}
          {scannedCount}/{totalCount} angles
          {roomCoverage !== null ? ` (${roomCoverage}%)` : ""}
        </Text>
      )}

      {/* Waypoint dots (when room has baselines) */}
      {roomWaypoints && roomWaypoints.length > 0 && (
        <View style={styles.waypointsRow}>
          {roomWaypoints.map((wp) => (
            <View key={wp.id} style={styles.waypointItem}>
              <View
                style={[
                  styles.dot,
                  wp.scanned ? styles.dotScanned : styles.dotPending,
                ]}
              />
              {wp.label && (
                <Text
                  style={[
                    styles.dotLabel,
                    wp.scanned && styles.dotLabelScanned,
                  ]}
                  numberOfLines={1}
                >
                  {wp.label}
                </Text>
              )}
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    flexDirection: "column",
    backgroundColor: "rgba(0,0,0,0.5)",
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 8,
    gap: 6,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.06)",
  },
  barRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  barBackground: {
    flex: 1,
    height: 5,
    backgroundColor: "rgba(255,255,255,0.1)",
    borderRadius: 3,
    overflow: "hidden",
  },
  barFill: {
    height: "100%",
    borderRadius: 3,
  },
  percentText: {
    fontSize: 12,
    fontWeight: "600",
    minWidth: 86,
    textAlign: "right",
  },
  roomProgressText: {
    color: "rgba(255,255,255,0.8)",
    fontSize: 12,
    fontWeight: "500",
  },
  waypointsRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingTop: 2,
  },
  waypointItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  dot: {
    width: 7,
    height: 7,
    borderRadius: 4,
  },
  dotScanned: {
    backgroundColor: "#22c55e",
  },
  dotPending: {
    backgroundColor: "rgba(255,255,255,0.2)",
  },
  dotLabel: {
    color: "rgba(255,255,255,0.35)",
    fontSize: 11,
    fontWeight: "500",
  },
  dotLabelScanned: {
    color: "rgba(34,197,94,0.8)",
  },
});

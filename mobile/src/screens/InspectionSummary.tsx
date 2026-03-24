/**
 * InspectionSummary.tsx — Post-Inspection Report
 *
 * Shows the results of a completed inspection:
 * - Overall readiness score
 * - Completion tier + coverage
 * - Duration
 * - Room-by-room scores + findings
 * - Confirmed findings grouped by severity
 */

import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Alert,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useNavigation, useRoute } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import type { RouteProp } from "@react-navigation/native";
import type { RootStackParamList, SummaryData, SummaryFindingData } from "../navigation";
import { getInspection, deleteInspectionFinding } from "../lib/api";
import { colors } from "../lib/tokens";

type Nav = NativeStackNavigationProp<RootStackParamList, "InspectionSummary">;
type Route = RouteProp<RootStackParamList, "InspectionSummary">;

const SEVERITY_COLORS: Record<string, string> = {
  cosmetic: colors.slate500,
  maintenance: colors.warning,
  safety: colors.primary,
  urgent_repair: colors.error,
  guest_damage: colors.purple,
};

const SEVERITY_LABELS: Record<string, string> = {
  cosmetic: "Cosmetic",
  maintenance: "Maintenance",
  safety: "Safety",
  urgent_repair: "Urgent Repair",
  guest_damage: "Guest Damage",
};

const MODE_LABELS: Record<string, string> = {
  turnover: "Turnover",
  maintenance: "Maintenance",
  owner_arrival: "Owner Arrival",
  vacancy_check: "Vacancy Check",
};

function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m ${seconds}s`;
}

function getScoreColor(score: number | null): string {
  if (score === null) return colors.muted;
  if (score >= 90) return colors.success;
  if (score >= 70) return colors.warning;
  if (score >= 50) return colors.primary;
  return colors.error;
}

function getTierLabel(tier: string): string {
  switch (tier) {
    case "thorough":
      return "Thorough";
    case "standard":
      return "Standard";
    case "minimum":
      return "Minimum";
    default:
      return tier;
  }
}

function getTierColor(tier: string): string {
  switch (tier) {
    case "thorough":
      return colors.success;
    case "standard":
      return colors.primary;
    default:
      return colors.slate300;
  }
}

function removeFindingFromSummary(
  summary: SummaryData,
  findingId: string,
): SummaryData {
  const nextRooms = summary.rooms.map((room) => {
    const nextFindings = room.findings.filter((finding) => finding.id !== findingId);
    return {
      ...room,
      findings: nextFindings,
      confirmedFindings: nextFindings.filter((finding) => finding.status !== "dismissed").length,
    };
  });

  return {
    ...summary,
    rooms: nextRooms,
    confirmedFindings: summary.confirmedFindings.filter((finding) => finding.id !== findingId),
  };
}

function mapInspectionToSummary(payload: {
  inspectionMode?: string;
  completionTier?: string | null;
  readinessScore?: number | null;
  startedAt?: string | null;
  completedAt?: string | null;
  rooms?: Array<{
    id: string;
    name: string;
    baselineImages?: Array<{ id: string }>;
  }>;
  results?: Array<{
    id: string;
    roomId: string;
    baselineImageId: string;
    score: number | null;
    findings?: Array<{
      id?: string;
      description?: string;
      severity?: string;
      confidence?: number;
      category?: string;
      status?: string;
      source?: "manual_note" | "ai";
    }>;
  }>;
}): SummaryData {
  const rooms = payload.rooms || [];
  const results = payload.results || [];

  const roomMeta = new Map(
    rooms.map((room) => [
      room.id,
      {
        roomName: room.name,
        anglesTotal: room.baselineImages?.length || 0,
      },
    ]),
  );

  const roomBuckets = new Map<
    string,
    {
      baselineIds: Set<string>;
      scores: number[];
      findings: SummaryFindingData[];
    }
  >();

  for (const result of results) {
    const bucket = roomBuckets.get(result.roomId) || {
      baselineIds: new Set<string>(),
      scores: [],
      findings: [],
    };
    bucket.baselineIds.add(result.baselineImageId);
    if (typeof result.score === "number") {
      bucket.scores.push(result.score);
    }

    const roomName = roomMeta.get(result.roomId)?.roomName || "Room";
    (result.findings || []).forEach((finding, findingIndex) => {
      const findingId =
        typeof finding.id === "string" && finding.id.length > 0
          ? finding.id
          : `${result.id}-${findingIndex}`;

      bucket.findings.push({
        id: findingId,
        description: finding.description || "Untitled finding",
        severity: finding.severity || "maintenance",
        confidence:
          typeof finding.confidence === "number" ? finding.confidence : 1,
        category: finding.category || "manual_note",
        roomName,
        status: finding.status || "confirmed",
        source:
          finding.source ||
          (finding.category === "manual_note" ? "manual_note" : "ai"),
        resultId: result.id,
        findingIndex,
      });
    });

    roomBuckets.set(result.roomId, bucket);
  }

  const summaryRooms = rooms.map((room) => {
    const bucket = roomBuckets.get(room.id) || {
      baselineIds: new Set<string>(),
      scores: [],
      findings: [],
    };
    // NOTE: On reload, this uses raw baseline count (not cluster-effective count).
    // Live inspection uses detector.getRoomProgress() which accounts for clustering.
    // This may show slightly different coverage than the live UI showed.
    // Full fix: persist effectiveAngles in bulk submission payload.
    const anglesTotal = room.baselineImages?.length || 0;
    const anglesScanned = Math.min(anglesTotal, bucket.baselineIds.size);
    const score =
      bucket.scores.length > 0
        ? bucket.scores.reduce((sum, value) => sum + value, 0) /
          bucket.scores.length
        : null;
    const coverage =
      anglesTotal > 0 ? Math.round((anglesScanned / anglesTotal) * 100) : 0;

    return {
      roomId: room.id,
      roomName: room.name,
      score,
      coverage,
      anglesScanned,
      anglesTotal,
      confirmedFindings: bucket.findings.filter((f) => f.status !== "dismissed").length,
      findings: bucket.findings.filter((f) => f.status !== "dismissed"),
    };
  });

  const allFindings = summaryRooms.flatMap((room) => room.findings);
  const totalAngles = summaryRooms.reduce(
    (sum, room) => sum + room.anglesTotal,
    0,
  );
  const totalScannedAngles = summaryRooms.reduce(
    (sum, room) => sum + room.anglesScanned,
    0,
  );
  const overallCoverage =
    totalAngles > 0 ? Math.round((totalScannedAngles / totalAngles) * 100) : 0;
  const startedAt = payload.startedAt ? new Date(payload.startedAt).getTime() : null;
  const completedAt = payload.completedAt ? new Date(payload.completedAt).getTime() : null;
  const durationMs =
    startedAt && completedAt && completedAt > startedAt
      ? completedAt - startedAt
      : 0;

  return {
    overallScore: payload.readinessScore ?? null,
    completionTier: payload.completionTier || "minimum",
    overallCoverage,
    durationMs,
    inspectionMode: payload.inspectionMode || "turnover",
    rooms: summaryRooms,
    confirmedFindings: allFindings,
  };
}

export default function InspectionSummaryScreen() {
  const navigation = useNavigation<Nav>();
  const route = useRoute<Route>();
  const { summaryData, inspectionId } = route.params;

  const defaultSummary: SummaryData = {
    overallScore: null,
    completionTier: "minimum",
    overallCoverage: 0,
    durationMs: 0,
    inspectionMode: "turnover",
    rooms: [],
    confirmedFindings: [],
  };
  const [data, setData] = useState<SummaryData>(summaryData || defaultSummary);
  const [loading, setLoading] = useState(!summaryData);
  const [error, setError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const hasData = data.rooms.length > 0 || data.confirmedFindings.length > 0;

  useEffect(() => {
    setData(summaryData || defaultSummary);
    setLoading(!summaryData);
    setError(null);
  }, [summaryData]);

  useEffect(() => {
    if (summaryData || !inspectionId) return;

    let cancelled = false;
    const load = async () => {
      try {
        setLoading(true);
        setError(null);
        const inspectionPayload = await getInspection(inspectionId);
        if (cancelled) return;
        setData(mapInspectionToSummary(inspectionPayload));
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof Error
              ? err.message
              : "Failed to load inspection details",
          );
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [inspectionId, summaryData]);

  const handleDeleteNote = useCallback(
    (finding: SummaryFindingData) => {
      Alert.alert(
        "Delete Note",
        "Remove this note from inspection details?",
        [
          { text: "Cancel", style: "cancel" },
          {
            text: "Delete",
            style: "destructive",
            onPress: async () => {
              // Capture the pre-delete snapshot via functional setter
              let previous: SummaryData | null = null;
              setData((current) => {
                previous = current;
                return removeFindingFromSummary(current, finding.id);
              });
              setDeletingId(finding.id);
              try {
                if (finding.resultId) {
                  await deleteInspectionFinding(inspectionId, {
                    resultId: finding.resultId,
                    findingId: finding.id,
                    findingIndex: finding.findingIndex,
                  });
                }
              } catch (err) {
                if (previous) setData(previous);
                Alert.alert(
                  "Delete failed",
                  err instanceof Error ? err.message : "Failed to delete note",
                );
              } finally {
                setDeletingId(null);
              }
            },
          },
        ],
      );
    },
    [inspectionId],
  );

  // Group confirmed findings by severity
  const findingsBySeverity = useMemo(() => {
    const groups: Record<string, typeof data.confirmedFindings> = {};
    for (const f of data.confirmedFindings) {
      if (!groups[f.severity]) groups[f.severity] = [];
      groups[f.severity].push(f);
    }
    // Sort by severity priority
    const order = ["urgent_repair", "safety", "guest_damage", "maintenance", "cosmetic"];
    const sorted: Array<[string, typeof data.confirmedFindings]> = [];
    for (const sev of order) {
      if (groups[sev]) sorted.push([sev, groups[sev]]);
    }
    return sorted;
  }, [data.confirmedFindings]);

  const scoreDisplay = data.overallScore !== null
    ? Math.round(data.overallScore)
    : "--";

  const scoreColor = getScoreColor(data.overallScore);

  if (loading) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.loadingState}>
          <ActivityIndicator size="large" color={colors.primary} />
          <Text style={styles.loadingText}>Loading inspection details...</Text>
        </View>
      </SafeAreaView>
    );
  }

  if (error) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.loadingState}>
          <Text style={styles.errorTitle}>Unable to load inspection details</Text>
          <Text style={styles.errorBody}>{error}</Text>
          <View style={{ flexDirection: "row", gap: 12, marginTop: 4 }}>
            <TouchableOpacity
              style={[styles.completeButton, { flex: 1, backgroundColor: colors.primary }]}
              onPress={() => {
                setError(null);
                setLoading(true);
                void (async () => {
                  try {
                    const payload = await getInspection(inspectionId);
                    setData(mapInspectionToSummary(payload));
                  } catch (err) {
                    setError(err instanceof Error ? err.message : "Failed to load inspection details");
                  } finally {
                    setLoading(false);
                  }
                })();
              }}
              activeOpacity={0.8}
            >
              <Text style={styles.completeButtonText}>Retry</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.completeButton, { flex: 1 }]}
              onPress={() => navigation.goBack()}
              activeOpacity={0.8}
            >
              <Text style={styles.completeButtonText}>Back</Text>
            </TouchableOpacity>
          </View>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        {/* Header */}
        <Text style={styles.title}>Inspection Complete</Text>
        <View style={styles.headerRow}>
          <View style={styles.modeBadge}>
            <Text style={styles.modeText}>
              {MODE_LABELS[data.inspectionMode] || data.inspectionMode}
            </Text>
          </View>
          {hasData && (
            <Text style={styles.durationText}>
              {formatDuration(data.durationMs)}
            </Text>
          )}
        </View>

        {/* Score Card */}
        <View style={styles.scoreCard}>
          <Text style={styles.scoreLabel}>READINESS SCORE</Text>
          <Text style={[styles.scoreValue, { color: scoreColor }]}>
            {scoreDisplay}
          </Text>
          <Text style={styles.scoreSubtext}>
            {data.overallScore !== null
              ? data.overallScore >= 90
                ? "Excellent condition"
                : data.overallScore >= 70
                  ? "Good with minor issues"
                  : data.overallScore >= 50
                    ? "Needs attention"
                    : "Significant issues found"
              : data.rooms.length > 0
                ? data.overallCoverage > 0 || data.rooms.some(r => r.anglesScanned > 0)
                  ? "Coverage captured; AI scoring unavailable"
                  : "No captured views yet"
                : "No comparisons run"}
          </Text>
          {/* Score bar */}
          {data.overallScore !== null && (
            <View style={styles.scoreBarContainer}>
              <View style={styles.scoreBar}>
                <View
                  style={[
                    styles.scoreBarFill,
                    {
                      width: `${Math.min(100, data.overallScore)}%`,
                      backgroundColor: scoreColor,
                    },
                  ]}
                />
              </View>
            </View>
          )}
        </View>

        {/* Coverage Stats */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Coverage</Text>
          <View style={styles.statsGrid}>
            <View style={styles.statItem}>
              <Text style={styles.statItemLabel}>Completion</Text>
              <Text
                style={[
                  styles.statItemValue,
                  { color: getTierColor(data.completionTier) },
                ]}
              >
                {getTierLabel(data.completionTier)}
              </Text>
            </View>
            <View style={styles.statItem}>
              <Text style={styles.statItemLabel}>Rooms</Text>
              <Text style={styles.statItemValue}>{data.rooms.length}</Text>
            </View>
            <View style={styles.statItem}>
              <Text style={styles.statItemLabel}>Coverage</Text>
              <Text style={styles.statItemValue}>{data.overallCoverage}%</Text>
            </View>
            <View style={styles.statItem}>
              <Text style={styles.statItemLabel}>Findings</Text>
              <Text
                style={[
                  styles.statItemValue,
                  data.confirmedFindings.length > 0 && { color: colors.primary },
                ]}
              >
                {data.confirmedFindings.length}
              </Text>
            </View>
          </View>
        </View>

        {/* Room-by-Room Breakdown */}
        {data.rooms.length > 0 && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Room Details</Text>
            {data.rooms.map((room) => (
              <View key={room.roomId} style={styles.roomCard}>
                <View style={styles.roomHeader}>
                  <Text style={styles.roomName}>{room.roomName}</Text>
                  {room.score !== null && (
                    <View
                      style={[
                        styles.roomScoreBadge,
                        {
                          backgroundColor: `${getScoreColor(room.score)}18`,
                          borderColor: `${getScoreColor(room.score)}40`,
                        },
                      ]}
                    >
                      <Text
                        style={[
                          styles.roomScore,
                          { color: getScoreColor(room.score) },
                        ]}
                      >
                        {Math.round(room.score)}
                      </Text>
                    </View>
                  )}
                </View>
                <View style={styles.roomStats}>
                  <Text style={styles.roomStat}>
                    {room.anglesScanned}/{room.anglesTotal} angles
                  </Text>
                  <Text style={styles.roomStatDivider}>|</Text>
                  <Text style={styles.roomStat}>{room.coverage}%</Text>
                  {room.confirmedFindings > 0 && (
                    <>
                      <Text style={styles.roomStatDivider}>|</Text>
                      <Text style={[styles.roomStat, styles.roomFindingsStat]}>
                        {room.confirmedFindings} finding
                        {room.confirmedFindings !== 1 ? "s" : ""}
                      </Text>
                    </>
                  )}
                </View>
                {/* Room coverage bar */}
                <View style={styles.roomCoverageBar}>
                  <View
                    style={[
                      styles.roomCoverageFill,
                      {
                        width: `${room.coverage}%`,
                        backgroundColor:
                          room.coverage >= 90
                            ? colors.success
                            : room.coverage >= 50
                              ? colors.primary
                              : colors.slate300,
                      },
                    ]}
                  />
                </View>
              </View>
            ))}
          </View>
        )}

        {/* Confirmed Findings by Severity */}
        {findingsBySeverity.length > 0 ? (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Findings</Text>
            {findingsBySeverity.map(([severity, findings]) => (
              <View key={severity} style={styles.severityGroup}>
                <View style={styles.severityHeader}>
                  <View
                    style={[
                      styles.severityDot,
                      { backgroundColor: SEVERITY_COLORS[severity] || colors.slate500 },
                    ]}
                  />
                  <Text style={styles.severityLabel}>
                    {SEVERITY_LABELS[severity] || severity}
                  </Text>
                  <View style={styles.severityCountBadge}>
                    <Text style={styles.severityCount}>{findings.length}</Text>
                  </View>
                </View>
                {findings.map((finding) => (
                  <View key={finding.id} style={styles.findingRow}>
                    <View
                      style={[
                        styles.findingAccent,
                        { backgroundColor: SEVERITY_COLORS[severity] || colors.slate500 },
                      ]}
                    />
                    <View style={styles.findingContent}>
                      <Text style={styles.findingDescription}>
                        {finding.description}
                      </Text>
                      <View style={styles.findingMetaRow}>
                        <Text style={styles.findingRoom}>{finding.roomName}</Text>
                        {finding.source === "manual_note" && (
                          <View style={styles.noteBadge}>
                            <Text style={styles.noteBadgeText}>NOTE</Text>
                          </View>
                        )}
                      </View>
                      {finding.source === "manual_note" && (
                        <TouchableOpacity
                          style={styles.deleteNoteButton}
                          onPress={() => handleDeleteNote(finding)}
                          disabled={deletingId === finding.id}
                        >
                          <Text style={styles.deleteNoteButtonText}>
                            {deletingId === finding.id ? "Deleting..." : "Delete Note"}
                          </Text>
                        </TouchableOpacity>
                      )}
                    </View>
                  </View>
                ))}
              </View>
            ))}
          </View>
        ) : (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Findings</Text>
            <View style={styles.emptyFindings}>
              <Text style={styles.emptyIcon}>--</Text>
              <Text style={styles.emptyText}>
                {hasData ? "No findings confirmed" : "No findings recorded"}
              </Text>
            </View>
          </View>
        )}
      </ScrollView>

      <View style={styles.footer}>
        <TouchableOpacity
          style={styles.completeButton}
          onPress={() => navigation.popToTop()}
          activeOpacity={0.8}
        >
          <Text style={styles.completeButtonText}>Done</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  loadingState: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    padding: 24,
    gap: 12,
  },
  loadingText: {
    color: colors.muted,
    fontSize: 14,
    fontWeight: "500",
  },
  errorTitle: {
    color: colors.heading,
    fontSize: 18,
    fontWeight: "600",
    textAlign: "center",
  },
  errorBody: {
    color: colors.error,
    fontSize: 14,
    fontWeight: "500",
    textAlign: "center",
    marginBottom: 12,
  },
  content: {
    padding: 20,
    paddingTop: 32,
    paddingBottom: 20,
  },
  title: {
    fontSize: 28,
    fontWeight: "600",
    color: colors.heading,
    marginBottom: 10,
    letterSpacing: -0.5,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    marginBottom: 24,
  },
  modeBadge: {
    backgroundColor: "rgba(77, 166, 255, 0.1)",
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "rgba(77, 166, 255, 0.15)",
  },
  modeText: {
    color: colors.primary,
    fontSize: 13,
    fontWeight: "600",
    letterSpacing: 0.3,
  },
  durationText: {
    color: colors.slate600,
    fontSize: 13,
    fontWeight: "500",
  },

  // Score
  scoreCard: {
    backgroundColor: colors.card,
    borderRadius: 20,
    padding: 28,
    alignItems: "center",
    marginBottom: 24,
    borderWidth: 1,
    borderColor: colors.stone,
  },
  scoreLabel: {
    color: colors.muted,
    fontSize: 12,
    fontWeight: "600",
    letterSpacing: 1,
    marginBottom: 8,
  },
  scoreValue: {
    fontSize: 56,
    fontWeight: "600",
  },
  scoreSubtext: {
    color: colors.slate600,
    fontSize: 14,
    marginTop: 4,
    fontWeight: "500",
  },
  scoreBarContainer: {
    width: "100%",
    marginTop: 16,
  },
  scoreBar: {
    height: 6,
    backgroundColor: "rgba(255,255,255,0.06)",
    borderRadius: 3,
    overflow: "hidden",
  },
  scoreBarFill: {
    height: "100%",
    borderRadius: 3,
  },

  // Sections
  section: {
    marginBottom: 24,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: "600",
    color: colors.heading,
    marginBottom: 14,
    letterSpacing: -0.2,
  },

  // Stats Grid
  statsGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
  },
  statItem: {
    flex: 1,
    minWidth: "45%",
    backgroundColor: colors.card,
    borderRadius: 14,
    padding: 16,
    borderWidth: 1,
    borderColor: colors.stone,
  },
  statItemLabel: {
    color: colors.muted,
    fontSize: 12,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: 6,
  },
  statItemValue: {
    color: colors.heading,
    fontSize: 20,
    fontWeight: "600",
  },

  // Room Details
  roomCard: {
    backgroundColor: colors.card,
    borderRadius: 14,
    padding: 16,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: colors.stone,
  },
  roomHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 10,
  },
  roomName: {
    fontSize: 16,
    fontWeight: "600",
    color: colors.heading,
    flex: 1,
  },
  roomScoreBadge: {
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderRadius: 8,
    borderWidth: 1,
  },
  roomScore: {
    fontSize: 16,
    fontWeight: "600",
  },
  roomStats: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginBottom: 10,
  },
  roomStat: {
    color: colors.slate600,
    fontSize: 12,
    fontWeight: "500",
  },
  roomStatDivider: {
    color: colors.stone,
    fontSize: 12,
  },
  roomFindingsStat: {
    color: colors.primary,
    fontWeight: "600",
  },
  roomCoverageBar: {
    height: 4,
    backgroundColor: "rgba(255,255,255,0.06)",
    borderRadius: 2,
    overflow: "hidden",
  },
  roomCoverageFill: {
    height: "100%",
    borderRadius: 2,
  },

  // Findings
  severityGroup: {
    marginBottom: 18,
  },
  severityHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginBottom: 10,
  },
  severityDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  severityLabel: {
    color: colors.heading,
    fontSize: 15,
    fontWeight: "600",
    flex: 1,
    letterSpacing: -0.2,
  },
  severityCountBadge: {
    backgroundColor: "rgba(107, 114, 128, 0.08)",
    paddingHorizontal: 10,
    paddingVertical: 3,
    borderRadius: 6,
  },
  severityCount: {
    color: colors.muted,
    fontSize: 13,
    fontWeight: "600",
  },
  findingRow: {
    backgroundColor: colors.card,
    borderRadius: 12,
    marginBottom: 8,
    marginLeft: 18,
    overflow: "hidden",
    flexDirection: "row",
    borderWidth: 1,
    borderColor: colors.stone,
  },
  findingAccent: {
    width: 4,
  },
  findingContent: {
    flex: 1,
    padding: 14,
  },
  findingMetaRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  findingDescription: {
    color: colors.foreground,
    fontSize: 14,
    lineHeight: 20,
    marginBottom: 4,
    fontWeight: "500",
  },
  findingRoom: {
    color: colors.slate600,
    fontSize: 12,
    fontWeight: "500",
  },
  noteBadge: {
    backgroundColor: "rgba(77,166,255,0.12)",
    borderWidth: 1,
    borderColor: "rgba(77,166,255,0.28)",
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  noteBadgeText: {
    color: colors.primary,
    fontSize: 10,
    fontWeight: "700",
    letterSpacing: 0.6,
  },
  deleteNoteButton: {
    marginTop: 8,
    alignSelf: "flex-start",
    borderWidth: 1,
    borderColor: "rgba(239,68,68,0.28)",
    backgroundColor: "rgba(239,68,68,0.08)",
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  deleteNoteButtonText: {
    color: colors.error,
    fontSize: 12,
    fontWeight: "600",
  },
  emptyFindings: {
    backgroundColor: colors.card,
    borderRadius: 16,
    padding: 32,
    alignItems: "center",
    borderWidth: 1,
    borderColor: colors.stone,
  },
  emptyIcon: {
    fontSize: 24,
    color: colors.slate700,
    marginBottom: 8,
  },
  emptyText: {
    color: colors.slate600,
    fontSize: 15,
    fontWeight: "500",
  },

  // Footer
  footer: {
    padding: 20,
    paddingBottom: 32,
  },
  completeButton: {
    backgroundColor: colors.primary,
    borderRadius: 16,
    paddingVertical: 18,
    alignItems: "center",
    shadowColor: colors.primary,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 12,
    elevation: 8,
  },
  completeButtonText: {
    color: colors.primaryForeground,
    fontSize: 18,
    fontWeight: "600",
    letterSpacing: 0.3,
  },
});

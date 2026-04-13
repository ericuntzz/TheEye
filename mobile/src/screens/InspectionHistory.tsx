import React, { useCallback, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  RefreshControl,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useFocusEffect, useNavigation, useRoute } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import type { RouteProp } from "@react-navigation/native";
import type { RootStackParamList } from "../navigation";
import { getInspections } from "../lib/api";
import { colors, radius, fontSize, spacing } from "../lib/tokens";

type Nav = NativeStackNavigationProp<RootStackParamList, "InspectionHistory">;
type ScreenRoute = RouteProp<RootStackParamList, "InspectionHistory">;

interface InspectionItem {
  id: string;
  propertyId: string;
  status: string;
  inspectionMode: string;
  completionTier: string | null;
  readinessScore: number | null;
  startedAt: string;
  completedAt: string | null;
}

const MODE_LABELS: Record<string, string> = {
  turnover: "Turnover",
  maintenance: "Maintenance",
  owner_arrival: "Owner Arrival",
  vacancy_check: "Vacancy Check",
};

function formatDate(value: string | null): string {
  if (!value) return "In progress";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown date";
  return date.toLocaleString();
}

export default function InspectionHistoryScreen() {
  const navigation = useNavigation<Nav>();
  const route = useRoute<ScreenRoute>();
  const { propertyId, propertyName } = route.params;

  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [items, setItems] = useState<InspectionItem[]>([]);
  const [error, setError] = useState<string | null>(null);

  const loadHistory = useCallback(async (isBackgroundRefresh = false) => {
    try {
      setError(null);
      // Only show full-screen spinner on initial load, not on re-focus
      if (!isBackgroundRefresh) setLoading(true);
      const inspections: InspectionItem[] = await getInspections({
        propertyId,
        limit: 50,
      });
      setItems(inspections);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load inspection history");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [propertyId]);

  const hasLoadedOnce = useRef(false);

  useFocusEffect(
    useCallback(() => {
      // First mount: full-screen spinner. Re-focus: silent background refresh.
      const isBackground = hasLoadedOnce.current;
      hasLoadedOnce.current = true;
      void loadHistory(isBackground);
    }, [loadHistory]),
  );

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <View style={styles.header}>
        <TouchableOpacity
          style={styles.backButton}
          onPress={() => navigation.goBack()}
          activeOpacity={0.7}
        >
          <Text style={styles.backText}>{"<"} Back</Text>
        </TouchableOpacity>
      </View>

      <Text style={styles.title}>Inspection Details</Text>
      <Text style={styles.subtitle}>
        {propertyName ? `${propertyName} history` : "Property inspection history"}
      </Text>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      ) : error ? (
        <View style={styles.errorCard}>
          <Text style={styles.errorText}>{error}</Text>
          <TouchableOpacity style={styles.retryButton} onPress={() => void loadHistory()}>
            <Text style={styles.retryText}>Retry</Text>
          </TouchableOpacity>
        </View>
      ) : items.length === 0 ? (
        <View style={styles.emptyCard}>
          <Text style={styles.emptyTitle}>No inspections yet</Text>
          <Text style={styles.emptyText}>
            Run your first inspection, then details will appear here.
          </Text>
        </View>
      ) : (
        <FlatList
          data={items}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.list}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => { setRefreshing(true); void loadHistory(); }}
              tintColor={colors.primary}
            />
          }
          renderItem={({ item }) => {
            const scoreLabel =
              typeof item.readinessScore === "number"
                ? `${Math.round(item.readinessScore)}`
                : "--";
            return (
              <TouchableOpacity
                style={styles.card}
                activeOpacity={0.75}
                onPress={() =>
                  navigation.navigate("InspectionSummary", {
                    inspectionId: item.id,
                    propertyId: item.propertyId,
                  })
                }
              >
                <View style={styles.cardHeader}>
                  <Text style={styles.modeText}>
                    {MODE_LABELS[item.inspectionMode] || item.inspectionMode}
                  </Text>
                  <View
                    style={[
                      styles.statusBadge,
                      item.status === "completed" ? styles.statusCompleted : styles.statusActive,
                    ]}
                  >
                    <Text
                      style={[
                        styles.statusText,
                        item.status === "completed"
                          ? styles.statusTextCompleted
                          : styles.statusTextActive,
                      ]}
                    >
                      {item.status}
                    </Text>
                  </View>
                </View>

                <View style={styles.metaRow}>
                  <Text style={styles.metaLabel}>Score</Text>
                  <Text style={styles.metaValue}>{scoreLabel}</Text>
                </View>
                <View style={styles.metaRow}>
                  <Text style={styles.metaLabel}>Completed</Text>
                  <Text style={styles.metaValue}>{formatDate(item.completedAt)}</Text>
                </View>
              </TouchableOpacity>
            );
          }}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
    paddingHorizontal: spacing.screen,
  },
  header: {
    paddingTop: spacing.tight,
  },
  backButton: {
    alignSelf: "flex-start",
    paddingVertical: spacing.tight,
    paddingRight: spacing.element,
  },
  backText: {
    color: colors.muted,
    fontSize: fontSize.bodyLg,
    fontWeight: "500",
  },
  title: {
    color: colors.heading,
    fontSize: fontSize.pageTitle,
    fontWeight: "600",
    letterSpacing: -0.4,
    marginTop: spacing.sm,
  },
  subtitle: {
    color: colors.muted,
    fontSize: fontSize.label,
    fontWeight: "500",
    marginTop: spacing.xs,
    marginBottom: spacing.container,
  },
  center: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
  },
  list: {
    gap: spacing.element,
    paddingBottom: spacing.safe,
  },
  card: {
    backgroundColor: colors.card,
    borderRadius: radius.xl,
    borderWidth: 1,
    borderColor: colors.stone,
    padding: spacing.card,
    gap: spacing.sm,
  },
  cardHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  modeText: {
    color: colors.heading,
    fontSize: fontSize.bodyLg,
    fontWeight: "600",
  },
  statusBadge: {
    borderRadius: radius.full,
    paddingHorizontal: spacing.element,
    paddingVertical: spacing.xs,
    borderWidth: 1,
  },
  statusCompleted: {
    backgroundColor: colors.successBg,
    borderColor: colors.successBorder,
  },
  statusActive: {
    backgroundColor: colors.primaryBgStrong,
    borderColor: colors.primaryBorder,
  },
  statusText: {
    fontSize: fontSize.caption,
    fontWeight: "600",
    textTransform: "capitalize",
  },
  statusTextCompleted: {
    color: colors.success,
  },
  statusTextActive: {
    color: colors.primary,
  },
  metaRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  metaLabel: {
    color: colors.muted,
    fontSize: fontSize.sm,
    fontWeight: "500",
  },
  metaValue: {
    color: colors.foreground,
    fontSize: fontSize.sm,
    fontWeight: "600",
  },
  errorCard: {
    backgroundColor: colors.errorBg,
    borderWidth: 1,
    borderColor: colors.errorBorder,
    borderRadius: radius.xl,
    padding: spacing.card,
    gap: spacing.element,
  },
  errorText: {
    color: colors.error,
    fontSize: fontSize.label,
    fontWeight: "500",
  },
  retryButton: {
    alignSelf: "flex-start",
    backgroundColor: colors.error,
    borderRadius: radius.md,
    paddingHorizontal: spacing.content,
    paddingVertical: spacing.sm,
  },
  retryText: {
    color: colors.primaryForeground,
    fontSize: fontSize.sm,
    fontWeight: "600",
  },
  emptyCard: {
    backgroundColor: colors.card,
    borderRadius: radius.xl,
    borderWidth: 1,
    borderColor: colors.stone,
    padding: spacing.md,
    gap: spacing.tight,
  },
  emptyTitle: {
    color: colors.heading,
    fontSize: fontSize.bodyLg,
    fontWeight: "600",
  },
  emptyText: {
    color: colors.muted,
    fontSize: fontSize.label,
    fontWeight: "500",
  },
});

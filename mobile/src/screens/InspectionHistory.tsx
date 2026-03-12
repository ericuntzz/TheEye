import React, { useCallback, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
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
import { colors } from "../lib/tokens";

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
  const [items, setItems] = useState<InspectionItem[]>([]);
  const [error, setError] = useState<string | null>(null);

  const loadHistory = useCallback(async () => {
    try {
      setError(null);
      setLoading(true);
      const inspections: InspectionItem[] = await getInspections({
        propertyId,
        limit: 50,
      });
      setItems(inspections);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load inspection history");
    } finally {
      setLoading(false);
    }
  }, [propertyId]);

  useFocusEffect(
    useCallback(() => {
      void loadHistory();
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
    paddingHorizontal: 20,
  },
  header: {
    paddingTop: 6,
  },
  backButton: {
    alignSelf: "flex-start",
    paddingVertical: 6,
    paddingRight: 10,
  },
  backText: {
    color: colors.muted,
    fontSize: 16,
    fontWeight: "500",
  },
  title: {
    color: colors.heading,
    fontSize: 28,
    fontWeight: "600",
    letterSpacing: -0.4,
    marginTop: 8,
  },
  subtitle: {
    color: colors.muted,
    fontSize: 14,
    fontWeight: "500",
    marginTop: 4,
    marginBottom: 18,
  },
  center: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
  },
  list: {
    gap: 10,
    paddingBottom: 40,
  },
  card: {
    backgroundColor: colors.card,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.stone,
    padding: 14,
    gap: 8,
  },
  cardHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  modeText: {
    color: colors.heading,
    fontSize: 16,
    fontWeight: "600",
  },
  statusBadge: {
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderWidth: 1,
  },
  statusCompleted: {
    backgroundColor: "rgba(74, 222, 128, 0.12)",
    borderColor: "rgba(74, 222, 128, 0.28)",
  },
  statusActive: {
    backgroundColor: "rgba(77, 166, 255, 0.12)",
    borderColor: "rgba(77, 166, 255, 0.28)",
  },
  statusText: {
    fontSize: 12,
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
    fontSize: 13,
    fontWeight: "500",
  },
  metaValue: {
    color: colors.foreground,
    fontSize: 13,
    fontWeight: "600",
  },
  errorCard: {
    backgroundColor: "rgba(239, 68, 68, 0.08)",
    borderWidth: 1,
    borderColor: "rgba(239, 68, 68, 0.25)",
    borderRadius: 14,
    padding: 14,
    gap: 10,
  },
  errorText: {
    color: colors.error,
    fontSize: 14,
    fontWeight: "500",
  },
  retryButton: {
    alignSelf: "flex-start",
    backgroundColor: colors.error,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  retryText: {
    color: colors.primaryForeground,
    fontSize: 13,
    fontWeight: "600",
  },
  emptyCard: {
    backgroundColor: colors.card,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.stone,
    padding: 16,
    gap: 6,
  },
  emptyTitle: {
    color: colors.heading,
    fontSize: 16,
    fontWeight: "600",
  },
  emptyText: {
    color: colors.muted,
    fontSize: 14,
    fontWeight: "500",
  },
});

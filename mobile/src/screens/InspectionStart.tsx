import React, { useState } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useNavigation, useRoute } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import type { RouteProp } from "@react-navigation/native";
import { createInspection } from "../lib/api";
import type { RootStackParamList, InspectionMode } from "../navigation";
import { colors, radius, shadows } from '../lib/tokens';
import DevicePicker from "../components/DevicePicker";
import type { ImageSourceType } from "../lib/image-source/types";

type Nav = NativeStackNavigationProp<RootStackParamList, "InspectionStart">;
type Route = RouteProp<RootStackParamList, "InspectionStart">;

const MODES: {
  key: InspectionMode;
  label: string;
  description: string;
  icon: string;
  color: string;
}[] = [
  {
    key: "turnover",
    label: "Turnover",
    description: "Post-checkout inspection. Optimized for damage detection and claims evidence.",
    icon: "T",
    color: colors.primary,
  },
  {
    key: "maintenance",
    label: "Maintenance",
    description: "Issue-specific inspection. Focus on repairs and known problems.",
    icon: "M",
    color: colors.warning,
  },
  {
    key: "owner_arrival",
    label: "Owner Arrival",
    description: "Premium readiness check. Elevated presentation and staging standards.",
    icon: "O",
    color: colors.purple,
  },
  {
    key: "vacancy_check",
    label: "Vacancy Check",
    description: "Monitor empty property. High tolerance for dust and minor environmental wear.",
    icon: "V",
    color: colors.cyan,
  },
];

export default function InspectionStartScreen() {
  const navigation = useNavigation<Nav>();
  const route = useRoute<Route>();
  const { propertyId } = route.params;

  const [selectedMode, setSelectedMode] = useState<InspectionMode>("turnover");
  const [selectedSource, setSelectedSource] = useState<ImageSourceType>("camera");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleStart = async () => {
    setLoading(true);
    setError(null);

    try {
      const inspection = await createInspection(propertyId, selectedMode);
      navigation.replace("InspectionCamera", {
        inspectionId: inspection.id,
        propertyId,
        inspectionMode: selectedMode,
        imageSource: selectedSource,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start inspection");
      setLoading(false);
    }
  };

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      {/* Back button */}
      <TouchableOpacity
        style={styles.backButton}
        onPress={() => navigation.goBack()}
        activeOpacity={0.7}
      >
        <Text style={styles.backButtonText}>{"<"} Back</Text>
      </TouchableOpacity>

      <Text style={styles.title}>Start Inspection</Text>
      <Text style={styles.subtitle}>Select inspection mode</Text>

      <DevicePicker selected={selectedSource} onSelect={setSelectedSource} />

      {error && (
        <View style={styles.errorContainer}>
          <Text style={styles.errorText}>{error}</Text>
          <TouchableOpacity
            onPress={() =>
              navigation.navigate("ReportIssue", {
                prefillError: error,
                prefillScreen: "InspectionStart",
              })
            }
            style={{ marginTop: 8 }}
          >
            <Text style={styles.errorReportLink}>Report this issue</Text>
          </TouchableOpacity>
        </View>
      )}

      <View style={styles.modes}>
        {MODES.map((mode) => {
          const isSelected = selectedMode === mode.key;
          return (
            <TouchableOpacity
              key={mode.key}
              style={[
                styles.modeCard,
                isSelected && [
                  styles.modeCardSelected,
                  { borderColor: mode.color },
                ],
              ]}
              onPress={() => setSelectedMode(mode.key)}
              activeOpacity={0.7}
            >
              <View style={styles.modeCardInner}>
                {/* Mode icon */}
                <View
                  style={[
                    styles.modeIcon,
                    {
                      backgroundColor: isSelected
                        ? `${mode.color}18`
                        : "rgba(148, 163, 184, 0.06)",
                      borderColor: isSelected
                        ? `${mode.color}40`
                        : "rgba(148, 163, 184, 0.1)",
                    },
                  ]}
                >
                  <Text
                    style={[
                      styles.modeIconText,
                      { color: isSelected ? mode.color : colors.muted },
                    ]}
                  >
                    {mode.icon}
                  </Text>
                </View>

                {/* Mode content */}
                <View style={styles.modeContent}>
                  <Text
                    style={[
                      styles.modeLabel,
                      isSelected && { color: mode.color },
                    ]}
                  >
                    {mode.label}
                  </Text>
                  <Text style={styles.modeDescription}>{mode.description}</Text>
                </View>

                {/* Selection indicator */}
                <View
                  style={[
                    styles.radioOuter,
                    isSelected && { borderColor: mode.color },
                  ]}
                >
                  {isSelected && (
                    <View
                      style={[
                        styles.radioInner,
                        { backgroundColor: mode.color },
                      ]}
                    />
                  )}
                </View>
              </View>
            </TouchableOpacity>
          );
        })}
      </View>

      <TouchableOpacity
        style={[styles.startButton, loading && styles.startButtonDisabled]}
        onPress={handleStart}
        disabled={loading}
        activeOpacity={0.8}
      >
        {loading ? (
          <ActivityIndicator color={colors.primaryForeground} />
        ) : (
          <Text style={styles.startButtonText}>Begin Inspection</Text>
        )}
      </TouchableOpacity>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
    paddingHorizontal: 20,
    paddingTop: 8,
  },
  backButton: {
    marginBottom: 20,
    alignSelf: "flex-start",
    paddingVertical: 4,
    paddingRight: 8,
  },
  backButtonText: {
    color: colors.muted,
    fontSize: 16,
    fontWeight: "500",
  },
  title: {
    fontSize: 30,
    fontWeight: "600",
    color: colors.heading,
    marginBottom: 4,
    letterSpacing: -0.5,
  },
  subtitle: {
    fontSize: 15,
    color: colors.muted,
    marginBottom: 24,
    fontWeight: "500",
  },
  errorContainer: {
    backgroundColor: "rgba(239, 68, 68, 0.1)",
    borderWidth: 1,
    borderColor: "rgba(239, 68, 68, 0.25)",
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
    marginBottom: 16,
  },
  errorText: {
    color: colors.error,
    fontSize: 14,
    fontWeight: "500",
  },
  errorReportLink: {
    color: colors.error,
    fontSize: 13,
    fontWeight: "600",
    textDecorationLine: "underline" as const,
  },
  modes: {
    gap: 10,
    flex: 1,
  },
  modeCard: {
    backgroundColor: colors.card,
    borderRadius: 16,
    padding: 18,
    borderWidth: 2,
    borderColor: colors.stone,
  },
  modeCardSelected: {
    backgroundColor: "rgba(77, 166, 255, 0.04)",
  },
  modeCardInner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
  },
  modeIcon: {
    width: 44,
    height: 44,
    borderRadius: 12,
    justifyContent: "center",
    alignItems: "center",
    borderWidth: 1,
  },
  modeIconText: {
    fontSize: 18,
    fontWeight: "600",
  },
  modeContent: {
    flex: 1,
  },
  modeLabel: {
    fontSize: 17,
    fontWeight: "600",
    color: colors.heading,
    marginBottom: 4,
    letterSpacing: -0.2,
  },
  modeDescription: {
    fontSize: 13,
    color: colors.muted,
    lineHeight: 18,
  },
  radioOuter: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 2,
    borderColor: colors.slate700,
    justifyContent: "center",
    alignItems: "center",
    marginLeft: 4,
  },
  radioInner: {
    width: 12,
    height: 12,
    borderRadius: 6,
  },
  startButton: {
    backgroundColor: colors.primary,
    borderRadius: 16,
    paddingVertical: 18,
    alignItems: "center",
    marginBottom: 40,
    marginTop: 20,
    shadowColor: colors.primary,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 12,
    elevation: 8,
  },
  startButtonDisabled: {
    opacity: 0.6,
    shadowOpacity: 0,
  },
  startButtonText: {
    color: colors.primaryForeground,
    fontSize: 18,
    fontWeight: "600",
    letterSpacing: 0.3,
  },
});

import React, { useState, useRef } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  ScrollView,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useNavigation, useRoute } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import type { RouteProp } from "@react-navigation/native";
import { createInspection } from "../lib/api";
import type { RootStackParamList, InspectionMode } from "../navigation";
import { colors, radius, shadows, fontSize, spacing } from '../lib/tokens';
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
  const startingRef = useRef(false);

  const handleStart = async () => {
    if (startingRef.current) return;
    startingRef.current = true;
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
    } finally {
      setLoading(false);
      startingRef.current = false;
    }
  };

  return (
    <SafeAreaView style={styles.container} edges={["top", "bottom"]}>
      {/* Back button */}
      <TouchableOpacity
        style={styles.backButton}
        onPress={() => navigation.goBack()}
        activeOpacity={0.7}
        accessibilityRole="button"
        accessibilityLabel="Go back to property"
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
            style={{ marginTop: spacing.sm }}
          >
            <Text style={styles.errorReportLink}>Report this issue</Text>
          </TouchableOpacity>
        </View>
      )}

      <ScrollView style={styles.modes} contentContainerStyle={styles.modesContent} showsVerticalScrollIndicator={false}>
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
              accessibilityRole="radio"
              accessibilityState={{ selected: isSelected }}
              accessibilityLabel={`${mode.label}: ${mode.description}`}
            >
              <View style={styles.modeCardInner}>
                {/* Mode icon */}
                <View
                  style={[
                    styles.modeIcon,
                    {
                      backgroundColor: isSelected
                        ? `${mode.color}18`
                        : colors.secondary,
                      borderColor: isSelected
                        ? `${mode.color}40`
                        : colors.cardBorder,
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
      </ScrollView>

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
    paddingHorizontal: spacing.screen,
    paddingTop: spacing.sm,
  },
  backButton: {
    marginBottom: spacing.screen,
    alignSelf: "flex-start",
    paddingVertical: spacing.element,
    paddingRight: spacing.md,
    minHeight: 44,
  },
  backButtonText: {
    color: colors.muted,
    fontSize: fontSize.bodyLg,
    fontWeight: "500",
  },
  title: {
    fontSize: fontSize.screenTitle,
    fontWeight: "600",
    color: colors.heading,
    marginBottom: spacing.xs,
    letterSpacing: -0.5,
  },
  subtitle: {
    fontSize: fontSize.body,
    color: colors.muted,
    marginBottom: spacing.lg,
    fontWeight: "500",
  },
  errorContainer: {
    backgroundColor: colors.errorBg,
    borderWidth: 1,
    borderColor: colors.errorBorder,
    borderRadius: radius.lg,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.content,
    marginBottom: spacing.md,
  },
  errorText: {
    color: colors.error,
    fontSize: fontSize.label,
    fontWeight: "500",
  },
  errorReportLink: {
    color: colors.error,
    fontSize: fontSize.sm,
    fontWeight: "600",
    textDecorationLine: "underline" as const,
  },
  modes: {
    flex: 1,
  },
  modesContent: {
    gap: spacing.element,
    paddingBottom: spacing.sm,
  },
  modeCard: {
    backgroundColor: colors.card,
    borderRadius: radius.xl,
    padding: spacing.container,
    borderWidth: 2,
    borderColor: colors.stone,
  },
  modeCardSelected: {
    backgroundColor: colors.primaryBg,
  },
  modeCardInner: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.card,
  },
  modeIcon: {
    width: 44,
    height: 44,
    borderRadius: radius.lg,
    justifyContent: "center",
    alignItems: "center",
    borderWidth: 1,
  },
  modeIconText: {
    fontSize: fontSize.h3,
    fontWeight: "600",
  },
  modeContent: {
    flex: 1,
  },
  modeLabel: {
    fontSize: fontSize.button,
    fontWeight: "600",
    color: colors.heading,
    marginBottom: spacing.xs,
    letterSpacing: -0.2,
  },
  modeDescription: {
    fontSize: fontSize.sm,
    color: colors.muted,
    lineHeight: 18,
  },
  radioOuter: {
    width: 22,
    height: 22,
    borderRadius: radius.full,
    borderWidth: 2,
    borderColor: colors.slate700,
    justifyContent: "center",
    alignItems: "center",
    marginLeft: spacing.xs,
  },
  radioInner: {
    width: 12,
    height: 12,
    borderRadius: radius.full,
  },
  startButton: {
    backgroundColor: colors.primary,
    borderRadius: radius.xl,
    paddingVertical: spacing.container,
    alignItems: "center",
    marginBottom: spacing.safe,
    marginTop: spacing.screen,
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
    fontSize: fontSize.h3,
    fontWeight: "600",
    letterSpacing: 0.3,
  },
});

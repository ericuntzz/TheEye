import React, { useState, useEffect, useRef } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useNavigation, useRoute } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import type { RouteProp } from "@react-navigation/native";
import type { RootStackParamList } from "../navigation";
import { supabase } from "../lib/supabase";
import { submitSupportTicket } from "../lib/api";
import { colors, radius, shadows, fontSize, spacing } from "../lib/tokens";

type Nav = NativeStackNavigationProp<RootStackParamList, "ReportIssue">;
type Route = RouteProp<RootStackParamList, "ReportIssue">;

type Category = "bug" | "feature_request" | "other";

const CATEGORIES: { key: Category; label: string }[] = [
  { key: "bug", label: "Bug" },
  { key: "feature_request", label: "Feature" },
  { key: "other", label: "Other" },
];

export default function ReportIssueScreen() {
  const navigation = useNavigation<Nav>();
  const route = useRoute<Route>();
  const prefillError = route.params?.prefillError;
  const prefillScreen = route.params?.prefillScreen;
  const successTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      if (successTimerRef.current) clearTimeout(successTimerRef.current);
    };
  }, []);

  const [category, setCategory] = useState<Category>("bug");
  const [description, setDescription] = useState(prefillError || "");
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session?.user?.email) {
        setEmail(session.user.email);
      }
    });
  }, []);

  const canSubmit = description.trim().length >= 10 && !submitting;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);

    try {
      const title =
        category === "bug"
          ? `Bug report: ${description.trim().slice(0, 80)}`
          : category === "feature_request"
            ? `Feature request: ${description.trim().slice(0, 80)}`
            : `Feedback: ${description.trim().slice(0, 80)}`;

      await submitSupportTicket({
        title,
        description: description.trim(),
        category,
        screen: prefillScreen,
        prefillError,
      });

      setSuccess(true);
      successTimerRef.current = setTimeout(() => {
        navigation.goBack();
      }, 1500);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Failed to submit report. Please try again.",
      );
    } finally {
      setSubmitting(false);
    }
  };

  if (success) {
    return (
      <SafeAreaView style={styles.container} edges={["top"]}>
        <View style={styles.successContainer}>
          <View style={styles.successCircle}>
            <Text style={styles.successCheck}>✓</Text>
          </View>
          <Text style={styles.successTitle}>Report Submitted</Text>
          <Text style={styles.successSubtitle}>
            Thanks for letting us know. We will look into this.
          </Text>
          <TouchableOpacity
            style={[styles.submitButton, { marginTop: spacing.lg, paddingHorizontal: spacing.safe }]}
            onPress={() => navigation.goBack()}
            activeOpacity={0.8}
          >
            <Text style={styles.submitButtonText}>Done</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity
          style={styles.backButton}
          onPress={() => navigation.goBack()}
          activeOpacity={0.7}
        >
          <Text style={styles.backButtonText}>{"\u2039"} Back</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Report Issue</Text>
        <View style={styles.backButton} />
      </View>

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
      >
        <ScrollView
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
        >
          {/* Error */}
          {error && (
            <View style={styles.errorContainer}>
              <Text style={styles.errorText}>{error}</Text>
            </View>
          )}

          {/* Category Selector */}
          <Text style={styles.sectionLabel}>Category</Text>
          <View style={styles.categoryRow}>
            {CATEGORIES.map((cat) => (
              <TouchableOpacity
                key={cat.key}
                style={[
                  styles.categoryPill,
                  category === cat.key && styles.categoryPillActive,
                ]}
                onPress={() => setCategory(cat.key)}
                activeOpacity={0.7}
              >
                <Text
                  style={[
                    styles.categoryPillText,
                    category === cat.key && styles.categoryPillTextActive,
                  ]}
                >
                  {cat.label}
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          {/* Description */}
          <Text style={styles.sectionLabel}>Description</Text>
          <View style={styles.inputCard}>
            <TextInput
              style={styles.textInput}
              placeholder="Describe the issue or suggestion..."
              placeholderTextColor={colors.muted}
              value={description}
              onChangeText={setDescription}
              multiline
              numberOfLines={6}
              textAlignVertical="top"
              autoFocus={!prefillError}
            />
          </View>
          {description.trim().length > 0 && description.trim().length < 10 && (
            <Text style={styles.charHint}>
              {10 - description.trim().length} more characters needed
            </Text>
          )}

          {/* Info Card */}
          <View style={styles.infoCard}>
            <Text style={styles.infoTitle}>INCLUDED WITH THIS REPORT</Text>
            <Text style={styles.infoText}>
              {email ? `Account: ${email}` : "Account info"}
              {"\n"}
              Device: {Platform.OS} {Platform.Version}
              {"\n"}
              App version: 1.0.0
            </Text>
          </View>

          {/* Submit */}
          <TouchableOpacity
            style={[styles.submitButton, !canSubmit && styles.submitButtonDisabled]}
            onPress={handleSubmit}
            disabled={!canSubmit}
            activeOpacity={0.8}
          >
            {submitting ? (
              <ActivityIndicator color={colors.primaryForeground} />
            ) : (
              <Text style={styles.submitButtonText}>Submit Report</Text>
            )}
          </TouchableOpacity>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },

  // Header
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: spacing.screen,
    paddingVertical: spacing.content,
  },
  backButton: {
    minWidth: 60,
  },
  backButtonText: {
    color: colors.muted,
    fontSize: fontSize.bodyLg,
    fontWeight: "500",
  },
  headerTitle: {
    fontSize: fontSize.button,
    fontWeight: "600",
    color: colors.heading,
  },

  // Content
  content: {
    padding: spacing.screen,
    paddingTop: spacing.sm,
    paddingBottom: spacing.safe,
  },

  // Error
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
    textAlign: "center",
    fontSize: fontSize.label,
    fontWeight: "500",
  },

  // Section
  sectionLabel: {
    color: colors.muted,
    fontSize: fontSize.sm,
    fontWeight: "600",
    marginBottom: spacing.element,
    marginLeft: spacing.xs,
    letterSpacing: 0.3,
    textTransform: "uppercase",
  },

  // Category Pills
  categoryRow: {
    flexDirection: "row",
    gap: spacing.element,
    marginBottom: spacing.lg,
  },
  categoryPill: {
    flex: 1,
    paddingVertical: spacing.content,
    borderRadius: radius.lg,
    backgroundColor: colors.card,
    borderWidth: 1.5,
    borderColor: colors.stone,
    alignItems: "center",
  },
  categoryPillActive: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },
  categoryPillText: {
    fontSize: fontSize.label,
    fontWeight: "600",
    color: colors.muted,
  },
  categoryPillTextActive: {
    color: colors.primaryForeground,
  },

  // TextInput
  inputCard: {
    backgroundColor: colors.card,
    borderRadius: radius.xl,
    borderWidth: 1,
    borderColor: colors.stone,
    overflow: "hidden",
    marginBottom: spacing.sm,
    ...shadows.card,
  },
  textInput: {
    paddingHorizontal: spacing.container,
    paddingVertical: spacing.md,
    color: colors.foreground,
    fontSize: fontSize.body,
    minHeight: 140,
    lineHeight: 22,
  },
  charHint: {
    color: colors.muted,
    fontSize: fontSize.caption,
    marginLeft: spacing.xs,
    marginBottom: spacing.md,
  },

  // Info Card
  infoCard: {
    backgroundColor: colors.primaryBg,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.primaryBorder,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.card,
    marginTop: spacing.sm,
    marginBottom: spacing.section,
  },
  infoTitle: {
    fontSize: fontSize.caption,
    fontWeight: "600",
    color: colors.primary,
    marginBottom: spacing.tight,
    letterSpacing: 0.3,
  },
  infoText: {
    fontSize: fontSize.sm,
    color: colors.muted,
    lineHeight: 20,
  },

  // Submit
  submitButton: {
    backgroundColor: colors.primary,
    borderRadius: radius.lg,
    paddingVertical: 17,
    alignItems: "center",
    ...shadows.card,
  },
  submitButtonDisabled: {
    opacity: 0.5,
  },
  submitButtonText: {
    color: colors.primaryForeground,
    fontSize: fontSize.button,
    fontWeight: "600",
    letterSpacing: 0.3,
  },

  // Success
  successContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: spacing.safe,
  },
  successCircle: {
    width: 72,
    height: 72,
    borderRadius: radius.full,
    backgroundColor: colors.successBg,
    borderWidth: 2,
    borderColor: colors.successBorder,
    justifyContent: "center",
    alignItems: "center",
    marginBottom: spacing.screen,
  },
  successCheck: {
    color: colors.success,
    fontSize: fontSize.pageTitle,
    fontWeight: "600",
  },
  successTitle: {
    fontSize: fontSize.modalTitle,
    fontWeight: "600",
    color: colors.heading,
    marginBottom: spacing.sm,
  },
  successSubtitle: {
    fontSize: fontSize.body,
    color: colors.muted,
    textAlign: "center",
    lineHeight: 22,
  },
});

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
import { colors, radius, shadows } from "../lib/tokens";

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
            <Text style={styles.infoTitle}>Included with this report</Text>
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
    paddingHorizontal: 20,
    paddingVertical: 12,
  },
  backButton: {
    minWidth: 60,
  },
  backButtonText: {
    color: colors.muted,
    fontSize: 16,
    fontWeight: "500",
  },
  headerTitle: {
    fontSize: 17,
    fontWeight: "600",
    color: colors.heading,
  },

  // Content
  content: {
    padding: 20,
    paddingTop: 8,
    paddingBottom: 40,
  },

  // Error
  errorContainer: {
    backgroundColor: "rgba(248, 113, 113, 0.1)",
    borderWidth: 1,
    borderColor: "rgba(248, 113, 113, 0.25)",
    borderRadius: radius.lg,
    paddingHorizontal: 16,
    paddingVertical: 12,
    marginBottom: 16,
  },
  errorText: {
    color: colors.error,
    textAlign: "center",
    fontSize: 14,
    fontWeight: "500",
  },

  // Section
  sectionLabel: {
    color: colors.muted,
    fontSize: 13,
    fontWeight: "600",
    marginBottom: 10,
    marginLeft: 4,
    letterSpacing: 0.3,
    textTransform: "uppercase",
  },

  // Category Pills
  categoryRow: {
    flexDirection: "row",
    gap: 10,
    marginBottom: 24,
  },
  categoryPill: {
    flex: 1,
    paddingVertical: 12,
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
    fontSize: 14,
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
    marginBottom: 8,
    ...shadows.card,
  },
  textInput: {
    paddingHorizontal: 18,
    paddingVertical: 16,
    color: colors.foreground,
    fontSize: 15,
    minHeight: 140,
    lineHeight: 22,
  },
  charHint: {
    color: colors.muted,
    fontSize: 12,
    marginLeft: 4,
    marginBottom: 16,
  },

  // Info Card
  infoCard: {
    backgroundColor: "rgba(77, 166, 255, 0.06)",
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: "rgba(77, 166, 255, 0.15)",
    paddingHorizontal: 16,
    paddingVertical: 14,
    marginTop: 8,
    marginBottom: 28,
  },
  infoTitle: {
    fontSize: 12,
    fontWeight: "600",
    color: colors.primary,
    marginBottom: 6,
    letterSpacing: 0.3,
    textTransform: "uppercase",
  },
  infoText: {
    fontSize: 13,
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
    fontSize: 17,
    fontWeight: "600",
    letterSpacing: 0.3,
  },

  // Success
  successContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: 40,
  },
  successCircle: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: "rgba(74, 222, 128, 0.12)",
    borderWidth: 2,
    borderColor: "rgba(74, 222, 128, 0.3)",
    justifyContent: "center",
    alignItems: "center",
    marginBottom: 20,
  },
  successCheck: {
    color: colors.success,
    fontSize: 28,
    fontWeight: "600",
  },
  successTitle: {
    fontSize: 22,
    fontWeight: "600",
    color: colors.heading,
    marginBottom: 8,
  },
  successSubtitle: {
    fontSize: 15,
    color: colors.muted,
    textAlign: "center",
    lineHeight: 22,
  },
});

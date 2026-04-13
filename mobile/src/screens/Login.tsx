import React, { useState, useRef } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
} from "react-native";
import { supabase } from "../lib/supabase";
import { colors, radius, shadows, fontSize, spacing } from '../lib/tokens';
import { AtriaMark } from "../components/AtriaMark";

export default function LoginScreen() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const signingInRef = useRef(false);

  const handleLogin = async () => {
    if (signingInRef.current) return;
    signingInRef.current = true;
    setLoading(true);
    setError(null);

    const { error: authError } = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password,
    });

    if (authError) {
      setError(authError.message);
    }
    // Always reset the guard — on success, the auth listener navigates away;
    // on error, the user needs to retry. Either way, unlock the button.
    signingInRef.current = false;
    setLoading(false);
  };

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === "ios" ? "padding" : "height"}
    >
      <View style={styles.inner}>
        {/* Logo Area */}
        <View style={styles.logoArea}>
          <View style={styles.logoMark}>
            <AtriaMark size={72} color="navy" />
          </View>
          <Text style={styles.appName}>ATRIA</Text>
          <Text style={styles.tagline}>Property Intelligence Platform</Text>
        </View>

        {/* Login Form */}
        <View style={styles.formContainer}>
          {error && (
            <View style={styles.errorContainer}>
              <Text style={styles.errorText}>{error}</Text>
            </View>
          )}

          <View style={styles.inputGroup}>
            <Text style={styles.inputLabel}>Email</Text>
            <TextInput
              style={styles.input}
              placeholder="you@company.com"
              placeholderTextColor={colors.muted}
              value={email}
              onChangeText={setEmail}
              autoCapitalize="none"
              keyboardType="email-address"
              autoComplete="email"
              returnKeyType="next"
              accessibilityLabel="Email address"
            />
          </View>

          <View style={styles.inputGroup}>
            <Text style={styles.inputLabel}>Password</Text>
            <TextInput
              style={styles.input}
              placeholder="Enter your password"
              placeholderTextColor={colors.muted}
              value={password}
              onChangeText={setPassword}
              secureTextEntry
              autoComplete="password"
              returnKeyType="done"
              onSubmitEditing={handleLogin}
              accessibilityLabel="Password"
            />
          </View>

          <TouchableOpacity
            style={[styles.button, loading && styles.buttonDisabled]}
            onPress={handleLogin}
            disabled={loading}
            activeOpacity={0.8}
          >
            {loading ? (
              <ActivityIndicator color={colors.primaryForeground} />
            ) : (
              <Text style={styles.buttonText}>Sign In</Text>
            )}
          </TouchableOpacity>
        </View>

        {/* Footer */}
        <Text style={styles.version}>v1.0.0</Text>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  inner: {
    flex: 1,
    justifyContent: "center",
    paddingHorizontal: spacing.section,
  },

  // Logo
  logoArea: {
    alignItems: "center",
    marginBottom: spacing.xxl,
  },
  logoMark: {
    marginBottom: spacing.screen,
  },
  appName: {
    fontSize: fontSize.h3,
    fontWeight: "600",
    color: colors.heading,
    letterSpacing: 5,
    marginBottom: spacing.tight,
  },
  tagline: {
    fontSize: fontSize.body,
    color: colors.muted,
    fontWeight: "400",
    letterSpacing: 0.3,
  },

  // Form
  formContainer: {
    gap: spacing.xs,
  },
  errorContainer: {
    backgroundColor: colors.errorBg,
    borderWidth: 1,
    borderColor: colors.errorBorder,
    borderRadius: radius.lg,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.content,
    marginBottom: spacing.sm,
  },
  errorText: {
    color: colors.error,
    textAlign: "center",
    fontSize: fontSize.label,
    fontWeight: "500",
  },
  inputGroup: {
    marginBottom: spacing.md,
  },
  inputLabel: {
    color: colors.muted,
    fontSize: fontSize.sm,
    fontWeight: "600",
    marginBottom: spacing.sm,
    marginLeft: spacing.xs,
    letterSpacing: 0.3,
    textTransform: "uppercase",
  },
  input: {
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    paddingHorizontal: spacing.container,
    paddingVertical: spacing.md,
    color: colors.foreground,
    fontSize: fontSize.bodyLg,
    borderWidth: 1.5,
    borderColor: colors.stone,
  },
  button: {
    backgroundColor: colors.primary,
    borderRadius: radius.lg,
    paddingVertical: 17,
    alignItems: "center",
    marginTop: spacing.content,
    ...shadows.card,
  },
  buttonDisabled: {
    opacity: 0.6,
    shadowOpacity: 0,
  },
  buttonText: {
    color: colors.primaryForeground,
    fontSize: fontSize.button,
    fontWeight: "600",
    letterSpacing: 0.3,
  },

  // Footer
  version: {
    color: colors.muted,
    fontSize: fontSize.caption,
    textAlign: "center",
    marginTop: spacing.xxl,
  },
});

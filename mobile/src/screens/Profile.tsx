import React, { useEffect, useState } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Alert,
  ScrollView,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import type { RootStackParamList } from "../navigation";
import { supabase } from "../lib/supabase";
import { colors, radius, shadows, fontSize, spacing } from "../lib/tokens";

type Nav = NativeStackNavigationProp<RootStackParamList, "Profile">;

export default function ProfileScreen() {
  const navigation = useNavigation<Nav>();
  const [email, setEmail] = useState<string | null>(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setEmail(session?.user?.email || "");
    });
  }, []);

  const resolvedEmail = email ?? "";
  const initial = resolvedEmail ? resolvedEmail[0].toUpperCase() : "U";

  const handleSignOut = () => {
    Alert.alert("Sign Out", "Are you sure you want to sign out?", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Sign Out",
        style: "destructive",
        onPress: async () => {
          try {
            await supabase.auth.signOut();
          } catch (err) {
            console.error("Sign out failed:", err);
            Alert.alert("Error", "Failed to sign out. Please try again.");
          }
        },
      },
    ]);
  };

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
        <Text style={styles.headerTitle}>Profile</Text>
        <View style={styles.backButton} />
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        {/* Avatar + Email */}
        <View style={styles.avatarSection}>
          <View style={styles.avatar}>
            <Text style={styles.avatarText}>{initial}</Text>
          </View>
          <Text style={styles.email}>{email === null ? "Loading..." : resolvedEmail}</Text>
        </View>

        {/* Menu Items */}
        <View style={styles.menuCard}>
          <TouchableOpacity style={[styles.menuItem, styles.menuItemDisabled]} activeOpacity={1} disabled>
            <View style={styles.menuItemLabelRow}>
              <Text style={[styles.menuItemText, styles.menuItemTextDisabled]}>Notification Preferences</Text>
              <View style={styles.comingSoonBadge}>
                <Text style={styles.comingSoonText}>Coming Soon</Text>
              </View>
            </View>
            <Text style={[styles.menuItemArrow, { opacity: 0.3 }]}>{">"}</Text>
          </TouchableOpacity>

          <View style={styles.menuDivider} />

          <TouchableOpacity
            style={styles.menuItem}
            activeOpacity={0.7}
            onPress={() => navigation.navigate("ReportIssue")}
          >
            <Text style={styles.menuItemText}>Help & Support</Text>
            <Text style={styles.menuItemArrow}>{">"}</Text>
          </TouchableOpacity>

          <View style={styles.menuDivider} />

          <TouchableOpacity style={[styles.menuItem, styles.menuItemDisabled]} activeOpacity={1} disabled>
            <View style={styles.menuItemLabelRow}>
              <Text style={[styles.menuItemText, styles.menuItemTextDisabled]}>About Atria</Text>
              <View style={styles.comingSoonBadge}>
                <Text style={styles.comingSoonText}>Coming Soon</Text>
              </View>
            </View>
            <Text style={[styles.menuItemArrow, { opacity: 0.3 }]}>{">"}</Text>
          </TouchableOpacity>
        </View>

        {/* Sign Out */}
        <TouchableOpacity
          style={styles.signOutButton}
          onPress={handleSignOut}
          activeOpacity={0.8}
        >
          <Text style={styles.signOutText}>Sign Out</Text>
        </TouchableOpacity>

        {/* Version */}
        <Text style={styles.version}>Atria v1.0.0</Text>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
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
  content: {
    padding: spacing.screen,
    paddingTop: spacing.xl,
  },
  avatarSection: {
    alignItems: "center",
    marginBottom: spacing.safe,
  },
  avatar: {
    width: 80,
    height: 80,
    borderRadius: radius.full,
    backgroundColor: colors.heading,
    justifyContent: "center",
    alignItems: "center",
    marginBottom: spacing.md,
    ...shadows.elevated,
  },
  avatarText: {
    color: colors.primaryForeground,
    fontSize: 32,
    fontWeight: "600",
  },
  email: {
    fontSize: fontSize.bodyLg,
    color: colors.muted,
    fontWeight: "500",
  },
  menuCard: {
    backgroundColor: colors.card,
    borderRadius: radius.xl,
    borderWidth: 1,
    borderColor: colors.stone,
    overflow: "hidden",
    marginBottom: spacing.xl,
    ...shadows.card,
  },
  menuItem: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: spacing.screen,
    paddingVertical: spacing.container,
  },
  menuItemText: {
    fontSize: fontSize.bodyLg,
    fontWeight: "500",
    color: colors.foreground,
  },
  menuItemArrow: {
    fontSize: fontSize.bodyLg,
    color: colors.muted,
  },
  menuItemDisabled: {
    opacity: 0.6,
  },
  menuItemTextDisabled: {
    color: colors.muted,
  },
  menuItemLabelRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.element,
    flex: 1,
  },
  comingSoonBadge: {
    backgroundColor: colors.primaryBg,
    borderRadius: radius.full,
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
  },
  comingSoonText: {
    fontSize: fontSize.badge,
    fontWeight: "600",
    color: colors.muted,
    letterSpacing: 0.3,
    textTransform: "uppercase",
  },
  menuDivider: {
    height: 1,
    backgroundColor: colors.stone,
    marginHorizontal: spacing.screen,
    opacity: 0.5,
  },
  signOutButton: {
    backgroundColor: colors.errorBg,
    borderRadius: radius.lg,
    paddingVertical: spacing.md,
    alignItems: "center",
    borderWidth: 1,
    borderColor: colors.errorBorder,
    marginBottom: spacing.lg,
  },
  signOutText: {
    color: colors.error,
    fontSize: fontSize.bodyLg,
    fontWeight: "600",
  },
  version: {
    textAlign: "center",
    color: colors.muted,
    fontSize: fontSize.sm,
    fontWeight: "500",
  },
});

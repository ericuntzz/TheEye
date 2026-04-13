import React, { useState, useCallback, useRef, useEffect, useMemo } from "react";
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  RefreshControl,
  Platform,
  Modal,
  TextInput,
  Pressable,
  KeyboardAvoidingView,
  Alert,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useNavigation, useFocusEffect } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { getProperties, createProperty, bulkDeleteProperties } from "../lib/api";
import { supabase } from "../lib/supabase";
import type { RootStackParamList } from "../navigation";
import { colors, radius, shadows, fontSize, spacing } from '../lib/tokens';

type Nav = NativeStackNavigationProp<RootStackParamList, "Properties">;

interface Property {
  id: string;
  name: string;
  address: string | null;
  city: string | null;
  state: string | null;
  trainingStatus: string;
  coverImageUrl: string | null;
  bedrooms: number | null;
  bathrooms: number | null;
  createdAt: string;
}

type SortOption = "newest" | "name" | "ready_first" | "needs_training";

export default function PropertiesScreen() {
  const navigation = useNavigation<Nav>();
  const [properties, setProperties] = useState<Property[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [userInitial, setUserInitial] = useState("U");
  const retryCountRef = useRef(0);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const MAX_AUTO_RETRIES = 2;

  // Add Property modal
  const [showAddModal, setShowAddModal] = useState(false);
  const [newPropertyName, setNewPropertyName] = useState("");
  const [newPropertyError, setNewPropertyError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  // Selection mode
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [showSortModal, setShowSortModal] = useState(false);
  const [sortBy, setSortBy] = useState<SortOption>("newest");

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session?.user?.email) {
        setUserInitial(session.user.email[0].toUpperCase());
      }
    });
  }, []);

  const loadProperties = useCallback(async (isAutoRetry = false) => {
    try {
      setError(null);
      const data = await getProperties();
      setProperties(data);
      retryCountRef.current = 0;
    } catch (err) {
      console.error("Failed to load properties:", err);

      if (isAutoRetry || retryCountRef.current >= MAX_AUTO_RETRIES) {
        const retryHint =
          Platform.OS === "web"
            ? "Tap here to retry."
            : "Pull to refresh.";
        setError(`Failed to load properties. ${retryHint}`);
      } else {
        retryCountRef.current += 1;
        retryTimerRef.current = setTimeout(() => loadProperties(true), 1500);
        return;
      }
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      loadProperties();
      return () => {
        if (retryTimerRef.current) {
          clearTimeout(retryTimerRef.current);
          retryTimerRef.current = null;
        }
      };
    }, [loadProperties]),
  );

  const onRefresh = () => {
    setRefreshing(true);
    loadProperties();
  };

  const trainedCount = properties.filter(
    (p) => p.trainingStatus === "trained",
  ).length;

  const sortedProperties = useMemo(() => {
    const statusRank = (status: string) => {
      if (status === "trained") return 0;
      if (status === "training") return 1;
      return 2;
    };

    return [...properties].sort((a, b) => {
      if (sortBy === "name") return a.name.localeCompare(b.name);
      if (sortBy === "ready_first") return statusRank(a.trainingStatus) - statusRank(b.trainingStatus);
      if (sortBy === "needs_training") return statusRank(b.trainingStatus) - statusRank(a.trainingStatus);

      const aTime = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const bTime = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      return bTime - aTime;
    });
  }, [properties, sortBy]);

  const closeAddModal = useCallback(() => {
    setShowAddModal(false);
    setNewPropertyName("");
    setNewPropertyError(null);
  }, []);

  // ── Add Property ──────────────────────────────────────────────

  const handleCreateProperty = async () => {
    const trimmed = newPropertyName.trim();
    if (!trimmed) {
      setNewPropertyError("Property name is required.");
      return;
    }
    if (trimmed.length < 2) {
      setNewPropertyError("Property name must be at least 2 characters.");
      return;
    }
    if (trimmed.length > 120) {
      setNewPropertyError("Property name must be 120 characters or fewer.");
      return;
    }
    if (!/^[a-zA-Z0-9\s\-'.,#&()]+$/.test(trimmed)) {
      setNewPropertyError("Property name contains invalid characters.");
      return;
    }

    setCreating(true);
    setNewPropertyError(null);
    try {
      const property = await createProperty({ name: trimmed });
      setShowAddModal(false);
      setNewPropertyName("");
      setNewPropertyError(null);
      navigation.navigate("PropertyTraining", {
        propertyId: property.id,
        propertyName: property.name,
      });
    } catch (err) {
      Alert.alert(
        "Error",
        err instanceof Error ? err.message : "Failed to create property",
      );
    } finally {
      setCreating(false);
    }
  };

  // ── Selection Mode ────────────────────────────────────────────

  const toggleSelectionMode = () => {
    if (selectionMode) {
      setSelectionMode(false);
      setSelectedIds(new Set());
    } else {
      setSelectionMode(true);
    }
  };

  const toggleSelection = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const handleBulkDelete = () => {
    const count = selectedIds.size;
    if (count === 0) return;

    Alert.alert(
      "Delete Properties",
      `Are you sure you want to delete ${count} ${count === 1 ? "property" : "properties"}? This will permanently remove all associated data. This cannot be undone.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: async () => {
            setBulkDeleting(true);
            try {
              await bulkDeleteProperties(Array.from(selectedIds));
              setSelectionMode(false);
              setSelectedIds(new Set());
              loadProperties();
            } catch (err) {
              Alert.alert(
                "Error",
                err instanceof Error ? err.message : "Failed to delete properties",
              );
            } finally {
              setBulkDeleting(false);
            }
          },
        },
      ],
    );
  };

  // ── Render Property Card ──────────────────────────────────────

  const renderProperty = useCallback(({ item }: { item: Property }) => {
    const isTrained = item.trainingStatus === "trained";
    const isSelected = selectionMode && selectedIds.has(item.id);

    return (
      <TouchableOpacity
        style={[styles.card, isSelected && styles.cardSelected]}
        onPress={() => {
          if (selectionMode) {
            toggleSelection(item.id);
            return;
          }
          if (isTrained) {
            navigation.navigate("InspectionStart", { propertyId: item.id });
          } else {
            navigation.navigate("PropertyTraining", {
              propertyId: item.id,
              propertyName: item.name,
            });
          }
        }}
        onLongPress={() => {
          if (selectionMode) return;
          navigation.navigate("PropertyDetail", { propertyId: item.id });
        }}
        activeOpacity={0.7}
        accessibilityRole="button"
        accessibilityLabel={`${item.name}, ${isTrained ? "ready for inspection" : "tap to train"}${selectionMode ? (isSelected ? ", selected" : ", not selected") : ". Long press to edit."}`}
      >
        {/* Selection checkbox OR color accent bar */}
        {selectionMode ? (
          <View style={[styles.checkboxArea, isSelected && styles.checkboxAreaSelected]}>
            <View style={[styles.checkbox, isSelected && styles.checkboxChecked]}>
              {isSelected && <Text style={styles.checkmark}>✓</Text>}
            </View>
          </View>
        ) : (
          <View
            style={[
              styles.cardAccent,
              { backgroundColor: isTrained ? colors.success : colors.primary },
            ]}
          />
        )}

        <View style={styles.cardContent}>
          <View style={styles.cardHeader}>
            <View style={styles.cardTitleArea}>
              <Text style={styles.propertyName} numberOfLines={1}>
                {item.name}
              </Text>
              {item.address && (
                <Text style={styles.address} numberOfLines={1}>
                  {item.address}
                  {item.city ? `, ${item.city}` : ""}
                  {item.state ? `, ${item.state}` : ""}
                </Text>
              )}
            </View>
            {/* Edit button — hidden in selection mode */}
            {!selectionMode && (
              <TouchableOpacity
                style={styles.editButton}
                onPress={() =>
                  navigation.navigate("PropertyDetail", {
                    propertyId: item.id,
                  })
                }
                activeOpacity={0.7}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              >
                <Text style={styles.editButtonText}>Edit</Text>
              </TouchableOpacity>
            )}
          </View>

          {/* Property details row */}
          <View style={styles.detailsRow}>
            <View
              style={[
                styles.badge,
                isTrained ? styles.badgeTrained : styles.badgeUntrained,
              ]}
            >
              <View
                style={[
                  styles.badgeDot,
                  {
                    backgroundColor: isTrained ? colors.success : colors.primary,
                  },
                ]}
              />
              <Text
                style={[
                  styles.badgeText,
                  { color: isTrained ? colors.success : colors.primary },
                ]}
              >
                {isTrained ? "Ready" : "Train"}
              </Text>
            </View>
            {item.bedrooms != null && (
              <View style={styles.detailChip}>
                <Text style={styles.detailText}>{item.bedrooms} bed</Text>
              </View>
            )}
            {item.bathrooms != null && (
              <View style={styles.detailChip}>
                <Text style={styles.detailText}>{item.bathrooms} bath</Text>
              </View>
            )}
            <View style={styles.detailChip}>
              <Text style={styles.detailText}>
                {isTrained ? "Tap to inspect" : "Tap to set up"}
              </Text>
            </View>
          </View>
        </View>
      </TouchableOpacity>
    );
  }, [navigation, selectionMode, selectedIds, toggleSelection]);

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={colors.primary} />
        <Text style={styles.loadingText}>Loading properties...</Text>
      </View>
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      {/* Header */}
      <View style={styles.header}>
        <View>
          <Text style={styles.title}>Properties</Text>
          <Text style={styles.subtitle}>
            {properties.length > 0
              ? selectionMode
                ? `${selectedIds.size} selected`
                : `${trainedCount} of ${properties.length} ready · ${sortBy === "newest" ? "Newest" : sortBy === "name" ? "A-Z" : sortBy === "ready_first" ? "Ready first" : "Needs training first"}`
              : "No properties yet"}
          </Text>
        </View>
        <View style={styles.headerActions}>
          {properties.length > 1 && !selectionMode && (
            <TouchableOpacity
              onPress={() => setShowSortModal(true)}
              style={styles.selectButton}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityLabel="Sort properties"
            >
              <Text style={styles.selectButtonText}>Sort</Text>
            </TouchableOpacity>
          )}
          {properties.length > 0 && (
            <TouchableOpacity
              onPress={toggleSelectionMode}
              style={styles.selectButton}
              activeOpacity={0.7}
            >
              <Text
                style={[
                  styles.selectButtonText,
                  selectionMode && styles.selectButtonTextActive,
                ]}
              >
                {selectionMode ? "Cancel" : "Select"}
              </Text>
            </TouchableOpacity>
          )}
          {!selectionMode && (
            <TouchableOpacity
              onPress={() => navigation.navigate("Profile")}
              style={styles.profileAvatar}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityLabel="Open profile"
            >
              <Text style={styles.profileAvatarText}>{userInitial}</Text>
            </TouchableOpacity>
          )}
        </View>
      </View>

      <FlatList
        data={sortedProperties}
        keyExtractor={(item) => item.id}
        renderItem={renderProperty}
        extraData={selectionMode ? selectedIds : undefined}
        contentContainerStyle={[
          styles.list,
          selectionMode && selectedIds.size > 0 && { paddingBottom: 110 },
        ]}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={colors.primary}
          />
        }
        ListEmptyComponent={
          <View style={styles.emptyContainer}>
            {error ? (
              <View style={styles.emptyRetryArea}>
                <TouchableOpacity
                  onPress={() => {
                    setLoading(true);
                    retryCountRef.current = 0;
                    loadProperties();
                  }}
                  activeOpacity={0.7}
                  accessibilityRole="button"
                  accessibilityLabel="Retry loading properties"
                  style={{ alignItems: "center" }}
                >
                  <View style={styles.emptyIcon}>
                    <Text style={styles.emptyIconRetryText}>↻</Text>
                  </View>
                  <Text style={styles.emptyTitle}>{error}</Text>
                  <View style={styles.retryButton}>
                    <Text style={styles.retryButtonText}>Retry</Text>
                  </View>
                </TouchableOpacity>
                <TouchableOpacity
                  onPress={() =>
                    navigation.navigate("ReportIssue", {
                      prefillError: error,
                      prefillScreen: "Properties",
                    })
                  }
                  style={{ marginTop: spacing.content }}
                >
                  <Text style={styles.reportLink}>Report this issue</Text>
                </TouchableOpacity>
              </View>
            ) : (
              <TouchableOpacity
                onPress={() => setShowAddModal(true)}
                activeOpacity={0.7}
                style={{ alignItems: "center" }}
              >
                <View style={styles.emptyIcon}>
                  <Text style={styles.emptyIconText}>+</Text>
                </View>
                <Text style={styles.emptyTitle}>No properties yet</Text>
                <Text style={styles.emptySubtext}>
                  Tap here to add your first property
                </Text>
              </TouchableOpacity>
            )}
          </View>
        }
        showsVerticalScrollIndicator={false}
      />

      {/* Floating Action Button */}
      {!selectionMode && properties.length > 0 && (
        <TouchableOpacity
          style={styles.fab}
          onPress={() => setShowAddModal(true)}
          activeOpacity={0.8}
          accessibilityRole="button"
          accessibilityLabel="Add new property"
        >
          <Text style={styles.fabIcon}>+</Text>
        </TouchableOpacity>
      )}

      {/* Selection mode bottom bar */}
      {selectionMode && selectedIds.size > 0 && (
        <View style={styles.selectionBar}>
          <Text style={styles.selectionBarText}>
            {selectedIds.size} {selectedIds.size === 1 ? "property" : "properties"}
          </Text>
          <TouchableOpacity
            style={styles.selectionDeleteButton}
            onPress={handleBulkDelete}
            disabled={bulkDeleting}
            activeOpacity={0.7}
          >
            {bulkDeleting ? (
              <ActivityIndicator size="small" color={colors.primaryForeground} />
            ) : (
              <Text style={styles.selectionDeleteText}>Delete</Text>
            )}
          </TouchableOpacity>
        </View>
      )}

      <Modal
        visible={showSortModal}
        transparent
        animationType="fade"
        onRequestClose={() => setShowSortModal(false)}
      >
        <Pressable style={styles.modalBackdrop} onPress={() => setShowSortModal(false)} />
        <View style={styles.sortSheetWrap}>
          <View style={styles.sortSheet}>
            <Text style={styles.modalTitle}>Sort Properties</Text>
            <Text style={styles.modalSubtitle}>Choose how the property list should be ordered</Text>

            {([
              { key: "newest", label: "Newest first" },
              { key: "name", label: "Name A-Z" },
              { key: "ready_first", label: "Ready first" },
              { key: "needs_training", label: "Needs training first" },
            ] as Array<{ key: SortOption; label: string }>).map((option) => {
              const selected = sortBy === option.key;
              return (
                <TouchableOpacity
                  key={option.key}
                  style={[styles.sortOption, selected && styles.sortOptionSelected]}
                  onPress={() => {
                    setSortBy(option.key);
                    setShowSortModal(false);
                  }}
                  activeOpacity={0.7}
                  accessibilityRole="button"
                  accessibilityLabel={`Sort by ${option.label}`}
                >
                  <Text style={[styles.sortOptionText, selected && styles.sortOptionTextSelected]}>
                    {option.label}
                  </Text>
                  {selected && <Text style={styles.sortOptionCheck}>✓</Text>}
                </TouchableOpacity>
              );
            })}
          </View>
        </View>
      </Modal>

      {/* Add Property Modal */}
      <Modal
        visible={showAddModal}
        transparent
        animationType="fade"
        onRequestClose={closeAddModal}
      >
        <KeyboardAvoidingView
          style={styles.modalOverlay}
          behavior={Platform.OS === "ios" ? "padding" : undefined}
        >
          <Pressable
            style={styles.modalBackdrop}
            onPress={closeAddModal}
          />
          <View style={styles.modalContent}>
              <Text style={styles.modalTitle}>New Property</Text>
              <Text style={styles.modalSubtitle}>
                Give it a name, then set up baselines
              </Text>
              <Text style={styles.modalLabel}>Property Name *</Text>
              <TextInput
                style={[
                  styles.modalInput,
                  newPropertyError ? styles.modalInputError : null,
                ]}
                value={newPropertyName}
                onChangeText={(value) => {
                  setNewPropertyName(value);
                  if (newPropertyError) {
                    setNewPropertyError(null);
                  }
                }}
                placeholder="e.g. Aspen Lodge"
                placeholderTextColor={colors.slate700}
                autoCapitalize="words"
                autoFocus
                returnKeyType="done"
                maxLength={120}
                onSubmitEditing={handleCreateProperty}
                accessibilityLabel="Property name"
                accessibilityHint="Required. Enter a name for this property."
              />
              {newPropertyError ? (
                <Text style={styles.modalErrorText}>{newPropertyError}</Text>
              ) : null}
              <View style={styles.modalActions}>
                <TouchableOpacity
                  style={styles.modalCancelButton}
                  onPress={closeAddModal}
                  activeOpacity={0.7}
                >
                  <Text style={styles.modalCancelText}>Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[
                    styles.modalCreateButton,
                    (!newPropertyName.trim() || creating) && styles.modalCreateButtonDisabled,
                  ]}
                  onPress={handleCreateProperty}
                  disabled={!newPropertyName.trim() || creating}
                  activeOpacity={0.7}
                >
                  {creating ? (
                    <ActivityIndicator size="small" color={colors.primaryForeground} />
                  ) : (
                    <Text style={styles.modalCreateText}>Create & Train</Text>
                  )}
                </TouchableOpacity>
              </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  center: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: colors.background,
    gap: spacing.content,
  },
  loadingText: {
    color: colors.muted,
    fontSize: fontSize.label,
  },

  // Header
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    paddingHorizontal: spacing.screen,
    paddingBottom: spacing.screen,
    paddingTop: spacing.sm,
  },
  title: {
    fontSize: fontSize.screenTitle,
    fontWeight: "600",
    color: colors.heading,
    letterSpacing: -0.5,
  },
  subtitle: {
    fontSize: fontSize.label,
    color: colors.muted,
    marginTop: spacing.xxs,
    fontWeight: "500",
  },
  headerActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.content,
    marginTop: spacing.xs,
  },
  selectButton: {
    paddingHorizontal: spacing.card,
    paddingVertical: spacing.sm,
    borderRadius: radius.sm,
    backgroundColor: colors.secondary,
    borderWidth: 1,
    borderColor: colors.cardBorder,
  },
  selectButtonText: {
    color: colors.muted,
    fontSize: fontSize.label,
    fontWeight: "600",
  },
  selectButtonTextActive: {
    color: colors.primary,
  },
  profileAvatar: {
    width: 36,
    height: 36,
    borderRadius: radius.full,
    backgroundColor: colors.heading,
    justifyContent: "center",
    alignItems: "center",
    ...shadows.card,
  },
  profileAvatarText: {
    color: colors.primaryForeground,
    fontSize: fontSize.body,
    fontWeight: "600",
  },

  // List
  list: {
    paddingHorizontal: spacing.screen,
    paddingBottom: 100,
    gap: spacing.content,
  },

  // Card
  card: {
    backgroundColor: colors.card,
    borderRadius: radius.xl,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: colors.stone,
    flexDirection: "row",
    ...shadows.card,
  },
  cardSelected: {
    borderColor: colors.primary,
    backgroundColor: colors.primaryBg,
  },
  cardAccent: {
    width: 4,
  },
  cardContent: {
    flex: 1,
    padding: spacing.container,
    paddingLeft: spacing.md,
  },
  cardHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    marginBottom: spacing.content,
    minWidth: 0,
  },
  cardTitleArea: {
    flex: 1,
    marginRight: spacing.content,
    minWidth: 0,
  },
  propertyName: {
    fontSize: fontSize.h3,
    fontWeight: "600",
    color: colors.heading,
    letterSpacing: -0.2,
  },
  address: {
    color: colors.muted,
    fontSize: fontSize.sm,
    marginTop: 3,
    flexShrink: 1,
  },

  // Selection checkbox
  checkboxArea: {
    width: 48,
    justifyContent: "center",
    alignItems: "center",
  },
  checkboxAreaSelected: {
    backgroundColor: colors.primaryBg,
  },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: colors.stone,
    justifyContent: "center",
    alignItems: "center",
  },
  checkboxChecked: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },
  checkmark: {
    color: colors.primaryForeground,
    fontSize: fontSize.label,
    fontWeight: "700",
  },

  // Edit button
  editButton: {
    paddingHorizontal: spacing.content,
    paddingVertical: spacing.tight,
    borderRadius: radius.sm,
    backgroundColor: colors.secondary,
    borderWidth: 1,
    borderColor: colors.cardBorder,
  },
  editButtonText: {
    color: colors.muted,
    fontSize: fontSize.caption,
    fontWeight: "600",
  },

  // Badge
  badge: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.tight,
    paddingHorizontal: spacing.element,
    paddingVertical: 5,
    borderRadius: radius.sm,
  },
  badgeTrained: {
    backgroundColor: colors.successBg,
  },
  badgeUntrained: {
    backgroundColor: colors.primaryBg,
  },
  badgeDot: {
    width: 6,
    height: 6,
    borderRadius: radius.full,
  },
  badgeText: {
    fontSize: fontSize.caption,
    fontWeight: "600",
    letterSpacing: 0.3,
  },

  // Details
  detailsRow: {
    flexDirection: "row",
    gap: spacing.sm,
    flexWrap: "wrap",
  },
  detailChip: {
    backgroundColor: colors.secondary,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.element,
    paddingVertical: spacing.xs,
    borderWidth: 1,
    borderColor: colors.cardBorder,
  },
  detailText: {
    color: colors.muted,
    fontSize: fontSize.caption,
    fontWeight: "500",
  },

  // FAB
  fab: {
    position: "absolute",
    bottom: spacing.xl,
    right: spacing.screen,
    width: 56,
    height: 56,
    borderRadius: radius.full,
    backgroundColor: colors.primary,
    justifyContent: "center",
    alignItems: "center",
    ...shadows.elevated,
  },
  fabIcon: {
    color: colors.primaryForeground,
    fontSize: fontSize.pageTitle,
    fontWeight: "400",
    marginTop: -spacing.xxs,
  },

  // Selection bottom bar
  selectionBar: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: spacing.screen,
    paddingVertical: spacing.md,
    paddingBottom: 34,
    backgroundColor: colors.card,
    borderTopWidth: 1,
    borderTopColor: colors.stone,
    ...shadows.elevated,
  },
  selectionBarText: {
    color: colors.heading,
    fontSize: fontSize.body,
    fontWeight: "600",
  },
  selectionDeleteButton: {
    backgroundColor: colors.error,
    paddingHorizontal: spacing.screen,
    paddingVertical: spacing.element,
    borderRadius: radius.md,
    minWidth: 80,
    alignItems: "center",
  },
  selectionDeleteText: {
    color: colors.primaryForeground,
    fontSize: fontSize.body,
    fontWeight: "600",
  },

  // Modal
  sortSheetWrap: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: "flex-end",
    padding: spacing.screen,
  },
  sortSheet: {
    backgroundColor: colors.card,
    borderRadius: radius.xl,
    padding: spacing.screen,
    borderWidth: 1,
    borderColor: colors.stone,
    ...shadows.elevated,
  },
  sortOption: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: spacing.card,
    paddingHorizontal: spacing.card,
    borderRadius: radius.md,
    backgroundColor: colors.secondary,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    marginTop: spacing.element,
  },
  sortOptionSelected: {
    borderColor: colors.primary,
    backgroundColor: colors.primaryBg,
  },
  sortOptionText: {
    color: colors.heading,
    fontSize: fontSize.body,
    fontWeight: "500",
  },
  sortOptionTextSelected: {
    color: colors.primary,
    fontWeight: "600",
  },
  sortOptionCheck: {
    color: colors.primary,
    fontSize: fontSize.bodyLg,
    fontWeight: "700",
  },

  modalOverlay: {
    flex: 1,
    justifyContent: "center",
    paddingHorizontal: spacing.lg,
  },
  modalBackdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: colors.camera.overlay,
  },
  modalContent: {
    backgroundColor: colors.card,
    borderRadius: radius.xl,
    padding: spacing.lg,
    width: "100%",
    maxWidth: 400,
    ...shadows.elevated,
  },
  modalTitle: {
    fontSize: fontSize.modalTitle,
    fontWeight: "600",
    color: colors.heading,
    letterSpacing: -0.3,
    marginBottom: spacing.xs,
  },
  modalSubtitle: {
    fontSize: fontSize.label,
    color: colors.muted,
    marginBottom: spacing.screen,
  },
  modalLabel: {
    fontSize: fontSize.sm,
    color: colors.heading,
    fontWeight: "600",
    marginBottom: spacing.sm,
  },
  modalInput: {
    backgroundColor: colors.secondary,
    borderWidth: 1,
    borderColor: colors.stone,
    borderRadius: radius.lg,
    paddingHorizontal: spacing.card,
    paddingVertical: 13,
    color: colors.foreground,
    fontSize: fontSize.bodyLg,
    fontWeight: "500",
    marginBottom: spacing.screen,
  },
  modalInputError: {
    borderColor: colors.error,
  },
  modalErrorText: {
    color: colors.error,
    fontSize: fontSize.caption,
    fontWeight: "500",
    marginTop: -spacing.content,
    marginBottom: spacing.content,
  },
  modalActions: {
    flexDirection: "row",
    gap: spacing.content,
  },
  modalCancelButton: {
    flex: 1,
    paddingVertical: 13,
    borderRadius: radius.md,
    backgroundColor: colors.secondary,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    alignItems: "center",
  },
  modalCancelText: {
    color: colors.muted,
    fontSize: fontSize.body,
    fontWeight: "600",
  },
  modalCreateButton: {
    flex: 1,
    paddingVertical: 13,
    borderRadius: radius.md,
    backgroundColor: colors.primary,
    alignItems: "center",
  },
  modalCreateButtonDisabled: {
    opacity: 0.4,
  },
  modalCreateText: {
    color: colors.primaryForeground,
    fontSize: fontSize.body,
    fontWeight: "600",
  },

  // Empty
  emptyContainer: {
    justifyContent: "center",
    alignItems: "center",
    paddingTop: 80,
    paddingHorizontal: spacing.safe,
  },
  emptyIcon: {
    width: 64,
    height: 64,
    borderRadius: radius.full,
    backgroundColor: colors.primaryBg,
    borderWidth: 2,
    borderColor: colors.primaryBorder,
    borderStyle: "dashed",
    justifyContent: "center",
    alignItems: "center",
    marginBottom: spacing.screen,
  },
  emptyIconText: {
    fontSize: fontSize.pageTitle,
    color: colors.primary,
    fontWeight: "400",
  },
  emptyRetryArea: {
    justifyContent: "center",
    alignItems: "center",
  },
  emptyIconRetryText: {
    fontSize: fontSize.pageTitle,
    color: colors.primary,
    fontWeight: "400",
  },
  emptyTitle: {
    color: colors.muted,
    fontSize: fontSize.button,
    fontWeight: "600",
    textAlign: "center",
    marginBottom: spacing.tight,
  },
  emptySubtext: {
    color: colors.muted,
    fontSize: fontSize.label,
    textAlign: "center",
    lineHeight: 20,
  },
  retryButton: {
    marginTop: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.element,
    borderRadius: radius.md,
    backgroundColor: colors.primaryBgStrong,
    borderWidth: 1,
    borderColor: colors.primaryBorder,
  },
  retryButtonText: {
    color: colors.primary,
    fontSize: fontSize.body,
    fontWeight: "600",
  },
  reportLink: {
    color: colors.muted,
    fontSize: fontSize.sm,
    fontWeight: "500",
    textDecorationLine: "underline" as const,
  },
});

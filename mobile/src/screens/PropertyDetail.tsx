import React, { useState, useCallback } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  TextInput,
  ScrollView,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Modal,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useNavigation, useRoute, useFocusEffect } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import type { RouteProp } from "@react-navigation/native";
import { Image } from "expo-image";
import { getProperty, updateProperty, deleteProperty } from "../lib/api";
import type { RootStackParamList } from "../navigation";
import { colors, radius, fontSize, spacing } from '../lib/tokens';
import { Ionicons } from "@expo/vector-icons";

type Nav = NativeStackNavigationProp<RootStackParamList, "PropertyDetail">;
type Route = RouteProp<RootStackParamList, "PropertyDetail">;

interface PropertyData {
  id: string;
  name: string;
  address: string | null;
  city: string | null;
  state: string | null;
  zipCode: string | null;
  propertyType: string | null;
  bedrooms: number | null;
  bathrooms: number | null;
  squareFeet: number | null;
  estimatedValue: string | null;
  notes: string | null;
  trainingStatus: string;
  coverImageUrl?: string | null;
}

const PROPERTY_TYPES = [
  { key: "house", label: "House" },
  { key: "condo", label: "Condo" },
  { key: "cabin", label: "Cabin" },
  { key: "villa", label: "Villa" },
  { key: "apartment", label: "Apartment" },
  { key: "townhouse", label: "Townhouse" },
  { key: "estate", label: "Estate" },
  { key: "other", label: "Other" },
];

export default function PropertyDetailScreen() {
  const navigation = useNavigation<Nav>();
  const route = useRoute<Route>();
  const { propertyId } = route.params;

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasChanges, setHasChanges] = useState(false);

  // Form fields
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [city, setCity] = useState("");
  const [state, setState] = useState("");
  const [zipCode, setZipCode] = useState("");
  const [propertyType, setPropertyType] = useState("");
  const [bedrooms, setBedrooms] = useState("");
  const [bathrooms, setBathrooms] = useState("");
  const [squareFeet, setSquareFeet] = useState("");
  const [estimatedValue, setEstimatedValue] = useState("");
  const [notes, setNotes] = useState("");
  const [trainingStatus, setTrainingStatus] = useState("untrained");
  const [coverImageUrl, setCoverImageUrl] = useState("");
  const [showPropertyDetailsModal, setShowPropertyDetailsModal] = useState(false);

  const loadProperty = useCallback(async () => {
    try {
      setError(null);
      const data: PropertyData = await getProperty(propertyId);
      setName(data.name || "");
      setAddress(data.address || "");
      setCity(data.city || "");
      setState(data.state || "");
      setZipCode(data.zipCode || "");
      setPropertyType(data.propertyType || "");
      setBedrooms(data.bedrooms != null ? String(data.bedrooms) : "");
      setBathrooms(data.bathrooms != null ? String(data.bathrooms) : "");
      setSquareFeet(data.squareFeet != null ? String(data.squareFeet) : "");
      setEstimatedValue(data.estimatedValue || "");
      setNotes(data.notes || "");
      setTrainingStatus(data.trainingStatus || "untrained");
      setCoverImageUrl(data.coverImageUrl || "");
      setHasChanges(false);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to load property",
      );
    } finally {
      setLoading(false);
    }
  }, [propertyId]);

  useFocusEffect(
    useCallback(() => {
      loadProperty();
    }, [loadProperty]),
  );

  const updateField = useCallback(
    (setter: (v: string) => void) => (value: string) => {
      setter(value);
      setHasChanges(true);
    },
    [],
  );

  const handleSave = async () => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError("Property name is required");
      return;
    }
    if (trimmedName.length < 2 || trimmedName.length > 120) {
      setError("Property name must be between 2 and 120 characters");
      return;
    }
    if (!/^[a-zA-Z0-9\s\-'.,#&()]+$/.test(trimmedName)) {
      setError("Property name contains invalid characters");
      return;
    }

    setSaving(true);
    setError(null);

    try {
      await updateProperty(propertyId, {
        name: name.trim(),
        address: address.trim() || null,
        city: city.trim() || null,
        state: state.trim() || null,
        zipCode: zipCode.trim() || null,
        propertyType: propertyType || null,
        bedrooms: bedrooms ? (Number.isNaN(parseInt(bedrooms, 10)) ? null : parseInt(bedrooms, 10)) : null,
        bathrooms: bathrooms ? (Number.isNaN(parseInt(bathrooms, 10)) ? null : parseInt(bathrooms, 10)) : null,
        squareFeet: squareFeet ? (Number.isNaN(parseInt(squareFeet, 10)) ? null : parseInt(squareFeet, 10)) : null,
        estimatedValue: estimatedValue.trim() || null,
        notes: notes.trim() || null,
      });
      setHasChanges(false);
      Alert.alert("Saved", "Property updated successfully.");
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to save changes",
      );
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = () => {
    Alert.alert(
      "Delete Property",
      `Are you sure you want to delete "${name}"? This will permanently remove the property and all associated data including rooms, baselines, and inspection history. This cannot be undone.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: async () => {
            setDeleting(true);
            try {
              await deleteProperty(propertyId);
              navigation.goBack();
            } catch (err) {
              setError(
                err instanceof Error
                  ? err.message
                  : "Failed to delete property",
              );
            } finally {
              setDeleting(false);
            }
          },
        },
      ],
    );
  };

  const handleBack = () => {
    if (hasChanges) {
      Alert.alert(
        "Unsaved Changes",
        "You have unsaved changes. Discard them?",
        [
          { text: "Keep Editing", style: "cancel" },
          {
            text: "Discard",
            style: "destructive",
            onPress: () => navigation.goBack(),
          },
        ],
      );
    } else {
      navigation.goBack();
    }
  };

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  if (error && !name) {
    return (
      <SafeAreaView style={styles.container} edges={["top"]}>
        <View style={styles.header}>
          <TouchableOpacity style={styles.backButton} onPress={() => navigation.goBack()} activeOpacity={0.7}>
            <Ionicons name="chevron-back" size={20} color={colors.muted} />
            <Text style={styles.backText}>Back</Text>
          </TouchableOpacity>
        </View>
        <View style={[styles.center, { paddingHorizontal: spacing.lg, gap: spacing.content }]}>
          <Text style={{ color: colors.heading, fontSize: 18, fontWeight: "600" }}>Unable to load property</Text>
          <Text style={{ color: colors.muted, fontSize: 14, textAlign: "center" }}>{error}</Text>
          <TouchableOpacity
            style={{ backgroundColor: colors.primary, borderRadius: radius.lg, paddingHorizontal: spacing.lg, paddingVertical: spacing.content, marginTop: spacing.sm }}
            onPress={() => { setLoading(true); loadProperty(); }}
            activeOpacity={0.8}
          >
            <Text style={{ color: colors.primaryForeground, fontSize: 16, fontWeight: "600" }}>Retry</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  const isTrained = trainingStatus === "trained";

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        keyboardVerticalOffset={0}
      >
        {/* Header */}
        <View style={styles.header}>
          <TouchableOpacity
            style={styles.backButton}
            onPress={handleBack}
            activeOpacity={0.7}
          >
            <Ionicons name="chevron-back" size={20} color={colors.muted} />
            <Text style={styles.backText}>Back</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[
              styles.saveButton,
              (!hasChanges || saving) && styles.saveButtonDisabled,
            ]}
            onPress={handleSave}
            disabled={!hasChanges || saving}
            activeOpacity={0.7}
          >
            {saving ? (
              <ActivityIndicator size="small" color={colors.foreground} />
            ) : (
              <Text
                style={[
                  styles.saveText,
                  !hasChanges && styles.saveTextDisabled,
                ]}
              >
                Save
              </Text>
            )}
          </TouchableOpacity>
        </View>

        <ScrollView
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          {/* Title + status */}
          <View style={styles.titleRow}>
            <View style={styles.titleCopy}>
              <Text style={styles.screenTitle}>{name || "Property"}</Text>
              <Text style={styles.screenSubtitle}>
                {PROPERTY_TYPES.find((type) => type.key === propertyType)?.label || "Property"}
              </Text>
            </View>
            <View
              style={[
                styles.statusBadge,
                isTrained ? styles.statusTrained : styles.statusUntrained,
              ]}
            >
              <View
                style={[
                  styles.statusDot,
                  {
                    backgroundColor: isTrained ? colors.success : colors.primary,
                  },
                ]}
              />
              <Text
                style={[
                  styles.statusText,
                  { color: isTrained ? colors.success : colors.primary },
                ]}
              >
                {isTrained ? "Trained" : "Untrained"}
              </Text>
            </View>
          </View>

          {error && (
            <View style={styles.errorContainer}>
              <Text style={styles.errorText}>{error}</Text>
              <TouchableOpacity
                onPress={() =>
                  navigation.navigate("ReportIssue", {
                    prefillError: error,
                    prefillScreen: "PropertyDetail",
                  })
                }
                style={{ marginTop: spacing.sm }}
              >
                <Text style={styles.errorReportLink}>Report this issue</Text>
              </TouchableOpacity>
            </View>
          )}

          {/* Overview Section */}
          <Text style={styles.sectionTitle}>Overview</Text>
          <View style={styles.section}>
            {coverImageUrl ? (
              <View style={styles.heroPreviewCard}>
                <Image
                  source={{ uri: coverImageUrl }}
                  style={styles.heroPreviewImage}
                  contentFit="cover"
                />
                <View style={styles.heroPreviewOverlay}>
                  <Text style={styles.heroPreviewTitle}>Latest Property Preview</Text>
                  <Text style={styles.heroPreviewSubtitle}>
                    Use this screen for the property’s identity and notes. Full location and detail fields live under Property Details.
                  </Text>
                </View>
              </View>
            ) : (
              <View style={styles.heroTextCard}>
                <Ionicons name="images-outline" size={18} color={colors.primary} />
                <Text style={styles.heroTextCardText}>
                  After training, the property preview shows up here so the main page feels visual and operational.
                </Text>
              </View>
            )}

            <View style={styles.field}>
              <Text style={styles.label}>Property Name *</Text>
              <TextInput
                style={styles.input}
                value={name}
                onChangeText={updateField(setName)}
                placeholder="e.g. Aspen Lodge"
                placeholderTextColor={colors.slate700}
                autoCapitalize="words"
              />
            </View>

            <View style={styles.field}>
              <Text style={styles.label}>Property Type</Text>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.typeRow}
              >
                {PROPERTY_TYPES.map((t) => {
                  const isSelected = propertyType === t.key;
                  return (
                    <TouchableOpacity
                      key={t.key}
                      style={[
                        styles.typeChip,
                        isSelected && styles.typeChipSelected,
                      ]}
                      onPress={() => {
                        setPropertyType(isSelected ? "" : t.key);
                        setHasChanges(true);
                      }}
                      activeOpacity={0.7}
                    >
                      <Text
                        style={[
                          styles.typeChipText,
                          isSelected && styles.typeChipTextSelected,
                        ]}
                      >
                        {t.label}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </ScrollView>
            </View>

            <View style={styles.field}>
              <Text style={styles.label}>Notes</Text>
              <TextInput
                style={[styles.input, styles.textArea]}
                value={notes}
                onChangeText={updateField(setNotes)}
                placeholder="Any notes about this property..."
                placeholderTextColor={colors.slate700}
                multiline
                numberOfLines={3}
                textAlignVertical="top"
              />
            </View>
          </View>

          {/* Quick Actions */}
          <Text style={styles.sectionTitle}>Actions</Text>
          <View style={styles.section}>
            <TouchableOpacity
              style={styles.actionRow}
              onPress={() => setShowPropertyDetailsModal(true)}
              activeOpacity={0.7}
            >
              <View
                style={[
                  styles.actionIconCircle,
                  { backgroundColor: colors.secondary },
                ]}
              >
                <Ionicons name="home-outline" size={20} color={colors.muted} />
              </View>
              <View style={styles.actionContent}>
                <Text style={styles.actionLabel}>Property Details</Text>
                <Text style={styles.actionDesc}>
                  Location, beds, baths, square footage, and valuation
                </Text>
              </View>
              <Ionicons name="chevron-forward" size={18} color={colors.slate700} />
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.actionRow}
              onPress={() =>
                navigation.navigate("InspectionHistory", {
                  propertyId,
                  propertyName: name,
                })
              }
              activeOpacity={0.7}
            >
              <View
                style={[
                  styles.actionIconCircle,
                  { backgroundColor: colors.primaryBgStrong },
                ]}
              >
                <Ionicons name="clipboard-outline" size={20} color={colors.primary} />
              </View>
              <View style={styles.actionContent}>
                <Text style={styles.actionLabel}>Inspection History</Text>
                <Text style={styles.actionDesc}>
                  View and manage inspection reports and notes
                </Text>
              </View>
              <Ionicons name="chevron-forward" size={18} color={colors.slate700} />
            </TouchableOpacity>

            {isTrained && (
              <TouchableOpacity
                style={styles.actionRow}
                onPress={() =>
                  navigation.navigate("InspectionStart", { propertyId })
                }
                activeOpacity={0.7}
              >
                <View style={styles.actionIconCircle}>
                  <Ionicons name="play" size={20} color={colors.success} />
                </View>
                <View style={styles.actionContent}>
                  <Text style={styles.actionLabel}>Start Inspection</Text>
                  <Text style={styles.actionDesc}>
                    Begin a new inspection of this property
                  </Text>
                </View>
                <Ionicons name="chevron-forward" size={18} color={colors.slate700} />
              </TouchableOpacity>
            )}

            <TouchableOpacity
              style={styles.actionRow}
              onPress={() =>
                navigation.navigate("PropertyTraining", {
                  propertyId,
                  propertyName: name,
                })
              }
              activeOpacity={0.7}
            >
              <View
                style={[
                  styles.actionIconCircle,
                  { backgroundColor: colors.primaryBg },
                ]}
              >
                <Ionicons name="camera-outline" size={20} color={colors.purple} />
              </View>
              <View style={styles.actionContent}>
                <Text style={styles.actionLabel}>
                  {isTrained ? "Re-Train Property" : "Train Property"}
                </Text>
                <Text style={styles.actionDesc}>
                  {isTrained
                    ? "Capture new baselines for this property"
                    : "Set up baselines for AI inspection"}
                </Text>
              </View>
              <Ionicons name="chevron-forward" size={18} color={colors.slate700} />
            </TouchableOpacity>
          </View>

          {/* Danger Zone */}
          <View style={[styles.section, styles.dangerSection]}>
            <TouchableOpacity
              style={styles.deleteButton}
              onPress={handleDelete}
              disabled={deleting}
              activeOpacity={0.7}
            >
              {deleting ? (
                <ActivityIndicator size="small" color={colors.error} />
              ) : (
                <>
                  <Text style={styles.deleteButtonText}>Delete Property</Text>
                  <Text style={styles.deleteButtonDesc}>
                    Permanently remove this property and all associated data
                  </Text>
                </>
              )}
            </TouchableOpacity>
          </View>

          {/* Bottom spacer */}
          <View style={{ height: 60 }} />
        </ScrollView>

        <Modal
          visible={showPropertyDetailsModal}
          animationType="slide"
          transparent
          onRequestClose={() => setShowPropertyDetailsModal(false)}
        >
          <View style={styles.detailsModalOverlay}>
            <KeyboardAvoidingView
              behavior={Platform.OS === "ios" ? "padding" : undefined}
              style={styles.detailsModalSheet}
            >
              <View style={styles.detailsModalHandle} />
              <View style={styles.detailsModalHeader}>
                <Text style={styles.detailsModalTitle}>Property Details</Text>
                <TouchableOpacity
                  onPress={() => setShowPropertyDetailsModal(false)}
                  activeOpacity={0.7}
                  style={styles.detailsModalClose}
                >
                  <Ionicons name="close" size={18} color={colors.muted} />
                </TouchableOpacity>
              </View>

              <ScrollView
                style={styles.detailsModalScroll}
                contentContainerStyle={styles.detailsModalScrollContent}
                keyboardShouldPersistTaps="handled"
                showsVerticalScrollIndicator={false}
              >
                <Text style={styles.sectionTitle}>Location</Text>
                <View style={styles.section}>
                  <View style={styles.field}>
                    <Text style={styles.label}>Street Address</Text>
                    <TextInput
                      style={styles.input}
                      value={address}
                      onChangeText={updateField(setAddress)}
                      placeholder="123 Main St"
                      placeholderTextColor={colors.slate700}
                      autoCapitalize="words"
                    />
                  </View>

                  <View style={styles.rowFields}>
                    <View style={[styles.field, { flex: 2 }]}>
                      <Text style={styles.label}>City</Text>
                      <TextInput
                        style={styles.input}
                        value={city}
                        onChangeText={updateField(setCity)}
                        placeholder="Aspen"
                        placeholderTextColor={colors.slate700}
                        autoCapitalize="words"
                      />
                    </View>
                    <View style={[styles.field, { flex: 1 }]}>
                      <Text style={styles.label}>State</Text>
                      <TextInput
                        style={styles.input}
                        value={state}
                        onChangeText={updateField(setState)}
                        placeholder="CO"
                        placeholderTextColor={colors.slate700}
                        autoCapitalize="characters"
                        maxLength={2}
                      />
                    </View>
                  </View>

                  <View style={styles.field}>
                    <Text style={styles.label}>ZIP Code</Text>
                    <TextInput
                      style={[styles.input, { maxWidth: 140 }]}
                      value={zipCode}
                      onChangeText={updateField(setZipCode)}
                      placeholder="81611"
                      placeholderTextColor={colors.slate700}
                      keyboardType="number-pad"
                      maxLength={10}
                    />
                  </View>
                </View>

                <Text style={styles.sectionTitle}>Details</Text>
                <View style={styles.section}>
                  <View style={styles.rowFields}>
                    <View style={[styles.field, { flex: 1 }]}>
                      <Text style={styles.label}>Bedrooms</Text>
                      <TextInput
                        style={styles.input}
                        value={bedrooms}
                        onChangeText={updateField(setBedrooms)}
                        placeholder="4"
                        placeholderTextColor={colors.slate700}
                        keyboardType="number-pad"
                        maxLength={3}
                      />
                    </View>
                    <View style={[styles.field, { flex: 1 }]}>
                      <Text style={styles.label}>Bathrooms</Text>
                      <TextInput
                        style={styles.input}
                        value={bathrooms}
                        onChangeText={updateField(setBathrooms)}
                        placeholder="3"
                        placeholderTextColor={colors.slate700}
                        keyboardType="number-pad"
                        maxLength={3}
                      />
                    </View>
                  </View>

                  <View style={styles.rowFields}>
                    <View style={[styles.field, { flex: 1 }]}>
                      <Text style={styles.label}>Square Feet</Text>
                      <TextInput
                        style={styles.input}
                        value={squareFeet}
                        onChangeText={updateField(setSquareFeet)}
                        placeholder="3,500"
                        placeholderTextColor={colors.slate700}
                        keyboardType="number-pad"
                      />
                    </View>
                    <View style={[styles.field, { flex: 1 }]}>
                      <Text style={styles.label}>Est. Value</Text>
                      <TextInput
                        style={styles.input}
                        value={estimatedValue}
                        onChangeText={updateField(setEstimatedValue)}
                        placeholder="$3,500,000"
                        placeholderTextColor={colors.slate700}
                      />
                    </View>
                  </View>
                </View>
              </ScrollView>
            </KeyboardAvoidingView>
          </View>
        </Modal>
      </KeyboardAvoidingView>
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
  },

  // Header
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: spacing.screen,
    paddingVertical: spacing.element,
  },
  backButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
    paddingVertical: spacing.xs,
    paddingRight: spacing.content,
  },
  backText: {
    color: colors.muted,
    fontSize: fontSize.bodyLg,
    fontWeight: "500",
  },
  saveButton: {
    backgroundColor: colors.primary,
    paddingHorizontal: spacing.screen,
    paddingVertical: spacing.element,
    borderRadius: radius.md,
    minWidth: 70,
    alignItems: "center",
  },
  saveButtonDisabled: {
    opacity: 0.4,
  },
  saveText: {
    color: colors.primaryForeground,
    fontSize: fontSize.body,
    fontWeight: "600",
  },
  saveTextDisabled: {
    color: colors.primaryForeground,
  },

  // Scroll content
  scrollContent: {
    paddingHorizontal: spacing.screen,
  },

  // Title
  titleRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: spacing.screen,
  },
  titleCopy: {
    flex: 1,
    gap: spacing.xxs,
    paddingRight: spacing.md,
  },
  screenTitle: {
    fontSize: fontSize.pageTitle,
    fontWeight: "600",
    color: colors.heading,
    letterSpacing: -0.5,
  },
  screenSubtitle: {
    color: colors.muted,
    fontSize: fontSize.body,
    fontWeight: "500",
  },
  statusBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.tight,
    paddingHorizontal: spacing.content,
    paddingVertical: spacing.tight,
    borderRadius: radius.sm,
  },
  statusTrained: {
    backgroundColor: colors.successBg,
  },
  statusUntrained: {
    backgroundColor: colors.primaryBg,
  },
  statusDot: {
    width: 7,
    height: 7,
    borderRadius: radius.full,
  },
  statusText: {
    fontSize: fontSize.caption,
    fontWeight: "600",
    letterSpacing: 0.3,
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
    fontSize: fontSize.label,
    fontWeight: "500",
  },
  errorReportLink: {
    color: colors.error,
    fontSize: fontSize.sm,
    fontWeight: "600",
    textDecorationLine: "underline" as const,
  },

  // Sections
  sectionTitle: {
    fontSize: fontSize.sm,
    fontWeight: "600",
    color: colors.muted,
    letterSpacing: 0.5,
    textTransform: "uppercase",
    marginBottom: spacing.element,
    marginTop: spacing.sm,
  },
  section: {
    backgroundColor: colors.card,
    borderRadius: radius.xl,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.stone,
    marginBottom: spacing.screen,
    gap: spacing.md,
  },
  heroPreviewCard: {
    borderRadius: radius.xl,
    overflow: "hidden",
    backgroundColor: colors.secondary,
    borderWidth: 1,
    borderColor: colors.stone,
  },
  heroPreviewImage: {
    width: "100%",
    height: 168,
    backgroundColor: colors.secondary,
  },
  heroPreviewOverlay: {
    gap: spacing.xs,
    padding: spacing.card,
    backgroundColor: colors.card,
  },
  heroPreviewTitle: {
    color: colors.heading,
    fontSize: fontSize.bodyLg,
    fontWeight: "700",
  },
  heroPreviewSubtitle: {
    color: colors.muted,
    fontSize: fontSize.sm,
    lineHeight: 20,
  },
  heroTextCard: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: spacing.sm,
    padding: spacing.card,
    borderRadius: radius.lg,
    backgroundColor: colors.primaryBg,
    borderWidth: 1,
    borderColor: colors.primaryBorder,
  },
  heroTextCardText: {
    flex: 1,
    color: colors.primary,
    fontSize: fontSize.sm,
    fontWeight: "600",
    lineHeight: 20,
  },

  // Fields
  field: {
    gap: spacing.tight,
  },
  label: {
    fontSize: fontSize.caption,
    fontWeight: "600",
    color: colors.muted,
    letterSpacing: 0.3,
    textTransform: "uppercase",
  },
  input: {
    backgroundColor: colors.secondary,
    borderWidth: 1,
    borderColor: colors.stone,
    borderRadius: radius.lg,
    paddingHorizontal: spacing.card,
    paddingVertical: 13,
    color: colors.foreground,
    fontSize: fontSize.bodyLg,
    fontWeight: "500",
  },
  textArea: {
    minHeight: 80,
    paddingTop: 13,
  },
  rowFields: {
    flexDirection: "row",
    gap: spacing.content,
  },

  // Property type picker
  typeRow: {
    gap: spacing.sm,
    paddingVertical: spacing.xxs,
    paddingRight: spacing.sm,
  },
  typeChip: {
    paddingHorizontal: spacing.card,
    paddingVertical: 9,
    borderRadius: radius.md,
    backgroundColor: colors.secondary,
    borderWidth: 1,
    borderColor: colors.cardBorder,
  },
  typeChipSelected: {
    backgroundColor: colors.primaryBgStrong,
    borderColor: colors.primaryBorder,
  },
  typeChipText: {
    color: colors.muted,
    fontSize: fontSize.label,
    fontWeight: "600",
  },
  typeChipTextSelected: {
    color: colors.primary,
  },

  // Actions
  actionRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.card,
    paddingVertical: spacing.xs,
  },
  actionIconCircle: {
    width: 40,
    height: 40,
    borderRadius: radius.lg,
    backgroundColor: colors.successBg,
    justifyContent: "center",
    alignItems: "center",
  },
  actionContent: {
    flex: 1,
  },
  actionLabel: {
    fontSize: fontSize.bodyLg,
    fontWeight: "600",
    color: colors.heading,
    marginBottom: spacing.xxs,
  },
  actionDesc: {
    fontSize: fontSize.sm,
    color: colors.muted,
  },
  // Danger zone
  dangerSection: {
    borderColor: colors.errorBorder,
  },
  deleteButton: {
    alignItems: "center",
    paddingVertical: spacing.sm,
  },
  deleteButtonText: {
    color: colors.error,
    fontSize: fontSize.bodyLg,
    fontWeight: "600",
    marginBottom: spacing.xs,
  },
  deleteButtonDesc: {
    color: colors.muted,
    fontSize: fontSize.sm,
    textAlign: "center",
  },
  detailsModalOverlay: {
    flex: 1,
    justifyContent: "flex-end",
    backgroundColor: "rgba(15, 23, 42, 0.45)",
  },
  detailsModalSheet: {
    maxHeight: "88%",
    backgroundColor: colors.background,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    borderWidth: 1,
    borderColor: colors.stone,
    overflow: "hidden",
  },
  detailsModalHandle: {
    alignSelf: "center",
    width: 40,
    height: 5,
    borderRadius: radius.full,
    backgroundColor: colors.stone,
    marginTop: spacing.element,
    marginBottom: spacing.tight,
  },
  detailsModalHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.screen,
    paddingBottom: spacing.content,
  },
  detailsModalTitle: {
    color: colors.heading,
    fontSize: fontSize.pageTitle,
    fontWeight: "700",
  },
  detailsModalClose: {
    width: 36,
    height: 36,
    borderRadius: radius.full,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.secondary,
  },
  detailsModalScroll: {
    flex: 1,
  },
  detailsModalScrollContent: {
    paddingHorizontal: spacing.screen,
    paddingBottom: spacing.xl,
  },
});

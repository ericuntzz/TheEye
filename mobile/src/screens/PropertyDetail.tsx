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
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useNavigation, useRoute, useFocusEffect } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import type { RouteProp } from "@react-navigation/native";
import { getProperty, updateProperty, deleteProperty } from "../lib/api";
import type { RootStackParamList } from "../navigation";
import { colors, radius, shadows } from '../lib/tokens';

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
    if (!name.trim()) {
      setError("Property name is required");
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
        bedrooms: bedrooms ? parseInt(bedrooms, 10) : null,
        bathrooms: bathrooms ? parseInt(bathrooms, 10) : null,
        squareFeet: squareFeet ? parseInt(squareFeet, 10) : null,
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

  const isTrained = trainingStatus === "trained";

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : "padding"}
        keyboardVerticalOffset={0}
      >
        {/* Header */}
        <View style={styles.header}>
          <TouchableOpacity
            style={styles.backButton}
            onPress={handleBack}
            activeOpacity={0.7}
          >
            <Text style={styles.backText}>{"\u2039"} Back</Text>
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
            <Text style={styles.screenTitle}>Edit Property</Text>
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
                style={{ marginTop: 8 }}
              >
                <Text style={styles.errorReportLink}>Report this issue</Text>
              </TouchableOpacity>
            </View>
          )}

          {/* Basic Info Section */}
          <Text style={styles.sectionTitle}>Basic Info</Text>
          <View style={styles.section}>
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

          {/* Location Section */}
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

          {/* Property Details Section */}
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

          {/* Quick Actions */}
          <Text style={styles.sectionTitle}>Actions</Text>
          <View style={styles.section}>
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
                  { backgroundColor: "rgba(77, 166, 255, 0.12)" },
                ]}
              >
                <Text style={[styles.actionIcon, { color: colors.primary }]}>
                  {"i"}
                </Text>
              </View>
              <View style={styles.actionContent}>
                <Text style={styles.actionLabel}>Inspection Details</Text>
                <Text style={styles.actionDesc}>
                  View and manage inspection reports and notes
                </Text>
              </View>
              <Text style={styles.actionChevron}>{">"}</Text>
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
                  <Text style={styles.actionIcon}>{">"}</Text>
                </View>
                <View style={styles.actionContent}>
                  <Text style={styles.actionLabel}>Start Inspection</Text>
                  <Text style={styles.actionDesc}>
                    Begin a new inspection of this property
                  </Text>
                </View>
                <Text style={styles.actionChevron}>{">"}</Text>
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
                  { backgroundColor: "rgba(168, 85, 247, 0.1)" },
                ]}
              >
                <Text style={[styles.actionIcon, { color: colors.purple }]}>
                  {"~"}
                </Text>
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
              <Text style={styles.actionChevron}>{">"}</Text>
            </TouchableOpacity>
          </View>

          {/* Danger Zone */}
          <Text style={[styles.sectionTitle, { color: colors.error }]}>
            Danger Zone
          </Text>
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
    paddingHorizontal: 20,
    paddingVertical: 10,
  },
  backButton: {
    paddingVertical: 4,
    paddingRight: 12,
  },
  backText: {
    color: colors.muted,
    fontSize: 16,
    fontWeight: "500",
  },
  saveButton: {
    backgroundColor: colors.primary,
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 10,
    minWidth: 70,
    alignItems: "center",
  },
  saveButtonDisabled: {
    opacity: 0.4,
  },
  saveText: {
    color: colors.primaryForeground,
    fontSize: 15,
    fontWeight: "600",
  },
  saveTextDisabled: {
    color: colors.primaryForeground,
  },

  // Scroll content
  scrollContent: {
    paddingHorizontal: 20,
  },

  // Title
  titleRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 20,
  },
  screenTitle: {
    fontSize: 28,
    fontWeight: "600",
    color: colors.heading,
    letterSpacing: -0.5,
  },
  statusBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
  },
  statusTrained: {
    backgroundColor: "rgba(34, 197, 94, 0.1)",
  },
  statusUntrained: {
    backgroundColor: "rgba(77, 166, 255, 0.1)",
  },
  statusDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
  },
  statusText: {
    fontSize: 12,
    fontWeight: "600",
    letterSpacing: 0.3,
  },

  // Error
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

  // Sections
  sectionTitle: {
    fontSize: 13,
    fontWeight: "600",
    color: colors.muted,
    letterSpacing: 0.5,
    textTransform: "uppercase",
    marginBottom: 10,
    marginTop: 8,
  },
  section: {
    backgroundColor: colors.card,
    borderRadius: 16,
    padding: 16,
    borderWidth: 1,
    borderColor: colors.stone,
    marginBottom: 20,
    gap: 16,
  },

  // Fields
  field: {
    gap: 6,
  },
  label: {
    fontSize: 12,
    fontWeight: "600",
    color: colors.muted,
    letterSpacing: 0.3,
    textTransform: "uppercase",
  },
  input: {
    backgroundColor: colors.secondary,
    borderWidth: 1,
    borderColor: colors.stone,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 13,
    color: colors.foreground,
    fontSize: 16,
    fontWeight: "500",
  },
  textArea: {
    minHeight: 80,
    paddingTop: 13,
  },
  rowFields: {
    flexDirection: "row",
    gap: 12,
  },

  // Property type picker
  typeRow: {
    gap: 8,
    paddingVertical: 2,
  },
  typeChip: {
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: 10,
    backgroundColor: "rgba(148, 163, 184, 0.06)",
    borderWidth: 1,
    borderColor: "rgba(148, 163, 184, 0.1)",
  },
  typeChipSelected: {
    backgroundColor: "rgba(77, 166, 255, 0.12)",
    borderColor: "rgba(77, 166, 255, 0.35)",
  },
  typeChipText: {
    color: colors.muted,
    fontSize: 14,
    fontWeight: "600",
  },
  typeChipTextSelected: {
    color: colors.primary,
  },

  // Actions
  actionRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    paddingVertical: 4,
  },
  actionIconCircle: {
    width: 40,
    height: 40,
    borderRadius: 12,
    backgroundColor: "rgba(34, 197, 94, 0.1)",
    justifyContent: "center",
    alignItems: "center",
  },
  actionIcon: {
    fontSize: 18,
    fontWeight: "600",
    color: colors.success,
  },
  actionContent: {
    flex: 1,
  },
  actionLabel: {
    fontSize: 16,
    fontWeight: "600",
    color: colors.heading,
    marginBottom: 2,
  },
  actionDesc: {
    fontSize: 13,
    color: colors.muted,
  },
  actionChevron: {
    color: colors.slate700,
    fontSize: 16,
    fontWeight: "600",
  },

  // Danger zone
  dangerSection: {
    borderColor: "rgba(239, 68, 68, 0.15)",
  },
  deleteButton: {
    alignItems: "center",
    paddingVertical: 8,
  },
  deleteButtonText: {
    color: colors.error,
    fontSize: 16,
    fontWeight: "600",
    marginBottom: 4,
  },
  deleteButtonDesc: {
    color: colors.muted,
    fontSize: 13,
    textAlign: "center",
  },
});

/**
 * AddItemComposer — Shared item creation/editing component
 *
 * Adapter-based: does NOT know whether it lives on the camera screen
 * or the summary screen. All context-specific behavior is provided
 * via capability props.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Image } from "expo-image";
import * as FileSystem from "expo-file-system";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import SupplyPicker, { type SupplyItem } from "./SupplyPicker";
import { colors, spacing, radius } from "../lib/tokens";
import type { AddItemType, FindingEvidenceItem } from "../lib/inspection/item-types";
import { EVIDENCE_CONSTRAINTS } from "../lib/inspection/item-types";
import {
  ADD_ITEM_TYPE_OPTIONS,
  buildItemDescription,
  getItemTypeAccent,
  getQuickAddTemplates,
  stripRestockQuantitySuffix,
} from "../lib/inspection/composer-utils";
import type { AddItemAttachmentDraft } from "../lib/inspection/composer-utils";

// ── Types ──────────────────────────────────────────────────────────────

export interface ComposerInitialValues {
  id?: string;
  itemType?: AddItemType;
  description?: string;
  quantity?: number;
  supplyItemId?: string;
  imageUrl?: string;
  videoUrl?: string;
  /** Pre-existing evidence items (for editing items with multiple attachments) */
  evidenceItems?: FindingEvidenceItem[];
}

export interface ComposerProps {
  /** Whether the composer is visible */
  visible: boolean;
  /** Initial values for editing an existing item */
  initialValues?: ComposerInitialValues;
  /** Whether this is editing an existing item (vs creating new) */
  isEditing: boolean;
  /** Supply catalog for the property */
  supplyCatalog?: SupplyItem[];

  // ── Capabilities ──
  canTakePhoto: boolean;
  canRecordVideo: boolean;
  canPickFromLibrary: boolean;
  canDictate: boolean;

  // ── Evidence capture callbacks ──
  onCapturePhoto?: () => Promise<{ uri: string } | null>;
  onCaptureVideo?: () => Promise<{ uri: string; durationMs?: number } | null>;
  onStopVideoCapture?: () => void;
  onPickExistingMedia?: () => Promise<
    Array<{ uri: string; kind: "photo" | "video" }> | null
  >;

  // ── Voice dictation ──
  onStartDictation?: () => Promise<boolean>;
  onStopDictation?: () => Promise<{ transcript?: string } | null>;
  isDictating?: boolean;

  // ── Lifecycle ──
  onSubmit: (result: ComposerResult) => Promise<void>;
  onCancel: () => void;
  isSubmitting: boolean;

  // ── Context ──
  roomName?: string | null;
  maxAttachments?: number;
}

export interface ComposerResult {
  itemType: AddItemType;
  description: string;
  quantity: number;
  supplyItem: SupplyItem | null;
  /** New local attachments to upload */
  attachments: AddItemAttachmentDraft[];
  /** Pre-existing evidence items to preserve (editing) */
  existingEvidence: FindingEvidenceItem[];
  /** @deprecated Single attachment for backward compat — prefer attachments[] */
  attachment: AddItemAttachmentDraft | null;
  /** @deprecated Single existing media for backward compat — prefer existingEvidence[] */
  existingMedia: { imageUrl?: string; videoUrl?: string } | null;
}

// ── Component ──────────────────────────────────────────────────────────

export default function AddItemComposer({
  visible,
  initialValues,
  isEditing,
  supplyCatalog = [],
  canTakePhoto,
  canRecordVideo,
  canPickFromLibrary,
  canDictate,
  onCapturePhoto,
  onCaptureVideo,
  onStopVideoCapture,
  onPickExistingMedia,
  onStartDictation,
  onStopDictation,
  isDictating = false,
  onSubmit,
  onCancel,
  isSubmitting,
  roomName,
  maxAttachments = EVIDENCE_CONSTRAINTS.maxTotalAttachments,
}: ComposerProps) {
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();

  const resolveSelectedSupply = useCallback(
    (supplyItemId?: string) => {
      if (!supplyItemId || supplyCatalog.length === 0) {
        return null;
      }
      return supplyCatalog.find((s) => s.id === supplyItemId) || null;
    },
    [supplyCatalog],
  );

  const getInitialDescription = useCallback(
    (values?: ComposerInitialValues) => {
      if (!values?.description) {
        return "";
      }
      return values.itemType === "restock"
        ? stripRestockQuantitySuffix(values.description)
        : values.description;
    },
    [],
  );

  // ── State ──
  const [itemType, setItemType] = useState<AddItemType>(
    initialValues?.itemType || "note",
  );
  const [noteText, setNoteText] = useState(getInitialDescription(initialValues));
  const [quantity, setQuantity] = useState(initialValues?.quantity || 1);
  const [selectedSupply, setSelectedSupply] = useState<SupplyItem | null>(() =>
    resolveSelectedSupply(initialValues?.supplyItemId),
  );
  const [showSupplyPicker, setShowSupplyPicker] = useState(
    () =>
      (initialValues?.itemType || "note") === "restock" && !selectedSupply,
  );
  const [attachments, setAttachments] = useState<AddItemAttachmentDraft[]>([]);
  const [existingEvidence, setExistingEvidence] = useState<FindingEvidenceItem[]>(() => {
    if (initialValues?.evidenceItems?.length) return initialValues.evidenceItems;
    // Legacy: convert imageUrl/videoUrl to evidence items
    const legacy: FindingEvidenceItem[] = [];
    if (initialValues?.imageUrl) {
      legacy.push({ id: `existing-photo-0`, kind: "photo", url: initialValues.imageUrl, uploadState: "uploaded", createdAt: new Date().toISOString() });
    }
    if (initialValues?.videoUrl) {
      legacy.push({ id: `existing-video-0`, kind: "video", url: initialValues.videoUrl, uploadState: "uploaded", createdAt: new Date().toISOString() });
    }
    return legacy;
  });
  const [isCapturingEvidence, setIsCapturingEvidence] = useState(false);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const recordingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!visible) {
      return;
    }

    const nextItemType = initialValues?.itemType || "note";
    const nextSelectedSupply = resolveSelectedSupply(initialValues?.supplyItemId);

    setItemType(nextItemType);
    setNoteText(getInitialDescription(initialValues));
    setQuantity(initialValues?.quantity || 1);
    setSelectedSupply(nextSelectedSupply);
    setShowSupplyPicker(nextItemType === "restock" && !nextSelectedSupply);
    setAttachments([]);
    // Rebuild existing evidence from initialValues
    if (initialValues?.evidenceItems?.length) {
      setExistingEvidence(initialValues.evidenceItems);
    } else {
      const legacy: FindingEvidenceItem[] = [];
      if (initialValues?.imageUrl) {
        legacy.push({ id: `existing-photo-0`, kind: "photo", url: initialValues.imageUrl, uploadState: "uploaded", createdAt: new Date().toISOString() });
      }
      if (initialValues?.videoUrl) {
        legacy.push({ id: `existing-video-0`, kind: "video", url: initialValues.videoUrl, uploadState: "uploaded", createdAt: new Date().toISOString() });
      }
      setExistingEvidence(legacy);
    }
    setIsCapturingEvidence(false);
    setRecordingSeconds(0);
    if (recordingTimerRef.current) {
      clearInterval(recordingTimerRef.current);
      recordingTimerRef.current = null;
    }
  }, [
    visible,
    initialValues?.id,
    initialValues?.itemType,
    initialValues?.description,
    initialValues?.quantity,
    initialValues?.supplyItemId,
    initialValues?.imageUrl,
    initialValues?.videoUrl,
    initialValues?.evidenceItems,
    getInitialDescription,
    resolveSelectedSupply,
  ]);

  useEffect(() => {
    return () => {
      if (recordingTimerRef.current) {
        clearInterval(recordingTimerRef.current);
        recordingTimerRef.current = null;
      }
    };
  }, []);

  // ── Derived ──
  const quickAddTemplates = useMemo(
    () => getQuickAddTemplates(itemType, roomName),
    [itemType, roomName],
  );

  const totalEvidenceCount = existingEvidence.length + attachments.length;
  const maxAttach = maxAttachments;
  const canAddMoreEvidence = totalEvidenceCount < maxAttach;

  const canSubmit =
    noteText.trim().length > 0 && !isSubmitting && !isDictating && !isCapturingEvidence;

  // ── Handlers ──
  const handleTypeChange = useCallback((newType: AddItemType) => {
    setItemType(newType);
    if (newType !== "restock") {
      setSelectedSupply(null);
      setShowSupplyPicker(false);
      setQuantity(1);
    }
  }, []);

  const handleCapturePhoto = useCallback(async () => {
    if (!onCapturePhoto || isSubmitting || isDictating || isCapturingEvidence) return;
    if (!canAddMoreEvidence) return;
    Keyboard.dismiss();
    try {
      const result = await onCapturePhoto();
      if (result?.uri) {
        setAttachments((prev) => [...prev, { kind: "photo", localUri: result.uri }]);
      }
    } catch {
      // Parent handles errors
    }
  }, [onCapturePhoto, isSubmitting, isDictating, isCapturingEvidence, canAddMoreEvidence]);

  const handleCaptureVideo = useCallback(async () => {
    if (!onCaptureVideo || isSubmitting || isDictating) return;

    if (isCapturingEvidence) {
      // Stop recording — parent will resolve the promise
      onStopVideoCapture?.();
      setIsCapturingEvidence(false);
      if (recordingTimerRef.current) {
        clearInterval(recordingTimerRef.current);
        recordingTimerRef.current = null;
      }
      return;
    }

    if (!canAddMoreEvidence) return;

    Keyboard.dismiss();
    setIsCapturingEvidence(true);
    setRecordingSeconds(0);
    recordingTimerRef.current = setInterval(() => {
      setRecordingSeconds((s) => s + 1);
    }, 1000);

    try {
      const result = await onCaptureVideo();
      if (result?.uri) {
        setAttachments((prev) => [...prev, { kind: "video", localUri: result.uri }]);
      }
    } catch {
      // Parent handles errors
    } finally {
      setIsCapturingEvidence(false);
      setRecordingSeconds(0);
      if (recordingTimerRef.current) {
        clearInterval(recordingTimerRef.current);
        recordingTimerRef.current = null;
      }
    }
  }, [onCaptureVideo, isSubmitting, isDictating, isCapturingEvidence, canAddMoreEvidence]);

  const handlePickMedia = useCallback(async () => {
    if (!onPickExistingMedia || isSubmitting || isDictating || isCapturingEvidence) return;
    if (!canAddMoreEvidence) return;
    Keyboard.dismiss();
    try {
      const results = await onPickExistingMedia();
      if (results && results.length > 0) {
        const remaining = maxAttach - totalEvidenceCount;
        const toAdd = results.slice(0, remaining).map((r) => ({
          kind: r.kind,
          localUri: r.uri,
        })) as AddItemAttachmentDraft[];
        setAttachments((prev) => [...prev, ...toAdd]);
      }
    } catch {
      // Parent handles errors
    }
  }, [onPickExistingMedia, isSubmitting, isDictating, isCapturingEvidence, canAddMoreEvidence, maxAttach, totalEvidenceCount]);

  const handleRemoveNewAttachment = useCallback((index: number) => {
    setAttachments((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const handleRemoveExistingEvidence = useCallback((id: string) => {
    setExistingEvidence((prev) => prev.filter((e) => e.id !== id));
  }, []);

  const handleDictation = useCallback(async () => {
    if (isDictating && onStopDictation) {
      const result = await onStopDictation();
      if (result?.transcript) {
        const transcript = result.transcript;
        setNoteText((prev) =>
          prev ? `${prev}\n${transcript}` : transcript,
        );
      }
    } else if (onStartDictation) {
      await onStartDictation();
    }
  }, [isDictating, onStartDictation, onStopDictation]);

  const handleSubmit = useCallback(async () => {
    if (!canSubmit) return;
    const description = buildItemDescription(
      noteText.trim(),
      itemType,
      quantity,
    );
    // Build backward-compat single attachment from first new attachment
    const firstAttachment = attachments[0] ?? null;
    // Build backward-compat existingMedia from first existing evidence
    const firstExistingPhoto = existingEvidence.find((e) => e.kind === "photo");
    const firstExistingVideo = existingEvidence.find((e) => e.kind === "video");
    const legacyExistingMedia =
      firstExistingPhoto || firstExistingVideo
        ? { imageUrl: firstExistingPhoto?.url, videoUrl: firstExistingVideo?.url }
        : null;

    await onSubmit({
      itemType,
      description,
      quantity,
      supplyItem: selectedSupply,
      attachments,
      existingEvidence,
      attachment: firstAttachment,
      existingMedia: legacyExistingMedia,
    });
  }, [
    canSubmit,
    noteText,
    itemType,
    quantity,
    selectedSupply,
    attachments,
    existingEvidence,
    onSubmit,
  ]);

  if (!visible) return null;

  const sheetMaxHeight = Math.min(windowHeight - Math.max(insets.top, 16) - spacing.screen, 720);
  const sheetMinHeight = Math.min(Math.max(430, windowHeight * 0.62), sheetMaxHeight);

  // ── Render ──
  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : "height"}
      style={[styles.overlay, StyleSheet.absoluteFill, { zIndex: 100 }]}
    >
      <View
        style={[
          styles.sheetContent,
          {
            maxHeight: sheetMaxHeight,
            minHeight: sheetMinHeight,
          },
        ]}
      >
        <View style={styles.sheetHandle} />
        <View style={styles.sheetHeader}>
          <Text style={styles.title}>
            {isEditing ? "Edit Item" : "Add Item"}
          </Text>
          {roomName && (
            <View style={styles.contextBadge}>
              <Ionicons
                name="location-outline"
                size={13}
                color={colors.muted}
              />
              <Text style={styles.contextText}>{roomName}</Text>
            </View>
          )}
        </View>

        <ScrollView
          style={styles.body}
          contentContainerStyle={styles.bodyContent}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
        >
          {/* Item type chips */}
          <View style={styles.chipRow}>
            {ADD_ITEM_TYPE_OPTIONS.map((type) => {
              const accent = getItemTypeAccent(type.key);
              const isActive = itemType === type.key;
              return (
                <TouchableOpacity
                  key={type.key}
                  onPress={() => handleTypeChange(type.key)}
                  activeOpacity={0.7}
                  style={[
                    styles.chip,
                    {
                      backgroundColor: isActive ? accent : `${accent}14`,
                      borderColor: isActive ? accent : `${accent}40`,
                    },
                  ]}
                >
                  <Ionicons
                    name={type.icon as keyof typeof Ionicons.glyphMap}
                    size={16}
                    color={isActive ? colors.camera.text : accent}
                  />
                  <Text
                    style={[
                      styles.chipText,
                      { color: isActive ? colors.camera.text : accent },
                    ]}
                  >
                    {type.label}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>

          {/* Restock helper */}
          {itemType === "restock" && (
            <View style={styles.helperBanner}>
              <Ionicons
                name="sparkles-outline"
                size={16}
                color={colors.success}
              />
              <Text style={styles.helperText}>
                Pick the exact supply when you can so Atria knows what to
                reorder.
              </Text>
            </View>
          )}

          {/* Quick add templates */}
          {quickAddTemplates.length > 0 && itemType !== "restock" && (
            <View style={styles.templatesSection}>
              <Text style={styles.miniLabel}>
                {itemType === "maintenance" ? "Common Issues" : "Quick Tasks"}
              </Text>
              <View style={styles.templateRow}>
                {quickAddTemplates.map((template) => (
                  <TouchableOpacity
                    key={template.id}
                    style={styles.templateChip}
                    onPress={() => setNoteText(template.value)}
                    activeOpacity={0.7}
                  >
                    <Ionicons
                      name={template.icon as keyof typeof Ionicons.glyphMap}
                      size={14}
                      color={getItemTypeAccent(itemType)}
                    />
                    <Text style={styles.templateText}>{template.label}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            </View>
          )}

          {/* Supply picker */}
          {itemType === "restock" &&
            showSupplyPicker &&
            supplyCatalog.length > 0 &&
            !selectedSupply && (
              <SupplyPicker
                items={supplyCatalog}
                onSelect={(item) => {
                  setSelectedSupply(item);
                  setNoteText(item.name);
                  if (item.defaultQuantity && item.defaultQuantity > 1) {
                    setQuantity(item.defaultQuantity);
                  } else {
                    setQuantity(1);
                  }
                  setShowSupplyPicker(false);
                }}
                onSkip={() => setShowSupplyPicker(false)}
              />
            )}

          {/* Custom restock fallback */}
          {itemType === "restock" &&
            !showSupplyPicker &&
            !selectedSupply && (
              <View style={styles.helperBannerMuted}>
                <Ionicons
                  name="create-outline"
                  size={16}
                  color={colors.muted}
                />
                <View style={{ flex: 1, gap: spacing.sm }}>
                  <Text style={styles.helperMutedText}>
                    Saving as a custom restock item. Use this when the property
                    does not have the exact supply in its catalog yet.
                  </Text>
                  {supplyCatalog.length > 0 && (
                    <TouchableOpacity
                      onPress={() => setShowSupplyPicker(true)}
                      activeOpacity={0.7}
                      style={styles.helperLinkButton}
                    >
                      <Text style={styles.helperLinkText}>
                        Pick from catalog instead
                      </Text>
                    </TouchableOpacity>
                  )}
                </View>
              </View>
            )}

          {/* Selected supply card */}
          {itemType === "restock" && selectedSupply && (
            <View style={styles.supplyCard}>
              <Ionicons
                name="checkmark-circle"
                size={18}
                color={colors.category.restock}
              />
              <View style={{ flex: 1 }}>
                <Text style={styles.supplyName}>{selectedSupply.name}</Text>
                <Text style={styles.supplyMeta}>
                  From catalog
                  {selectedSupply.amazonAsin ? " · Amazon linked" : ""}
                </Text>
              </View>
              <TouchableOpacity
                onPress={() => {
                  setSelectedSupply(null);
                  setShowSupplyPicker(true);
                  setNoteText("");
                  setQuantity(1);
                }}
                hitSlop={8}
              >
                <Ionicons
                  name="close-circle"
                  size={18}
                  color={colors.camera.textSubtle}
                />
              </TouchableOpacity>
            </View>
          )}

          {/* Voice dictation */}
          {canDictate && (
            <TouchableOpacity
              style={[
                styles.voiceButton,
                isDictating && styles.voiceButtonActive,
              ]}
              onPress={() => void handleDictation()}
              activeOpacity={0.7}
              disabled={isSubmitting || isCapturingEvidence}
            >
              <Ionicons
                name={isDictating ? "stop-circle" : "mic"}
                size={20}
                color={isDictating ? colors.camera.text : colors.primary}
              />
              <Text
                style={[
                  styles.voiceText,
                  isDictating && styles.voiceTextActive,
                ]}
              >
                {isDictating ? "Stop Recording" : "Tap to Dictate"}
              </Text>
            </TouchableOpacity>
          )}

          {/* Text input */}
          <View style={styles.inputSection}>
            <Text style={styles.miniLabel}>
              {itemType === "restock"
                ? "Item"
                : itemType === "maintenance"
                  ? "Issue"
                  : itemType === "task"
                    ? "Task"
                    : "Note"}
            </Text>
            <TextInput
              style={styles.noteInput}
              placeholder={
                itemType === "restock"
                  ? "e.g. Hand soap, toilet paper, coffee pods"
                  : itemType === "maintenance"
                    ? "e.g. Leaky faucet in master bath"
                    : itemType === "task"
                      ? "e.g. Replace HVAC filter, check smoke detectors"
                      : "e.g. Water stain on ceiling near AC vent"
              }
              placeholderTextColor={colors.slate500}
              value={noteText}
              onChangeText={(text) => {
                setNoteText(text);
                if (
                  selectedSupply &&
                  text.trim() !== selectedSupply.name.trim()
                ) {
                  setSelectedSupply(null);
                }
              }}
              multiline
              maxLength={500}
            />
          </View>

          {/* Quantity (restock only) */}
          {itemType === "restock" && (
            <View style={styles.quantityRow}>
              <Text style={styles.quantityLabel}>Quantity needed</Text>
              <View style={styles.quantityControls}>
                <TouchableOpacity
                  onPress={() => setQuantity((q) => Math.max(1, q - 1))}
                  style={styles.quantityButton}
                >
                  <Ionicons name="remove" size={18} color={colors.primary} />
                </TouchableOpacity>
                <Text style={styles.quantityValue}>{quantity}</Text>
                <TouchableOpacity
                  onPress={() => setQuantity((q) => Math.min(99, q + 1))}
                  style={styles.quantityButton}
                >
                  <Ionicons name="add" size={18} color={colors.primary} />
                </TouchableOpacity>
              </View>
            </View>
          )}

          {/* Evidence */}
          <View style={styles.evidenceSection}>
            <View style={styles.evidenceHeader}>
              <Text style={styles.miniLabel}>Evidence</Text>
            </View>
            <View style={styles.evidenceActionsRow}>
              {canTakePhoto && (
                <TouchableOpacity
                  style={[styles.evidenceAction, !canAddMoreEvidence && styles.buttonDisabled]}
                  onPress={() => void handleCapturePhoto()}
                  activeOpacity={0.7}
                  disabled={isSubmitting || isDictating || isCapturingEvidence || !canAddMoreEvidence}
                >
                  <Ionicons
                    name="camera-outline"
                    size={16}
                    color={colors.primary}
                  />
                  <Text style={styles.evidenceActionText}>Take Photo</Text>
                </TouchableOpacity>
              )}
              {canRecordVideo && (
                <TouchableOpacity
                  style={[
                    styles.evidenceAction,
                    isCapturingEvidence && styles.evidenceActionDanger,
                  ]}
                  onPress={() => void handleCaptureVideo()}
                  activeOpacity={0.7}
                  disabled={isSubmitting || isDictating}
                >
                  <Ionicons
                    name={
                      isCapturingEvidence
                        ? "stop-circle-outline"
                        : "videocam-outline"
                    }
                    size={16}
                    color={
                      isCapturingEvidence
                        ? colors.camera.text
                        : colors.primary
                    }
                  />
                  <Text
                    style={[
                      styles.evidenceActionText,
                      isCapturingEvidence && styles.evidenceActionTextDanger,
                    ]}
                  >
                    {isCapturingEvidence
                      ? `Stop ${Math.floor(recordingSeconds / 60)}:${String(recordingSeconds % 60).padStart(2, "0")}`
                      : "Record Video"}
                  </Text>
                </TouchableOpacity>
              )}
              {canPickFromLibrary && (
                <TouchableOpacity
                  style={[styles.evidenceAction, !canAddMoreEvidence && styles.buttonDisabled]}
                  onPress={() => void handlePickMedia()}
                  activeOpacity={0.7}
                  disabled={isSubmitting || isDictating || isCapturingEvidence || !canAddMoreEvidence}
                >
                  <Ionicons
                    name="images-outline"
                    size={16}
                    color={colors.primary}
                  />
                  <Text style={styles.evidenceActionText}>Add Existing</Text>
                </TouchableOpacity>
              )}
            </View>

            {/* Evidence count + constraint hint */}
            {totalEvidenceCount > 0 && (
              <Text style={styles.evidenceCount}>
                {totalEvidenceCount} / {maxAttach} attachments
              </Text>
            )}

            {/* Existing evidence items */}
            {existingEvidence.map((ev) => (
              <View key={ev.id} style={styles.attachmentCard}>
                {ev.kind === "photo" && ev.url ? (
                  <Image
                    source={{ uri: ev.url }}
                    style={styles.attachmentPreview}
                    contentFit="cover"
                  />
                ) : (
                  <View style={styles.videoAttachmentBadge}>
                    <Ionicons name="videocam" size={18} color={colors.primary} />
                  </View>
                )}
                <View style={{ flex: 1 }}>
                  <Text style={styles.attachmentTitle}>
                    {ev.kind === "photo" ? "Photo" : "Video"}
                  </Text>
                  <Text style={styles.attachmentMeta}>Already saved</Text>
                </View>
                <TouchableOpacity
                  onPress={() => handleRemoveExistingEvidence(ev.id)}
                  style={styles.removeButton}
                  hitSlop={8}
                >
                  <Ionicons name="trash-outline" size={16} color={colors.error} />
                </TouchableOpacity>
              </View>
            ))}

            {/* New attachment items */}
            {attachments.map((att, idx) => (
              <View key={`new-${idx}`} style={styles.attachmentCard}>
                {att.kind === "photo" ? (
                  <Image
                    source={{ uri: att.localUri }}
                    style={styles.attachmentPreview}
                    contentFit="cover"
                  />
                ) : (
                  <View style={styles.videoAttachmentBadge}>
                    <Ionicons name="videocam" size={18} color={colors.primary} />
                  </View>
                )}
                <View style={{ flex: 1 }}>
                  <Text style={styles.attachmentTitle}>
                    {att.kind === "photo" ? "Photo" : "Video"}
                  </Text>
                  <Text style={styles.attachmentMeta}>Ready to upload</Text>
                </View>
                <TouchableOpacity
                  onPress={() => handleRemoveNewAttachment(idx)}
                  style={styles.removeButton}
                  hitSlop={8}
                >
                  <Ionicons name="trash-outline" size={16} color={colors.error} />
                </TouchableOpacity>
              </View>
            ))}
          </View>
        </ScrollView>

        {/* Footer */}
        <View
          style={[
            styles.footer,
            { paddingBottom: Math.max(insets.bottom, 16) },
          ]}
        >
          <View style={styles.footerButtons}>
            <TouchableOpacity
              style={[
                styles.cancelButton,
                isSubmitting && styles.buttonDisabled,
              ]}
              onPress={() => {
                // Clean up local attachment files to prevent temp file leaks
                for (const att of attachments) {
                  FileSystem.deleteAsync(att.localUri, { idempotent: true }).catch(() => {});
                }
                onCancel();
              }}
              disabled={isSubmitting}
            >
              <Text style={styles.cancelText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[
                styles.submitButton,
                !canSubmit && styles.buttonDisabled,
              ]}
              onPress={() => void handleSubmit()}
              disabled={!canSubmit}
            >
              {isSubmitting ? (
                <ActivityIndicator
                  size="small"
                  color={colors.primaryForeground}
                />
              ) : (
                <Text style={styles.submitText}>
                  {isEditing
                    ? "Save Changes"
                    : itemType === "restock"
                      ? "Add Restock Item"
                      : itemType === "maintenance"
                        ? "Add Issue"
                        : itemType === "task"
                          ? "Add Task"
                          : "Save Note"}
                </Text>
              )}
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

// ── Styles ──────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    justifyContent: "flex-end",
    backgroundColor: colors.camera.overlay,
  },
  sheetContent: {
    backgroundColor: colors.card,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    borderWidth: 1,
    borderColor: colors.stone,
    overflow: "hidden",
    width: "100%",
  },
  sheetHandle: {
    alignSelf: "center",
    width: 40,
    height: 5,
    borderRadius: radius.full,
    backgroundColor: colors.stone,
    marginTop: spacing.element,
    marginBottom: spacing.tight,
  },
  sheetHeader: {
    paddingHorizontal: spacing.screen,
    paddingTop: spacing.xs,
    paddingBottom: spacing.content,
  },
  title: {
    color: colors.heading,
    fontSize: 20,
    fontWeight: "700",
    letterSpacing: -0.3,
  },
  contextBadge: {
    alignSelf: "flex-start",
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.tight,
    marginTop: 2,
  },
  contextText: {
    color: colors.muted,
    fontSize: 11,
    fontWeight: "500",
  },
  body: {
    flex: 1,
  },
  bodyContent: {
    flexGrow: 1,
    paddingHorizontal: spacing.screen,
    paddingBottom: spacing.xl,
    gap: spacing.card,
  },
  footer: {
    paddingHorizontal: spacing.screen,
    paddingTop: spacing.content,
    borderTopWidth: 1,
    borderTopColor: colors.stone,
    backgroundColor: colors.card,
  },
  footerButtons: {
    flexDirection: "column",
    gap: spacing.sm,
  },
  chipRow: {
    flexDirection: "row",
    gap: spacing.sm,
    flexWrap: "wrap",
  },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.tight,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.card,
    borderRadius: radius.full,
    borderWidth: 1,
  },
  chipText: {
    fontWeight: "600",
    fontSize: 13,
  },
  helperBanner: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: spacing.sm,
    padding: spacing.content,
    borderRadius: radius.lg,
    backgroundColor: colors.successBg,
    borderWidth: 1,
    borderColor: colors.successBorder,
  },
  helperText: {
    flex: 1,
    color: colors.success,
    fontSize: 13,
    lineHeight: 18,
    fontWeight: "500",
  },
  helperBannerMuted: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: spacing.sm,
    padding: spacing.content,
    borderRadius: radius.lg,
    backgroundColor: colors.secondary,
    borderWidth: 1,
    borderColor: colors.stone,
  },
  helperMutedText: {
    flex: 1,
    color: colors.muted,
    fontSize: 13,
    lineHeight: 18,
  },
  helperLinkButton: {
    alignSelf: "flex-start",
    paddingHorizontal: spacing.element,
    paddingVertical: spacing.tight,
    borderRadius: radius.full,
    backgroundColor: colors.primaryBgStrong,
  },
  helperLinkText: {
    color: colors.primary,
    fontSize: 12,
    fontWeight: "700",
  },
  templatesSection: {
    gap: spacing.sm,
  },
  templateRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.sm,
  },
  templateChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.tight,
    paddingHorizontal: spacing.element,
    paddingVertical: spacing.sm,
    borderRadius: radius.full,
    backgroundColor: colors.secondary,
    borderWidth: 1,
    borderColor: colors.stone,
  },
  templateText: {
    color: colors.heading,
    fontSize: 13,
    fontWeight: "600",
  },
  miniLabel: {
    color: colors.muted,
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 0.4,
    textTransform: "uppercase",
  },
  supplyCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    backgroundColor: colors.successBg,
    borderRadius: radius.md,
    padding: spacing.element,
    borderWidth: 1,
    borderColor: colors.successBorder,
  },
  supplyName: {
    color: colors.heading,
    fontSize: 14,
    fontWeight: "600",
  },
  supplyMeta: {
    color: colors.muted,
    fontSize: 11,
  },
  voiceButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.sm,
    paddingVertical: spacing.element,
    paddingHorizontal: spacing.md,
    borderRadius: radius.full,
    backgroundColor: colors.primaryBg,
    alignSelf: "center",
  },
  voiceButtonActive: {
    backgroundColor: colors.destructive,
  },
  voiceText: {
    color: colors.primary,
    fontWeight: "600",
    fontSize: 14,
  },
  voiceTextActive: {
    color: colors.camera.text,
  },
  inputSection: {
    gap: spacing.sm,
  },
  noteInput: {
    borderWidth: 1,
    borderColor: colors.stone,
    borderRadius: radius.lg,
    paddingHorizontal: spacing.card,
    paddingTop: spacing.content,
    paddingBottom: spacing.content,
    fontSize: 15,
    lineHeight: 22,
    color: colors.foreground,
    backgroundColor: colors.card,
    minHeight: 64,
    maxHeight: 120,
    textAlignVertical: "top",
  },
  quantityRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: colors.secondary,
    borderRadius: radius.lg,
    paddingHorizontal: spacing.card,
    paddingVertical: spacing.content,
    borderWidth: 1,
    borderColor: colors.stone,
  },
  quantityLabel: {
    color: colors.heading,
    fontSize: 14,
    fontWeight: "600",
  },
  quantityControls: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.content,
  },
  quantityButton: {
    width: 44,
    height: 44,
    borderRadius: radius.full,
    backgroundColor: colors.primaryBg,
    alignItems: "center",
    justifyContent: "center",
  },
  quantityValue: {
    minWidth: 24,
    textAlign: "center",
    color: colors.heading,
    fontSize: 18,
    fontWeight: "700",
  },
  evidenceSection: {
    gap: spacing.element,
    padding: spacing.card,
    borderRadius: 14,
    backgroundColor: colors.secondary,
    borderWidth: 1,
    borderColor: colors.stone,
  },
  evidenceHeader: {
    gap: spacing.xs,
  },
  evidenceCount: {
    color: colors.muted,
    fontSize: 12,
    fontWeight: "500",
  },
  evidenceActionsRow: {
    flexDirection: "row",
    gap: spacing.element,
    flexWrap: "wrap",
  },
  evidenceAction: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.tight,
    paddingHorizontal: spacing.content,
    paddingVertical: spacing.element,
    minHeight: 44,
    borderRadius: radius.md,
    backgroundColor: colors.primaryBgStrong,
    borderWidth: 1,
    borderColor: colors.primaryBorder,
  },
  evidenceActionDanger: {
    backgroundColor: colors.destructive,
    borderColor: colors.destructive,
  },
  evidenceActionText: {
    color: colors.primary,
    fontSize: 13,
    fontWeight: "600",
  },
  evidenceActionTextDanger: {
    color: colors.camera.text,
  },
  attachmentCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.element,
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.stone,
    padding: spacing.element,
  },
  attachmentPreview: {
    width: 58,
    height: 58,
    borderRadius: radius.md,
    backgroundColor: colors.stone,
  },
  videoAttachmentBadge: {
    width: 58,
    height: 58,
    borderRadius: radius.md,
    backgroundColor: colors.primaryBgStrong,
    alignItems: "center",
    justifyContent: "center",
  },
  attachmentTitle: {
    color: colors.heading,
    fontSize: 14,
    fontWeight: "600",
  },
  attachmentMeta: {
    color: colors.muted,
    fontSize: 12,
    marginTop: spacing.xxs,
  },
  removeButton: {
    width: 32,
    height: 32,
    borderRadius: radius.full,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.errorBg,
  },
  cancelButton: {
    paddingVertical: spacing.card,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.lg,
    backgroundColor: colors.secondary,
    alignItems: "center",
  },
  cancelText: {
    color: colors.foreground,
    fontSize: 15,
    fontWeight: "600",
  },
  submitButton: {
    paddingVertical: spacing.card,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.lg,
    backgroundColor: colors.primary,
    alignItems: "center",
  },
  buttonDisabled: {
    opacity: 0.4,
  },
  submitText: {
    color: colors.primaryForeground,
    fontSize: 15,
    fontWeight: "600",
  },
});

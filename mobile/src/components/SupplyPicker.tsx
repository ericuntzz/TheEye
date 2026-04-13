import React, { useMemo, useState } from "react";
import {
  FlatList,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { colors, radius, fontSize, spacing } from "../lib/tokens";

export interface SupplyItem {
  id: string;
  name: string;
  category: string;
  amazonAsin?: string | null;
  defaultQuantity?: number;
  unit?: string;
  roomId?: string | null;
}

interface Props {
  items: SupplyItem[];
  onSelect: (item: SupplyItem) => void;
  onSkip: () => void;
}

/**
 * Inline supply catalog picker shown in the Add Item → Restock flow.
 * Shows a searchable list of supply items from the property's catalog.
 * User can pick one (auto-fills name + ASIN) or tap "Custom item" to skip.
 */
export default function SupplyPicker({ items, onSelect, onSkip }: Props) {
  const [search, setSearch] = useState("");

  const filtered = useMemo(() => {
    if (!search.trim()) return items;
    const q = search.toLowerCase().trim();
    return items.filter(
      (item) =>
        item.name.toLowerCase().includes(q) ||
        item.category.toLowerCase().includes(q),
    );
  }, [items, search]);

  const CATEGORY_ICONS: Record<string, keyof typeof Ionicons.glyphMap> = {
    toiletry: "water-outline",
    cleaning: "sparkles-outline",
    linen: "bed-outline",
    kitchen: "restaurant-outline",
    amenity: "gift-outline",
    maintenance: "construct-outline",
    other: "ellipsis-horizontal-outline",
  };

  return (
    <View style={styles.container}>
      <Text style={styles.label}>Select from catalog</Text>

      <View style={styles.searchRow}>
        <Ionicons name="search" size={16} color={colors.slate500} />
        <TextInput
          style={styles.searchInput}
          placeholder="Search supplies..."
          placeholderTextColor={colors.slate500}
          value={search}
          onChangeText={setSearch}
          autoCorrect={false}
        />
        {search.length > 0 && (
          <TouchableOpacity onPress={() => setSearch("")} hitSlop={8}>
            <Ionicons name="close-circle" size={16} color={colors.slate500} />
          </TouchableOpacity>
        )}
      </View>

      <FlatList
        data={filtered}
        keyExtractor={(item) => item.id}
        style={styles.list}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        ListEmptyComponent={
          <Text style={styles.emptyText}>
            {search ? "No matching items" : "No supply items in catalog"}
          </Text>
        }
        renderItem={({ item }) => (
          <TouchableOpacity
            style={styles.itemRow}
            onPress={() => onSelect(item)}
            activeOpacity={0.7}
          >
            <Ionicons
              name={CATEGORY_ICONS[item.category] || "cube-outline"}
              size={18}
              color={colors.primary}
            />
            <View style={styles.itemInfo}>
              <Text style={styles.itemName} numberOfLines={1}>
                {item.name}
              </Text>
              <Text style={styles.itemMeta}>
                {item.category}
                {item.amazonAsin ? " · Amazon" : ""}
                {item.defaultQuantity && item.defaultQuantity > 1
                  ? ` · ×${item.defaultQuantity}`
                  : ""}
              </Text>
            </View>
            <Ionicons name="add-circle-outline" size={20} color={colors.category.restock} />
          </TouchableOpacity>
        )}
      />

      <TouchableOpacity
        style={styles.skipButton}
        onPress={onSkip}
        activeOpacity={0.7}
      >
        <Ionicons name="create-outline" size={16} color={colors.primary} />
        <Text style={styles.skipText}>Custom item instead</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    maxHeight: 260,
    marginBottom: spacing.sm,
  },
  label: {
    color: colors.slate300,
    fontSize: fontSize.caption,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: spacing.tight,
  },
  searchRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    backgroundColor: colors.primaryBg,
    borderRadius: radius.md,
    paddingHorizontal: spacing.element,
    paddingVertical: spacing.tight,
    marginBottom: spacing.tight,
    borderWidth: 1,
    borderColor: colors.primaryBgStrong,
  },
  searchInput: {
    flex: 1,
    color: colors.camera.textBody,
    fontSize: fontSize.label,
    paddingVertical: spacing.xxs,
  },
  list: {
    maxHeight: 180,
  },
  itemRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.element,
    paddingVertical: spacing.element,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.md,
    backgroundColor: colors.camera.overlayCardLight,
    marginBottom: spacing.xs,
    borderWidth: 1,
    borderColor: colors.camera.borderSubtle,
  },
  itemInfo: {
    flex: 1,
  },
  itemName: {
    color: colors.camera.textBody,
    fontSize: fontSize.label,
    fontWeight: "600",
  },
  itemMeta: {
    color: colors.camera.textSubtle,
    fontSize: fontSize.micro,
    marginTop: 1,
    textTransform: "capitalize",
  },
  emptyText: {
    color: colors.slate500,
    fontSize: fontSize.sm,
    textAlign: "center",
    paddingVertical: spacing.screen,
  },
  skipButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.tight,
    paddingVertical: spacing.element,
    marginTop: spacing.xs,
  },
  skipText: {
    color: colors.primary,
    fontSize: fontSize.sm,
    fontWeight: "600",
  },
});

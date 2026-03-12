import React, { useCallback, useState } from "react";
import { View, Text, TouchableOpacity, StyleSheet, ActivityIndicator } from "react-native";
import type { ImageSourceType } from "../lib/image-source/types";
import { bleManagerService } from "../lib/ble/ble-manager";
import { colors } from "../lib/tokens";

interface Props {
  selected: ImageSourceType;
  onSelect: (source: ImageSourceType) => void;
}

export default function DevicePicker({ selected, onSelect }: Props) {
  const [isScanning, setIsScanning] = useState(false);
  const [frameFound, setFrameFound] = useState(false);
  const [openGlassFound, setOpenGlassFound] = useState(false);
  const [scanMessage, setScanMessage] = useState<string | null>(null);

  const handleScan = useCallback(async () => {
    setIsScanning(true);
    try {
      const devices = await bleManagerService.scanInspectionDevices(5000);
      setFrameFound(devices.some((d) => d.sourceType === "frame"));
      setOpenGlassFound(devices.some((d) => d.sourceType === "openglass"));
      if (devices.length === 0) {
        setScanMessage("No compatible glasses found nearby.");
      } else {
        setScanMessage(`Found ${devices.length} nearby BLE device(s).`);
      }
    } catch {
      setScanMessage("Scanning failed. Bluetooth may be unavailable on this device.");
    } finally {
      setIsScanning(false);
    }
  }, []);

  return (
    <View style={styles.container}>
      <Text style={styles.label}>Capture Device</Text>
      <View style={styles.row}>
        <Option
          label="Phone"
          subtitle="Default"
          selected={selected === "camera"}
          onPress={() => onSelect("camera")}
        />
        <Option
          label="Frame"
          subtitle={frameFound ? "Detected" : "Not detected"}
          selected={selected === "frame"}
          onPress={() => onSelect("frame")}
        />
        <Option
          label="OpenGlass"
          subtitle={openGlassFound ? "Detected" : "Not detected"}
          selected={selected === "openglass"}
          onPress={() => onSelect("openglass")}
        />
      </View>
      <TouchableOpacity
        style={styles.scanButton}
        onPress={handleScan}
        disabled={isScanning}
        activeOpacity={0.8}
        accessibilityRole="button"
        accessibilityLabel="Scan for smart glasses"
      >
        {isScanning ? (
          <ActivityIndicator color={colors.primaryForeground} />
        ) : (
          <Text style={styles.scanButtonText}>Scan for Glasses</Text>
        )}
      </TouchableOpacity>
      {scanMessage ? <Text style={styles.scanMessage}>{scanMessage}</Text> : null}
      {selected !== "camera" && (
        <Text style={styles.previewHint}>
          Glasses sources are in preview mode. Phone camera remains fallback for high-detail capture.
        </Text>
      )}
    </View>
  );
}

function Option({
  label,
  subtitle,
  selected,
  onPress,
}: {
  label: string;
  subtitle: string;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity
      style={[styles.option, selected && styles.optionSelected]}
      onPress={onPress}
      activeOpacity={0.8}
      accessibilityRole="button"
      accessibilityLabel={`${label} capture source`}
      accessibilityState={{ selected }}
    >
      <Text
        style={[styles.optionLabel, selected && styles.optionLabelSelected]}
        numberOfLines={1}
      >
        {label}
      </Text>
      <Text style={styles.optionSubtitle} numberOfLines={1}>
        {subtitle}
      </Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: colors.card,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.stone,
    padding: 12,
    marginBottom: 16,
  },
  label: {
    color: colors.muted,
    fontSize: 12,
    fontWeight: "600",
    marginBottom: 10,
    letterSpacing: 0.2,
    textTransform: "uppercase",
  },
  row: {
    flexDirection: "row",
    gap: 8,
  },
  option: {
    flex: 1,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.stone,
    backgroundColor: colors.secondary,
    minHeight: 52,
    paddingVertical: 10,
    paddingHorizontal: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  optionSelected: {
    borderColor: colors.primary,
    backgroundColor: "rgba(77, 166, 255, 0.08)",
  },
  optionLabel: {
    color: colors.heading,
    fontSize: 13,
    fontWeight: "600",
  },
  optionLabelSelected: {
    color: colors.primary,
  },
  optionSubtitle: {
    marginTop: 4,
    color: colors.muted,
    fontSize: 11,
  },
  scanButton: {
    marginTop: 10,
    borderRadius: 10,
    backgroundColor: colors.primary,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 10,
  },
  scanButtonText: {
    color: colors.primaryForeground,
    fontSize: 13,
    fontWeight: "600",
  },
  scanMessage: {
    marginTop: 8,
    color: colors.muted,
    fontSize: 12,
  },
  previewHint: {
    marginTop: 6,
    color: colors.muted,
    fontSize: 12,
  },
});

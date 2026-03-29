import { requireOptionalNativeModule } from "expo-modules-core";

export interface FeatureCapability {
  supported: boolean;
  optimized: boolean;
  reason?: string;
  recoveryHint?: string;
}

const hasExpoAvNativeModule = Boolean(requireOptionalNativeModule("ExponentAV"));
const hasVideoThumbnailsNativeModule = Boolean(
  requireOptionalNativeModule("ExpoVideoThumbnails"),
);

export const buildCapabilities = Object.freeze({
  hasExpoAvNativeModule,
  hasVideoThumbnailsNativeModule,
});

const DEV_BUILD_HINT =
  "Open the latest Atria dev build instead of Expo Go or an older preview client.";

export function getVideoTrainingCapability(): FeatureCapability {
  if (!buildCapabilities.hasVideoThumbnailsNativeModule) {
    return {
      supported: false,
      optimized: false,
      reason:
        "Video training is unavailable in this build because it cannot extract training frames from video.",
      recoveryHint: DEV_BUILD_HINT,
    };
  }

  if (!buildCapabilities.hasExpoAvNativeModule) {
    // Video thumbnails work but we can't read video duration for extended sampling.
    // This is fine for clips under 60s (our recording cap). Don't alarm the user.
    return {
      supported: true,
      optimized: false,
      reason: undefined,
      recoveryHint: "Short, steady clips produce the best training frames.",
    };
  }

  return { supported: true, optimized: true };
}

export function getVoiceNotesCapability(): FeatureCapability {
  if (!buildCapabilities.hasExpoAvNativeModule) {
    return {
      supported: false,
      optimized: false,
      reason: "Voice notes are unavailable in this build.",
      recoveryHint: DEV_BUILD_HINT,
    };
  }

  return { supported: true, optimized: true };
}

export function getInspectionAiBuildRequirement(): string {
  return `AI inspection requires the Atria dev build. ${DEV_BUILD_HINT}`;
}


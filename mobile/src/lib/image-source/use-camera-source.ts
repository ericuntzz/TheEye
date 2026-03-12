import { useMemo } from "react";
import type { RefObject } from "react";
import type { CameraView } from "expo-camera";
import type { ImageSource } from "./types";

export function useCameraSource(
  cameraRef: RefObject<CameraView | null>,
): ImageSource {
  return useMemo(
    () => ({
      type: "camera",
      label: "Phone Camera",
      isConnected: true,
      async start() {},
      async stop() {},
      async capturePreviewFrame() {
        const camera = cameraRef.current;
        if (!camera) return null;
        try {
          const photo = await camera.takePictureAsync({
            quality: 0.35,
            base64: true,
          });
          if (!photo?.base64) return null;
          return {
            base64: photo.base64,
            timestamp: Date.now(),
            width: photo.width,
            height: photo.height,
          };
        } catch {
          return null;
        }
      },
      async captureHighResFrame() {
        const camera = cameraRef.current;
        if (!camera) return null;
        try {
          const photo = await camera.takePictureAsync({
            quality: 0.75,
            base64: true,
          });
          if (!photo?.base64) return null;
          return {
            base64: photo.base64,
            timestamp: Date.now(),
            width: photo.width,
            height: photo.height,
          };
        } catch {
          return null;
        }
      },
    }),
    [cameraRef],
  );
}

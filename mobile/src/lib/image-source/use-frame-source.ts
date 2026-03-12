import { useMemo } from "react";
import { frameDriver } from "../ble/frame-driver";
import type { ImageSource } from "./types";

export function useFrameSource(): ImageSource {
  return useMemo(
    () => ({
      type: "frame",
      label: "Brilliant Frame",
      get isConnected() {
        return frameDriver.isConnected();
      },
      async start() {},
      async stop() {
        await frameDriver.disconnect();
      },
      async capturePreviewFrame() {
        const base64 = await frameDriver.captureSnapshot();
        if (!base64) return null;
        return { base64, timestamp: Date.now() };
      },
      async captureHighResFrame() {
        const base64 = await frameDriver.captureSnapshot();
        if (!base64) return null;
        return { base64, timestamp: Date.now() };
      },
    }),
    [],
  );
}

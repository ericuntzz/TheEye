import { useMemo } from "react";
import { openGlassDriver } from "../ble/openglass-driver";
import type { ImageSource } from "./types";

export function useOpenGlassSource(): ImageSource {
  return useMemo(
    () => ({
      type: "openglass",
      label: "OpenGlass",
      get isConnected() {
        return openGlassDriver.isConnected();
      },
      async start() {},
      async stop() {
        await openGlassDriver.disconnect();
      },
      async capturePreviewFrame() {
        const base64 = await openGlassDriver.captureSnapshot();
        if (!base64) return null;
        return { base64, timestamp: Date.now() };
      },
      async captureHighResFrame() {
        const base64 = await openGlassDriver.captureSnapshot();
        if (!base64) return null;
        return { base64, timestamp: Date.now() };
      },
    }),
    [],
  );
}

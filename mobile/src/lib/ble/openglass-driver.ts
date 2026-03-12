import { bleManagerService } from "./ble-manager";

export const OPENGLASS_SERVICE_UUID = "19b10000-e8f2-537e-4f6c-d104768a1214";

export class OpenGlassDriver {
  private connectedDeviceId: string | null = null;

  async connect(deviceId: string): Promise<boolean> {
    const connected = await bleManagerService.connect(deviceId);
    if (connected) {
      this.connectedDeviceId = deviceId;
    }
    return connected;
  }

  async disconnect(): Promise<void> {
    if (!this.connectedDeviceId) return;
    await bleManagerService.disconnect(this.connectedDeviceId);
    this.connectedDeviceId = null;
  }

  isConnected(): boolean {
    return this.connectedDeviceId !== null;
  }

  async captureSnapshot(): Promise<string | null> {
    // OpenGlass chunked JPEG transfer integration is planned.
    // Return null for now and allow camera fallback.
    return null;
  }
}

export const openGlassDriver = new OpenGlassDriver();

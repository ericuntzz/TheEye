import { bleManagerService } from "./ble-manager";

export const FRAME_SERVICE_UUID = "7a230001-5475-a6a4-654c-8431f6ad49c4";

export class FrameDriver {
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
    // Frame integration protocol to stream/reassemble JPEG chunks is planned.
    // For now we return null so callers gracefully fall back to phone camera.
    return null;
  }
}

export const frameDriver = new FrameDriver();

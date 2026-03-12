import type { ImageSourceType } from "../image-source/types";

export interface DiscoveredDevice {
  id: string;
  name: string;
  rssi: number | null;
  sourceType: Exclude<ImageSourceType, "camera"> | "unknown";
}

const FRAME_SERVICE_UUID = "7a230001-5475-a6a4-654c-8431f6ad49c4";
const OPENGLASS_SERVICE_UUID = "19b10000-e8f2-537e-4f6c-d104768a1214";

export class BleManagerService {
  private manager: any | null = null;

  async ensureManager(): Promise<boolean> {
    if (this.manager) return true;
    try {
      const module = await import("react-native-ble-plx");
      this.manager = new module.BleManager();
      return true;
    } catch {
      return false;
    }
  }

  async scanInspectionDevices(timeoutMs: number = 6000): Promise<DiscoveredDevice[]> {
    const ready = await this.ensureManager();
    if (!ready || !this.manager) return [];

    const discovered = new Map<string, DiscoveredDevice>();

    await new Promise<void>((resolve) => {
      const stop = () => {
        try {
          this.manager?.stopDeviceScan();
        } catch {
          // ignore
        }
        resolve();
      };

      const timer = setTimeout(stop, timeoutMs);
      this.manager.startDeviceScan(
        null,
        { allowDuplicates: false },
        (error: unknown, device: any) => {
          if (error) {
            clearTimeout(timer);
            stop();
            return;
          }
          if (!device?.id) return;

          const serviceUuids = Array.isArray(device.serviceUUIDs)
            ? device.serviceUUIDs.map((uuid: string) => uuid.toLowerCase())
            : [];
          const name = device.localName || device.name || "Unknown Device";
          let sourceType: DiscoveredDevice["sourceType"] = "unknown";
          if (serviceUuids.includes(FRAME_SERVICE_UUID)) {
            sourceType = "frame";
          } else if (serviceUuids.includes(OPENGLASS_SERVICE_UUID)) {
            sourceType = "openglass";
          } else if (typeof name === "string") {
            const lowered = name.toLowerCase();
            if (lowered.includes("frame")) sourceType = "frame";
            if (lowered.includes("glass")) sourceType = "openglass";
          }

          discovered.set(device.id, {
            id: device.id,
            name,
            rssi: typeof device.rssi === "number" ? device.rssi : null,
            sourceType,
          });
        },
      );
    });

    return Array.from(discovered.values());
  }

  async connect(deviceId: string): Promise<boolean> {
    const ready = await this.ensureManager();
    if (!ready || !this.manager) return false;
    try {
      const device = await this.manager.connectToDevice(deviceId, {
        autoConnect: false,
      });
      await device.discoverAllServicesAndCharacteristics();
      return true;
    } catch {
      return false;
    }
  }

  async disconnect(deviceId: string): Promise<void> {
    if (!this.manager) return;
    try {
      await this.manager.cancelDeviceConnection(deviceId);
    } catch {
      // ignore
    }
  }
}

export const bleManagerService = new BleManagerService();

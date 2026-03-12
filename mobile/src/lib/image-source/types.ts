export type ImageSourceType = "camera" | "frame" | "openglass";

export interface SourceFrame {
  base64: string;
  timestamp: number;
  width?: number;
  height?: number;
}

export interface ImageSource {
  type: ImageSourceType;
  label: string;
  isConnected: boolean;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  capturePreviewFrame: () => Promise<SourceFrame | null>;
  captureHighResFrame: () => Promise<SourceFrame | null>;
}

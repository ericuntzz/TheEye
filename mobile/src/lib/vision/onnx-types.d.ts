/**
 * Type declarations for packages loaded dynamically at runtime.
 * These allow TypeScript compilation without the packages installed.
 */

declare module "onnxruntime-react-native" {
  export class InferenceSession {
    static create(
      uri: string,
      options?: Record<string, unknown>,
    ): Promise<InferenceSession>;
    inputNames: string[];
    outputNames: string[];
    run(
      feeds: Record<string, Tensor>,
    ): Promise<Record<string, { data: Float32Array | Int32Array }>>;
  }

  export class Tensor {
    constructor(
      type: string,
      data: Float32Array | Int32Array | Uint8Array,
      dims: number[],
    );
  }
}

declare module "expo-asset" {
  export class Asset {
    static fromModule(module: number): Asset;
    downloadAsync(): Promise<void>;
    localUri: string | null;
  }
}

declare module "expo-image-manipulator" {
  export interface ImageResult {
    uri: string;
    width: number;
    height: number;
    base64?: string;
  }

  export enum SaveFormat {
    JPEG = "jpeg",
    PNG = "png",
  }

  export interface Action {
    resize?: { width?: number; height?: number };
    crop?: { originX: number; originY: number; width: number; height: number };
  }

  export function manipulateAsync(
    uri: string,
    actions: Action[],
    saveOptions?: { format?: SaveFormat; base64?: boolean; compress?: number },
  ): Promise<ImageResult>;
}

declare module "jpeg-js" {
  export interface DecodeResult {
    width: number;
    height: number;
    data: Uint8Array;
  }

  export function decode(
    jpegData: Uint8Array,
    options?: { useTArray?: boolean; formatAsRGBA?: boolean },
  ): DecodeResult;
}

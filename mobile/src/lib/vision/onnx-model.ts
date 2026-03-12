/**
 * Mobile ONNX Model Loader — MobileCLIP-S0
 *
 * Loads and runs the MobileCLIP-S0 ONNX model on-device via onnxruntime-react-native.
 * Generates 512-dimensional embeddings from camera frames for room detection.
 *
 * Graceful fallback: if model isn't bundled or fails to load, returns null
 * and room detection falls back to manual switching.
 */

import { decodeBase64JpegToRgb } from "./image-utils";

const EMBEDDING_DIM = 512;
const IMAGE_SIZE = 256; // MobileCLIP-S0 input size

// ImageNet normalization values used by MobileCLIP
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

export type EmbeddingResult = Float32Array;

export interface OnnxModelLoader {
  /** Whether the model loaded successfully */
  isLoaded: boolean;
  /** Generate a 512-dim embedding from an image URI */
  generateEmbedding: (imageUri: string) => Promise<EmbeddingResult | null>;
  /** Clean up model resources */
  dispose: () => void;
}

/**
 * Attempt to load the MobileCLIP-S0 ONNX model.
 * Returns a model loader object, or a stub with isLoaded=false if unavailable.
 */
export async function loadOnnxModel(): Promise<OnnxModelLoader> {
  try {
    // Dynamic imports — these packages may not be installed
    const ort = await import("onnxruntime-react-native");

    // Try to load the model from bundled assets
    // The model file must be placed at mobile/assets/models/mobileclip-s0.onnx
    // and referenced in app.json/expo config as an asset
    const Asset = (await import("expo-asset")).Asset;
    const modelAsset = Asset.fromModule(
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require("../../../../assets/models/mobileclip-s0.onnx")
    );
    await modelAsset.downloadAsync();

    if (!modelAsset.localUri) {
      console.warn("[onnx-model] Model asset has no local URI");
      return createStubLoader();
    }

    const session = await ort.InferenceSession.create(modelAsset.localUri);
    console.log("[onnx-model] MobileCLIP-S0 loaded successfully");

    return {
      isLoaded: true,

      async generateEmbedding(imageUri: string): Promise<EmbeddingResult | null> {
        try {
          // Preprocess image: resize to 256x256, normalize
          const ImageManipulator = await import("expo-image-manipulator");
          const resized = await ImageManipulator.manipulateAsync(
            imageUri,
            [{ resize: { width: IMAGE_SIZE, height: IMAGE_SIZE } }],
            { format: ImageManipulator.SaveFormat.JPEG, base64: true },
          );

          if (!resized.base64) return null;

          // Decode base64 to pixel data
          // Note: In production, this would use a native module for efficient
          // pixel access. For now, we use a JS-based approach.
          const decoded = await decodeBase64JpegToRgb(resized.base64);
          if (!decoded) return null;
          const pixelData = decoded.rgb;

          // Normalize to NCHW float32 tensor
          const floatData = new Float32Array(3 * IMAGE_SIZE * IMAGE_SIZE);
          for (let c = 0; c < 3; c++) {
            for (let i = 0; i < IMAGE_SIZE * IMAGE_SIZE; i++) {
              const pixelValue = pixelData[i * 3 + c] / 255.0;
              floatData[c * IMAGE_SIZE * IMAGE_SIZE + i] =
                (pixelValue - MEAN[c]) / STD[c];
            }
          }

          // Create tensor and run inference
          const inputTensor = new ort.Tensor("float32", floatData, [
            1,
            3,
            IMAGE_SIZE,
            IMAGE_SIZE,
          ]);

          const feeds: Record<string, any> = {};
          feeds[session.inputNames[0]] = inputTensor;
          const results = await session.run(feeds);
          const outputData = results[session.outputNames[0]].data as Float32Array;

          // L2 normalize
          const embedding = new Float32Array(EMBEDDING_DIM);
          let norm = 0;
          for (let i = 0; i < EMBEDDING_DIM; i++) {
            embedding[i] = outputData[i];
            norm += outputData[i] * outputData[i];
          }
          norm = Math.sqrt(norm);
          if (norm > 0) {
            for (let i = 0; i < EMBEDDING_DIM; i++) {
              embedding[i] /= norm;
            }
          }

          return embedding;
        } catch (error) {
          console.warn("[onnx-model] Embedding generation failed:", error);
          return null;
        }
      },

      dispose() {
        // onnxruntime-react-native sessions are cleaned up by GC
        console.log("[onnx-model] Model disposed");
      },
    };
  } catch (error) {
    console.warn(
      "[onnx-model] Failed to load ONNX model (expected if model not bundled):",
      (error as Error).message,
    );
    return createStubLoader();
  }
}

/**
 * Create a stub loader when the model isn't available.
 */
function createStubLoader(): OnnxModelLoader {
  return {
    isLoaded: false,
    async generateEmbedding() {
      return null;
    },
    dispose() {},
  };
}

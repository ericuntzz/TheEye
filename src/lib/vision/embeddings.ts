/**
 * Embedding Generation — MobileCLIP-S0 ONNX with Placeholder Fallback
 *
 * Generates 512-dimensional image embeddings for room detection and
 * baseline comparison. Uses the MobileCLIP-S0 ONNX model when available,
 * falling back to deterministic hash-based placeholders otherwise.
 *
 * The same model must be used on both server and mobile to ensure
 * embedding consistency (cosine similarity depends on identical weights).
 */

import { existsSync } from "fs";
import { join } from "path";
import { fetchImageBuffer } from "./fetch-image";

const MODEL_PATH = join(process.cwd(), "src/lib/vision/models/mobileclip-s0.onnx");
const EMBEDDING_DIM = 512;
const IMAGE_SIZE = 256; // MobileCLIP-S0 input size
export const REAL_EMBEDDING_MODEL_VERSION = "mobileclip-s0-v1";
export const PLACEHOLDER_EMBEDDING_MODEL_VERSION = "mobileclip-s0-placeholder-v1";

// Singleton state
let onnxSession: any = null;
let onnxLoadAttempted = false;
let modelAvailable = false;

export interface GenerateEmbeddingOptions {
  /**
   * Only for local development: generate deterministic placeholder vectors
   * if the real model is unavailable.
   */
  allowPlaceholder?: boolean;
}

/**
 * Get the current embedding model version string.
 */
export function getModelVersion(): string {
  return modelAvailable
    ? REAL_EMBEDDING_MODEL_VERSION
    : PLACEHOLDER_EMBEDDING_MODEL_VERSION;
}

export function isPlaceholderModelVersion(version: string | null | undefined): boolean {
  return version === PLACEHOLDER_EMBEDDING_MODEL_VERSION;
}

/**
 * Whether the real ONNX embedding model is available.
 * Triggers a one-time load attempt if not already attempted.
 */
export async function hasRealEmbeddingModel(): Promise<boolean> {
  return ensureModel();
}

/**
 * Attempt to load the ONNX model. Called once on first embedding request.
 * Returns true if model loaded successfully.
 */
async function ensureModel(): Promise<boolean> {
  if (onnxLoadAttempted) return modelAvailable;
  onnxLoadAttempted = true;

  if (!existsSync(MODEL_PATH)) {
    console.warn(
      `[embeddings] ONNX model not found at ${MODEL_PATH}. Using placeholder embeddings. ` +
      `See docs/ONNX_MODEL_SETUP.md for model acquisition instructions.`
    );
    return false;
  }

  try {
    const ort = await import("onnxruntime-node");
    onnxSession = await ort.InferenceSession.create(MODEL_PATH, {
      executionProviders: ["cpu"],
    });
    modelAvailable = true;
    console.log("[embeddings] ONNX model loaded successfully");
    return true;
  } catch (error) {
    console.error("[embeddings] Failed to load ONNX model:", error);
    return false;
  }
}

/**
 * Generate a 512-dimensional embedding for an image.
 *
 * If the ONNX model is available, runs real MobileCLIP-S0 inference.
 * Otherwise, returns a deterministic placeholder based on URL hash.
 */
export async function generateEmbedding(imageUrl: string): Promise<number[]> {
  return generateEmbeddingWithOptions(imageUrl);
}

export async function generateEmbeddingWithOptions(
  imageUrl: string,
  options: GenerateEmbeddingOptions = {},
): Promise<number[]> {
  const hasModel = await ensureModel();

  if (hasModel && onnxSession) {
    return generateOnnxEmbedding(imageUrl);
  }

  if (options.allowPlaceholder) {
    return generatePlaceholderEmbedding(imageUrl);
  }

  throw new Error(
    "Embedding model unavailable. Provision MobileCLIP ONNX model or enable ALLOW_PLACEHOLDER_EMBEDDINGS=1 for local development only.",
  );
}

/**
 * Generate embedding via ONNX Runtime inference.
 */
async function generateOnnxEmbedding(imageUrl: string): Promise<number[]> {
  try {
    const ort = await import("onnxruntime-node");

    // Fetch and preprocess image
    const imageBuffer = await fetchImageBuffer(imageUrl);
    if (!imageBuffer) {
      throw new Error("Failed to fetch image bytes");
    }

    const sharp = (await import("sharp")).default;

    // Resize to 256x256 and get raw RGB pixel data
    const { data } = await sharp(imageBuffer)
      .resize(IMAGE_SIZE, IMAGE_SIZE, { fit: "cover" })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    // Convert to float32 and normalize (ImageNet normalization)
    // MobileCLIP uses mean=[0.485, 0.456, 0.406], std=[0.229, 0.224, 0.225]
    const mean = [0.485, 0.456, 0.406];
    const std = [0.229, 0.224, 0.225];
    const floatData = new Float32Array(3 * IMAGE_SIZE * IMAGE_SIZE);

    for (let c = 0; c < 3; c++) {
      for (let i = 0; i < IMAGE_SIZE * IMAGE_SIZE; i++) {
        const pixelValue = data[i * 3 + c] / 255.0;
        floatData[c * IMAGE_SIZE * IMAGE_SIZE + i] =
          (pixelValue - mean[c]) / std[c];
      }
    }

    // Create input tensor [1, 3, 256, 256] (NCHW format)
    const inputTensor = new ort.Tensor("float32", floatData, [
      1,
      3,
      IMAGE_SIZE,
      IMAGE_SIZE,
    ]);

    // Run inference
    const feeds: Record<string, any> = {};
    const inputName = onnxSession.inputNames[0];
    feeds[inputName] = inputTensor;

    const results = await onnxSession.run(feeds);
    const outputName = onnxSession.outputNames[0];
    const outputData = results[outputName].data as Float32Array;

    // L2 normalize the embedding
    const embedding = Array.from(outputData.slice(0, EMBEDDING_DIM));
    return normalizeVector(embedding);
  } catch (error) {
    console.error("[embeddings] ONNX inference failed:", error);
    throw new Error(
      `ONNX inference failed for image: ${imageUrl.slice(0, 160)}`,
      { cause: error as Error },
    );
  }
}

/**
 * Deterministic placeholder embedding from URL hash.
 * Produces consistent 512-dim unit vectors for the same URL.
 */
function generatePlaceholderEmbedding(imageUrl: string): number[] {
  const embedding = new Array(EMBEDDING_DIM);
  let hash = 0;
  for (let i = 0; i < imageUrl.length; i++) {
    const char = imageUrl.charCodeAt(i);
    hash = ((hash << 5) - hash + char) | 0;
  }
  for (let i = 0; i < EMBEDDING_DIM; i++) {
    hash = ((hash << 13) ^ hash) | 0;
    hash = (hash * 0x5bd1e995) | 0;
    hash = ((hash >> 15) ^ hash) | 0;
    embedding[i] = (hash & 0xffff) / 0xffff - 0.5;
  }
  return normalizeVector(embedding);
}

/**
 * L2 normalize a vector to unit length.
 */
function normalizeVector(vec: number[]): number[] {
  let norm = 0;
  for (let i = 0; i < vec.length; i++) {
    norm += vec[i] * vec[i];
  }
  norm = Math.sqrt(norm);
  if (norm === 0) return vec;
  return vec.map((v) => v / norm);
}

// fetchImageBuffer imported from ./fetch-image

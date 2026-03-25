/**
 * YOLOv8n Object Detector — "The Eye"
 *
 * On-device real-time object detection using YOLOv8n via ONNX Runtime.
 * Runs alongside MobileCLIP (room detection) to provide item-level
 * inventory tracking during inspections.
 *
 * COCO 80-class detection → filtered to property-relevant items.
 * Confidence accumulates across frames for reliable item verification.
 */

import { Asset } from "expo-asset";
import * as ImageManipulator from "expo-image-manipulator";

// Lazy-loaded ONNX runtime (native module)
let ort: typeof import("onnxruntime-react-native") | null = null;

// YOLO input dimensions
const YOLO_INPUT_SIZE = 640;
const YOLO_CONFIDENCE_THRESHOLD = 0.35;
const YOLO_NMS_IOU_THRESHOLD = 0.45;

// COCO class names (80 classes)
const COCO_CLASSES = [
  "person", "bicycle", "car", "motorcycle", "airplane", "bus", "train", "truck", "boat",
  "traffic light", "fire hydrant", "stop sign", "parking meter", "bench", "bird", "cat",
  "dog", "horse", "sheep", "cow", "elephant", "bear", "zebra", "giraffe", "backpack",
  "umbrella", "handbag", "tie", "suitcase", "frisbee", "skis", "snowboard", "sports ball",
  "kite", "baseball bat", "baseball glove", "skateboard", "surfboard", "tennis racket",
  "bottle", "wine glass", "cup", "fork", "knife", "spoon", "bowl", "banana", "apple",
  "sandwich", "orange", "broccoli", "carrot", "hot dog", "pizza", "donut", "cake",
  "chair", "couch", "potted plant", "bed", "dining table", "toilet", "tv", "laptop",
  "mouse", "remote", "keyboard", "cell phone", "microwave", "oven", "toaster", "sink",
  "refrigerator", "book", "clock", "vase", "scissors", "teddy bear", "hair drier", "toothbrush",
];

// Property-relevant COCO classes (filter out vehicles, animals, outdoor objects)
const PROPERTY_RELEVANT_CLASSES = new Set([
  "bottle", "wine glass", "cup", "fork", "knife", "spoon", "bowl",
  "chair", "couch", "potted plant", "bed", "dining table", "toilet",
  "tv", "laptop", "remote", "keyboard", "cell phone",
  "microwave", "oven", "toaster", "sink", "refrigerator",
  "book", "clock", "vase", "scissors", "teddy bear", "hair drier", "toothbrush",
  "backpack", "umbrella", "handbag", "suitcase",
]);

export interface DetectedObject {
  className: string;
  classId: number;
  confidence: number;
  bbox: { x: number; y: number; width: number; height: number };
}

export interface YoloDetectionResult {
  objects: DetectedObject[];
  propertyRelevantObjects: DetectedObject[];
  inferenceTimeMs: number;
}

export interface YoloModelLoader {
  isLoaded: boolean;
  unavailableReason?: string;
  detect: (imageUri: string) => Promise<YoloDetectionResult | null>;
  dispose: () => void;
}

/**
 * Load the YOLOv8n ONNX model for on-device object detection.
 */
export async function loadYoloModel(): Promise<YoloModelLoader> {
  try {
    ort = await import("onnxruntime-react-native");
  } catch {
    return {
      isLoaded: false,
      unavailableReason: "onnxruntime-react-native not available",
      detect: async () => null,
      dispose: () => {},
    };
  }

  let session: InstanceType<typeof ort.InferenceSession> | null = null;

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const modelAsset = Asset.fromModule(require("../../../assets/models/yolov8n.onnx"));
    await modelAsset.downloadAsync();

    if (!modelAsset.localUri) {
      return {
        isLoaded: false,
        unavailableReason: "YOLO model asset has no local URI",
        detect: async () => null,
        dispose: () => {},
      };
    }

    session = await ort.InferenceSession.create(modelAsset.localUri);
    console.log("[YOLO] Model loaded successfully");
    console.log("[YOLO] Input names:", session.inputNames);
    console.log("[YOLO] Output names:", session.outputNames);
  } catch (err) {
    console.warn("[YOLO] Failed to load model:", err);
    return {
      isLoaded: false,
      unavailableReason: `Model load failed: ${err instanceof Error ? err.message : String(err)}`,
      detect: async () => null,
      dispose: () => {},
    };
  }

  const detect = async (imageUri: string): Promise<YoloDetectionResult | null> => {
    if (!session || !ort) return null;

    const startTime = Date.now();

    try {
      // Resize to 640x640 — use max quality to avoid lossy recompression artifacts
      const resized = await ImageManipulator.manipulateAsync(
        imageUri,
        [{ resize: { width: YOLO_INPUT_SIZE, height: YOLO_INPUT_SIZE } }],
        { format: ImageManipulator.SaveFormat.JPEG, base64: true, compress: 1.0 },
      );

      if (!resized.base64) return null;

      // Decode JPEG to raw RGB
      const { decodeBase64JpegToRgb } = await import("./image-utils");
      const decoded = await decodeBase64JpegToRgb(resized.base64);
      if (!decoded) return null;

      // Normalize to 0-1 range (YOLO uses 0-1, not ImageNet normalization)
      const { width, height, rgb } = decoded;
      const floatData = new Float32Array(3 * width * height);
      for (let i = 0; i < width * height; i++) {
        floatData[i] = rgb[i * 3] / 255.0; // R
        floatData[width * height + i] = rgb[i * 3 + 1] / 255.0; // G
        floatData[2 * width * height + i] = rgb[i * 3 + 2] / 255.0; // B
      }

      // Create NCHW tensor
      const inputTensor = new ort.Tensor("float32", floatData, [1, 3, height, width]);
      const inputName = session.inputNames[0] || "images";
      const feeds: Record<string, InstanceType<typeof ort.Tensor>> = {
        [inputName]: inputTensor,
      };

      // Run inference
      let results: Record<string, { data: Float32Array | Int32Array; dims?: readonly number[] }>;
      try {
        results = await session.run(feeds);
      } finally {
        // Clean up input tensor to prevent memory leaks
        try { (inputTensor as unknown as { dispose?: () => void }).dispose?.(); } catch { /* noop */ }
      }
      const outputName = session.outputNames[0] || "output0";
      const output = results[outputName];
      if (!output?.data) return null;

      // Validate and parse YOLOv8 output shape
      // Expected: [1, 84, N] where N = num detections (8400 for 640x640)
      const dims = (output as unknown as { dims?: readonly number[] }).dims;
      const numClasses = 80;
      const expectedChannels = 4 + numClasses; // 4 bbox + 80 classes = 84
      let numDetections: number;

      if (dims && dims.length === 3 && dims[1] === expectedChannels) {
        numDetections = dims[2];
      } else if (dims && dims.length === 3 && dims[2] === expectedChannels) {
        // Transposed output: [1, N, 84] — some ONNX exports use this layout
        console.warn("[YOLO] Output is transposed [1, N, 84] — adjusting parser");
        numDetections = dims[1];
      } else {
        console.warn("[YOLO] Unexpected output shape:", dims, "— falling back to 8400");
        numDetections = 8400;
      }

      const data = output.data as Float32Array;

      const detections: DetectedObject[] = [];

      for (let i = 0; i < numDetections; i++) {
        // Find best class
        let maxScore = 0;
        let maxClassId = 0;
        for (let c = 0; c < numClasses; c++) {
          const score = data[(4 + c) * numDetections + i];
          if (score > maxScore) {
            maxScore = score;
            maxClassId = c;
          }
        }

        if (maxScore < YOLO_CONFIDENCE_THRESHOLD) continue;

        // Extract bbox (center x, center y, width, height)
        const cx = data[0 * numDetections + i];
        const cy = data[1 * numDetections + i];
        const w = data[2 * numDetections + i];
        const h = data[3 * numDetections + i];

        detections.push({
          className: COCO_CLASSES[maxClassId] || `class_${maxClassId}`,
          classId: maxClassId,
          confidence: maxScore,
          bbox: {
            x: (cx - w / 2) / YOLO_INPUT_SIZE,
            y: (cy - h / 2) / YOLO_INPUT_SIZE,
            width: w / YOLO_INPUT_SIZE,
            height: h / YOLO_INPUT_SIZE,
          },
        });
      }

      // Clean up output tensors to prevent memory leaks
      try {
        for (const key of Object.keys(results)) {
          (results[key] as unknown as { dispose?: () => void }).dispose?.();
        }
      } catch { /* noop — dispose may not be available */ }

      // Simple NMS (non-max suppression)
      const nmsDetections = applyNMS(detections, YOLO_NMS_IOU_THRESHOLD);

      const inferenceTimeMs = Date.now() - startTime;

      return {
        objects: nmsDetections,
        propertyRelevantObjects: nmsDetections.filter(
          (d) => PROPERTY_RELEVANT_CLASSES.has(d.className),
        ),
        inferenceTimeMs,
      };
    } catch (err) {
      console.warn("[YOLO] Detection failed:", err);
      return null;
    }
  };

  return {
    isLoaded: true,
    detect,
    dispose: () => {
      try { (session as unknown as { dispose?: () => void })?.dispose?.(); } catch { /* noop */ }
      session = null;
    },
  };
}

/** Simple NMS — suppress overlapping boxes with lower confidence */
function applyNMS(detections: DetectedObject[], iouThreshold: number): DetectedObject[] {
  // Sort by confidence descending
  const sorted = [...detections].sort((a, b) => b.confidence - a.confidence);
  const kept: DetectedObject[] = [];

  for (const det of sorted) {
    let dominated = false;
    for (const existing of kept) {
      if (existing.className === det.className && iou(existing.bbox, det.bbox) > iouThreshold) {
        dominated = true;
        break;
      }
    }
    if (!dominated) kept.push(det);
  }

  return kept;
}

function iou(
  a: DetectedObject["bbox"],
  b: DetectedObject["bbox"],
): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width);
  const y2 = Math.min(a.y + a.height, b.y + b.height);

  const intersection = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const aArea = a.width * a.height;
  const bArea = b.width * b.height;
  const union = aArea + bArea - intersection;

  return union > 0 ? intersection / union : 0;
}

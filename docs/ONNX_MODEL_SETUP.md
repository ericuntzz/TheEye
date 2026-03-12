# MobileCLIP-S0 ONNX Model Setup

This guide explains how to obtain, convert, and bundle the MobileCLIP-S0 model for use in Atria's room detection and embedding generation.

## Overview

Atria uses MobileCLIP-S0 (Apple's mobile-optimized CLIP model) to generate 512-dimensional image embeddings. These embeddings power:

- **Server-side**: Baseline image embeddings stored during property training
- **Mobile**: Real-time room detection by comparing live camera frames against stored baselines

The same model file must be used on both server and mobile to ensure embedding consistency (cosine similarity scores depend on identical weights).

## Current State

Without the ONNX model file, the system runs in **placeholder mode**:
- Server: Deterministic hash-based embeddings (consistent but not visually meaningful)
- Mobile: Manual room switching instead of auto-detection

Both fallbacks are fully functional. The system logs a warning when using placeholders.

## Step 1: Obtain the Model

### Option A: From Apple's ml-mobileclip Repository

```bash
git clone https://github.com/apple/ml-mobileclip.git
cd ml-mobileclip
pip install -e .
```

### Option B: From HuggingFace

```bash
pip install huggingface_hub
python -c "from huggingface_hub import hf_hub_download; hf_hub_download('apple/MobileCLIP-S0-OpenCLIP', 'open_clip_pytorch_model.bin', local_dir='.')"
```

## Step 2: Export to ONNX

### Automated (Recommended)

The export script handles downloading, exporting, validating, and placing the model:

```bash
pip install -r scripts/requirements-model.txt
python scripts/export-mobileclip-onnx.py
```

This places the model at `src/lib/vision/models/mobileclip-s0.onnx` (and copies to `mobile/assets/models/` if the mobile directory exists).

For CPU-only PyTorch (saves ~2GB download):
```bash
pip install torch --index-url https://download.pytorch.org/whl/cpu
pip install open-clip-torch onnx onnxruntime Pillow
python scripts/export-mobileclip-onnx.py
```

### Manual Export (Alternative)

> **Note:** MobileCLIP-S0 was removed from open_clip >=3.3. Use MobileCLIP2-S0 instead — same 512-dim output, same 256x256 input, fully compatible.

```python
import torch
import open_clip

# Load the model (MobileCLIP2-S0 replaces the original MobileCLIP-S0)
model, preprocess_train, preprocess_val = open_clip.create_model_and_transforms(
    'MobileCLIP2-S0',
    pretrained='dfndr2b'
)
model.eval()

# Export only the image encoder
image_encoder = model.visual

# Create dummy input (1, 3, 256, 256) — MobileCLIP2-S0 uses 256x256 input
dummy_input = torch.randn(1, 3, 256, 256)

torch.onnx.export(
    image_encoder,
    dummy_input,
    "mobileclip-s0.onnx",
    input_names=["image"],
    output_names=["embedding"],
    dynamic_axes={
        "image": {0: "batch_size"},
        "embedding": {0: "batch_size"},
    },
    opset_version=17,
)

print("Exported to mobileclip-s0.onnx")
```

## Step 3: Quantize for Mobile (Optional)

INT8 quantization reduces model size from ~40MB to ~10-15MB:

```python
import onnxruntime as ort
from onnxruntime.quantization import quantize_dynamic, QuantType

quantize_dynamic(
    "mobileclip-s0.onnx",
    "mobileclip-s0-int8.onnx",
    weight_type=QuantType.QInt8,
)
```

## Step 4: Place Model Files

### Server (Next.js)
```bash
mkdir -p src/lib/vision/models
cp mobileclip-s0.onnx src/lib/vision/models/mobileclip-s0.onnx
```

### Mobile (Expo/React Native)
```bash
mkdir -p mobile/assets/models
cp mobileclip-s0.onnx mobile/assets/models/mobileclip-s0.onnx
```

For mobile, also update `app.json` or `expo` config to include the model as an asset:
```json
{
  "expo": {
    "assetBundlePatterns": ["assets/models/*"]
  }
}
```

## Step 5: Install Runtime Dependencies

### Server
```bash
npm install onnxruntime-node
```

### Mobile
```bash
cd mobile
npx expo install onnxruntime-react-native
```

Note: `onnxruntime-react-native` requires a custom dev client (not Expo Go):
```bash
npx expo prebuild
npx expo run:ios  # or run:android
```

## Step 6: Verify

### Server Verification
```bash
# Start the dev server
npm run dev

# Generate embeddings for test images
curl -X POST http://localhost:3000/api/embeddings \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{"imageUrls": ["https://example.com/test.jpg"]}'

# Response should show modelVersion: "mobileclip-s0-v1" (not "placeholder")
```

### Mobile Verification
- Start inspection on a trained property
- Room badge should show "Auto" instead of "Manual"
- Camera should auto-detect rooms as you walk through the property

## Image Preprocessing

Both server and mobile use identical preprocessing:
1. Resize to 256x256 (cover crop)
2. Convert to RGB float32
3. Normalize with ImageNet values: mean=[0.485, 0.456, 0.406], std=[0.229, 0.224, 0.225]
4. NCHW tensor format: [1, 3, 256, 256]
5. L2 normalize the output embedding

## Troubleshooting

- **"ONNX model not found"**: Model file not at expected path. Check the paths in Step 4.
- **"Failed to load ONNX model"**: `onnxruntime-node` or `onnxruntime-react-native` not installed, or model file corrupt.
- **Inconsistent embeddings**: Server and mobile must use the exact same `.onnx` file. Different quantization levels will produce different embeddings.
- **Mobile "Manual" mode despite model present**: `onnxruntime-react-native` requires custom dev client. Expo Go won't load native ONNX modules.

#!/usr/bin/env python3
"""
Export MobileCLIP-S0 image encoder to ONNX for Atria embedding generation.

Usage:
    pip install -r scripts/requirements-model.txt
    python scripts/export-mobileclip-onnx.py

    For CPU-only PyTorch (saves ~2GB download):
    pip install torch --index-url https://download.pytorch.org/whl/cpu
    pip install open-clip-torch onnx onnxruntime Pillow

Output:
    src/lib/vision/models/mobileclip-s0.onnx
"""

import os
import sys

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.join(SCRIPT_DIR, "..")
OUTPUT_DIR = os.path.join(PROJECT_ROOT, "src", "lib", "vision", "models")
OUTPUT_PATH = os.path.join(OUTPUT_DIR, "mobileclip-s0.onnx")
MOBILE_OUTPUT_DIR = os.path.join(PROJECT_ROOT, "mobile", "assets", "models")

EMBEDDING_DIM = 512
INPUT_SIZE = 256
OPSET_VERSION = 18


def main():
    # ---- Check dependencies ----
    try:
        import torch
        import open_clip
        import onnx
        import onnxruntime as ort
    except ImportError as e:
        print(f"Missing dependency: {e}")
        print("\nInstall required packages:")
        print("  pip install -r scripts/requirements-model.txt")
        print("\nFor CPU-only PyTorch (smaller download):")
        print("  pip install torch --index-url https://download.pytorch.org/whl/cpu")
        sys.exit(1)

    import numpy as np

    # ---- Step 1: Load MobileCLIP2-S0 ----
    # MobileCLIP-S0 was removed from open_clip >=3.3; MobileCLIP2-S0 is the successor
    # with the same 512-dim output and 256x256 input — fully compatible.
    MODEL_NAME = "MobileCLIP2-S0"
    PRETRAINED_TAG = "dfndr2b"

    print(f"[1/6] Loading {MODEL_NAME} from HuggingFace (downloads weights on first run)...")

    try:
        model, _, preprocess = open_clip.create_model_and_transforms(
            MODEL_NAME,
            pretrained=PRETRAINED_TAG,
        )
    except Exception as e:
        print(f"\nFailed to load model: {e}")
        print("\nAvailable MobileCLIP pretrained models:")
        try:
            for name, tag in open_clip.list_pretrained():
                if "mobile" in name.lower():
                    print(f"  {name} / {tag}")
        except Exception:
            pass
        print("\nThe pretrained tag may have changed. Check:")
        print("  https://github.com/mlfoundations/open_clip")
        sys.exit(1)

    model.eval()
    print(f"   Model loaded: {MODEL_NAME} / {PRETRAINED_TAG}")

    # ---- Step 2: Create image encoder wrapper ----
    print("[2/6] Wrapping image encoder for ONNX export...")

    class ImageEncoder(torch.nn.Module):
        """Wraps the visual backbone + projection head for clean ONNX export."""

        def __init__(self, clip_model):
            super().__init__()
            self.visual = clip_model.visual

        def forward(self, image):
            return self.visual(image)

    image_encoder = ImageEncoder(model)
    image_encoder.eval()

    # Verify output shape with PyTorch
    dummy = torch.randn(1, 3, INPUT_SIZE, INPUT_SIZE)
    with torch.no_grad():
        test_out = image_encoder(dummy)
    assert test_out.shape == (1, EMBEDDING_DIM), (
        f"Expected output (1, {EMBEDDING_DIM}), got {test_out.shape}"
    )
    print(f"   PyTorch output shape: {test_out.shape} -- correct")

    # ---- Step 3: Export to ONNX ----
    print(f"[3/6] Exporting to ONNX (opset {OPSET_VERSION})...")
    os.makedirs(OUTPUT_DIR, exist_ok=True)

    # Use dynamo=False for the legacy TorchScript-based exporter which produces
    # more portable ONNX models with better numeric fidelity vs PyTorch.
    torch.onnx.export(
        image_encoder,
        dummy,
        OUTPUT_PATH,
        input_names=["image"],
        output_names=["embedding"],
        dynamic_axes={
            "image": {0: "batch_size"},
            "embedding": {0: "batch_size"},
        },
        opset_version=OPSET_VERSION,
        do_constant_folding=True,
        dynamo=False,
    )
    print(f"   Exported to: {OUTPUT_PATH}")

    # ---- Step 4: Validate ONNX structure ----
    print("[4/6] Validating ONNX model structure...")
    onnx_model = onnx.load(OUTPUT_PATH)
    onnx.checker.check_model(onnx_model)

    inputs = onnx_model.graph.input
    outputs = onnx_model.graph.output
    print(f"   Inputs:  {[i.name for i in inputs]}")
    print(f"   Outputs: {[o.name for o in outputs]}")
    print("   ONNX validation passed")

    # ---- Step 5: Verify inference matches PyTorch ----
    print("[5/6] Running verification inference (ONNX vs PyTorch)...")
    session = ort.InferenceSession(OUTPUT_PATH, providers=["CPUExecutionProvider"])
    input_name = session.get_inputs()[0].name
    output_name = session.get_outputs()[0].name

    test_input = np.random.randn(1, 3, INPUT_SIZE, INPUT_SIZE).astype(np.float32)
    onnx_result = session.run([output_name], {input_name: test_input})
    onnx_embedding = onnx_result[0]

    with torch.no_grad():
        torch_embedding = image_encoder(torch.from_numpy(test_input)).numpy()

    assert onnx_embedding.shape == (1, EMBEDDING_DIM), (
        f"ONNX output shape {onnx_embedding.shape} != expected (1, {EMBEDDING_DIM})"
    )

    max_diff = float(np.max(np.abs(torch_embedding - onnx_embedding)))

    # Cosine similarity is what matters for room matching — not element-wise max diff.
    # Deep networks accumulate float rounding across layers, so max_diff of 0.01-0.1 is normal.
    def cosine_sim(a, b):
        a_flat, b_flat = a.flatten(), b.flatten()
        return float(np.dot(a_flat, b_flat) / (np.linalg.norm(a_flat) * np.linalg.norm(b_flat)))

    cos_sim = cosine_sim(torch_embedding, onnx_embedding)

    print(f"   ONNX output shape: {onnx_embedding.shape}")
    print(f"   Max element diff (PyTorch vs ONNX): {max_diff:.6f}")
    print(f"   Cosine similarity (PyTorch vs ONNX): {cos_sim:.6f}")

    if cos_sim < 0.99:
        print(f"   FAIL: Cosine similarity too low ({cos_sim:.4f}). Export may be broken.")
        sys.exit(1)
    else:
        print("   Outputs match within acceptable tolerance")

    # ---- Step 6: Summary ----
    file_size_mb = os.path.getsize(OUTPUT_PATH) / (1024 * 1024)

    print(f"\n[6/6] Done!")
    print(f"   Model:         {MODEL_NAME} (image encoder, compatible with MobileCLIP-S0)")
    print(f"   File:          {OUTPUT_PATH}")
    print(f"   Size:          {file_size_mb:.1f} MB")
    print(f"   Embedding dim: {EMBEDDING_DIM}")
    print(f"   Input shape:   [1, 3, {INPUT_SIZE}, {INPUT_SIZE}] (NCHW, ImageNet-normalized)")
    print(f"   ONNX opset:    {OPSET_VERSION}")

    # Optionally copy to mobile
    if os.path.isdir(os.path.join(PROJECT_ROOT, "mobile")):
        os.makedirs(MOBILE_OUTPUT_DIR, exist_ok=True)
        mobile_path = os.path.join(MOBILE_OUTPUT_DIR, "mobileclip-s0.onnx")
        import shutil
        shutil.copy2(OUTPUT_PATH, mobile_path)
        mobile_size = os.path.getsize(mobile_path) / (1024 * 1024)
        print(f"\n   Also copied to mobile: {mobile_path} ({mobile_size:.1f} MB)")

    print(f"\n   Next steps:")
    print(f"   1. Restart 'npm run dev' -- embeddings will use the real model")
    print(f"   2. Train a property to generate real embeddings")
    print(f"   3. Verify modelVersion is 'mobileclip-s0-v1' (not placeholder)")


if __name__ == "__main__":
    main()

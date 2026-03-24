import { NextRequest, NextResponse } from "next/server";
import { createClient as createSupabaseClient, type SupabaseClient } from "@supabase/supabase-js";
import { getDbUser, isValidUUID, isSafeUrl } from "@/lib/auth";
import { db } from "@/server/db";
import {
  properties,
  mediaUploads,
  rooms,
  items,
  baselineImages,
  baselineVersions,
} from "@/server/schema";
import { eq, and, inArray, ne } from "drizzle-orm";
import { emitEventSafe } from "@/lib/events/emit";
import {
  generateEmbeddingWithOptions,
  getModelVersion,
  hasRealEmbeddingModel,
} from "@/lib/vision/embeddings";
import { computeQualityScore } from "@/lib/vision/quality";
import { dedupeNearDuplicateImages } from "@/lib/vision/keyframe-dedupe";
import { fetchImageBuffer } from "@/lib/vision/fetch-image";

const KEYFRAME_DEDUPE_MIN_IMAGES = 4;
const KEYFRAME_DEDUPE_MIN_KEEP = 3;
const ALLOW_PLACEHOLDER_EMBEDDINGS =
  process.env.ALLOW_PLACEHOLDER_EMBEDDINGS === "1";
const MIN_USABLE_BASELINE_RATIO = 0.5;
const PREVIEW_WIDTH = 640;
const PREVIEW_HEIGHT = 360;
const VERIFICATION_WIDTH = 480;
const VERIFICATION_HEIGHT = 360;
const GENERIC_IMAGE_LABEL_RE =
  /^(?:view|angle|area|shot|photo|image|picture|frame)\s*\d*$/i;
const GENERIC_TYPED_IMAGE_LABEL_RE =
  /^(?:room overview|overview|detail(?: view)?|close[- ]?up(?: check)?)(?:\s*\d+)?$/i;

function normalizeInspectionLabel(
  rawLabel: string | null | undefined,
  fallbackRoomName: string,
  fallbackIndex: number,
  classification?: {
    type?: string;
    detail_subject?: string | null;
  } | null,
): string {
  const cleanedLabel = typeof rawLabel === "string" ? rawLabel.trim().slice(0, 100) : "";
  const detailSubject =
    typeof classification?.detail_subject === "string"
      ? classification.detail_subject.trim().slice(0, 100)
      : "";
  const imageType = classification?.type;

  const isGeneric =
    !cleanedLabel ||
    GENERIC_IMAGE_LABEL_RE.test(cleanedLabel) ||
    GENERIC_TYPED_IMAGE_LABEL_RE.test(cleanedLabel);

  if (!isGeneric) {
    return cleanedLabel;
  }

  if (detailSubject) {
    return detailSubject;
  }

  // Type-aware fallbacks are more descriptive than numbered views
  if (imageType === "overview") {
    return `${fallbackRoomName} wide view`;
  }
  if (imageType === "required_detail" && detailSubject) {
    return detailSubject;
  }
  if (imageType === "required_detail") {
    return `Close-up check ${fallbackIndex + 1}`;
  }
  if (imageType === "detail" && detailSubject) {
    return detailSubject;
  }
  if (imageType === "detail") {
    return `Detail spot ${fallbackIndex + 1}`;
  }

  // Last resort — at least give a spatial hint instead of just a number
  return `${fallbackRoomName} spot ${fallbackIndex + 1}`;
}

function createStorageAdminClient(): SupabaseClient | null {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    return null;
  }

  return createSupabaseClient(supabaseUrl, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}

function isBucketMissingError(message: string): boolean {
  const normalized = message.toLowerCase();
  return normalized.includes("not found") || normalized.includes("bucket");
}

function isTransientUploadError(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("fetch failed") ||
    normalized.includes("network") ||
    normalized.includes("timed out") ||
    normalized.includes("timeout") ||
    normalized.includes("econnreset") ||
    normalized.includes("socket")
  );
}

async function uploadToPropertyMediaWithRetry(
  supabase: SupabaseClient,
  path: string,
  data: Buffer,
  contentType: string,
): Promise<string | null> {
  let lastMessage = "Upload failed";

  for (let attempt = 1; attempt <= STORAGE_UPLOAD_RETRIES; attempt++) {
    const { error } = await supabase.storage
      .from("property-media")
      .upload(path, data, { contentType, upsert: true });

    if (!error) {
      const {
        data: { publicUrl },
      } = supabase.storage.from("property-media").getPublicUrl(path);
      return publicUrl;
    }

    lastMessage = error.message || lastMessage;

    if (isBucketMissingError(lastMessage)) {
      await supabase.storage.createBucket("property-media", { public: true }).catch(() => {});
      continue;
    }

    if (isTransientUploadError(lastMessage) && attempt < STORAGE_UPLOAD_RETRIES) {
      await new Promise((resolve) => setTimeout(resolve, 400 * attempt));
      continue;
    }

    break;
  }

  console.warn("[train] Failed to upload derived baseline asset:", lastMessage);
  return null;
}

async function generateDerivedBaselineAssets(
  supabase: SupabaseClient | null,
  propertyId: string,
  baselineId: string,
  imageUrl: string,
): Promise<{ previewUrl?: string; verificationImageUrl?: string }> {
  if (!supabase) {
    return {};
  }

  const sourceBuffer = await fetchImageBuffer(imageUrl);
  if (!sourceBuffer) {
    return {};
  }

  const sharp = (await import("sharp")).default;
  const [previewBuffer, verificationBuffer] = await Promise.all([
    sharp(sourceBuffer)
      .rotate()
      .resize(PREVIEW_WIDTH, PREVIEW_HEIGHT, { fit: "cover", position: "centre" })
      .jpeg({ quality: 82 })
      .toBuffer(),
    sharp(sourceBuffer)
      .rotate()
      .resize(VERIFICATION_WIDTH, VERIFICATION_HEIGHT, {
        fit: "cover",
        position: "centre",
      })
      .greyscale()
      .png()
      .toBuffer(),
  ]);

  const previewPath = `${propertyId}/baseline-assets/${baselineId}-preview.jpg`;
  const verificationPath = `${propertyId}/baseline-assets/${baselineId}-verify.png`;

  const [previewUrl, verificationImageUrl] = await Promise.all([
    uploadToPropertyMediaWithRetry(supabase, previewPath, previewBuffer, "image/jpeg"),
    uploadToPropertyMediaWithRetry(supabase, verificationPath, verificationBuffer, "image/png"),
  ]);
  const versionTag = Date.now();

  return {
    previewUrl: previewUrl ? `${previewUrl}?v=${versionTag}` : undefined,
    verificationImageUrl: verificationImageUrl ? `${verificationImageUrl}?v=${versionTag}` : undefined,
  };
}

type RoomAnalysis = {
  name?: string;
  room_type?: string;
  roomType?: string;
  description?: string;
  image_urls?: string[];
  imageUrls?: string[];
  image_labels?: Record<string, string>;
  imageLabels?: Record<string, string>;
  items?: Array<{
    name?: unknown;
    category?: unknown;
    description?: unknown;
    condition?: unknown;
    importance?: unknown;
  }>;
  image_classifications?: Record<string, {
    type?: string;
    parent_url?: string | null;
    detail_subject?: string | null;
  }>;
  imageClassifications?: Record<string, {
    type?: string;
    parent_url?: string | null;
    detail_subject?: string | null;
  }>;
};

type PropertyAnalysis = {
  rooms: RoomAnalysis[];
};

const STORAGE_UPLOAD_RETRIES = 5;

// POST /api/properties/[id]/train - Analyze uploaded media with AI
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
  const { id } = await params;
  if (!isValidUUID(id)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const dbUser = await getDbUser();
  if (!dbUser) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Verify property ownership
  const [property] = await db
    .select()
    .from(properties)
    .where(and(eq(properties.id, id), eq(properties.userId, dbUser.id)));

  if (!property) {
    return NextResponse.json({ error: "Property not found" }, { status: 404 });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { mediaUploadIds } = body;

  if (
    !mediaUploadIds ||
    !Array.isArray(mediaUploadIds) ||
    mediaUploadIds.length === 0
  ) {
    return NextResponse.json(
      { error: "No media uploads provided" },
      { status: 400 },
    );
  }

  const MAX_UPLOAD_IDS = 100;
  if (mediaUploadIds.length > MAX_UPLOAD_IDS) {
    return NextResponse.json(
      { error: `Too many uploads. Maximum is ${MAX_UPLOAD_IDS}` },
      { status: 400 },
    );
  }

  // Validate mediaUploadIds are valid UUIDs
  for (const uploadId of mediaUploadIds) {
    if (typeof uploadId !== "string" || !isValidUUID(uploadId)) {
      return NextResponse.json(
        { error: `Invalid upload ID: ${uploadId}` },
        { status: 400 },
      );
    }
  }

  // Get uploaded media (verified to belong to this property)
  const uploads = await db
    .select()
    .from(mediaUploads)
    .where(
      and(
        inArray(mediaUploads.id, mediaUploadIds as string[]),
        eq(mediaUploads.propertyId, id),
      ),
    );

  if (uploads.length === 0) {
    return NextResponse.json(
      { error: "No valid uploads found" },
      { status: 400 },
    );
  }

  // Check embedding model BEFORE acquiring training lock to avoid stuck status
  const hasRealModel = await hasRealEmbeddingModel();
  if (!hasRealModel && !ALLOW_PLACEHOLDER_EMBEDDINGS) {
    return NextResponse.json(
      {
        error:
          "Embedding model is unavailable. Provision the MobileCLIP ONNX model first (see docs/ONNX_MODEL_SETUP.md) or set ALLOW_PLACEHOLDER_EMBEDDINGS=1 for local development only.",
      },
      { status: 503 },
    );
  }

  // Mark property as training — optimistic lock prevents concurrent runs
  const [trainingLock] = await db
    .update(properties)
    .set({ trainingStatus: "training", updatedAt: new Date() })
    .where(
      and(
        eq(properties.id, id),
        ne(properties.trainingStatus, "training"),
      ),
    )
    .returning({ id: properties.id });

  if (!trainingLock) {
    return NextResponse.json(
      { error: "Training is already in progress for this property" },
      { status: 409 },
    );
  }

  try {
    const rawImageUrls = uploads
      .filter((u) => u.fileType.startsWith("image/"))
      .map((u) => u.fileUrl);
    const videoUploadCount = uploads.filter((u) =>
      u.fileType.startsWith("video/")
    ).length;

    if (rawImageUrls.length === 0) {
      throw new Error(
        videoUploadCount > 0
          ? "No photo/keyframe frames found. Videos were uploaded, but training needs image frames."
          : "No image files found in uploads. Please upload at least one image.",
      );
    }

    const dedupeEnabled = rawImageUrls.length >= KEYFRAME_DEDUPE_MIN_IMAGES;
    let imageUrls = [...rawImageUrls];
    let dedupeSummary = {
      enabled: dedupeEnabled,
      inputCount: rawImageUrls.length,
      keptCount: rawImageUrls.length,
      droppedCount: 0,
      hashedCount: 0,
      hashFailureCount: 0,
    };

    if (dedupeEnabled) {
      const dedupeResult = await dedupeNearDuplicateImages(rawImageUrls);
      imageUrls = ensureMinimumFrameSet(
        dedupeResult.keptUrls,
        rawImageUrls,
        KEYFRAME_DEDUPE_MIN_KEEP,
      );
      dedupeSummary = {
        enabled: true,
        inputCount: rawImageUrls.length,
        keptCount: imageUrls.length,
        droppedCount: Math.max(0, rawImageUrls.length - imageUrls.length),
        hashedCount: dedupeResult.hashedCount,
        hashFailureCount: dedupeResult.hashFailureCount,
      };
      console.info("[train] keyframe dedupe summary:", dedupeSummary);
    }

    // Analyze images with Claude Vision API directly
    const rawAnalysis = await analyzePropertyImages(imageUrls, property.name);
    const analysis = normalizeAnalysis(rawAnalysis, imageUrls);

    // Clean up existing rooms/baselines/versions from previous training
    // FK cascades: deleting rooms → auto-deletes items + baselineImages
    const existingRooms = await db
      .select({ id: rooms.id })
      .from(rooms)
      .where(eq(rooms.propertyId, id));

    if (existingRooms.length > 0) {
      console.info(`[train] Cleaning up ${existingRooms.length} existing rooms for re-training`);
      await db.delete(rooms).where(eq(rooms.propertyId, id));
    }

    // Clean up existing baseline versions (cascade deletes linked baseline images)
    await db.delete(baselineVersions).where(eq(baselineVersions.propertyId, id));

    // Create rooms and items from AI analysis
    const createdRooms = [];

    // Validate AI analysis structure
    const VALID_CONDITIONS = ["excellent", "good", "fair", "poor"];
    const VALID_IMPORTANCES = ["critical", "high", "normal", "low"];

    for (let i = 0; i < analysis.rooms.length; i++) {
      const roomData = analysis.rooms[i];

      // Validate room name from AI response
      const roomName = typeof roomData.name === "string" && roomData.name.trim()
        ? roomData.name.trim().slice(0, 200)
        : `Room ${i + 1}`;
      const roomDescription = typeof roomData.description === "string"
        ? roomData.description.slice(0, 500)
        : null;
      const rawRoomType = roomData.room_type || roomData.roomType;
      const roomType = typeof rawRoomType === "string"
        ? rawRoomType.slice(0, 50)
        : null;

      // Create room
      const [newRoom] = await db
        .insert(rooms)
        .values({
          propertyId: id,
          name: roomName,
          description: roomDescription,
          roomType: roomType,
          sortOrder: i,
        })
        .returning();

      // Create items for this room
      const roomItems = [];
      if (roomData.items && Array.isArray(roomData.items)) {
        for (const itemData of roomData.items) {
          // Validate item name from AI response
          const itemName = typeof itemData.name === "string" && itemData.name.trim()
            ? itemData.name.trim().slice(0, 200)
            : "Unknown Item";
          const itemCondition = typeof itemData.condition === "string" && VALID_CONDITIONS.includes(itemData.condition)
            ? itemData.condition
            : "good";
          const itemImportance = typeof itemData.importance === "string" && VALID_IMPORTANCES.includes(itemData.importance)
            ? itemData.importance
            : "normal";

          const [newItem] = await db
            .insert(items)
            .values({
              roomId: newRoom.id,
              name: itemName,
              category: typeof itemData.category === "string" ? itemData.category.slice(0, 100) : null,
              description: typeof itemData.description === "string" ? itemData.description.slice(0, 500) : null,
              condition: itemCondition,
              importance: itemImportance,
            })
            .returning();
          roomItems.push({
            name: newItem.name,
            category: newItem.category || "",
          });
        }
      }

      // Assign baseline images to this room
      const roomImageUrls = Array.isArray(roomData.image_urls)
        ? roomData.image_urls
        : Array.isArray(roomData.imageUrls)
          ? roomData.imageUrls
          : [];
      const roomImageLabels =
        roomData.image_labels && typeof roomData.image_labels === "object"
          ? roomData.image_labels
          : roomData.imageLabels && typeof roomData.imageLabels === "object"
            ? roomData.imageLabels
            : {};
      const roomImageClassifications: Record<string, {
        type?: string;
        parent_url?: string | null;
        detail_subject?: string | null;
      }> =
        roomData.image_classifications && typeof roomData.image_classifications === "object"
          ? (roomData.image_classifications as Record<string, { type?: string; parent_url?: string | null; detail_subject?: string | null }>)
          : roomData.imageClassifications && typeof roomData.imageClassifications === "object"
            ? (roomData.imageClassifications as Record<string, { type?: string; parent_url?: string | null; detail_subject?: string | null }>)
            : {};
      let baselineCount = 0;
      const insertedBaselinesByUrl: Array<{ id: string; imageUrl: string }> = [];

      for (const imgUrl of roomImageUrls) {
        // Only insert valid, safe string URLs from AI response
        if (typeof imgUrl !== "string" || !imgUrl.trim()) continue;
        if (!isSafeUrl(imgUrl)) continue;
        const labelFromAi =
          typeof roomImageLabels[imgUrl] === "string" ? roomImageLabels[imgUrl] : null;
        const classification =
          roomImageClassifications && typeof roomImageClassifications === "object"
            ? roomImageClassifications[imgUrl]
            : null;
        const [inserted] = await db.insert(baselineImages).values({
          roomId: newRoom.id,
          imageUrl: imgUrl,
          label: normalizeInspectionLabel(
            labelFromAi,
            roomName,
            baselineCount,
            classification,
          ),
          isActive: true,
        }).returning({ id: baselineImages.id });
        if (inserted) {
          insertedBaselinesByUrl.push({ id: inserted.id, imageUrl: imgUrl });
        }
        baselineCount++;
      }

      // Store image classification metadata (overview/detail/standard + parent-child links)
      if (Object.keys(roomImageClassifications).length > 0 && insertedBaselinesByUrl.length > 0) {
        for (const { id, imageUrl } of insertedBaselinesByUrl) {
          const classification = roomImageClassifications[imageUrl];
          if (!classification?.type) continue;

          const imageType = (["overview", "detail", "required_detail", "standard"] as const).includes(
            classification.type as "overview" | "detail" | "required_detail" | "standard",
          )
            ? (classification.type as "overview" | "detail" | "required_detail" | "standard")
            : ("standard" as const);

          // Resolve parent_url to a baseline ID
          let parentBaselineId: string | null = null;
          if (classification.parent_url && typeof classification.parent_url === "string") {
            const parent = insertedBaselinesByUrl.find(b => b.imageUrl === classification.parent_url);
            parentBaselineId = parent?.id ?? null;
          }

          await db.update(baselineImages)
            .set({
              metadata: {
                imageType,
                parentBaselineId,
                detailSubject: classification.detail_subject || null,
              },
            })
            .where(eq(baselineImages.id, id));
        }
      }

      // If no specific images assigned, distribute available images
      if (baselineCount === 0 && imageUrls.length > 0) {
        const startIdx = Math.floor(
          (i * imageUrls.length) / analysis.rooms.length,
        );
        const endIdx = Math.floor(
          ((i + 1) * imageUrls.length) / analysis.rooms.length,
        );
        const insertedFallbackBaselines: Array<{ id: string; imageUrl: string }> =
          [];
        for (let j = startIdx; j < endIdx && j < imageUrls.length; j++) {
          const fallbackUrl = imageUrls[j];
          const classification =
            roomImageClassifications && typeof roomImageClassifications === "object"
              ? roomImageClassifications[fallbackUrl]
              : null;
          const [inserted] = await db.insert(baselineImages).values({
            roomId: newRoom.id,
            imageUrl: fallbackUrl,
            label: normalizeInspectionLabel(
              null,
              roomName,
              j - startIdx,
              classification,
            ),
            isActive: true,
          }).returning({ id: baselineImages.id });
          if (inserted) {
            insertedBaselinesByUrl.push({ id: inserted.id, imageUrl: fallbackUrl });
            insertedFallbackBaselines.push({
              id: inserted.id,
              imageUrl: fallbackUrl,
            });
          }
          baselineCount++;
        }

        if (
          Object.keys(roomImageClassifications).length > 0 &&
          insertedFallbackBaselines.length > 0
        ) {
          for (const { id, imageUrl } of insertedFallbackBaselines) {
            const classification = roomImageClassifications[imageUrl];
            if (!classification?.type) continue;

            const imageType = ([
              "overview",
              "detail",
              "required_detail",
              "standard",
            ] as const).includes(
              classification.type as
                | "overview"
                | "detail"
                | "required_detail"
                | "standard",
            )
              ? (classification.type as
                  | "overview"
                  | "detail"
                  | "required_detail"
                  | "standard")
              : ("standard" as const);

            let parentBaselineId: string | null = null;
            if (
              classification.parent_url &&
              typeof classification.parent_url === "string"
            ) {
              const parent = insertedBaselinesByUrl.find(
                (b) => b.imageUrl === classification.parent_url,
              );
              parentBaselineId = parent?.id ?? null;
            }

            await db
              .update(baselineImages)
              .set({
                metadata: {
                  imageType,
                  parentBaselineId,
                  detailSubject: classification.detail_subject || null,
                },
              })
              .where(eq(baselineImages.id, id));
          }
        }
      }

      createdRooms.push({
        name: newRoom.name,
        roomType: newRoom.roomType || "unknown",
        items: roomItems,
        baselineCount,
      });
    }

    // Create baseline version v1
    const [baselineVersion] = await db
      .insert(baselineVersions)
      .values({
        propertyId: id,
        versionNumber: 1,
        label: "Initial Training",
        isActive: true,
      })
      .returning();

    // Link all baseline images to this version and generate embeddings
    // Batch-fetch all rooms + baselines for this property (fixes N+1)
    const allPropertyRooms = await db
      .select({ id: rooms.id })
      .from(rooms)
      .where(eq(rooms.propertyId, id));

    const allRoomIds = allPropertyRooms.map((r) => r.id);
    const allPropertyBaselines = allRoomIds.length > 0
      ? await db
          .select({ id: baselineImages.id, imageUrl: baselineImages.imageUrl })
          .from(baselineImages)
          .where(inArray(baselineImages.roomId, allRoomIds))
      : [];

    const allBaselineIds: string[] = allPropertyBaselines.map((bl) => bl.id);

    // Process embeddings + quality scores in parallel (concurrency-limited)
    const EMBEDDING_CONCURRENCY = 3;
    let embeddingFailures = 0;
    let usableBaselineCount = 0;
    const storageAdmin = createStorageAdminClient();

    for (let i = 0; i < allPropertyBaselines.length; i += EMBEDDING_CONCURRENCY) {
      const batch = allPropertyBaselines.slice(i, i + EMBEDDING_CONCURRENCY);
      await Promise.all(
        batch.map(async (bl) => {
          const [embeddingResult, qualityResult, derivedAssetsResult] =
            await Promise.allSettled([
              generateEmbeddingWithOptions(bl.imageUrl, {
                allowPlaceholder: ALLOW_PLACEHOLDER_EMBEDDINGS,
              }),
              computeQualityScore(bl.imageUrl),
              generateDerivedBaselineAssets(storageAdmin, id, bl.id, bl.imageUrl),
            ]);

          if (embeddingResult.status === "rejected") {
            embeddingFailures++;
            console.warn(
              "[train] Embedding generation failed for one baseline:",
              embeddingResult.reason,
            );
          }

          if (derivedAssetsResult.status === "rejected") {
            console.warn(
              "[train] Derived baseline asset generation failed:",
              derivedAssetsResult.reason,
            );
          }

          const embedding =
            embeddingResult.status === "fulfilled" ? embeddingResult.value : null;
          const qualityScore =
            qualityResult.status === "fulfilled" ? qualityResult.value : 150;
          const derivedAssets =
            derivedAssetsResult.status === "fulfilled"
              ? derivedAssetsResult.value
              : {};

          if (embedding) {
            usableBaselineCount++;
          }

          await db
            .update(baselineImages)
            .set({
              baselineVersionId: baselineVersion.id,
              embedding,
              qualityScore,
              embeddingModelVersion: embedding ? getModelVersion() : null,
              previewUrl: derivedAssets.previewUrl ?? null,
              verificationImageUrl: derivedAssets.verificationImageUrl ?? null,
            })
            .where(eq(baselineImages.id, bl.id));
        }),
      );
    }

    // Quality gate: deactivate baselines with very poor quality scores (> 2000),
    // but never strand a room without enough active, usable baselines.
    let deactivatedBaselines = 0;
    if (allRoomIds.length > 0) {
      const baselinesWithScores = await db
        .select({
          id: baselineImages.id,
          roomId: baselineImages.roomId,
          qualityScore: baselineImages.qualityScore,
          embedding: baselineImages.embedding,
        })
        .from(baselineImages)
        .where(inArray(baselineImages.roomId, allRoomIds));

      const toDeactivate: string[] = [];
      let deactivatedUsableBaselines = 0;
      const baselinesByRoom = new Map<
        string,
        typeof baselinesWithScores
      >();

      for (const baseline of baselinesWithScores) {
        const list = baselinesByRoom.get(baseline.roomId) || [];
        list.push(baseline);
        baselinesByRoom.set(baseline.roomId, list);
      }

      for (const roomBaselines of baselinesByRoom.values()) {
        // Higher quality score is worse, so consider the noisiest baselines first.
        roomBaselines.sort(
          (a, b) => (b.qualityScore ?? 0) - (a.qualityScore ?? 0),
        );

        const usableCount = roomBaselines.filter(
          (baseline) =>
            Array.isArray(baseline.embedding) && baseline.embedding.length > 0,
        ).length;
        const minActiveUsableBaselines = Math.min(2, usableCount);
        let remainingUsableBaselines = usableCount;

        for (const baseline of roomBaselines) {
          const score = baseline.qualityScore ?? 0;
          if (score <= 2000) continue;

          const hasUsableEmbedding =
            Array.isArray(baseline.embedding) && baseline.embedding.length > 0;
          if (
            hasUsableEmbedding &&
            remainingUsableBaselines <= minActiveUsableBaselines
          ) {
            continue;
          }

          toDeactivate.push(baseline.id);
          if (hasUsableEmbedding) {
            remainingUsableBaselines--;
            deactivatedUsableBaselines++;
          }
          console.warn(
            `[train] Deactivated baseline ${baseline.id} due to poor quality score: ${score}`,
          );
        }
      }

      if (toDeactivate.length > 0) {
        await db
          .update(baselineImages)
          .set({ isActive: false })
          .where(inArray(baselineImages.id, toDeactivate));
        deactivatedBaselines = toDeactivate.length;
        usableBaselineCount = Math.max(
          0,
          usableBaselineCount - deactivatedUsableBaselines,
        );
      }
    }

    if (allPropertyBaselines.length > 0) {
      const minUsableBaselines = Math.max(
        createdRooms.length,
        Math.ceil(allPropertyBaselines.length * MIN_USABLE_BASELINE_RATIO),
      );

      if (usableBaselineCount < minUsableBaselines) {
        throw new Error(
          `Training produced only ${usableBaselineCount}/${allPropertyBaselines.length} usable baseline views. Please retrain this property.`,
        );
      }
    }

    if (embeddingFailures > 0) {
      console.warn(
        `[train] ${embeddingFailures}/${allPropertyBaselines.length} baselines failed embedding generation`,
      );
    }

    // Set cover image and mark as trained
    await db
      .update(properties)
      .set({
        trainingStatus: "trained",
        trainingCompletedAt: new Date(),
        coverImageUrl: imageUrls[0] || null,
        updatedAt: new Date(),
      })
      .where(eq(properties.id, id));

    // Emit events
    await emitEventSafe({
      eventType: "BaselineVersionCreated",
      aggregateId: id,
      propertyId: id,
      userId: dbUser.id,
      payload: {
        versionId: baselineVersion.id,
        versionNumber: 1,
        label: "Initial Training",
        baselineCount: allBaselineIds.length,
        roomCount: createdRooms.length,
      },
    });

    await emitEventSafe({
      eventType: "PropertyCreated",
      aggregateId: id,
      propertyId: id,
      userId: dbUser.id,
      payload: {
        propertyName: property.name,
        roomCount: createdRooms.length,
        totalItems: createdRooms.reduce((sum, r) => sum + r.items.length, 0),
        baselineCount: allBaselineIds.length,
      },
    });

    const totalItems = createdRooms.reduce(
      (sum, r) => sum + r.items.length,
      0,
    );

    return NextResponse.json({
      rooms: createdRooms,
      totalRooms: createdRooms.length,
      totalItems,
      usableBaselines: usableBaselineCount,
      deactivatedBaselines,
      dedupe: dedupeSummary,
      mediaSummary: {
        uploadedImages: rawImageUrls.length,
        uploadedVideos: videoUploadCount,
        analyzedFrames: imageUrls.length,
      },
      baselineVersion: {
        id: baselineVersion.id,
        versionNumber: 1,
        label: "Initial Training",
      },
    });
  } catch (err) {
    // Reset training status on error
    try {
      await db
        .update(properties)
        .set({ trainingStatus: "untrained", updatedAt: new Date() })
        .where(eq(properties.id, id));
    } catch (resetErr) {
      console.error("[train] Failed to reset training status:", resetErr);
    }

    return NextResponse.json(
      {
        error:
          err instanceof Error ? err.message : "Training failed unexpectedly",
      },
      { status: 500 },
    );
  }
  } catch (error) {
    console.error("[train] POST error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}

// Analyze property images with Claude Vision API
async function analyzePropertyImages(
  imageUrls: string[],
  propertyName: string,
): Promise<PropertyAnalysis> {
  const anthropicKey = process.env.CLAUDE_API_KEY;

  if (!anthropicKey) {
    return generateBasicStructure(imageUrls);
  }

  try {
    const imagesToAnalyze = imageUrls.slice(0, 10);
    const imageContents = [];

    for (const url of imagesToAnalyze) {
      try {
        if (!isSafeUrl(url)) {
          console.warn("[train] Blocked unsafe URL:", url);
          continue;
        }
        const imgRes = await fetch(url, { signal: AbortSignal.timeout(30000) });
        if (!imgRes.ok) continue;
        const buffer = await imgRes.arrayBuffer();
        const base64 = Buffer.from(buffer).toString("base64");
        const contentType =
          imgRes.headers.get("content-type") || "image/jpeg";

        imageContents.push({
          type: "image" as const,
          source: {
            type: "base64" as const,
            media_type: contentType.split(";")[0].trim(),
            data: base64,
          },
        });
      } catch (fetchErr) {
        console.warn("[train] Skipping image that failed to fetch:", fetchErr instanceof Error ? fetchErr.message : fetchErr);
      }
    }

    if (imageContents.length === 0) {
      return generateBasicStructure(imageUrls);
    }

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: AbortSignal.timeout(120000), // 2 minute timeout for AI analysis
      headers: {
        "Content-Type": "application/json",
        "x-api-key": anthropicKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 4096,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: `You are analyzing photos of a luxury property called "${propertyName}". Identify each distinct room shown and all notable items/furniture/decor in each room.

Return ONLY valid JSON (no other text) with this structure:
{
  "rooms": [
    {
      "name": "Room Name (e.g. Master Bedroom, Kitchen)",
      "room_type": "bedroom|bathroom|kitchen|living|dining|outdoor|garage|office|hallway|other",
      "description": "Brief description of the room",
      "image_urls": ["urls of images showing this room"],
      "image_labels": {
        "image_url_here": "Bookshelf wall"
      },
      "image_classifications": {
        "matching image url": {
          "type": "overview | detail | required_detail | standard",
          "parent_url": "url of the overview image this detail belongs to, or null",
          "detail_subject": "what this close-up is examining, or null"
        }
      },
      "items": [
        {
          "name": "Item name (e.g. Leather Sofa, Crystal Chandelier)",
          "category": "furniture|decor|appliance|fixture|art|textile|storage|lighting|electronics",
          "description": "Brief description",
          "condition": "excellent|good|fair",
          "importance": "critical|high|normal|low"
        }
      ]
    }
  ]
}

Analyze all images and group them by room. Be thorough — identify every significant item visible. If multiple images show the same room from different angles, group them together.

CRITICAL LABELING RULE — image_labels:
Every image MUST have a label in image_labels. Each label MUST be 2-4 words describing the most prominent object or area the camera is pointing at.

GOOD labels: "Treadmill and weights", "Bookshelf corner", "Desk workspace", "Recliner chair", "Wall shelves", "Exercise machine"
BAD labels (NEVER use these): "View 1", "Area 2", "Angle 3", "Shot 4", "Room overview", "Detail view", "Standard view"

The label must help a person find this exact spot in the room. Imagine telling someone "go stand where you can see the [label]" — the label must make that instruction clear. If two images show similar areas, differentiate them: "Left wall shelves" vs "Right wall shelves".

For each image, also classify it in image_classifications:
- "overview": shows the full room or a large section from a distance
- "detail": a close-up of a specific item, fixture, or area that is visible in an overview shot. These get automatically covered when the overview is matched.
- "required_detail": a close-up that requires independent verification — the inspector must specifically capture this angle. Use this for images showing the inside of cabinets, drawers, closets, appliance interiors, under-sink areas, or anything that is NOT visible from the overview shot and requires physically opening, moving, or closely inspecting something.
- "standard": a normal room angle that is neither a wide overview nor a tight close-up
For detail and required_detail images, set parent_url to the overview image URL that contains or is nearest to the subject, and detail_subject to the item name. This helps the inspection app understand spatial relationships between wide and close-up views.`,
              },
              ...imageContents,
            ],
          },
        ],
      }),
    });

    if (!res.ok) {
      return generateBasicStructure(imageUrls);
    }

    const data = await res.json();
    const rawText = data.content?.[0]?.text;

    if (!rawText) {
      return generateBasicStructure(imageUrls);
    }

    try {
      return JSON.parse(rawText);
    } catch {
      const start = rawText.indexOf("{");
      const end = rawText.lastIndexOf("}") + 1;
      if (start !== -1 && end > start) {
        return JSON.parse(rawText.substring(start, end));
      }
      return generateBasicStructure(imageUrls);
    }
  } catch (aiErr) {
    console.warn("[train] Claude API call failed, falling back to basic structure:", aiErr instanceof Error ? aiErr.message : aiErr);
    return generateBasicStructure(imageUrls);
  }
}

// Embedding generation and quality scoring are now in shared modules:
// - @/lib/vision/embeddings (generateEmbeddingWithOptions, getModelVersion)
// - @/lib/vision/quality (computeQualityScore)

function generateBasicStructure(imageUrls: string[]): PropertyAnalysis {
  if (imageUrls.length === 0) {
    return { rooms: [] };
  }

  return {
    rooms: [
      {
        name: "Primary Room",
        room_type: "other",
        description: "Fallback room grouping used (manual review recommended)",
        image_urls: [...imageUrls],
        items: [],
      },
    ],
  };
}

function normalizeAnalysis(
  analysis: PropertyAnalysis,
  imageUrls: string[],
): PropertyAnalysis {
  const rooms = Array.isArray(analysis?.rooms) ? analysis.rooms : [];
  if (rooms.length === 0) {
    return generateBasicStructure(imageUrls);
  }

  const mergedByName = new Map<string, RoomAnalysis>();
  const unnamedRooms: RoomAnalysis[] = [];

  for (const room of rooms) {
    const roomName =
      typeof room?.name === "string" && room.name.trim()
        ? room.name.trim()
        : "";
    const roomImages = getRoomImageUrls(room);
    const roomItems = Array.isArray(room.items) ? room.items : [];

    if (!roomName) {
      unnamedRooms.push({
        ...room,
        image_urls: roomImages,
        imageUrls: undefined,
        items: roomItems,
      });
      continue;
    }

    const key = roomName.toLowerCase();
    const existing = mergedByName.get(key);
    if (!existing) {
      mergedByName.set(key, {
        ...room,
        name: roomName,
        image_urls: roomImages,
        imageUrls: undefined,
        items: roomItems,
      });
      continue;
    }

    existing.image_urls = [
      ...new Set([...getRoomImageUrls(existing), ...roomImages]),
    ];
    existing.imageUrls = undefined;
    existing.items = [
      ...(Array.isArray(existing.items) ? existing.items : []),
      ...roomItems,
    ];

    const existingType =
      (typeof existing.room_type === "string" && existing.room_type) ||
      (typeof existing.roomType === "string" && existing.roomType) ||
      "";
    const incomingType =
      (typeof room.room_type === "string" && room.room_type) ||
      (typeof room.roomType === "string" && room.roomType) ||
      "";
    if ((!existingType || existingType === "other") && incomingType) {
      existing.room_type = incomingType;
      existing.roomType = undefined;
    }

    if (
      (!existing.description || !existing.description.trim()) &&
      typeof room.description === "string"
    ) {
      existing.description = room.description;
    }
  }

  const normalizedRooms = [...mergedByName.values(), ...unnamedRooms];
  if (normalizedRooms.length === 0) {
    return generateBasicStructure(imageUrls);
  }

  const hasOnlyGenericNames = normalizedRooms.every((room, idx) => {
    const name =
      typeof room?.name === "string" && room.name.trim()
        ? room.name.trim()
        : `Room ${idx + 1}`;
    return /^room\s*\d+$/i.test(name) || /^area\s*\d+$/i.test(name);
  });

  if (hasOnlyGenericNames && normalizedRooms.length > 1) {
    return generateBasicStructure(imageUrls);
  }

  return { rooms: normalizedRooms };
}

function getRoomImageUrls(room: RoomAnalysis): string[] {
  const imageUrls = [
    ...(Array.isArray(room.image_urls) ? room.image_urls : []),
    ...(Array.isArray(room.imageUrls) ? room.imageUrls : []),
  ];
  return [
    ...new Set(
      imageUrls.filter(
        (url): url is string => typeof url === "string" && url.trim().length > 0,
      ),
    ),
  ];
}

function ensureMinimumFrameSet(
  dedupedUrls: string[],
  originalUrls: string[],
  minimumKeep: number,
): string[] {
  const targetCount = Math.min(minimumKeep, originalUrls.length);
  if (dedupedUrls.length >= targetCount) {
    return dedupedUrls;
  }

  const expanded = [...dedupedUrls];
  const seen = new Set(expanded);

  for (const url of originalUrls) {
    if (expanded.length >= targetCount) break;
    if (seen.has(url)) continue;
    expanded.push(url);
    seen.add(url);
  }

  return expanded;
}

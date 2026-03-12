import { NextRequest, NextResponse } from "next/server";
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

const KEYFRAME_DEDUPE_MIN_IMAGES = 4;
const KEYFRAME_DEDUPE_MIN_KEEP = 3;
const ALLOW_PLACEHOLDER_EMBEDDINGS =
  process.env.ALLOW_PLACEHOLDER_EMBEDDINGS === "1";

type RoomAnalysis = {
  name?: string;
  room_type?: string;
  roomType?: string;
  description?: string;
  image_urls?: string[];
  imageUrls?: string[];
  items?: Array<{
    name?: unknown;
    category?: unknown;
    description?: unknown;
    condition?: unknown;
    importance?: unknown;
  }>;
};

type PropertyAnalysis = {
  rooms: RoomAnalysis[];
};

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
      let baselineCount = 0;

      for (const imgUrl of roomImageUrls) {
        // Only insert valid, safe string URLs from AI response
        if (typeof imgUrl !== "string" || !imgUrl.trim()) continue;
        if (!isSafeUrl(imgUrl)) continue;
        await db.insert(baselineImages).values({
          roomId: newRoom.id,
          imageUrl: imgUrl,
          label: `Baseline ${baselineCount + 1}`,
          isActive: true,
        });
        baselineCount++;
      }

      // If no specific images assigned, distribute available images
      if (baselineCount === 0 && imageUrls.length > 0) {
        const startIdx = Math.floor(
          (i * imageUrls.length) / analysis.rooms.length,
        );
        const endIdx = Math.floor(
          ((i + 1) * imageUrls.length) / analysis.rooms.length,
        );
        for (let j = startIdx; j < endIdx && j < imageUrls.length; j++) {
          await db.insert(baselineImages).values({
            roomId: newRoom.id,
            imageUrl: imageUrls[j],
            label: `Baseline ${j - startIdx + 1}`,
            isActive: true,
          });
          baselineCount++;
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

    const allBaselineIds: string[] = [];
    for (const bl of allPropertyBaselines) {
      allBaselineIds.push(bl.id);

      // Generate embedding + quality score
      const embedding = await generateEmbeddingWithOptions(bl.imageUrl, {
        allowPlaceholder: ALLOW_PLACEHOLDER_EMBEDDINGS,
      });
      const qualityScore = await computeQualityScore(bl.imageUrl);

      await db
        .update(baselineImages)
        .set({
          baselineVersionId: baselineVersion.id,
          embedding,
          qualityScore,
          embeddingModelVersion: getModelVersion(),
        })
        .where(eq(baselineImages.id, bl.id));
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
  const anthropicKey = process.env.ANTHROPIC_API_KEY;

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
        model: "claude-sonnet-4-5-20250514",
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

Analyze all images and group them by room. Be thorough — identify every significant item visible. If multiple images show the same room from different angles, group them together.`,
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

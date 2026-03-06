import { NextRequest, NextResponse } from "next/server";
import { getDbUser } from "@/lib/auth";
import { db } from "@/server/db";
import {
  properties,
  mediaUploads,
  rooms,
  items,
  baselineImages,
} from "@/server/schema";
import { eq, and, inArray } from "drizzle-orm";

// POST /api/properties/[id]/train - Analyze uploaded media with AI
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
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

  // Mark property as training
  await db
    .update(properties)
    .set({ trainingStatus: "training", updatedAt: new Date() })
    .where(eq(properties.id, id));

  try {
    const imageUrls = uploads
      .filter((u) => u.fileType.startsWith("image/"))
      .map((u) => u.fileUrl);

    if (imageUrls.length === 0) {
      throw new Error(
        "No image files found in uploads. Please upload at least one image.",
      );
    }

    // Analyze images with Claude Vision API directly
    const analysis = await analyzePropertyImages(imageUrls, property.name);

    // Create rooms and items from AI analysis
    const createdRooms = [];

    for (let i = 0; i < analysis.rooms.length; i++) {
      const roomData = analysis.rooms[i];

      // Create room
      const [newRoom] = await db
        .insert(rooms)
        .values({
          propertyId: id,
          name: roomData.name,
          description: roomData.description || null,
          roomType: roomData.room_type || roomData.roomType || null,
          sortOrder: i,
        })
        .returning();

      // Create items for this room
      const roomItems = [];
      if (roomData.items && Array.isArray(roomData.items)) {
        for (const itemData of roomData.items) {
          const [newItem] = await db
            .insert(items)
            .values({
              roomId: newRoom.id,
              name: itemData.name,
              category: itemData.category || null,
              description: itemData.description || null,
              condition: itemData.condition || "good",
              importance: itemData.importance || "normal",
            })
            .returning();
          roomItems.push({
            name: newItem.name,
            category: newItem.category || "",
          });
        }
      }

      // Assign baseline images to this room
      const roomImageUrls = roomData.image_urls || roomData.imageUrls || [];
      let baselineCount = 0;

      for (const imgUrl of roomImageUrls) {
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

    const totalItems = createdRooms.reduce(
      (sum, r) => sum + r.items.length,
      0,
    );

    return NextResponse.json({
      rooms: createdRooms,
      totalRooms: createdRooms.length,
      totalItems,
    });
  } catch (err) {
    // Reset training status on error
    await db
      .update(properties)
      .set({ trainingStatus: "untrained", updatedAt: new Date() })
      .where(eq(properties.id, id));

    return NextResponse.json(
      {
        error:
          err instanceof Error ? err.message : "Training failed unexpectedly",
      },
      { status: 500 },
    );
  }
}

// Analyze property images with Claude Vision API
async function analyzePropertyImages(
  imageUrls: string[],
  propertyName: string,
): Promise<{ rooms: any[] }> {
  const anthropicKey = process.env.ANTHROPIC_API_KEY;

  if (!anthropicKey) {
    return generateBasicStructure(imageUrls);
  }

  try {
    const imagesToAnalyze = imageUrls.slice(0, 10);
    const imageContents = [];

    for (const url of imagesToAnalyze) {
      try {
        const imgRes = await fetch(url);
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
      } catch {
        // Skip images that fail to fetch
      }
    }

    if (imageContents.length === 0) {
      return generateBasicStructure(imageUrls);
    }

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
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
  } catch {
    return generateBasicStructure(imageUrls);
  }
}

function generateBasicStructure(imageUrls: string[]): { rooms: any[] } {
  const rooms = imageUrls.map((url, i) => ({
    name: `Room ${i + 1}`,
    room_type: "other",
    description: "Auto-detected room (manual review recommended)",
    image_urls: [url],
    items: [],
  }));

  return { rooms };
}

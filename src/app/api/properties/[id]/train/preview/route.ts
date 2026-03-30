import { NextRequest, NextResponse } from "next/server";
import { getDbUser, isValidUUID, isSafeUrl } from "@/lib/auth";
import { db } from "@/server/db";
import { properties, mediaUploads } from "@/server/schema";
import { eq, and, inArray } from "drizzle-orm";

/**
 * POST /api/properties/[id]/train/preview
 *
 * Progressive training preview — runs a lightweight Claude analysis on a batch
 * of uploaded images to identify rooms and items in real-time during the capture
 * phase. Called every ~5 uploads so the user sees room identification happening
 * as they capture, rather than waiting for the full analysis at the end.
 *
 * Returns a preliminary room analysis that the mobile client can display.
 * The full train endpoint will do a final merge/dedup pass when "Done" is tapped.
 */
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

    let body: { mediaUploadIds?: string[]; previousRooms?: string[] };
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    const { mediaUploadIds, previousRooms = [] } = body;
    if (!mediaUploadIds || !Array.isArray(mediaUploadIds) || mediaUploadIds.length === 0) {
      return NextResponse.json({ error: "mediaUploadIds required" }, { status: 400 });
    }

    // Cap at 15 images per preview batch
    const cappedIds = mediaUploadIds.slice(0, 15);

    // Resolve upload URLs
    const uploads = await db
      .select({ id: mediaUploads.id, fileUrl: mediaUploads.fileUrl, fileType: mediaUploads.fileType })
      .from(mediaUploads)
      .where(
        and(
          inArray(mediaUploads.id, cappedIds),
          eq(mediaUploads.propertyId, id),
        ),
      );

    const imageUrls = uploads
      .filter((u) => u.fileType?.startsWith("image/") && u.fileUrl)
      .map((u) => u.fileUrl!);

    if (imageUrls.length === 0) {
      return NextResponse.json({
        rooms: [],
        itemCount: 0,
        message: "No image uploads found in this batch",
      });
    }

    // Lightweight Claude call — identify rooms and key items only
    const anthropicKey = process.env.CLAUDE_API_KEY;
    if (!anthropicKey) {
      return NextResponse.json({
        rooms: [],
        itemCount: 0,
        message: "AI unavailable",
      });
    }

    // Build image content blocks
    const imageContents: Array<{ type: string; source?: { type: string; media_type: string; data: string }; text?: string }> = [];
    let loadedCount = 0;

    for (const url of imageUrls.slice(0, 10)) { // Max 10 images per preview
      try {
        if (!isSafeUrl(url)) continue;
        const res = await fetch(url, {
          signal: AbortSignal.timeout(8000),
          redirect: "error",
        });
        if (!res.ok) continue;
        const buffer = Buffer.from(await res.arrayBuffer());
        const contentType = res.headers.get("content-type")?.split(";")[0]?.trim() || "image/jpeg";
        const base64 = buffer.toString("base64");
        if (base64.length < 100) continue;

        imageContents.push({
          type: "image",
          source: {
            type: "base64",
            media_type: contentType,
            data: base64,
          },
        });
        loadedCount++;
      } catch {
        // Skip failed images
      }
    }

    if (loadedCount === 0) {
      return NextResponse.json({
        rooms: [],
        itemCount: 0,
        message: "Could not load any images",
      });
    }

    const previousRoomsContext = previousRooms.length > 0
      ? `\n\nPreviously identified rooms: ${previousRooms.join(", ")}. If these images show the same rooms, use the same names. If they show new rooms, add them.`
      : "";

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: AbortSignal.timeout(30000), // 30s timeout for preview (faster than full train)
      headers: {
        "Content-Type": "application/json",
        "x-api-key": anthropicKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 2048,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: `You are doing a quick preview analysis of property photos for "${property.name}". Identify which rooms are shown and the key items visible.${previousRoomsContext}

Return ONLY valid JSON:
{
  "rooms": [
    {
      "name": "Room Name",
      "imageCount": number_of_images_showing_this_room,
      "keyItems": ["Item 1", "Item 2", "Item 3"]
    }
  ]
}

Be concise. Focus on room identification and the most notable 3-5 items per room. This is a quick preview, not a full analysis.`,
              },
              ...imageContents,
            ],
          },
        ],
      }),
    });

    if (!res.ok) {
      console.warn(`[train/preview] Claude API error: ${res.status}`);
      return NextResponse.json({
        rooms: [],
        itemCount: 0,
        message: "Preview analysis temporarily unavailable",
      });
    }

    const data = await res.json();
    const rawText = data.content?.[0]?.text || "";

    let parsed: { rooms?: Array<{ name: string; imageCount?: number; keyItems?: string[] }> } = { rooms: [] };
    try {
      parsed = JSON.parse(rawText);
    } catch {
      // Try extracting JSON from markdown
      const start = rawText.indexOf("{");
      const end = rawText.lastIndexOf("}") + 1;
      if (start !== -1 && end > start) {
        try {
          parsed = JSON.parse(rawText.substring(start, end));
        } catch {
          // Fall through with empty rooms
        }
      }
    }

    const rooms = (parsed.rooms || []).map((r) => ({
      name: typeof r.name === "string" ? r.name.trim() : "Unknown Room",
      imageCount: typeof r.imageCount === "number" ? r.imageCount : 1,
      keyItems: Array.isArray(r.keyItems) ? r.keyItems.filter((i): i is string => typeof i === "string").slice(0, 8) : [],
    }));

    const totalItems = rooms.reduce((sum, r) => sum + r.keyItems.length, 0);

    return NextResponse.json({
      rooms,
      itemCount: totalItems,
      message: rooms.length > 0
        ? `Found ${rooms.length} room${rooms.length !== 1 ? "s" : ""} with ${totalItems} items`
        : "Analyzing images...",
    });
  } catch (error) {
    console.error("[train/preview] Error:", error);
    return NextResponse.json({
      rooms: [],
      itemCount: 0,
      message: "Preview failed",
    }, { status: 500 });
  }
}

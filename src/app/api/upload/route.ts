import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getDbUser } from "@/lib/auth";
import { db } from "@/server/db";
import { properties, mediaUploads } from "@/server/schema";
import { eq, and } from "drizzle-orm";

const ALLOWED_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "video/mp4",
  "video/quicktime",
]);

const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB

export async function POST(request: NextRequest) {
  const dbUser = await getDbUser();
  if (!dbUser) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = await createClient();
  const formData = await request.formData();
  const file = formData.get("file") as File | null;
  const propertyId = formData.get("propertyId") as string | null;

  if (!file || !propertyId) {
    return NextResponse.json(
      { error: "File and propertyId are required" },
      { status: 400 },
    );
  }

  // Verify property ownership
  const [property] = await db
    .select()
    .from(properties)
    .where(and(eq(properties.id, propertyId), eq(properties.userId, dbUser.id)));

  if (!property) {
    return NextResponse.json(
      { error: "Property not found" },
      { status: 404 },
    );
  }

  // Validate file type
  if (!ALLOWED_TYPES.has(file.type)) {
    return NextResponse.json(
      { error: "Unsupported file type. Use JPG, PNG, WebP, GIF, MP4, or MOV." },
      { status: 400 },
    );
  }

  // Validate file size
  if (file.size > MAX_FILE_SIZE) {
    return NextResponse.json(
      { error: "File too large. Maximum size is 50MB." },
      { status: 400 },
    );
  }

  // Upload to Supabase Storage
  const fileExt = file.name.split(".").pop();
  const fileName = `${propertyId}/${Date.now()}-${Math.random().toString(36).slice(2)}.${fileExt}`;

  const arrayBuffer = await file.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  let uploadSuccess = false;

  const { error: uploadError } = await supabase.storage
    .from("property-media")
    .upload(fileName, buffer, {
      contentType: file.type,
      upsert: false,
    });

  if (uploadError) {
    if (
      uploadError.message.includes("not found") ||
      uploadError.message.includes("Bucket")
    ) {
      await supabase.storage.createBucket("property-media", {
        public: true,
      });
      const { error: retryError } = await supabase.storage
        .from("property-media")
        .upload(fileName, buffer, {
          contentType: file.type,
          upsert: false,
        });
      if (retryError) {
        return NextResponse.json(
          { error: `Upload failed: ${retryError.message}` },
          { status: 500 },
        );
      }
      uploadSuccess = true;
    } else {
      return NextResponse.json(
        { error: `Upload failed: ${uploadError.message}` },
        { status: 500 },
      );
    }
  } else {
    uploadSuccess = true;
  }

  if (!uploadSuccess) {
    return NextResponse.json({ error: "Upload failed" }, { status: 500 });
  }

  // Get public URL
  const {
    data: { publicUrl },
  } = supabase.storage.from("property-media").getPublicUrl(fileName);

  // Store record in DB
  const [record] = await db
    .insert(mediaUploads)
    .values({
      propertyId,
      fileUrl: publicUrl,
      fileName: file.name,
      fileType: file.type,
      fileSize: file.size,
    })
    .returning();

  return NextResponse.json({
    id: record.id,
    fileUrl: publicUrl,
    fileName: file.name,
    fileType: file.type,
  });
}

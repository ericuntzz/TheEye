import { NextRequest, NextResponse } from "next/server";
import { createClient as createSupabaseClient, type SupabaseClient } from "@supabase/supabase-js";
import { getDbUser, isValidUUID } from "@/lib/auth";
import { db } from "@/server/db";
import { properties, mediaUploads } from "@/server/schema";
import { eq, and } from "drizzle-orm";

const ALLOWED_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/heic",
  "image/heif",
  "video/mp4",
  "video/quicktime",
]);

const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB
const STORAGE_UPLOAD_RETRIES = 5;

function createStorageAdminClient(): SupabaseClient {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error("Missing Supabase storage server credentials");
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
): Promise<{ error: { message: string } | null }> {
  let lastError: { message: string } | null = null;

  for (let attempt = 1; attempt <= STORAGE_UPLOAD_RETRIES; attempt++) {
    const { error } = await supabase.storage
      .from("property-media")
      .upload(path, data, {
        contentType,
        upsert: false,
      });

    if (!error) {
      return { error: null };
    }

    lastError = { message: error.message };
    const msg = error.message || "Upload failed";

    if (isBucketMissingError(msg)) {
      await supabase.storage.createBucket("property-media", { public: true });
      continue;
    }

    if (isTransientUploadError(msg) && attempt < STORAGE_UPLOAD_RETRIES) {
      await new Promise((resolve) => setTimeout(resolve, 400 * attempt));
      continue;
    }

    return { error: { message: msg } };
  }

  return { error: lastError || { message: "Upload failed after retries" } };
}

export async function POST(request: NextRequest) {
  try {
  const dbUser = await getDbUser();
  if (!dbUser) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const contentType = request.headers.get("content-type") || "";

  // Route to base64 handler for JSON bodies
  if (contentType.includes("application/json")) {
    return handleBase64Upload(request, dbUser.id);
  }

  const supabase = createStorageAdminClient();
  let formData: {
    get(name: string): FormDataEntryValue | null;
  };
  try {
    formData = (await request.formData()) as unknown as {
      get(name: string): FormDataEntryValue | null;
    };
  } catch (formErr) {
    const msg = formErr instanceof Error ? formErr.message : String(formErr);
    if (
      msg.toLowerCase().includes("formdata") ||
      msg.toLowerCase().includes("boundary") ||
      msg.toLowerCase().includes("body")
    ) {
      return NextResponse.json(
        {
          error:
            "Upload payload could not be parsed. Keep each video under 50MB and retry.",
        },
        { status: 413 },
      );
    }
    throw formErr;
  }
  const file = formData.get("file") as File | null;
  const propertyId = formData.get("propertyId") as string | null;

  if (!file || !propertyId) {
    return NextResponse.json(
      { error: "File and propertyId are required" },
      { status: 400 },
    );
  }

  if (!isValidUUID(propertyId)) {
    return NextResponse.json(
      { error: "Invalid propertyId format" },
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

  const { error: uploadError } = await uploadToPropertyMediaWithRetry(
    supabase,
    fileName,
    buffer,
    file.type,
  );
  if (uploadError) {
    console.error("[upload] Storage error:", uploadError.message);
    return NextResponse.json(
      { error: `Upload failed: ${uploadError.message}` },
      { status: 500 },
    );
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
  } catch (error) {
    console.error("[upload] POST error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}

const MAX_BASE64_SIZE = 50 * 1024 * 1024; // 50MB decoded

async function handleBase64Upload(request: NextRequest, userId: string) {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { base64Image, propertyId, fileName } = body;

  if (!base64Image || !propertyId) {
    return NextResponse.json(
      { error: "base64Image and propertyId are required" },
      { status: 400 },
    );
  }

  if (typeof base64Image !== "string") {
    return NextResponse.json(
      { error: "base64Image must be a string" },
      { status: 400 },
    );
  }

  if (typeof propertyId !== "string" || !isValidUUID(propertyId)) {
    return NextResponse.json(
      { error: "Invalid propertyId format" },
      { status: 400 },
    );
  }

  // Verify property ownership
  const [property] = await db
    .select()
    .from(properties)
    .where(
      and(eq(properties.id, propertyId as string), eq(properties.userId, userId)),
    );

  if (!property) {
    return NextResponse.json(
      { error: "Property not found" },
      { status: 404 },
    );
  }

  // Parse base64 — supports both raw and data URI formats
  let base64Data = base64Image as string;
  let mimeType = "image/jpeg";

  const dataUriMatch = base64Data.match(
    /^data:((?:image|video)\/[\w.+-]+);base64,(.+)$/,
  );
  if (dataUriMatch) {
    mimeType = dataUriMatch[1];
    base64Data = dataUriMatch[2];
  }

  if (!ALLOWED_TYPES.has(mimeType)) {
    return NextResponse.json(
      { error: "Unsupported image type" },
      { status: 400 },
    );
  }

  const buffer = Buffer.from(base64Data, "base64");

  if (buffer.length > MAX_BASE64_SIZE) {
    return NextResponse.json(
      { error: "Image too large. Maximum size is 50MB." },
      { status: 400 },
    );
  }

  // Determine file extension from mime type
  const extMap: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
    "image/heic": "heic",
    "image/heif": "heif",
    "video/mp4": "mp4",
    "video/quicktime": "mov",
  };
  const ext = extMap[mimeType] || "jpg";
  const generatedName =
    (fileName as string) ||
    `capture-${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
  const storagePath = `${propertyId}/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;

  const supabase = createStorageAdminClient();

  const { error: uploadError } = await uploadToPropertyMediaWithRetry(
    supabase,
    storagePath,
    buffer,
    mimeType,
  );
  if (uploadError) {
    return NextResponse.json(
      { error: `Upload failed: ${uploadError.message}` },
      { status: 500 },
    );
  }

  const {
    data: { publicUrl },
  } = supabase.storage.from("property-media").getPublicUrl(storagePath);

  const [record] = await db
    .insert(mediaUploads)
    .values({
      propertyId: propertyId as string,
      fileUrl: publicUrl,
      fileName: generatedName,
      fileType: mimeType,
      fileSize: buffer.length,
    })
    .returning();

  return NextResponse.json({
    id: record.id,
    fileUrl: publicUrl,
    fileName: generatedName,
    fileType: mimeType,
  });
}

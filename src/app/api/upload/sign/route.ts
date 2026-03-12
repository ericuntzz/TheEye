import { NextRequest, NextResponse } from "next/server";
import { createClient as createSupabaseClient, type SupabaseClient } from "@supabase/supabase-js";
import { and, eq } from "drizzle-orm";
import { getDbUser, isValidUUID } from "@/lib/auth";
import { db } from "@/server/db";
import { properties } from "@/server/schema";

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

const MAX_IMAGE_FILE_SIZE = 50 * 1024 * 1024; // 50MB
const MAX_VIDEO_FILE_SIZE = 512 * 1024 * 1024; // 512MB

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

function sanitizeFileName(fileName: string, fallback: string): string {
  const trimmed = fileName.trim();
  if (!trimmed) return fallback;

  return trimmed
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 120) || fallback;
}

export async function POST(request: NextRequest) {
  try {
    const dbUser = await getDbUser();
    if (!dbUser) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    let body: Record<string, unknown>;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const propertyId = body.propertyId;
    const fileName = body.fileName;
    const fileType = body.fileType;
    const fileSize = body.fileSize;

    if (typeof propertyId !== "string" || !isValidUUID(propertyId)) {
      return NextResponse.json({ error: "Invalid propertyId format" }, { status: 400 });
    }

    if (typeof fileType !== "string" || !ALLOWED_TYPES.has(fileType)) {
      return NextResponse.json(
        { error: "Unsupported file type. Use JPG, PNG, WebP, GIF, MP4, or MOV." },
        { status: 400 },
      );
    }

    if (fileSize != null && (typeof fileSize !== "number" || !Number.isFinite(fileSize) || fileSize < 0)) {
      return NextResponse.json({ error: "Invalid fileSize" }, { status: 400 });
    }

    const maxSizeForType = fileType.startsWith("video/")
      ? MAX_VIDEO_FILE_SIZE
      : MAX_IMAGE_FILE_SIZE;
    if (typeof fileSize === "number" && fileSize > maxSizeForType) {
      const maxLabel = fileType.startsWith("video/") ? "512MB" : "50MB";
      return NextResponse.json(
        { error: `File too large. Maximum size is ${maxLabel}.` },
        { status: 400 },
      );
    }

    const [property] = await db
      .select()
      .from(properties)
      .where(and(eq(properties.id, propertyId), eq(properties.userId, dbUser.id)));

    if (!property) {
      return NextResponse.json({ error: "Property not found" }, { status: 404 });
    }

    const extFromType = fileType === "video/quicktime"
      ? "mov"
      : fileType.split("/")[1]?.split(";")[0] || "bin";
    const fallbackName = fileType.startsWith("video/") ? "training-video" : "training-image";
    const safeOriginalName = sanitizeFileName(
      typeof fileName === "string" ? fileName : "",
      `${fallbackName}.${extFromType}`,
    );
    const storagePath = `${propertyId}/${Date.now()}-${Math.random().toString(36).slice(2)}-${safeOriginalName}`;

    const supabase = createStorageAdminClient();

    // Ensure bucket exists for greenfield environments
    await supabase.storage.createBucket("property-media", { public: true }).catch(() => {});

    const { data, error } = await supabase.storage
      .from("property-media")
      .createSignedUploadUrl(storagePath, { upsert: false });

    if (error || !data?.signedUrl) {
      return NextResponse.json(
        { error: `Failed to prepare upload: ${error?.message || "unknown error"}` },
        { status: 500 },
      );
    }

    const {
      data: { publicUrl },
    } = supabase.storage.from("property-media").getPublicUrl(storagePath);

    return NextResponse.json({
      storagePath,
      signedUrl: data.signedUrl,
      token: data.token,
      publicUrl,
      fileName: safeOriginalName,
      fileType,
      propertyId,
    });
  } catch (error) {
    console.error("[upload/sign] POST error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}


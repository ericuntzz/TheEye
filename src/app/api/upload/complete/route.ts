import { NextRequest, NextResponse } from "next/server";
import { createClient as createSupabaseClient, type SupabaseClient } from "@supabase/supabase-js";
import { and, eq } from "drizzle-orm";
import { getDbUser, isValidUUID } from "@/lib/auth";
import { db } from "@/server/db";
import { mediaUploads, properties } from "@/server/schema";

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

function normalizeStoragePath(input: string): string {
  return input
    .replace(/^\/+/, "")
    .replace(/\.\./g, "")
    .trim();
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
    const storagePathRaw = body.storagePath;
    const fileName = body.fileName;
    const fileType = body.fileType;
    const fileSize = body.fileSize;

    if (typeof propertyId !== "string" || !isValidUUID(propertyId)) {
      return NextResponse.json({ error: "Invalid propertyId format" }, { status: 400 });
    }
    if (typeof storagePathRaw !== "string" || !storagePathRaw.trim()) {
      return NextResponse.json({ error: "storagePath is required" }, { status: 400 });
    }
    if (typeof fileName !== "string" || !fileName.trim()) {
      return NextResponse.json({ error: "fileName is required" }, { status: 400 });
    }
    if (typeof fileType !== "string" || !ALLOWED_TYPES.has(fileType)) {
      return NextResponse.json({ error: "Unsupported file type" }, { status: 400 });
    }
    if (typeof fileSize !== "number" || !Number.isFinite(fileSize) || fileSize < 0) {
      return NextResponse.json({ error: "Invalid fileSize" }, { status: 400 });
    }

    const storagePath = normalizeStoragePath(storagePathRaw);
    if (!storagePath.startsWith(`${propertyId}/`)) {
      return NextResponse.json(
        { error: "storagePath must belong to the target property" },
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

    const supabase = createStorageAdminClient();
    const {
      data: { publicUrl },
    } = supabase.storage.from("property-media").getPublicUrl(storagePath);

    const [record] = await db
      .insert(mediaUploads)
      .values({
        propertyId,
        fileUrl: publicUrl,
        fileName: fileName.trim().slice(0, 255),
        fileType,
        fileSize: Math.round(fileSize),
      })
      .returning();

    return NextResponse.json({
      id: record.id,
      fileUrl: publicUrl,
      fileName: record.fileName,
      fileType: record.fileType,
    });
  } catch (error) {
    console.error("[upload/complete] POST error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}


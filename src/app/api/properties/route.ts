import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { db } from "@/server/db";
import { properties, users } from "@/server/schema";
import { eq } from "drizzle-orm";

async function getDbUser() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return null;

  const [dbUser] = await db
    .select()
    .from(users)
    .where(eq(users.supabaseId, user.id));

  if (!dbUser) {
    // Auto-create user record
    const [newUser] = await db
      .insert(users)
      .values({
        supabaseId: user.id,
        email: user.email!,
      })
      .returning();
    return newUser;
  }

  return dbUser;
}

// GET /api/properties - List all properties for the current user
export async function GET() {
  const dbUser = await getDbUser();
  if (!dbUser) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const userProperties = await db
    .select()
    .from(properties)
    .where(eq(properties.userId, dbUser.id));

  return NextResponse.json(userProperties);
}

// POST /api/properties - Create a new property
export async function POST(request: NextRequest) {
  const dbUser = await getDbUser();
  if (!dbUser) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json();

  const [property] = await db
    .insert(properties)
    .values({
      userId: dbUser.id,
      name: body.name,
      address: body.address || null,
      city: body.city || null,
      state: body.state || null,
      zipCode: body.zipCode || null,
      propertyType: body.propertyType || null,
      bedrooms: body.bedrooms ? parseInt(body.bedrooms) : null,
      bathrooms: body.bathrooms ? parseInt(body.bathrooms) : null,
      squareFeet: body.squareFeet ? parseInt(body.squareFeet) : null,
      estimatedValue: body.estimatedValue || null,
      notes: body.notes || null,
    })
    .returning();

  return NextResponse.json(property, { status: 201 });
}

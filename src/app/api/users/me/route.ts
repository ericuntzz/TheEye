import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { db } from "@/server/db";
import { users } from "@/server/schema";
import { eq } from "drizzle-orm";

export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Find or create user in our database
  let [dbUser] = await db
    .select()
    .from(users)
    .where(eq(users.supabaseId, user.id));

  if (!dbUser) {
    [dbUser] = await db
      .insert(users)
      .values({
        supabaseId: user.id,
        email: user.email!,
        firstName: user.user_metadata?.first_name || null,
        lastName: user.user_metadata?.last_name || null,
        profileImageUrl: user.user_metadata?.avatar_url || null,
      })
      .returning();
  }

  return NextResponse.json(dbUser);
}

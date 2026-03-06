import { createClient } from "@/lib/supabase/server";
import { db } from "@/server/db";
import { users } from "@/server/schema";
import { eq } from "drizzle-orm";

/**
 * Get the authenticated user's database record.
 * Auto-creates a user record on first login if one doesn't exist.
 */
export async function getDbUser() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return null;

  const [dbUser] = await db
    .select()
    .from(users)
    .where(eq(users.supabaseId, user.id));

  if (dbUser) return dbUser;

  // Auto-create user record on first access
  const [newUser] = await db
    .insert(users)
    .values({
      supabaseId: user.id,
      email: user.email || `${user.id}@unknown`,
      firstName: user.user_metadata?.first_name || null,
      lastName: user.user_metadata?.last_name || null,
      profileImageUrl: user.user_metadata?.avatar_url || null,
    })
    .returning();

  return newUser;
}

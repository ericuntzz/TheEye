import { NextResponse } from "next/server";
import { getDbUser } from "@/lib/auth";

export async function GET() {
  const dbUser = await getDbUser();
  if (!dbUser) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return NextResponse.json(dbUser);
}

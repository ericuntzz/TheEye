import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

const VISION_SERVICE_URL =
  process.env.VISION_SERVICE_URL || "http://localhost:8000";

export async function POST(request: NextRequest) {
  // Verify authentication
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await request.json();

    // Proxy the request to the Python vision service
    const response = await fetch(`${VISION_SERVICE_URL}/api/v1/compare`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        ...body,
        userId: user.id,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      return NextResponse.json(
        { error: `Vision service error: ${errorText}` },
        { status: response.status },
      );
    }

    const result = await response.json();
    return NextResponse.json(result);
  } catch (error) {
    console.error("Vision comparison error:", error);
    return NextResponse.json(
      { error: "Failed to process comparison" },
      { status: 500 },
    );
  }
}

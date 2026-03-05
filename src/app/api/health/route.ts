import { NextResponse } from "next/server";

export async function GET() {
  return NextResponse.json({
    status: "ok",
    service: "the-eye-web",
    timestamp: new Date().toISOString(),
  });
}

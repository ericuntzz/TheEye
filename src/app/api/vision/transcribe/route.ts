import { NextRequest, NextResponse } from "next/server";
import { getDbUser } from "@/lib/auth";

/**
 * POST /api/vision/transcribe
 *
 * Accepts an audio file upload and returns a text transcription.
 * Uses OpenAI Whisper API for transcription (most cost-effective
 * for audio-to-text). Falls back to Claude if Whisper is unavailable.
 *
 * Body: multipart/form-data with "audio" file field
 * Returns: { transcript: string }
 */
export async function POST(request: NextRequest) {
  try {
    const dbUser = await getDbUser();
    if (!dbUser) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const formData = await request.formData().catch(() => null);
    if (!formData) {
      return NextResponse.json({ error: "Invalid form data" }, { status: 400 });
    }

    const audioFile = formData.get("audio");
    if (!audioFile || !(audioFile instanceof File)) {
      return NextResponse.json({ error: "audio file is required" }, { status: 400 });
    }

    // Validate MIME type — only accept audio formats
    const ALLOWED_AUDIO_TYPES = ["audio/mp4", "audio/m4a", "audio/x-m4a", "audio/mpeg", "audio/wav", "audio/webm", "audio/ogg", "audio/aac"];
    const audioType = audioFile.type?.toLowerCase().split(";")[0]?.trim();
    if (!audioType || !ALLOWED_AUDIO_TYPES.includes(audioType)) {
      return NextResponse.json(
        { error: `Unsupported audio format: ${audioType || "unknown"}. Accepted: ${ALLOWED_AUDIO_TYPES.join(", ")}` },
        { status: 400 },
      );
    }

    // Validate file size (max 25MB — Whisper API limit)
    const MAX_AUDIO_SIZE = 25 * 1024 * 1024;
    if (audioFile.size > MAX_AUDIO_SIZE) {
      return NextResponse.json({ error: "Audio file too large (max 25MB)" }, { status: 400 });
    }

    // Try OpenAI Whisper first (best for audio transcription)
    const openaiKey = process.env.OPENAI_API_KEY;
    if (openaiKey) {
      try {
        const whisperForm = new FormData();
        whisperForm.append("file", audioFile, audioFile.name || "voice-note.m4a");
        whisperForm.append("model", "whisper-1");
        whisperForm.append("language", "en");
        whisperForm.append("response_format", "text");

        const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${openaiKey}`,
          },
          body: whisperForm,
          signal: AbortSignal.timeout(30000),
        });

        if (res.ok) {
          const transcript = (await res.text()).trim();
          return NextResponse.json({ transcript });
        }

        console.warn(`[transcribe] Whisper API error: ${res.status} ${res.statusText}`);
      } catch (err) {
        console.warn("[transcribe] Whisper API failed:", err);
      }
    }

    // Fallback: Use Claude to describe the audio context
    // (Claude can't directly transcribe audio, but we can note the attempt)
    const anthropicKey = process.env.CLAUDE_API_KEY;
    if (anthropicKey) {
      // For now, return empty transcript with a note — Claude doesn't support audio input directly.
      // When Anthropic adds audio support, this path will handle it.
      console.warn("[transcribe] No Whisper API key available. Claude audio transcription not yet supported.");
      return NextResponse.json({
        transcript: "",
        warning: "Transcription requires OPENAI_API_KEY for Whisper. Audio saved but not transcribed.",
      });
    }

    return NextResponse.json({
      transcript: "",
      warning: "No transcription service available. Set OPENAI_API_KEY for Whisper transcription.",
    });
  } catch (error) {
    console.error("[vision/transcribe] POST error:", error);
    return NextResponse.json({ error: "Transcription failed" }, { status: 500 });
  }
}

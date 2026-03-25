/**
 * Voice Notes — Hands-Free Finding Input
 *
 * Enables inspectors to speak findings naturally while walking.
 * Captures audio, transcribes it, and creates structured findings
 * linked to the nearest captured frame.
 *
 * Uses expo-speech for TTS feedback and expo-av for recording.
 * Server-side transcription via Whisper or Claude.
 */

import { Audio } from "expo-av";

export interface VoiceNoteResult {
  /** Transcribed text from the recording */
  transcript: string;
  /** Duration of the recording in milliseconds */
  durationMs: number;
  /** URI of the audio file (for upload if needed) */
  audioUri: string;
}

export interface VoiceNoteRecorder {
  /** Whether recording is currently active */
  isRecording: boolean;
  /** Start recording a voice note */
  startRecording: () => Promise<boolean>;
  /** Stop recording and get the transcribed result */
  stopRecording: () => Promise<VoiceNoteResult | null>;
  /** Cancel the current recording without transcribing */
  cancelRecording: () => Promise<void>;
  /** Clean up resources */
  dispose: () => void;
}

const MAX_RECORDING_DURATION_MS = 30000; // 30 seconds max

/**
 * Create a voice note recorder.
 * Call startRecording() to begin, stopRecording() to get the transcript.
 */
export function createVoiceNoteRecorder(
  apiUrl: string,
  getAuthToken: () => Promise<string | null>,
): VoiceNoteRecorder {
  let recording: Audio.Recording | null = null;
  let recordingStartTime = 0;
  let autoStopTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const startRecording = async (): Promise<boolean> => {
    if (disposed || recording) return false;

    try {
      // Request permissions
      const { granted } = await Audio.requestPermissionsAsync();
      if (!granted) {
        console.warn("[VoiceNotes] Microphone permission denied");
        return false;
      }

      // Configure audio session for recording
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true,
      });

      // Start recording
      const { recording: newRecording } = await Audio.Recording.createAsync(
        Audio.RecordingOptionsPresets.HIGH_QUALITY,
      );

      recording = newRecording;
      recordingStartTime = Date.now();

      // Auto-stop after max duration
      autoStopTimer = setTimeout(() => {
        if (recording) {
          console.log("[VoiceNotes] Auto-stopping after max duration");
          void stopRecording();
        }
      }, MAX_RECORDING_DURATION_MS);

      return true;
    } catch (err) {
      console.warn("[VoiceNotes] Failed to start recording:", err);
      return false;
    }
  };

  let stopping = false; // Guard against race between auto-stop and manual stop

  const stopRecording = async (): Promise<VoiceNoteResult | null> => {
    if (!recording || stopping) return null;
    stopping = true;

    if (autoStopTimer) {
      clearTimeout(autoStopTimer);
      autoStopTimer = null;
    }

    try {
      await recording.stopAndUnloadAsync();
      const uri = recording.getURI();
      const durationMs = Date.now() - recordingStartTime;
      recording = null;

      if (!uri) return null;

      // Reset audio mode
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: false,
      });

      // Transcribe via server
      const transcript = await transcribeAudio(uri, apiUrl, getAuthToken);

      return {
        transcript: transcript || "",
        durationMs,
        audioUri: uri,
      };
    } catch (err) {
      console.warn("[VoiceNotes] Failed to stop recording:", err);
      recording = null;
      return null;
    } finally {
      stopping = false;
    }
  };

  const cancelRecording = async (): Promise<void> => {
    if (!recording) return;

    if (autoStopTimer) {
      clearTimeout(autoStopTimer);
      autoStopTimer = null;
    }

    try {
      await recording.stopAndUnloadAsync();
    } catch {
      // Ignore errors during cancel
    }
    recording = null;

    await Audio.setAudioModeAsync({
      allowsRecordingIOS: false,
    });
  };

  return {
    get isRecording() {
      return recording !== null;
    },
    startRecording,
    stopRecording,
    cancelRecording,
    dispose: () => {
      disposed = true;
      void cancelRecording();
    },
  };
}

/**
 * Transcribe audio file via server-side AI.
 * Falls back to empty string on failure.
 */
async function transcribeAudio(
  audioUri: string,
  apiUrl: string,
  getAuthToken: () => Promise<string | null>,
): Promise<string> {
  try {
    const token = await getAuthToken();
    if (!token) return "";

    // React Native FormData requires URI-based objects, not Blob
    const formData = new FormData();
    formData.append("audio", {
      uri: audioUri,
      type: "audio/mp4",
      name: "voice-note.m4a",
    } as unknown as Blob); // RN FormData accepts this shape

    const transcribeRes = await fetch(`${apiUrl}/api/vision/transcribe`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
      },
      body: formData,
    });

    if (!transcribeRes.ok) {
      console.warn("[VoiceNotes] Transcription failed:", transcribeRes.status);
      return "";
    }

    const data = await transcribeRes.json();
    return data.transcript || "";
  } catch (err) {
    console.warn("[VoiceNotes] Transcription error:", err);
    return "";
  }
}

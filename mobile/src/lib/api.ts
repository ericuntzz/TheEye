import { Platform } from "react-native";
import { supabase } from "./supabase";

const API_BASE = process.env.EXPO_PUBLIC_API_URL ?? "";
if (!API_BASE) throw new Error("Missing EXPO_PUBLIC_API_URL env var");
const LOCALHOST_API_PATTERN = /(^|:\/\/)(localhost|127\.0\.0\.1)(:|\/|$)/i;

if (__DEV__ && LOCALHOST_API_PATTERN.test(API_BASE)) {
  console.warn(
    `[api] EXPO_PUBLIC_API_URL is ${API_BASE}. On physical devices, localhost points to the phone. Use your Mac LAN IP or run "npm run dev:phone".`,
  );
}

/** Default request timeout (15 seconds) */
const REQUEST_TIMEOUT_MS = 15_000;

/** Max retries for transient failures (network errors, 5xx) */
const MAX_RETRIES = 2;

interface FetchOptions extends RequestInit {
  json?: Record<string, unknown>;
  /** Override default timeout (ms). Set to 0 for no timeout. */
  timeoutMs?: number;
  /** Disable automatic retry for this request */
  noRetry?: boolean;
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "ApiError";
  }
}

/**
 * Fetch with a timeout using AbortController.
 */
function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  if (timeoutMs <= 0) return fetch(url, options);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  return fetch(url, { ...options, signal: controller.signal }).finally(() =>
    clearTimeout(timeout),
  );
}

/**
 * Authenticated fetch wrapper for the Next.js backend.
 * Includes request timeout, automatic retry on transient failures,
 * and 401 token refresh.
 */
async function authFetch(path: string, options: FetchOptions = {}) {
  const {
    data: { session },
  } = await supabase.auth.getSession();

  if (!session?.access_token) {
    throw new Error("Not authenticated");
  }

  const { json, timeoutMs = REQUEST_TIMEOUT_MS, noRetry, ...fetchOptions } = options;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${session.access_token}`,
    ...(options.headers as Record<string, string>),
  };

  if (json) {
    headers["Content-Type"] = "application/json";
    fetchOptions.body = JSON.stringify(json);
  }

  const url = `${API_BASE}${path}`;
  const maxAttempts = noRetry ? 1 : MAX_RETRIES + 1;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetchWithTimeout(url, { ...fetchOptions, headers }, timeoutMs);

      // On 401, try refreshing the token once and retry
      if (res.status === 401 && attempt === 1) {
        const { data: refreshData } = await supabase.auth.refreshSession();
        if (refreshData.session?.access_token) {
          headers.Authorization = `Bearer ${refreshData.session.access_token}`;
          continue; // Retry with new token
        }
        throw new ApiError(401, "Session expired. Please sign in again.");
      }

      if (!res.ok) {
        const error = await res.json().catch(() => ({ error: `${res.status} ${res.statusText}` }));
        const apiError = new ApiError(res.status, error.error || error.message || `Request failed (${res.status})`);

        // Retry on 5xx server errors (not on 4xx client errors)
        if (res.status >= 500 && attempt < maxAttempts) {
          await delay(attempt * 1000); // 1s, 2s backoff
          continue;
        }

        // Auto-report 5xx errors to support (after retries exhausted)
        if (res.status >= 500) {
          reportError({
            errorMessage: apiError.message,
            httpStatus: apiError.status,
            action: `${fetchOptions.method || "GET"} ${path}`,
            isAutomatic: true,
          });
        }
        throw apiError;
      }

      return res;
    } catch (err) {
      // Retry on network/timeout errors
      if (err instanceof ApiError) throw err;
      if (attempt < maxAttempts) {
        await delay(attempt * 1000);
        continue;
      }
      if ((err as Error).name === "AbortError") {
        reportError({
          errorMessage: "Request timed out",
          httpStatus: 0,
          action: `${fetchOptions.method || "GET"} ${path}`,
          isAutomatic: true,
        });
        throw new ApiError(0, withPhoneDevHint("Request timed out."));
      }
      reportError({
        errorMessage: "Network error",
        httpStatus: 0,
        action: `${fetchOptions.method || "GET"} ${path}`,
        isAutomatic: true,
      });
      throw new ApiError(0, withPhoneDevHint("Network error."));
    }
  }

  // Should not reach here, but satisfy TypeScript
  throw new ApiError(0, "Request failed after retries");
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withPhoneDevHint(baseMessage: string): string {
  if (__DEV__ && LOCALHOST_API_PATTERN.test(API_BASE)) {
    return `${baseMessage} API URL is ${API_BASE}. On a physical phone, localhost points to the phone itself. Run "npm run dev:phone" or set EXPO_PUBLIC_API_URL to your Mac LAN IP.`;
  }

  return `${baseMessage} Verify the API server is running and reachable from your phone.`;
}

// ============================================================================
// Auto Error Reporting
// ============================================================================

let lastAutoReportTime = 0;
let failedAutoReportCount = 0;
const AUTO_REPORT_COOLDOWN_MS = 60_000; // Max 1 auto-report per 60s

/**
 * Get count of failed auto-reports since app launch. Useful for debug screens.
 */
export function getFailedAutoReportCount(): number {
  return failedAutoReportCount;
}

interface ErrorReportContext {
  screen?: string;
  action?: string;
  errorMessage: string;
  httpStatus?: number;
  isAutomatic: boolean;
}

/**
 * Fire-and-forget error report to the backend support ticket endpoint.
 * Throttled: max 1 auto-report per 60 seconds to avoid flooding.
 * Uses fetchWithTimeout directly (NOT authFetch) to prevent circular loops.
 */
export function reportError(context: ErrorReportContext) {
  // Throttle automatic reports
  if (context.isAutomatic) {
    const now = Date.now();
    if (now - lastAutoReportTime < AUTO_REPORT_COOLDOWN_MS) return;
    lastAutoReportTime = now;
  }

  // Fire and forget
  void (async () => {
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session?.access_token) return;

      const url = `${API_BASE}/api/support/ticket`;
      await fetchWithTimeout(
        url,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${session.access_token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            title: context.httpStatus
              ? `App error: HTTP ${context.httpStatus}`
              : `App error: ${context.errorMessage.slice(0, 80)}`,
            description: context.errorMessage,
            severity:
              context.httpStatus && context.httpStatus >= 500 ? "high" : "medium",
            source: context.isAutomatic ? "auto" : "manual",
            screen: context.screen,
            errorCode: context.httpStatus,
            category: "bug",
            deviceInfo: {
              platform: Platform.OS,
              osVersion: String(Platform.Version),
              appVersion: "1.0.0",
            },
          }),
        },
        5000, // 5s timeout for the report itself
      );
    } catch (reportErr) {
      // Track failed reports for debug visibility but never throw
      failedAutoReportCount++;
      if (__DEV__) {
        console.debug("[reportError] Auto-report failed:", reportErr);
      }
    }
  })();
}

/**
 * Submit a support ticket from the manual Report Issue screen.
 * Unlike reportError, this awaits the response and throws on failure.
 */
export async function submitSupportTicket(ticket: {
  title: string;
  description: string;
  category: string;
  screen?: string;
  prefillError?: string;
}) {
  const trimmedDescription = ticket.description.trim();
  const trimmedPrefill = ticket.prefillError?.trim();
  const shouldAppendPrefill =
    Boolean(trimmedPrefill) && trimmedPrefill !== trimmedDescription;

  const res = await authFetch("/api/support/ticket", {
    method: "POST",
    json: {
      title: ticket.title,
      description: shouldAppendPrefill
        ? `${trimmedDescription}\n\nOriginal error: ${trimmedPrefill}`
        : trimmedDescription,
      category: ticket.category,
      source: "manual",
      screen: ticket.screen,
      severity: "medium",
      deviceInfo: {
        platform: Platform.OS,
        osVersion: String(Platform.Version),
        appVersion: "1.0.0",
      },
    },
    noRetry: true,
  });
  return res.json();
}

// ============================================================================
// Properties
// ============================================================================

export async function getProperties() {
  const res = await authFetch("/api/properties");
  return res.json();
}

export async function getProperty(id: string) {
  const res = await authFetch(`/api/properties/${id}`);
  return res.json();
}

export interface PropertyCondition {
  id: string;
  propertyId: string;
  roomId: string | null;
  description: string;
  category: string;
  severity: string | null;
  isActive: boolean;
}

export async function getPropertyConditions(
  propertyId: string,
  options?: { activeOnly?: boolean },
): Promise<PropertyCondition[]> {
  const params = new URLSearchParams();
  if (options?.activeOnly === false) {
    params.set("active", "false");
  }
  const query = params.toString();
  const res = await authFetch(
    `/api/properties/${propertyId}/conditions${query ? `?${query}` : ""}`,
  );
  return res.json();
}

export async function updateProperty(
  id: string,
  updates: Record<string, unknown>,
) {
  const res = await authFetch(`/api/properties/${id}`, {
    method: "PATCH",
    json: updates,
  });
  return res.json();
}

export async function deleteProperty(id: string) {
  const res = await authFetch(`/api/properties/${id}`, {
    method: "DELETE",
  });
  return res.json();
}

export async function createProperty(data: { name: string }) {
  const res = await authFetch("/api/properties", {
    method: "POST",
    json: data,
  });
  return res.json();
}

export async function bulkDeleteProperties(ids: string[]) {
  const res = await authFetch("/api/properties/bulk", {
    method: "DELETE",
    json: { ids },
  });
  return res.json();
}

// ============================================================================
// Inspections
// ============================================================================

export async function createInspection(propertyId: string, mode: string = "turnover") {
  const res = await authFetch("/api/inspections", {
    method: "POST",
    json: { propertyId, inspectionMode: mode },
  });
  return res.json();
}

export async function getInspections(options?: {
  propertyId?: string;
  limit?: number;
  offset?: number;
}) {
  const params = new URLSearchParams();
  if (options?.propertyId) params.set("propertyId", options.propertyId);
  if (typeof options?.limit === "number") params.set("limit", String(options.limit));
  if (typeof options?.offset === "number") params.set("offset", String(options.offset));
  const query = params.toString();
  const res = await authFetch(`/api/inspections${query ? `?${query}` : ""}`);
  return res.json();
}

export async function getInspection(id: string) {
  const res = await authFetch(`/api/inspections/${id}`);
  return res.json();
}

export async function getInspectionBaselines(inspectionId: string) {
  const res = await authFetch(`/api/inspections/${inspectionId}/baselines`);
  return res.json();
}

export async function submitBulkResults(
  inspectionId: string,
  results: unknown[],
  completionTier?: string,
  notes?: string,
) {
  const res = await authFetch(`/api/inspections/${inspectionId}/bulk`, {
    method: "POST",
    json: { results, completionTier, notes },
  });
  return res.json();
}

export async function deleteInspectionFinding(
  inspectionId: string,
  payload: {
    resultId: string;
    findingId?: string;
    findingIndex?: number;
  },
) {
  const res = await authFetch(`/api/inspections/${inspectionId}/findings`, {
    method: "DELETE",
    json: payload as unknown as Record<string, unknown>,
  });
  return res.json();
}

// ============================================================================
// Training
// ============================================================================

export async function trainProperty(propertyId: string, mediaUploadIds: string[]) {
  const res = await authFetch(`/api/properties/${propertyId}/train`, {
    method: "POST",
    json: { mediaUploadIds },
    timeoutMs: 180_000, // 3 min — training calls Claude Vision + creates rooms/items/baselines
    noRetry: true, // Don't retry training — server may already be processing
  });
  return res.json();
}

export async function getRooms(propertyId: string) {
  const res = await authFetch(`/api/properties/${propertyId}/rooms`);
  return res.json();
}

// ============================================================================
// Vision Comparison (SSE)
// ============================================================================

export interface CompareStreamOptions {
  baselineUrl: string;
  currentImages: string[];
  roomName: string;
  inspectionMode?: string;
  knownConditions?: string[];
  inspectionId?: string;
  roomId?: string;
  baselineImageId?: string;
}

/**
 * POST to the SSE compare-stream endpoint.
 * Returns the raw Response for SSE parsing by the comparison manager.
 */
export async function compareStream(options: CompareStreamOptions) {
  return authFetch("/api/vision/compare-stream", {
    method: "POST",
    json: options as unknown as Record<string, unknown>,
  });
}

// ============================================================================
// Upload
// ============================================================================

export async function uploadBase64Image(
  base64Image: string,
  propertyId: string,
  fileName?: string,
) {
  const res = await authFetch("/api/upload", {
    method: "POST",
    json: { base64Image, propertyId, fileName },
    timeoutMs: 120_000, // 2 min — base64 images can be 2-5MB each
  });
  return res.json();
}

/**
 * Upload an image file from a local URI (used for extracted video keyframes).
 */
export async function uploadImageFile(
  imageUri: string,
  propertyId: string,
  fileName?: string,
) {
  const resolvedName = fileName || `training-keyframe-${Date.now()}.jpg`;
  const maxAttempts = MAX_RETRIES + 1;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.access_token) {
      throw new ApiError(0, "Not authenticated");
    }

    try {
      const localFileRes = await fetchWithTimeout(imageUri, {}, 60_000);
      if (!localFileRes.ok) {
        throw new ApiError(0, "Unable to read keyframe image from device storage");
      }
      const rawBlob = await localFileRes.blob();
      // Ensure MIME type is set — local file:// fetches may produce empty type
      const fileBlob =
        rawBlob.type && rawBlob.type.startsWith("image/")
          ? rawBlob
          : new Blob([rawBlob], { type: "image/jpeg" });

      const formData = new FormData();
      formData.append("propertyId", propertyId);
      formData.append("file", fileBlob, resolvedName);

      const res = await fetchWithTimeout(
        `${API_BASE}/api/upload`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${session.access_token}`,
          },
          body: formData,
        },
        120_000,
      );

      if (!res.ok) {
        const error = await res.json().catch(() => ({
          error: `${res.status} ${res.statusText}`,
        }));
        const apiError = new ApiError(
          res.status,
          error.error || error.message || `Upload failed (${res.status})`,
        );

        if (res.status >= 500 && attempt < maxAttempts) {
          await delay(attempt * 1000);
          continue;
        }

        throw apiError;
      }

      return res.json();
    } catch (err) {
      if (err instanceof ApiError) throw err;
      if (attempt < maxAttempts) {
        await delay(attempt * 1000);
        continue;
      }
      const msg = (err as Error).name === "AbortError"
        ? "Keyframe upload timed out"
        : "Network error during keyframe upload";
      reportError({
        errorMessage: msg,
        httpStatus: 0,
        action: "POST /api/upload (keyframe)",
        isAutomatic: true,
      });
      throw new ApiError(0, `${msg}. Check your connection.`);
    }
  }

  throw new ApiError(0, "Keyframe upload failed after retries");
}

interface SignedVideoUploadSession {
  storagePath: string;
  signedUrl: string;
  token: string;
  publicUrl: string;
  fileName: string;
  fileType: string;
  propertyId: string;
}

async function createSignedVideoUploadSession(
  propertyId: string,
  fileName: string,
  fileType: string,
  fileSize: number,
): Promise<SignedVideoUploadSession> {
  const res = await authFetch("/api/upload/sign", {
    method: "POST",
    json: {
      propertyId,
      fileName,
      fileType,
      fileSize,
    },
    timeoutMs: 30_000,
    noRetry: true,
  });
  return res.json();
}

async function completeSignedVideoUpload(
  propertyId: string,
  storagePath: string,
  fileName: string,
  fileType: string,
  fileSize: number,
) {
  const res = await authFetch("/api/upload/complete", {
    method: "POST",
    json: {
      propertyId,
      storagePath,
      fileName,
      fileType,
      fileSize,
    },
    timeoutMs: 30_000,
    noRetry: true,
  });
  return res.json();
}

/**
 * Upload a video file using FormData (not base64 — videos are too large).
 * Accepts a local file URI from expo-camera recordAsync().
 */
export async function uploadVideoFile(
  videoUri: string,
  propertyId: string,
  fileName?: string,
) {
  const resolvedName = fileName || `training-video-${Date.now()}.mp4`;
  const maxAttempts = MAX_RETRIES + 1; // 3 attempts total

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.access_token) {
      throw new ApiError(0, "Not authenticated");
    }

    try {
      const localFileRes = await fetchWithTimeout(
        videoUri,
        {},
        120_000,
      );
      if (!localFileRes.ok) {
        throw new ApiError(0, "Unable to read captured video from device storage");
      }
      const fileBlob = await localFileRes.blob();
      const contentType = fileBlob.type || "video/mp4";

      const signed = await createSignedVideoUploadSession(
        propertyId,
        resolvedName,
        contentType,
        fileBlob.size,
      );

      const { error: signedUploadError } = await supabase.storage
        .from("property-media")
        .uploadToSignedUrl(
          signed.storagePath,
          signed.token,
          fileBlob as unknown as Blob,
          {
            contentType,
            upsert: false,
            cacheControl: "3600",
          },
        );

      if (signedUploadError) {
        const apiError = new ApiError(
          500,
          `Upload failed: ${signedUploadError.message || "signed upload failed"}`,
        );

        if (attempt < maxAttempts) {
          await delay(attempt * 1000);
          continue;
        }

        reportError({
          errorMessage: apiError.message,
          httpStatus: 500,
          action: "POST /api/upload/sign + uploadToSignedUrl (video)",
          isAutomatic: true,
        });
        throw apiError;
      }

      return completeSignedVideoUpload(
        propertyId,
        signed.storagePath,
        resolvedName,
        contentType,
        fileBlob.size,
      );
    } catch (err) {
      if (err instanceof ApiError) throw err;
      if (attempt < maxAttempts) {
        await delay(attempt * 1000);
        continue;
      }
      const msg = (err as Error).name === "AbortError" ? "Video upload timed out" : "Network error during video upload";
      reportError({ errorMessage: msg, httpStatus: 0, action: "POST /api/upload/sign + PUT signed upload (video)", isAutomatic: true });
      throw new ApiError(0, `${msg}. Check your connection.`);
    }
  }

  throw new ApiError(0, "Video upload failed after retries");
}

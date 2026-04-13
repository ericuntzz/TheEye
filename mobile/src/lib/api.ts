import { Platform } from "react-native";
import Constants from "expo-constants";
import * as FileSystem from "expo-file-system";
import { supabase } from "./supabase";

const CONFIGURED_API_BASE = normalizeApiBase(process.env.EXPO_PUBLIC_API_URL ?? "");
if (!CONFIGURED_API_BASE && !__DEV__) {
  throw new Error("Missing EXPO_PUBLIC_API_URL env var");
}
const LOCALHOST_API_PATTERN = /(^|:\/\/)(localhost|127\.0\.0\.1)(:|\/|$)/i;
const DEV_API_PORT_START = 3000;
const DEV_API_PORT_END = 3020;
const DEV_HEALTHCHECK_TIMEOUT_MS = 1500;
let resolvedApiBaseOverride: string | null = null;
let devApiBaseDiscoveryPromise: Promise<string | null> | null = null;

if (__DEV__ && CONFIGURED_API_BASE && LOCALHOST_API_PATTERN.test(CONFIGURED_API_BASE)) {
  console.warn(
    `[api] EXPO_PUBLIC_API_URL is ${CONFIGURED_API_BASE}. On physical devices, localhost points to the phone. Use your Mac LAN IP or run "npm run dev:phone".`,
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

function normalizeApiBase(value: string | null | undefined): string {
  return value?.trim().replace(/\/+$/, "") ?? "";
}

function parseUrlSafe(value: string | null | undefined): URL | null {
  if (!value) return null;
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function extractHostFromUri(value: string | null | undefined): string | null {
  if (!value) return null;
  const parsed = parseUrlSafe(value.includes("://") ? value : `http://${value}`);
  return parsed?.hostname ?? null;
}

function isPrivateIpv4Host(host: string): boolean {
  const ipv4Match = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!ipv4Match) return false;
  const [a, b] = ipv4Match.slice(1).map(Number);
  if ([a, b].some((part) => Number.isNaN(part))) return false;
  return (
    a === 10 ||
    a === 127 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254)
  );
}

function isLikelyLocalDevHost(host: string): boolean {
  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host.endsWith(".local") ||
    isPrivateIpv4Host(host)
  );
}

function getExpoDevHost(): string | null {
  return (
    extractHostFromUri(Constants.expoConfig?.hostUri) ||
    extractHostFromUri(Constants.expoGoConfig?.debuggerHost) ||
    extractHostFromUri(Constants.platform?.hostUri)
  );
}

function buildApiBase(protocol: string, host: string, port: number): string {
  return normalizeApiBase(`${protocol}//${host}:${port}`);
}

function getDerivedDevApiBase(): string | null {
  if (!__DEV__) return null;
  const host = getExpoDevHost();
  if (!host) return null;
  return buildApiBase("http:", host, DEV_API_PORT_START);
}

function getActiveApiBase(): string {
  const candidate =
    normalizeApiBase(resolvedApiBaseOverride) ||
    CONFIGURED_API_BASE ||
    getDerivedDevApiBase();

  if (candidate) return candidate;

  throw new Error(
    "Missing EXPO_PUBLIC_API_URL env var and could not derive a dev API URL from Expo.",
  );
}

function getApiBaseForDebug(): string {
  return normalizeApiBase(resolvedApiBaseOverride) || CONFIGURED_API_BASE || getDerivedDevApiBase() || "(unset)";
}

async function isHealthyAtriaApi(base: string): Promise<boolean> {
  try {
    const response = await fetchWithTimeout(
      `${base}/api/health`,
      { method: "GET" },
      DEV_HEALTHCHECK_TIMEOUT_MS,
    );
    if (!response.ok) return false;
    const body = await response.text();
    return body.includes('"status":"ok"') && body.includes('"service":"atria-web"');
  } catch {
    return false;
  }
}

async function discoverHealthyDevApiBase(
  failedBase: string,
): Promise<string | null> {
  if (!__DEV__) return null;

  const normalizedFailedBase = normalizeApiBase(failedBase);
  if (
    resolvedApiBaseOverride &&
    normalizeApiBase(resolvedApiBaseOverride) !== normalizedFailedBase
  ) {
    return resolvedApiBaseOverride;
  }

  if (devApiBaseDiscoveryPromise) {
    return devApiBaseDiscoveryPromise;
  }

  devApiBaseDiscoveryPromise = (async () => {
    const configuredUrl = parseUrlSafe(CONFIGURED_API_BASE);
    const candidateHosts = new Set<string>();
    const configuredHost = configuredUrl?.hostname;
    const expoHost = getExpoDevHost();

    if (configuredHost && isLikelyLocalDevHost(configuredHost)) {
      candidateHosts.add(configuredHost);
    }
    if (expoHost && isLikelyLocalDevHost(expoHost)) {
      candidateHosts.add(expoHost);
    }

    if (candidateHosts.size === 0) {
      return null;
    }

    const candidatePorts: number[] = [];
    const pushPort = (port: number) => {
      if (
        Number.isInteger(port) &&
        port >= 1 &&
        port <= 65535 &&
        !candidatePorts.includes(port)
      ) {
        candidatePorts.push(port);
      }
    };

    const configuredPort = configuredUrl?.port ? parseInt(configuredUrl.port, 10) : null;
    if (configuredPort) pushPort(configuredPort);
    for (let port = DEV_API_PORT_START; port <= DEV_API_PORT_END; port += 1) {
      pushPort(port);
    }

    for (const host of candidateHosts) {
      const candidateProtocol =
        host === configuredHost && configuredUrl?.protocol === "https:"
          ? "https:"
          : "http:";
      for (const port of candidatePorts) {
        const candidate = buildApiBase(candidateProtocol, host, port);
        if (candidate === normalizedFailedBase) continue;
        if (await isHealthyAtriaApi(candidate)) {
          resolvedApiBaseOverride = candidate;
          if (__DEV__) {
            console.warn(
              `[api] Recovered from unreachable API base ${normalizedFailedBase} -> ${candidate}`,
            );
          }
          return candidate;
        }
      }
    }

    return null;
  })().finally(() => {
    devApiBaseDiscoveryPromise = null;
  });

  return devApiBaseDiscoveryPromise;
}

async function signOutExpiredSession() {
  try {
    await supabase.auth.signOut({ scope: "local" });
  } catch {
    // Ignore sign-out cleanup failures; caller will still surface the auth error.
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
  const controller = new AbortController();
  const externalSignal = options.signal;
  let timeout: ReturnType<typeof setTimeout> | null = null;

  const abortFromExternalSignal = () => controller.abort();

  if (externalSignal?.aborted) {
    controller.abort();
  } else if (externalSignal) {
    externalSignal.addEventListener("abort", abortFromExternalSignal, {
      once: true,
    });
  }

  if (timeoutMs > 0) {
    timeout = setTimeout(() => controller.abort(), timeoutMs);
  }

  return fetch(url, { ...options, signal: controller.signal }).finally(() => {
    if (timeout) {
      clearTimeout(timeout);
    }
    externalSignal?.removeEventListener("abort", abortFromExternalSignal);
  });
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
    await signOutExpiredSession();
    throw new ApiError(401, "Session expired. Please sign in again.");
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

  const maxAttempts = noRetry ? 1 : MAX_RETRIES + 1;
  let requestBase = getActiveApiBase();
  let hasRetriedWithRecoveredBase = false;

  requestLoop: while (true) {
    const url = `${requestBase}${path}`;

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
          await signOutExpiredSession();
          throw new ApiError(401, "Session expired. Please sign in again.");
        }

        if (!res.ok) {
          const error = await res
            .json()
            .catch(() => ({ error: `${res.status} ${res.statusText}` }));
          const apiError = new ApiError(
            res.status,
            error.error || error.message || `Request failed (${res.status})`,
          );

          if (res.status === 401) {
            await signOutExpiredSession();
          }

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
        if ((err as Error).name === "AbortError" && fetchOptions.signal?.aborted) {
          throw err;
        }
        if (attempt < maxAttempts) {
          await delay(attempt * 1000);
          continue;
        }

        if (!hasRetriedWithRecoveredBase) {
          const recoveredBase = await discoverHealthyDevApiBase(requestBase);
          if (recoveredBase && recoveredBase !== requestBase) {
            requestBase = recoveredBase;
            hasRetriedWithRecoveredBase = true;
            continue requestLoop;
          }
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

    break;
  }

  // Should not reach here, but satisfy TypeScript
  throw new ApiError(0, "Request failed after retries");
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withPhoneDevHint(baseMessage: string): string {
  if (__DEV__) {
    const debugApiBase = getApiBaseForDebug();
    const localhostHint = LOCALHOST_API_PATTERN.test(debugApiBase)
      ? ' On a physical phone, localhost points to the phone itself. Run "npm run dev:phone" or set EXPO_PUBLIC_API_URL to your Mac LAN IP.'
      : "";
    return `${baseMessage} API URL is ${debugApiBase}. Health check: ${debugApiBase}/api/health.${localhostHint}`;
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

      const url = `${getActiveApiBase()}/api/support/ticket`;
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

// ── Finding Feedback (cross-inspection learning) ──────────────────────

export interface FindingFeedbackItem {
  id: string;
  findingFingerprint: string;
  findingDescription: string;
  findingCategory: string | null;
  action: "confirmed" | "dismissed";
  dismissReason: string | null;
  dismissCount: number;
  roomId: string | null;
  baselineImageId: string | null;
  createdAt: string;
}

/** Fetch all finding feedback for a property — seeds suppression at inspection start */
export async function getPropertyFeedback(
  propertyId: string,
): Promise<FindingFeedbackItem[]> {
  const res = await authFetch(`/api/properties/${propertyId}/feedback`);
  const data = await res.json();
  return data.feedback || [];
}

/** Record a finding confirm/dismiss for cross-inspection learning */
export async function postFindingFeedback(
  propertyId: string,
  feedback: {
    inspectionId?: string;
    roomId?: string;
    baselineImageId?: string;
    findingFingerprint: string;
    findingDescription: string;
    findingCategory?: string;
    findingSeverity?: string;
    action: "confirmed" | "dismissed";
    dismissReason?: string;
  },
): Promise<{ id: string; dismissCount: number }> {
  const res = await authFetch(`/api/properties/${propertyId}/feedback`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(feedback),
  });
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
  events?: unknown[],
  effectiveCoverage?: {
    overall: number;
    rooms: Array<{
      roomId: string;
      effectiveAnglesScanned: number;
      effectiveAnglesTotal: number;
      effectiveCoverage: number;
    }>;
  },
) {
  const res = await authFetch(`/api/inspections/${inspectionId}/bulk`, {
    method: "POST",
    json: { results, completionTier, notes, events, effectiveCoverage },
    timeoutMs: 60_000,
    noRetry: true,
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
    noRetry: true,
  });
  return res.json();
}

export async function updateInspectionFinding(
  inspectionId: string,
  payload: {
    resultId: string;
    findingId?: string;
    findingIndex?: number;
    description: string;
    severity?: string;
    category?: string;
    itemType?: string;
    restockQuantity?: number;
    supplyItemId?: string;
    imageUrl?: string | null;
    videoUrl?: string | null;
    evidenceItems?: Array<{
      id: string;
      kind: "photo" | "video";
      url: string;
      thumbnailUrl?: string;
      durationMs?: number;
      createdAt?: string;
    }>;
    source?: string;
    derivedFromFindingId?: string | null;
    derivedFromComparisonId?: string | null;
    origin?: string;
  },
) {
  const res = await authFetch(`/api/inspections/${inspectionId}/findings`, {
    method: "PATCH",
    json: payload as unknown as Record<string, unknown>,
  });
  return res.json();
}

/**
 * Get-or-create a room-level anchor inspectionResult for manual/action items.
 * Returns the anchor's resultId which should be used instead of random baseline results.
 */
export async function resolveRoomAnchor(
  inspectionId: string,
  roomId: string,
): Promise<{ anchorId: string; isNew: boolean; findingsCount: number }> {
  const res = await authFetch(`/api/inspections/${inspectionId}/room-anchor`, {
    method: "POST",
    json: { roomId } as Record<string, unknown>,
  });
  return res.json();
}

export async function addInspectionFinding(
  inspectionId: string,
  payload: {
    resultId: string;
    description: string;
    severity?: string;
    category?: string;
    itemType?: string;
    restockQuantity?: number;
    supplyItemId?: string;
    imageUrl?: string;
    videoUrl?: string;
    evidenceItems?: Array<{
      id: string;
      kind: "photo" | "video";
      url: string;
      thumbnailUrl?: string;
      durationMs?: number;
      createdAt?: string;
    }>;
    source?: string;
    derivedFromFindingId?: string;
    derivedFromComparisonId?: string;
    origin?: string;
  },
) {
  const res = await authFetch(`/api/inspections/${inspectionId}/findings`, {
    method: "POST",
    json: payload as unknown as Record<string, unknown>,
    noRetry: true,
  });
  return res.json();
}

// ============================================================================
// Training
// ============================================================================

export async function trainProperty(
  propertyId: string,
  mediaUploadIds: string[],
  options?: {
    signal?: AbortSignal;
    previewAnalysis?: { rooms: Array<{ name: string; keyItems: string[] }> };
  },
) {
  const json: Record<string, unknown> = { mediaUploadIds };
  if (options?.previewAnalysis) {
    json.previewAnalysis = options.previewAnalysis;
  }
  const res = await authFetch(`/api/properties/${propertyId}/train`, {
    method: "POST",
    json,
    timeoutMs: 180_000,
    noRetry: true,
    signal: options?.signal,
  });
  return res.json();
}

/**
 * Progressive training preview — sends a batch of uploaded images for quick
 * room/item identification during the capture phase. Non-blocking, fire-and-forget.
 */
export async function trainPreview(
  propertyId: string,
  mediaUploadIds: string[],
  previousRooms: string[] = [],
): Promise<{
  rooms: Array<{ name: string; imageCount: number; keyItems: string[] }>;
  itemCount: number;
  message: string;
}> {
  const res = await authFetch(`/api/properties/${propertyId}/train/preview`, {
    method: "POST",
    json: { mediaUploadIds, previousRooms },
    timeoutMs: 35_000, // 35s — lightweight analysis
    noRetry: true,
  });
  return res.json();
}

export async function getRooms(propertyId: string) {
  const res = await authFetch(`/api/properties/${propertyId}/rooms`);
  return res.json();
}

// ============================================================================
// Supply & Restock
// ============================================================================

export async function getPropertySupplies(propertyId: string, category?: string) {
  const params = category ? `?category=${encodeURIComponent(category)}` : "";
  const res = await authFetch(`/api/properties/${propertyId}/supplies${params}`);
  return res.json();
}

export async function createSupplyItem(propertyId: string, item: {
  name: string;
  category: string;
  amazonAsin?: string;
  amazonUrl?: string;
  defaultQuantity?: number;
  parLevel?: number;
  unit?: string;
  vendor?: string;
  notes?: string;
  roomId?: string;
}) {
  const res = await authFetch(`/api/properties/${propertyId}/supplies`, {
    method: "POST",
    json: item,
  });
  return res.json();
}

export async function updateSupplyItem(propertyId: string, supplyItemId: string, updates: Record<string, unknown>) {
  const res = await authFetch(`/api/properties/${propertyId}/supplies`, {
    method: "PATCH",
    json: { supplyItemId, ...updates },
  });
  return res.json();
}

export async function deleteSupplyItem(propertyId: string, supplyItemId: string) {
  const res = await authFetch(`/api/properties/${propertyId}/supplies`, {
    method: "DELETE",
    json: { supplyItemId },
  });
  return res.json();
}

export async function getRestockOrders(propertyId: string, status?: string) {
  const params = status ? `?status=${encodeURIComponent(status)}` : "";
  const res = await authFetch(`/api/properties/${propertyId}/restock${params}`);
  return res.json();
}

export async function createRestockOrder(propertyId: string, order: {
  inspectionId?: string;
  items: Array<{
    name: string;
    supplyItemId?: string;
    amazonAsin?: string;
    quantity?: number;
    roomName?: string;
    source?: string;
  }>;
  notes?: string;
}) {
  const res = await authFetch(`/api/properties/${propertyId}/restock`, {
    method: "POST",
    json: order,
  });
  return res.json();
}

export async function updateRestockOrder(propertyId: string, orderId: string, updates: {
  status?: string;
  itemUpdates?: Array<{ itemId: string; status?: string; quantity?: number }>;
  notes?: string;
}) {
  const res = await authFetch(`/api/properties/${propertyId}/restock/${orderId}`, {
    method: "PATCH",
    json: updates,
  });
  return res.json();
}

export async function dispatchRestockOrder(propertyId: string, orderId: string, dispatch: {
  vendorId: string;
  method: "email" | "sms";
  message?: string;
}) {
  const res = await authFetch(`/api/properties/${propertyId}/restock/${orderId}/dispatch`, {
    method: "POST",
    json: dispatch,
  });
  return res.json();
}

export async function getPropertyVendors(propertyId: string, category?: string) {
  const params = category ? `?category=${encodeURIComponent(category)}` : "";
  const res = await authFetch(`/api/properties/${propertyId}/vendors${params}`);
  return res.json();
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
  try {
    // Read the local thumbnail directly from Expo's file API to avoid
    // 0-byte uploads that can happen when piping file:// URIs through fetch().
    const file = new FileSystem.File(imageUri);
    if (!file.exists || file.size === 0) {
      throw new ApiError(0, "Unable to read keyframe image from device storage");
    }

    const base64 = await file.base64();
    const mimeFromFile = typeof file.type === "string" ? file.type : "";
    const lowerUri = imageUri.toLowerCase();
    const contentType =
      mimeFromFile && mimeFromFile.startsWith("image/")
        ? mimeFromFile
        : lowerUri.endsWith(".png")
          ? "image/png"
          : lowerUri.endsWith(".webp")
            ? "image/webp"
            : lowerUri.endsWith(".gif")
              ? "image/gif"
              : lowerUri.endsWith(".heic")
                ? "image/heic"
                : lowerUri.endsWith(".heif")
                  ? "image/heif"
                  : "image/jpeg";

    const extension =
      contentType === "image/png"
        ? "png"
        : contentType === "image/webp"
          ? "webp"
          : contentType === "image/gif"
            ? "gif"
            : contentType === "image/heic"
              ? "heic"
              : contentType === "image/heif"
                ? "heif"
                : "jpg";
    const resolvedName = fileName || `image-upload-${Date.now()}.${extension}`;

    if (!base64) {
      throw new ApiError(0, "Unable to read keyframe image from device storage");
    }

    return uploadBase64Image(
      `data:${contentType};base64,${base64}`,
      propertyId,
      resolvedName,
    );
  } catch (err) {
    const msg = err instanceof ApiError
      ? err.message
      : (err as Error).name === "AbortError"
        ? "Keyframe upload timed out"
        : "Unable to read and upload keyframe image";
    reportError({
      errorMessage: msg,
      httpStatus: 0,
      action: "POST /api/upload (keyframe)",
      isAutomatic: true,
    });
    throw err instanceof ApiError
      ? err
      : new ApiError(0, `${msg}. Check your connection.`);
  }
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
      const videoFile = new FileSystem.File(videoUri);
      if (!videoFile.exists || videoFile.size === 0) {
        throw new ApiError(0, "Unable to read captured video from device storage");
      }
      const contentType = videoFile.type || "video/mp4";

      const signed = await createSignedVideoUploadSession(
        propertyId,
        resolvedName,
        contentType,
        videoFile.size,
      );

      const { error: signedUploadError } = await supabase.storage
        .from("property-media")
        .uploadToSignedUrl(
          signed.storagePath,
          signed.token,
          videoFile as unknown as Blob,
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
        videoFile.size,
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

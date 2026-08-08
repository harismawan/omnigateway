import { type ErrorCode, GatewayError, type ProviderId } from "@omni/ir";
import type { HttpResponse } from "./types.ts";

/** Maps an upstream status to a canonical code, before body inspection. */
function codeForStatus(status: number): ErrorCode {
  if (status === 401 || status === 403) return "AUTH";
  if (status === 402) return "QUOTA_EXHAUSTED";
  if (status === 404) return "MODEL_UNAVAILABLE";
  if (status === 413 || status === 422 || status === 400) return "BAD_REQUEST";
  if (status === 429) return "RATE_LIMIT";
  if (status === 529) return "OVERLOADED";
  if (status >= 500) return "UPSTREAM";
  return "UPSTREAM";
}

/** `Retry-After` is seconds or an HTTP date; both appear in the wild. */
export function parseRetryAfter(header: string | null, now: number): number | undefined {
  if (header === null) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(header);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

/**
 * Builds a GatewayError from a failed upstream response.
 *
 * Reads the body so the message is useful, but never logs it — the caller
 * decides what to surface, and the message is truncated to keep prompt
 * echoes out of error text.
 */
export async function httpError(
  res: HttpResponse,
  provider: ProviderId,
  now = Date.now(),
): Promise<GatewayError> {
  const text = await res.text().catch(() => "");
  let message = text.slice(0, 500);
  let code = codeForStatus(res.status);

  try {
    const parsed = JSON.parse(text) as {
      error?: { type?: string; message?: string; code?: string };
      detail?: unknown;
    };
    if (typeof parsed.error?.message === "string") message = parsed.error.message.slice(0, 500);
    // Some upstreams answer with a bare `{"detail": "..."}` instead. Without
    // this the whole JSON blob was handed to the client as the message.
    else if (typeof parsed.detail === "string") message = parsed.detail.slice(0, 500);
    const type = parsed.error?.type ?? parsed.error?.code;
    if (type === "overloaded_error") code = "OVERLOADED";
    else if (type === "insufficient_quota") code = "QUOTA_EXHAUSTED";
    else if (type === "context_length_exceeded") code = "BAD_REQUEST";
    else if (type === "content_policy_violation") code = "CONTENT_FILTER";
  } catch {
    // Non-JSON error bodies (HTML gateway pages) keep the status-derived code.
  }

  const retryAfterMs = parseRetryAfter(res.headers.get("retry-after"), now);
  return new GatewayError(code, message || `${provider} returned ${res.status}`, {
    provider,
    status: res.status,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  });
}

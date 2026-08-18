import type { ApiErrorBody } from "./types.ts";

/**
 * A failed control-API call, carrying the gateway's own error code so callers
 * can branch on it (`AUTH` drives the session redirect) without string matching
 * on the message.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }

  /** True when the session is gone and the operator must sign in again. */
  get isUnauthenticated(): boolean {
    return this.status === 401 || this.code === "AUTH";
  }
}

function isErrorBody(value: unknown): value is ApiErrorBody {
  if (typeof value !== "object" || value === null) return false;
  const error: unknown = (value as { error?: unknown }).error;
  if (typeof error !== "object" || error === null) return false;
  return typeof (error as { message?: unknown }).message === "string";
}

type RequestOptions = {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  signal?: AbortSignal;
  /** Statuses to hand back as data instead of throwing, e.g. 202 while polling. */
  accept?: readonly number[];
};

export type ApiResult<T> = { status: number; data: T };

/**
 * One place where a control-API call is made.
 *
 * Session state travels in an HttpOnly cookie, so every call is same-origin and
 * `credentials: "same-origin"`; nothing here ever reads or writes a token.
 */
export async function request<T>(
  path: string,
  options: RequestOptions = {},
): Promise<ApiResult<T>> {
  const method = options.method ?? "GET";
  // A `Blob` body is sent as itself. The one caller that does this is the
  // database import, whose body is a whole SQLite file: serializing it would
  // mean holding a base64 copy of a database in memory to send a third more
  // bytes than it started with.
  const raw = options.body instanceof Blob ? options.body : null;
  const init: RequestInit = {
    method,
    credentials: "same-origin",
    headers:
      options.body === undefined
        ? {}
        : { "content-type": raw === null ? "application/json" : "application/octet-stream" },
    ...(options.body === undefined
      ? {}
      : { body: raw === null ? JSON.stringify(options.body) : raw }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };

  const response = await fetch(path, init);
  const accepted = options.accept ?? [];

  let payload: unknown = null;
  if (response.status !== 204) {
    const text = await response.text();
    if (text.length > 0) {
      try {
        payload = JSON.parse(text);
      } catch {
        // A non-JSON body from a proxy or a crash: reported by status alone.
        payload = null;
      }
    }
  }

  if (!response.ok && !accepted.includes(response.status)) {
    const code = isErrorBody(payload) ? (payload.error.code ?? "INTERNAL") : "INTERNAL";
    const message = isErrorBody(payload)
      ? payload.error.message
      : `request failed with status ${response.status}`;
    throw new ApiError(response.status, String(code), message);
  }

  // A 202 that reached here was explicitly accepted, and may still be an error
  // body; callers that opt in know the shape they asked for.
  return { status: response.status, data: payload as T };
}

export async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
  const result = await request<T>(path, signal === undefined ? {} : { signal });
  return result.data;
}

export async function post<T>(path: string, body?: unknown): Promise<T> {
  const result = await request<T>(path, {
    method: "POST",
    ...(body === undefined ? {} : { body }),
  });
  return result.data;
}

export async function put<T>(path: string, body: unknown): Promise<T> {
  const result = await request<T>(path, { method: "PUT", body });
  return result.data;
}

export async function patch<T>(path: string, body: unknown): Promise<T> {
  const result = await request<T>(path, { method: "PATCH", body });
  return result.data;
}

export async function del<T>(path: string): Promise<T> {
  const result = await request<T>(path, { method: "DELETE" });
  return result.data;
}

/** Builds `/api/usage?...` and friends without hand-rolling escaping. */
export function withQuery(
  path: string,
  params: Record<string, string | number | undefined>,
): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    search.set(key, String(value));
  }
  const query = search.toString();
  return query.length === 0 ? path : `${path}?${query}`;
}

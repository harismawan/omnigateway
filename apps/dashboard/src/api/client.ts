/**
 * The one place this app talks to the gateway.
 *
 * The HttpOnly `omni_admin` cookie authenticates same-origin control-surface
 * requests. Gateway API-key authorization must never be attached here.
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

  /** True when the session lapsed and the app should send the operator to /login. */
  get isUnauthenticated(): boolean {
    return this.status === 401;
  }
}

type ErrorBody = { error?: { code?: unknown; message?: unknown } };

async function toApiError(response: Response): Promise<ApiError> {
  let code = "INTERNAL";
  let message = `request failed with status ${response.status}`;
  try {
    const body = (await response.json()) as ErrorBody;
    if (typeof body.error?.code === "string") code = body.error.code;
    if (typeof body.error?.message === "string") message = body.error.message;
  } catch {
    // A proxy or crash can return HTML. The status is still useful to callers.
  }
  return new ApiError(response.status, code, message);
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: body === undefined ? {} : { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  if (!response.ok) throw await toApiError(response);
  if (response.status === 204) return null as T;

  const text = await response.text();
  if (text.length === 0) return null as T;
  return JSON.parse(text) as T;
}

export const api = {
  get: <T>(path: string): Promise<T> => request<T>("GET", path),
  post: <T>(path: string, body?: unknown): Promise<T> => request<T>("POST", path, body),
  put: <T>(path: string, body?: unknown): Promise<T> => request<T>("PUT", path, body),
  patch: <T>(path: string, body?: unknown): Promise<T> => request<T>("PATCH", path, body),
  del: <T>(path: string): Promise<T> => request<T>("DELETE", path),
};

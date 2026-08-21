/**
 * The one way a plugin's UI talks to its own backend.
 *
 * A plugin's server half is mounted at `/api/plugins/<id>/…`, so every call a
 * plugin UI makes is the console's own control API with a prefix on it. The
 * conventions therefore have to be the console's conventions, not a second set:
 * same-origin, session state in an HttpOnly cookie, JSON in and JSON out, and
 * nothing here ever reads or writes a token. This mirrors
 * `apps/dashboard/src/api/client.ts` deliberately rather than importing it — a
 * package may not import an app, and a plugin bundle must not pull the whole
 * console in behind one helper.
 */

/**
 * A failed plugin-API call, carrying the gateway's own error code.
 *
 * Same shape and same reason as the console's `ApiError`: callers branch on the
 * code rather than string-matching a message, and `AUTH` is what tells a plugin
 * its panel is looking at a dead session rather than a broken route.
 */
export class PluginApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "PluginApiError";
    this.status = status;
    this.code = code;
  }

  /** True when the session is gone and the operator must sign in again. */
  get isUnauthenticated(): boolean {
    return this.status === 401 || this.code === "AUTH";
  }
}

/**
 * A dot encoded so a literal `..` check will not see it.
 *
 * `encodeURIComponent(".")` is `"."`, so nothing legitimate produces `%2e`. A
 * path carrying one was either built from somebody else's encoding or built to
 * slip past exactly the check below, and the SDK cannot know whether the router
 * on the other end decodes before it matches. It refuses the shape rather than
 * betting on the receiver.
 */
const ENCODED_DOT = /%2e/i;

/**
 * Refuse a path that leaves the plugin's own prefix. Never normalise one.
 *
 * Normalising would be the friendlier behaviour and the wrong one. `../keys`
 * quietly rewritten to `keys` is a bug that ships: the author believes they
 * reached the console's key API, the call succeeds against something else, and
 * the mistake surfaces as wrong data rather than as an error. Refusing puts the
 * failure at the call site with the path in the message.
 *
 * Two rules, for two different reasons:
 *
 * - `..` is the actual escape. `/api/plugins/x/../../keys` resolves to
 *   `/api/keys` under `new URL()` and under any server that normalises before
 *   it routes.
 * - A leading `/` is not an escape today, because the result is concatenated
 *   and stays under the prefix. It is refused because the author who typed it
 *   meant an absolute path, and on the day this joins with `new URL(path,
 *   base)` instead of a template string — the obvious, harmless-looking
 *   refactor — an absolute path silently starts resolving from the origin root.
 *   The rule costs a plugin author one character and closes that door in
 *   advance.
 *
 * This is a guardrail, not a sandbox. A plugin runs in the console's own page
 * and can call `fetch` directly; nothing here can stop a hostile one. What it
 * stops is the ordinary accident of a path built out of user input, which is
 * the failure that actually happens.
 */
function assertWithinPrefix(label: string, value: string): void {
  if (value.length === 0) {
    throw new TypeError(`plugin api ${label} must not be empty`);
  }
  if (value.startsWith("/")) {
    throw new TypeError(
      `plugin api ${label} must be relative to the plugin's own prefix, got ${JSON.stringify(value)}`,
    );
  }
  if (value.includes("..") || ENCODED_DOT.test(value)) {
    throw new TypeError(
      `plugin api ${label} must not escape the plugin's own prefix, got ${JSON.stringify(value)}`,
    );
  }
}

/**
 * Build `/api/plugins/<pluginId>/<path>`, or throw.
 *
 * Exported because it is the guard, and a guard that can only be reached
 * through an async request is a guard that can only be tested through one. The
 * id is checked with the same rules as the path: it arrives from a manifest the
 * host parsed, but a helper that trusts one of its two inputs is a helper whose
 * safety depends on a file it cannot see.
 */
export function pluginApiPath(pluginId: string, path: string): string {
  assertWithinPrefix("plugin id", pluginId);
  if (pluginId.includes("/")) {
    throw new TypeError(`plugin api plugin id must be a single path segment, got ${pluginId}`);
  }
  assertWithinPrefix("path", path);
  return `/api/plugins/${pluginId}/${path}`;
}

/** The four verbs a plugin panel needs, bound to that plugin's prefix. */
export type PluginApi = {
  get<T>(path: string, signal?: AbortSignal): Promise<T>;
  post<T>(path: string, body?: unknown): Promise<T>;
  put<T>(path: string, body: unknown): Promise<T>;
  del<T>(path: string): Promise<T>;
};

type ErrorBody = { error: { code?: unknown; message: string } };

function isErrorBody(value: unknown): value is ErrorBody {
  if (typeof value !== "object" || value === null) return false;
  const error: unknown = (value as { error?: unknown }).error;
  if (typeof error !== "object" || error === null) return false;
  return typeof (error as { message?: unknown }).message === "string";
}

type RequestInitLike = {
  method: string;
  credentials: "same-origin";
  headers: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
};

async function request<T>(
  pluginId: string,
  method: string,
  path: string,
  body: unknown,
  signal: AbortSignal | undefined,
): Promise<T> {
  const url = pluginApiPath(pluginId, path);
  const init: RequestInitLike = {
    method,
    // Session state travels in an HttpOnly cookie the plugin cannot read, which
    // is the point: a plugin never holds a credential it could leak or log.
    credentials: "same-origin",
    headers: body === undefined ? {} : { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    ...(signal === undefined ? {} : { signal }),
  };

  const response = await fetch(url, init);

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

  if (!response.ok) {
    const code = isErrorBody(payload) ? (payload.error.code ?? "INTERNAL") : "INTERNAL";
    const message = isErrorBody(payload)
      ? payload.error.message
      : `request failed with status ${response.status}`;
    throw new PluginApiError(response.status, String(code), message);
  }

  return payload as T;
}

/**
 * Build a `PluginApi` outside React.
 *
 * Separate from the hook so the host can hand one to `mount` as a prop, and so
 * the prefix guard is testable without a renderer.
 */
export function createPluginApi(pluginId: string): PluginApi {
  assertWithinPrefix("plugin id", pluginId);
  return {
    get: <T>(path: string, signal?: AbortSignal) =>
      request<T>(pluginId, "GET", path, undefined, signal),
    post: <T>(path: string, body?: unknown) => request<T>(pluginId, "POST", path, body, undefined),
    put: <T>(path: string, body: unknown) => request<T>(pluginId, "PUT", path, body, undefined),
    del: <T>(path: string) => request<T>(pluginId, "DELETE", path, undefined, undefined),
  };
}

/**
 * One `PluginApi` per plugin id, for the lifetime of the page.
 *
 * A `PluginApi` is immutable and derived from nothing but its id, so a fresh
 * object per render would be a new identity for a value that never changes —
 * and a new identity is what turns `useEffect(…, [api])` into a loop and
 * defeats a `queryKey` built from it. `useMemo` would fix that per component;
 * a module-level cache fixes it across every component in the plugin, and it
 * costs one entry per installed plugin.
 *
 * It is also why *this* module imports no React, which is worth keeping even
 * now that `live.ts` does: a cache that needs no hook is reachable from
 * anywhere, including code that is not a component. The package-wide version of
 * this rule ended when the SDK joined the console's shared imports — see
 * `index.ts` — but "do not reach for a hook where a module-level value will do"
 * outlived it.
 */
const apiByPluginId = new Map<string, PluginApi>();

/**
 * The API helper for a plugin, stable across renders.
 *
 * Named as a hook because it is meant to be called from a component body and
 * returns render-stable state, and because the rules-of-hooks lint an author
 * already has should apply to it. It happens not to need a React hook to keep
 * that promise — see the cache above.
 *
 * A plugin's root also receives an `api` in its props. Both exist because
 * prop-drilling one helper through a panel's whole tree is the kind of chore an
 * author works around by building their own client, which is how the prefix
 * guard stops being used.
 */
export function usePluginApi(pluginId: string): PluginApi {
  const existing = apiByPluginId.get(pluginId);
  if (existing !== undefined) return existing;
  const created = createPluginApi(pluginId);
  apiByPluginId.set(pluginId, created);
  return created;
}

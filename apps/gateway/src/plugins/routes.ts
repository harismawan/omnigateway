import type { AdminAuth } from "@omni/control";
import { GatewayError, type Logger, noopLogger } from "@omni/ir";
import type { PluginRequest, PluginResponse, PluginRoute } from "@omnigateway/plugin-api";
import { Elysia } from "elysia";
import { apiErrorHandler, apiErrorResponse, requireAdmin } from "../routes/http.ts";

export type MountedPlugin = { id: string; routes: readonly PluginRoute[] };

export type PluginRouteDeps = {
  admin: AdminAuth;
  plugins: readonly MountedPlugin[];
  logger?: Logger;
};

/**
 * Where every plugin route lives, and the only prefix any of them may occupy.
 *
 * Written once and compared against after the path is assembled, so the
 * confinement is a checked property of the mounted string rather than a claim
 * about the validation above it.
 */
const MOUNT_PREFIX = "/api/plugins";

/**
 * The id shape `parseManifest` already enforced.
 *
 * Re-checked here because this is the point where an id becomes part of a URL
 * by string concatenation, and a mount that trusted the manifest would be one
 * unvalidated call site away from `/api/plugins/../keys`. The manifest is the
 * gate; this is the lock on the door behind it.
 */
const ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

/**
 * One path segment a plugin may declare: a literal, or a `:name` parameter.
 *
 * Deliberately narrow, and an allowlist rather than a list of things to strip.
 * `.` and `..` are excluded by the explicit check below rather than by the
 * character class, because a class that excludes dots would also exclude
 * `manifest.json`.
 *
 * Both encodings of a separator fall out of the class rather than needing their
 * own check: `%` cannot appear, so `%2e%2e` cannot arrive hoping to become `..`
 * after a decode nobody in this file performs, and `\` cannot appear either.
 * Widening this class is therefore a security change — it is the check those
 * two rely on.
 */
const SEGMENT_PATTERN = /^[A-Za-z0-9._~-]+$/;
const PARAM_PATTERN = /^:[A-Za-z][A-Za-z0-9_]*$/;

/**
 * A plugin-declared path, confined to that plugin's mount, or `null`.
 *
 * Refusal, never rewriting. A plugin that declared `/../keys` did not mean
 * `/keys`, and silently normalising it would mount *something* at a path its
 * author never wrote and never tested — the failure would surface later, as a
 * route that answers the wrong request. Returning `null` costs that one route
 * and says so in the log.
 */
export function mountPath(id: string, path: string): string | null {
  if (!ID_PATTERN.test(id)) return null;
  if (!path.startsWith("/")) return null;

  const base = `${MOUNT_PREFIX}/${id}`;
  // "/" is the plugin's index route; it has no segments to check.
  if (path !== "/") {
    for (const segment of path.slice(1).split("/")) {
      if (segment === "." || segment === "..") return null;
      // The allowlist below requires at least one character, which is also what
      // refuses `//` and a trailing slash: an empty segment has a canonical
      // spelling the author can write instead, so refusing costs them nothing.
      if (!SEGMENT_PATTERN.test(segment) && !PARAM_PATTERN.test(segment)) return null;
    }
  }

  const mounted = `${base}${path}`;
  // The second lock, and deliberately unreachable: no path that survived the
  // segment allowlist can fail this. It is kept because it costs one comparison
  // and it is the assertion a future widening of that allowlist would trip over
  // — the same reason the file server in `app.ts` compares its resolved path
  // even after resolving it. No test can reach it; a mutation of it survives.
  if (mounted !== base && !mounted.startsWith(`${base}/`)) return null;
  return mounted;
}

/**
 * A plugin's view of the request.
 *
 * Headers are not carried across — see `PluginRequest`. The body is read here
 * rather than through `readJson` because a plugin route may legitimately be a
 * `GET`, and `readJson` treats an absent body as malformed JSON; that is right
 * for the admin API, whose bodied routes always carry one, and wrong here.
 */
async function pluginRequest(
  request: Request,
  params: Record<string, string>,
): Promise<PluginRequest> {
  const url = new URL(request.url);
  const query = Object.fromEntries(url.searchParams);

  let body: unknown = null;
  if (request.method !== "GET") {
    const text = await request.text();
    if (text.trim().length > 0) {
      try {
        body = JSON.parse(text);
      } catch {
        throw new GatewayError("BAD_REQUEST", "invalid JSON body");
      }
    }
  }

  return { params, query, body };
}

/** Anything a plugin puts here reaches a response header, so the set is closed. */
const CACHE_CONTROL_PATTERN = /^[A-Za-z0-9 ,=."'_-]{1,200}$/;

/**
 * A `PluginResponse` rendered as an HTTP response.
 *
 * The header map is built here, from nothing, one field at a time. That is the
 * mechanism behind "a plugin cannot set arbitrary headers": there is no path
 * from plugin-supplied data to a header name at all, so `set-cookie`, a CORS
 * relaxation, or an override of a security header cannot originate from a
 * plugin — not because the type discourages it, but because nothing in this
 * function would carry it.
 *
 * `cacheControl` is the one influence, and even its *value* is checked: a CRLF
 * in it would be header injection, and a value the pattern rejects is dropped
 * rather than failing the response, because a bad caching hint is not worth a
 * 500 to the operator staring at the panel.
 */
export function toResponse(result: PluginResponse): Response {
  const status = result.status ?? 200;
  const headers: Record<string, string> = {};
  if (result.cacheControl !== undefined && CACHE_CONTROL_PATTERN.test(result.cacheControl)) {
    headers["cache-control"] = result.cacheControl;
  }

  // `bytes` wins when a plugin sets both, which the type says it will not: the
  // verbatim branch is the one where guessing wrong corrupts an asset.
  if (result.bytes !== undefined) {
    headers["content-type"] = result.contentType ?? "application/octet-stream";
    return new Response(result.bytes, { status, headers });
  }

  // Always `application/json`, never `contentType`: this branch serialised the
  // payload itself, so it knows what it produced better than the plugin does.
  headers["content-type"] = "application/json";
  return new Response(JSON.stringify(result.json ?? null), { status, headers });
}

function isPluginResponse(value: unknown): value is PluginResponse {
  return typeof value === "object" && value !== null;
}

/**
 * Every installed plugin's routes, mounted under `/api/plugins/<id>/`.
 *
 * Two properties this module exists to hold:
 *
 * **The host applies `requireAdmin`, not the plugin.** A plugin supplies a
 * handler and nothing else, so it cannot compose its own guard and cannot omit
 * one. That is what keeps "admin sessions are preserved on every `/api/*` route"
 * a property of the gateway rather than a convention each plugin author is
 * trusted to remember.
 *
 * **A plugin cannot shadow a core route.** Paths are confined at mount time, and
 * this module is composed after the core route modules, so even a hole in the
 * confinement would find `/api/keys` already claimed.
 *
 * A throwing handler costs its own request a 500 and nothing else. Its error is
 * logged with the plugin id and never rendered: the message is authored outside
 * this repository and could contain anything, including whatever the plugin was
 * holding when it threw.
 */
export function pluginRoutes(deps: PluginRouteDeps): Elysia {
  const logger = deps.logger ?? noopLogger;

  // Built by statement rather than by chain: each `.use`-style call returns a
  // differently parameterised `Elysia`, and the routes below are added in a
  // loop, so there is no single chained expression to hold anyway.
  const app = new Elysia();
  app.onError(apiErrorHandler);

  for (const plugin of deps.plugins) {
    for (const route of plugin.routes) {
      const path = mountPath(plugin.id, route.path);
      if (path === null) {
        // Refused, not fatal: one malformed route declaration must not stop a
        // gateway from starting, and the operator needs the surviving install
        // to reach the panel that tells them which plugin to remove.
        logger.error("plugin route refused", { plugin: plugin.id });
        continue;
      }

      const handle = async (context: {
        request: Request;
        params: Record<string, string>;
      }): Promise<Response> => {
        // Before anything the plugin authored runs, and outside the try below,
        // so an auth failure renders as 401 rather than as a plugin error.
        await requireAdmin(context.request, deps.admin);
        const input = await pluginRequest(context.request, context.params);

        try {
          const result = await route.handler(input);
          if (!isPluginResponse(result)) throw new Error("handler returned no response");
          return toResponse(result);
        } catch {
          logger.error("plugin route handler failed", { plugin: plugin.id });
          return apiErrorResponse(new GatewayError("INTERNAL", "plugin route failed"));
        }
      };

      switch (route.method) {
        case "GET":
          app.get(path, handle);
          break;
        case "POST":
          app.post(path, handle);
          break;
        case "PUT":
          app.put(path, handle);
          break;
        case "DELETE":
          app.delete(path, handle);
          break;
        default:
          // Reachable despite the union: a plugin is compiled elsewhere, so its
          // `method` is whatever its bundle actually emitted. Silently not
          // mounting it leaves the author with a route that 404s and no reason
          // anywhere, which is the same failure `mountPath` refuses to produce.
          logger.error("plugin route method not supported", { plugin: plugin.id });
          break;
      }
    }
  }

  return app;
}

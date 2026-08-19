import { realpathSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import type { AdminAuth } from "@omni/control";
import { type Logger, noopLogger } from "@omni/ir";
import { Elysia } from "elysia";
import { requireAdmin } from "../routes/http.ts";
import type { LoadedPlugin } from "./loader.ts";

/**
 * Where a plugin's UI bundle is served from.
 *
 * The design says `/plugins/<id>/…`, and this deviates to `/plugin-assets/`
 * deliberately. `/plugins/<id>` is also the natural client-side route for a
 * plugin's own page, and the console is a single-page app whose catch-all serves
 * `index.html` for anything it does not recognise. Sharing the prefix means
 * every request under it is ambiguous — asset or navigation — and resolving it
 * needs the asset handler to fall through to the SPA on a miss, which Elysia
 * does not express cleanly and which turns a mistyped filename into an HTML
 * document delivered to an `import`. One extra path segment removes the
 * ambiguity entirely.
 */
export const PLUGIN_ASSET_PREFIX = "/plugin-assets";

/** What the console needs to render a plugin's nav entry and mount its bundle. */
export type PluginCatalogEntry = {
  id: string;
  name: string;
  version: string;
  nav: { label: string; icon?: string | undefined } | null;
  ui: {
    /** Absolute URL the console imports, or null when there is no UI at all. */
    entry: string | null;
    compatible: boolean;
    reason?: string | undefined;
  } | null;
};

export function pluginCatalog(plugins: readonly LoadedPlugin[]): PluginCatalogEntry[] {
  return plugins.map((plugin) => ({
    id: plugin.id,
    name: plugin.manifest.name,
    version: plugin.manifest.version,
    nav: plugin.manifest.nav === undefined ? null : plugin.manifest.nav,
    ui:
      plugin.ui === undefined
        ? null
        : {
            // Only a compatible UI gets a URL. A console that received one for an
            // incompatible bundle could still import it by accident, and the
            // failure would arrive as a render crash rather than as the disabled
            // nav entry the operator is supposed to see.
            entry: plugin.ui.compatible
              ? `${PLUGIN_ASSET_PREFIX}/${plugin.id}/${plugin.ui.entry}`
              : null,
            compatible: plugin.ui.compatible,
            ...(plugin.ui.reason === undefined ? {} : { reason: plugin.ui.reason }),
          },
  }));
}

/**
 * Serves plugin catalogs and plugin UI bundles.
 *
 * The catalog is admin-gated: which plugins an installation runs is state about
 * that installation.
 *
 * The bundles are **not** gated, and that is deliberate rather than an
 * oversight. The console's own JavaScript is served without a session too — what
 * is gated is the data behind `/api`, not the code that asks for it. A plugin's
 * bundle is the same class of thing: static code an operator chose to install,
 * carrying no data. Gating it would also make module resolution depend on cookie
 * behaviour during an `import`, where a redirect to a login page arrives as a
 * syntax error rather than as a 401.
 */
export function pluginUiRoutes(deps: {
  admin: AdminAuth;
  plugins: readonly LoadedPlugin[];
  logger?: Logger;
}) {
  const logger = deps.logger ?? noopLogger;

  /**
   * Each plugin's UI root, resolved once at construction.
   *
   * Resolved through `realpath` here so a symlinked installation directory is
   * compared against what it actually is, and so the per-request check is a
   * prefix test against a real path rather than a second resolution.
   */
  const roots = new Map<string, string>();
  for (const plugin of deps.plugins) {
    if (plugin.ui === undefined || !plugin.ui.compatible) continue;
    try {
      roots.set(plugin.id, realpathSync(join(plugin.ui.dir, "ui")));
    } catch {
      // A plugin that declared a UI whose directory is missing. The catalog
      // still lists it; there is simply nothing to serve, and every request
      // below 404s rather than the gateway failing to build its routes.
      logger.warn("plugin ui directory is missing", { plugin: plugin.id });
    }
  }

  return new Elysia()
    .get("/api/plugins", async ({ request }) => {
      await requireAdmin(request, deps.admin);
      return { plugins: pluginCatalog(deps.plugins) };
    })
    .get(`${PLUGIN_ASSET_PREFIX}/:id/*`, ({ params, request, set }) => {
      const notFound = () => {
        set.status = 404;
        return { error: { code: "NOT_FOUND", message: "no such plugin asset" } };
      };

      const root = roots.get(params.id);
      if (root === undefined) return notFound();

      // The router's own wildcard rather than arithmetic on the prefix length:
      // recomputing where the path starts is one off-by-one away from serving
      // the wrong file, and the router already knows.
      //
      // It arrives percent-encoded, and decoding it here is what makes the two
      // checks below mean anything. Left encoded, `..%2fsecret` resolves as a
      // literal filename that happens to contain odd characters — safe by
      // accident, never matching a real file, and it would also mean a plugin
      // could not ship an asset whose name contains an encoded character.
      // Decoded, that same input is `../secret` and is refused by a check that
      // can be tested.
      let rest: string;
      try {
        rest = decodeURIComponent(params["*"] ?? "");
      } catch {
        // A malformed escape. Refused rather than passed on, because what the
        // filesystem would make of it is anybody's guess.
        return notFound();
      }

      let real: string;
      try {
        real = realpathSync(resolve(root, `./${rest}`));
      } catch {
        // Includes every escaping path that lands on nothing: there is no file
        // to serve either way, and a 404 is the same answer.
        return notFound();
      }

      /**
       * The single check, deliberately not two.
       *
       * A lexical `startsWith` before this one reads like defence in depth and
       * is not: `realpath` already resolves `..` and symlinks both, so any path
       * the lexical check would reject either resolves outside the root and is
       * caught here, or does not exist and threw above. Deleting a mutation from
       * that check changes no behaviour and fails no test — which is the signal
       * that it was decoration, and decoration in a security path is worse than
       * nothing because it invites the belief that something is being done.
       *
       * An empty remainder is covered here too: it resolves to the root itself,
       * and the root is not a prefix-plus-separator of itself.
       */
      if (!real.startsWith(`${root}${sep}`)) return notFound();

      const file = Bun.file(real);
      return new Response(file, {
        headers: {
          // Not immutable: plugin bundles are replaced in place by
          // `omni plugin install`, and a year-long cache would serve the old one
          // until an operator cleared their browser.
          "cache-control": "no-cache",
          "content-type": real.endsWith(".js")
            ? "text/javascript; charset=utf-8"
            : real.endsWith(".css")
              ? "text/css; charset=utf-8"
              : file.type,
        },
      });
    });
}

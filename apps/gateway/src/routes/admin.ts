import {
  ADMIN_COOKIE,
  type AdminAuth,
  type CatalogProblem,
  type ConsoleDeps,
  type ConsoleLine,
  type ConsoleQuery,
  type ConsoleRead,
  type ConsoleSource,
  consoleLimit,
  createApiKeyCredential,
  createKey,
  credentialHealth,
  dryRun,
  getSettings,
  listCredentials,
  listKeys,
  listModels,
  patchCredential,
  providerCatalog,
  putModel,
  putSettings,
  queryUsage,
  quotaHistory,
  readConsole,
  readRequestBody,
  recentLogs,
  removeCredential,
  removeModel,
  revokeKey,
  setKeyLimits,
  setKeyModels,
  setupFiles,
} from "@omni/control";
import { describeError, GatewayError, type Logger, noopLogger, parseLogLevel } from "@omni/ir";
import type { Store } from "@omni/store";
import { Elysia } from "elysia";
import type { Invalidator } from "../stream/broadcaster.ts";
import type { ConsoleFleet } from "../stream/consoleFleet.ts";
import {
  apiErrorHandler,
  readCookie,
  readJson,
  readJsonRecord,
  requireAdmin,
  requireReader,
  sessionCookie,
} from "./http.ts";

export type AdminDeps = {
  store: Store;
  admin: AdminAuth;
  now: () => number;
  sessionTtlMs: number;
  /** Public origin, which is what a generated client configuration points at. */
  baseUrl: string;
  /**
   * Whether `OMNI_BODY_LOGGING_ALLOWED` was set at boot.
   *
   * Reported on `/api/settings` beside the settings themselves, because the
   * runtime toggle is meaningless without it: a console that only knew the
   * setting would render a switch that silently does nothing, which is a bug
   * report rather than a feature. It is startup configuration and is not
   * settable here — that is the whole point of the second key.
   */
  bodyLoggingAllowed?: boolean;
  logger?: Logger;
  /**
   * Where this process's stdout was captured, and how to read it.
   *
   * Resolved once at boot rather than per request: the answer is a function of
   * configuration and of which supervisor started the process, neither of which
   * changes while it runs. Absent means the console route reports that nothing
   * captured stdout — the ordinary state under `bun run dev`.
   */
  console?: { source: ConsoleSource; deps: ConsoleDeps };
  /**
   * Reads another process's console. Absent in tests that have one process;
   * the route then answers for this one alone.
   */
  consoleFleet?: ConsoleFleet;
  /** This process's name, so `/api/nodes` can say which entry is the one answering. */
  nodeId: string;
  /**
   * Tells every open console that one of these routes changed a resource.
   *
   * Optional so a test can mount this surface without a socket layer behind it,
   * which is what almost all of them want. Absent, the routes behave exactly as
   * they did before push existed and the console falls back to its poll.
   */
  broadcaster?: Invalidator;
};

/**
 * The HTTP half of the control surface.
 *
 * Every handler does the same three things: prove there is an admin session,
 * call one operation in `@omni/control`, and shape the result as JSON. The
 * operations themselves — validation, store writes, ranking — live in the
 * package, so the CLI reaches them without going through a socket.
 */
export function adminRoutes(deps: AdminDeps) {
  const logger = deps.logger ?? noopLogger;
  /**
   * A provider whose catalog entry had to be repaired, said once.
   *
   * The catalog is assembled from a registry fixed at boot, so a problem in it
   * is a property of the installation rather than of the request: reporting per
   * call would put the same line on stdout every time a console loads, and the
   * batching rule the channel registry already follows applies for the same
   * reason. One line per distinct problem per process.
   *
   * `reason` is the only field a description can travel in — `LogFields` is a
   * closed allowlist and `provider` is typed to the compiled-in ids, which a
   * plugin-supplied one is not. Both halves are bounded before they get here.
   */
  const reportedCatalogProblems = new Set<string>();
  const reportCatalogProblem = (problem: CatalogProblem): void => {
    const key = `${problem.field} ${problem.provider}`;
    if (reportedCatalogProblems.has(key)) return;
    reportedCatalogProblems.add(key);
    logger.warn("provider catalog repaired", {
      reason: `${problem.provider} ${problem.field}: ${problem.reason}`,
    });
  };
  /**
   * What a mutation announces, called after the write and never before it.
   *
   * Four of this file's fourteen mutating routes deliberately call nothing, and
   * that is a decision rather than four oversights. `/api/setup` runs before an
   * admin session can exist, so there is no subscribed socket to tell and no
   * resource with a topic that it changes. Login and logout change a cookie,
   * not a row, and nothing a console renders moves when either happens.
   * `/api/models/:id/dry-run` is a POST that writes nothing at all — it probes
   * a target and reports what came back.
   */
  const changed = (topic: string): void => deps.broadcaster?.invalidate(topic);
  return (
    new Elysia()
      .onError(apiErrorHandler)
      .get("/api/status", async ({ request }) => {
        const token = readCookie(request, ADMIN_COOKIE);
        const principal = token === null ? null : await deps.admin.verify(token);
        return {
          configured: await deps.admin.isConfigured(),
          authenticated: principal !== null,
          // Which surface this session belongs to, so the dashboard's gate can
          // land it on the right branch rather than rendering a console the
          // session cannot populate. Null when unauthenticated.
          principal,
          // Whether a read-only password exists at all, so the login form knows
          // whether to offer that mode. Unauthenticated on purpose: it is the
          // login screen that needs it, and it reveals only that a feature is
          // switched on.
          viewerConfigured: await deps.admin.isViewerConfigured(),
        };
      })

      .post("/api/setup", async ({ request, set }) => {
        if (await deps.admin.isConfigured()) {
          set.status = 409;
          return {
            error: { code: "CONFLICT", message: "an admin password is already configured" },
          };
        }

        const body = await readJsonRecord(request);
        if (typeof body?.password !== "string") {
          throw new GatewayError("BAD_REQUEST", "password is required");
        }

        let created: boolean;
        try {
          created = await deps.admin.setInitialPassword(body.password);
        } catch (error) {
          throw new GatewayError("BAD_REQUEST", describeError(error, "invalid password"));
        }
        if (!created) {
          set.status = 409;
          return {
            error: { code: "CONFLICT", message: "an admin password is already configured" },
          };
        }

        const token = await deps.admin.login(body.password);
        if (token === null) throw new GatewayError("INTERNAL", "could not create admin session");
        logger.info("admin setup completed");
        set.headers["set-cookie"] = sessionCookie(
          request,
          token,
          Math.floor(deps.sessionTtlMs / 1_000),
        );
        return { ok: true };
      })

      .post("/api/login", async ({ request, set }) => {
        const body = await readJsonRecord(request);
        // An explicit field, defaulting to admin. Never "try the admin password
        // and fall back to the viewer one": a fallback would mint a viewer
        // session for a mistyped admin password on the day the two collide, and
        // it doubles the Argon2 cost of every failed login.
        const viewer = body?.mode === "viewer";
        const password = typeof body?.password === "string" ? body.password : null;
        const token =
          password === null
            ? null
            : viewer
              ? await deps.admin.loginViewer(password)
              : await deps.admin.login(password);
        if (token === null) {
          logger.info("admin login failed", { reason: "invalid credentials" });
          throw new GatewayError("AUTH", "invalid password");
        }
        logger.info("admin login succeeded");

        set.headers["set-cookie"] = sessionCookie(
          request,
          token,
          Math.floor(deps.sessionTtlMs / 1_000),
        );
        return { ok: true };
      })

      .post("/api/logout", async ({ request, set }) => {
        const token = readCookie(request, ADMIN_COOKIE);
        if (token !== null) await deps.admin.logout(token);
        set.headers["set-cookie"] = sessionCookie(request, "", 0);
        return { ok: true };
      })

      .get("/api/credentials", async ({ request }) => {
        await requireReader(request, deps.admin);
        return { credentials: await listCredentials(deps.store) };
      })

      .post("/api/credentials", async ({ request }) => {
        await requireAdmin(request, deps.admin);
        const body = await readJsonRecord(request);
        if (body === null) throw new GatewayError("BAD_REQUEST", "credential body is required");
        const credential = await createApiKeyCredential(
          deps.store,
          { provider: body.provider, apiKey: body.apiKey, ...body },
          logger,
        );
        changed("res:credentials");
        return { credential };
      })

      .get("/api/credentials/health", async ({ request }) => {
        await requireReader(request, deps.admin);
        return credentialHealth(deps);
      })

      /**
       * Retained quota readings, for the one surface that charts them, plus the
       * gateway rate that corroborates them.
       *
       * The burn estimate itself rides `/api/credentials/health`, which every
       * board already loads, and is not repeated here. The gateway rate is the
       * other way round: it is a request-log aggregate, and this route is
       * fetched only while a row is expanded, so it is priced correctly here
       * and would be head-of-line blocking on a ten-second poll. Clamping the
       * span to the retention window is `@omni/control`'s rule, not this
       * handler's.
       */
      .get("/api/credentials/quota/history", async ({ request, query }) => {
        await requireReader(request, deps.admin);
        return quotaHistory(deps, {
          since: query.since,
          until: query.until,
          credentialId: query.credentialId,
        });
      })

      .patch("/api/credentials/:id", async ({ request, params }) => {
        await requireAdmin(request, deps.admin);
        await patchCredential(deps, params.id, await readJson(request));
        changed("res:credentials");
        return { ok: true };
      })

      .delete("/api/credentials/:id", async ({ request, params }) => {
        await requireAdmin(request, deps.admin);
        await removeCredential(deps.store, params.id);
        changed("res:credentials");
        return { ok: true };
      })

      .get("/api/models", async ({ request }) => {
        await requireReader(request, deps.admin);
        return { models: await listModels(deps.store) };
      })
      // What this installation *can* serve, as opposed to `/api/models`, which is
      // what the operator configured. The console reads it for the model picker,
      // catalog pricing hints, connect dialog and provider palette — everything
      // it used to import from `@omni/providers` at build time, which a provider
      // loaded from disk at boot could never have been part of.
      // `requireReader`, not `requireAdmin`. The console shell awaits this for
      // every screen and admits the read-only administrator, so an admin-only
      // catalog turned a viewer's whole console into "Console unavailable" —
      // the all-or-nothing gate doing exactly what it says. Provider reference
      // data is also strictly less sensitive than `GET /api/models`, which a
      // viewer already reads: labels, colours, curated model ids and list
      // prices, none of it installation state.
      .get("/api/catalog", async ({ request }) => {
        await requireReader(request, deps.admin);
        return { providers: providerCatalog(reportCatalogProblem) };
      })

      .put("/api/models/:id", async ({ request, params }) => {
        await requireAdmin(request, deps.admin);
        await putModel(deps.store, params.id, await readJson(request));
        changed("res:models");
        return { ok: true };
      })

      .delete("/api/models/:id", async ({ request, params }) => {
        await requireAdmin(request, deps.admin);
        await removeModel(deps.store, params.id);
        changed("res:models");
        return { ok: true };
      })

      /**
       * The configuration an agent needs to talk to this gateway.
       *
       * Served rather than rendered in the browser so Claude model mappings and
       * opencode limits use the same pool descriptions as the CLI. A browser
       * deriving either separately would eventually disagree with the gateway.
       *
       * The key is always a placeholder. The store keeps only hashes, so there is
       * no real key to render, and a snippet that carried one would leak it into
       * every screenshot of this screen.
       */
      .get("/api/agent-setup", async ({ request, query }) => {
        await requireReader(request, deps.admin);
        const client = query.client === "opencode" ? "opencode" : "claude";
        const defaultModel = query.defaultModel;
        if (!defaultModel) {
          throw new GatewayError("BAD_REQUEST", `defaultModel is required for ${client} setup`);
        }
        try {
          return {
            client,
            files: await setupFiles(
              deps.store,
              client,
              { baseUrl: deps.baseUrl },
              {
                defaultModel,
                ...(query.fableModel ? { fableModel: query.fableModel } : {}),
                ...(query.opusModel ? { opusModel: query.opusModel } : {}),
                ...(query.sonnetModel ? { sonnetModel: query.sonnetModel } : {}),
                ...(query.haikuModel ? { haikuModel: query.haikuModel } : {}),
              },
            ),
          };
        } catch (error) {
          throw new GatewayError(
            "BAD_REQUEST",
            describeError(error, "invalid Claude model mapping"),
          );
        }
      })

      .get("/api/keys", async ({ request }) => {
        await requireReader(request, deps.admin);
        return { keys: await listKeys(deps.store) };
      })

      .post("/api/keys", async ({ request }) => {
        await requireAdmin(request, deps.admin);
        // The only response that ever contains a key. It exists in plaintext
        // nowhere else, so an operator who loses it must issue a new one.
        const created = await createKey(deps.store, await readJson(request));
        changed("res:keys");
        return created;
      })

      /**
       * One of the two fields on a key that are editable after minting — this
       * one and the allowlist below.
       *
       * `bodyLoggingOptOut` has no route like this on purpose: it is a promise
       * to whoever holds the key. A limit is the operator's own ceiling on
       * their own installation, and a weekly spend cap that cannot be adjusted
       * without minting a new key and redeploying every client is a cap that
       * gets set to unlimited instead.
       */
      .put("/api/keys/:id/limits", async ({ request, params }) => {
        await requireAdmin(request, deps.admin);
        const key = await setKeyLimits(deps.store, params.id, await readJson(request));
        changed("res:keys");
        return key;
      })

      /**
       * The other field on a key that is editable after minting.
       *
       * An allowlist that cannot be adjusted without minting a new key and
       * redeploying every client is an allowlist that gets set to unrestricted
       * instead. The list arrives whole: `null` (every model) and `[]` (none)
       * are distinct facts, and both survive the write.
       */
      .put("/api/keys/:id/models", async ({ request, params }) => {
        await requireAdmin(request, deps.admin);
        const key = await setKeyModels(deps.store, params.id, await readJson(request));
        changed("res:keys");
        return key;
      })

      .delete("/api/keys/:id", async ({ request, params }) => {
        await requireAdmin(request, deps.admin);
        await revokeKey(deps.store, params.id);
        changed("res:keys");
        return { ok: true };
      })

      /**
       * The runtime settings, and the one piece of boot configuration that
       * decides whether one of them can do anything.
       *
       * `bodyLoggingAllowed` rides here rather than on `/api/status` because
       * that route answers before there is a session, and rather than on a new
       * endpoint because this is the screen that renders the toggle it governs.
       * It is a sibling of `settings`, not a field inside it: `Settings` is the
       * shape `PUT` accepts and the store persists, and an environment fact
       * folded into it would look editable.
       */
      .get("/api/settings", async ({ request }) => {
        await requireReader(request, deps.admin);
        return {
          settings: await getSettings(deps.store),
          bodyLoggingAllowed: deps.bodyLoggingAllowed === true,
          // Whether, not what. The hash never leaves the store and there is no
          // route that reads it back.
          viewerConfigured: await deps.admin.isViewerConfigured(),
        };
      })

      /**
       * Replaces the admin password, having been shown the current one.
       *
       * The session cookie is not enough on its own: it may be an unattended
       * browser, and a cookie that could rewrite the credential behind it would
       * turn "left the tab open" into "locked out of the gateway". The check
       * itself is `@omni/control`'s, which is where every other decision about
       * what a correct password is already lives.
       *
       * A success ends every session, this caller's included — so the response
       * is a 200 whose cookie is already dead, and the console sends the
       * operator to the login screen rather than pretending otherwise.
       */
      .put("/api/settings/password", async ({ request }) => {
        await requireAdmin(request, deps.admin);
        const body = await readJsonRecord(request);
        const current = body?.current;
        const password = body?.password;
        if (typeof current !== "string" || typeof password !== "string") {
          throw new GatewayError("BAD_REQUEST", "current and password are required");
        }
        let changed: boolean;
        try {
          changed = await deps.admin.changePassword(current, password);
        } catch (error) {
          throw new GatewayError("BAD_REQUEST", describeError(error, "invalid password"));
        }
        if (!changed) {
          // Deliberately the same shape a failed login gets. Whether the
          // current password was right is the one bit this route must not leak
          // to anyone who reached it with a stolen cookie.
          logger.info("admin password change refused", { reason: "invalid credentials" });
          throw new GatewayError("AUTH", "current password is incorrect");
        }
        logger.info("admin password changed");
        return { ok: true };
      })

      /**
       * Sets or clears the read-only administrator's password.
       *
       * A mutation, so `requireAdmin` — a viewer must not be able to change the
       * credential that admitted them, which would let one read-only holder lock
       * out another and keep the access for themselves.
       *
       * `null` clears it and is how the access is withdrawn. An absent field is
       * not `null`: it is a malformed request, because "leave it alone" and
       * "remove it" must not share a spelling on a route whose whole job is to
       * grant or revoke access.
       */
      .put("/api/settings/viewer-password", async ({ request }) => {
        await requireAdmin(request, deps.admin);
        const body = await readJsonRecord(request);
        if (body === null || !("password" in body)) {
          throw new GatewayError("BAD_REQUEST", "password is required, and may be null");
        }
        const password = body.password;
        if (password !== null && typeof password !== "string") {
          throw new GatewayError("BAD_REQUEST", "password must be a string or null");
        }
        try {
          await deps.admin.setViewerPassword(password);
        } catch (error) {
          throw new GatewayError("BAD_REQUEST", describeError(error, "invalid password"));
        }
        logger.info(password === null ? "viewer access removed" : "viewer password set");
        changed("res:settings");
        return { ok: true };
      })

      .put("/api/settings", async ({ request }) => {
        await requireAdmin(request, deps.admin);
        await putSettings(deps.store, await readJson(request));
        changed("res:settings");
        return { ok: true };
      })

      .post("/api/models/:id/dry-run", async ({ request, params }) => {
        await requireAdmin(request, deps.admin);
        return dryRun(deps, params.id, await readJson(request));
      })

      .get("/api/usage", async ({ request, query }) => {
        await requireReader(request, deps.admin);
        return {
          rows: await queryUsage(deps, {
            grain: query.grain,
            groupBy: query.groupBy,
            splitBy: query.splitBy,
            since: query.since,
            until: query.until,
          }),
        };
      })

      .get("/api/logs", async ({ request, query }) => {
        await requireReader(request, deps.admin);
        return { logs: await recentLogs(deps.store, query.limit) };
      })

      /**
       * One request's captured bodies, decrypted.
       *
       * The most sensitive thing this gateway serves, so it sits behind the same
       * session check as everything else here and behind nothing weaker. There
       * is no unauthenticated form of this route and no token-scoped one.
       *
       * `@omni/control` decides what an absent or unreadable artifact means, and
       * every one of those is a state rather than a failure: an artifact swept
       * out from under its row, one that no longer decrypts, or a request that
       * was never captured at all. This handler adds no error mapping of its
       * own, so there is nothing here to leak a path, a digest, or a stack.
       */
      /**
       * The operator alone, not a reader.
       *
       * Every other GET on this surface widened to `requireReader`; this one did
       * not, and the asymmetry is the point. A read-only administrator exists so
       * somebody can diagnose an installation without being able to change it —
       * that is a claim about *write* access, and it is not a reason to hand
       * them every prompt and completion the gateway has stored. Body capture is
       * also the one thing a key holder can be promised is never retained
       * (`bodyLoggingOptOut`), and a promise that widens with the reader count
       * is not one.
       */
      .get("/api/requests/:id/body", async ({ request, params }) => {
        await requireAdmin(request, deps.admin);
        return readRequestBody(deps.store, params.id);
      })

      /**
       * The gateway's own output, as opposed to `/api/logs`, which is what
       * clients asked for.
       *
       * The `journalctl` argv is fixed and nothing from the query reaches it:
       * `lines` is clamped to an integer and `level` is parsed to one of four
       * words or dropped. The call goes through the injected runner, so a test
       * never spawns anything.
       */
      .get("/api/console", async ({ request, query }) => {
        await requireReader(request, deps.admin);
        const level = parseLogLevel(query.level);
        const since = Number(query.since);
        const consoleQuery: ConsoleQuery = {
          lines: consoleLimit(query.lines),
          ...(level === null ? {} : { level }),
          ...(Number.isFinite(since) && since > 0 ? { since } : {}),
        };
        const local = async (): Promise<ConsoleRead> =>
          deps.console === undefined
            ? { source: "none", lines: [] }
            : readConsole(deps.console.deps, deps.console.source, consoleQuery);

        // `node` names a process; absent means this one, which is what a
        // single-process install has always been shown. `all` merges every
        // live process by timestamp, the view a fleet's operator wants first.
        const node = typeof query.node === "string" ? query.node : "";
        if (node === "" || node === deps.nodeId || deps.consoleFleet === undefined) return local();
        if (node !== "all") return deps.consoleFleet.read(node, consoleQuery);

        const fleet = deps.consoleFleet;
        const live = await deps.store.maintenance.nodes(deps.now());
        const reads = await Promise.allSettled(
          live.map((entry) =>
            fleet.read(entry.id, consoleQuery).then((read) => ({ nodeId: entry.id, read })),
          ),
        );
        const lines: Array<ConsoleLine & { nodeId: string }> = [];
        // Whether any process that answered is capturing its output at all.
        // A fleet where none is — the usual container deployment, stdout going
        // to the runtime with no `OMNI_LOG_FILE` — must answer `none` like a
        // single process would. Reporting `fleet` with no lines instead tells
        // the console the log is merely empty, so it says the gateway will
        // write here on the next boot or token refresh, and it never will.
        let captured = false;
        for (const outcome of reads) {
          if (outcome.status !== "fulfilled") continue;
          if (outcome.value.read.source !== "none") captured = true;
          for (const line of outcome.value.read.lines) {
            lines.push({ ...line, nodeId: outcome.value.nodeId });
          }
        }
        // Only when something answered: every process unreachable is a fleet
        // that could not be read, which is not the same claim as one that
        // captures nothing, and `TIMEOUT` is already how that is reported.
        if (!captured && reads.some((outcome) => outcome.status === "fulfilled")) {
          return { source: "none", lines: [] };
        }
        // Undated lines keep their place at the end: a merge that sorted them
        // first would put a process's banner above every other process's log.
        lines.sort(
          (a, b) => (a.at ?? Number.POSITIVE_INFINITY) - (b.at ?? Number.POSITIVE_INFINITY),
        );
        return { source: "fleet", lines: lines.slice(-consoleQuery.lines) };
      })
      /**
       * The processes serving this installation, most recently heard from
       * first. One entry on a single-process install, and that entry is
       * `self`.
       */
      .get("/api/nodes", async ({ request }) => {
        await requireReader(request, deps.admin);
        const nodes = await deps.store.maintenance.nodes(deps.now());
        return { nodes: nodes.map((node) => ({ ...node, self: node.id === deps.nodeId })) };
      })
  );
}

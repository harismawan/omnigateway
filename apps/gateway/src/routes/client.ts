import {
  ADMIN_COOKIE,
  type AdminAuth,
  accountQuota,
  accountQuotaHistory,
  logLimit,
  queryUsage,
  readOwnKey,
  recentLogs,
  scopeOf,
  toClientLog,
} from "@omni/control";
import { GatewayError, type Logger, noopLogger } from "@omni/ir";
import type { Store } from "@omni/store";
import { Elysia } from "elysia";
import {
  apiErrorHandler,
  readCookie,
  readJsonRecord,
  requireClient,
  sessionCookie,
} from "./http.ts";

export type ClientDeps = {
  store: Store;
  admin: AdminAuth;
  sessionTtlMs: number;
  now?: () => number;
  logger?: Logger;
};

/**
 * `/api/client/*` — what the holder of one API key may see about themselves.
 *
 * Every route here reads through `scopeOf`, so the narrowing is the same rule
 * the rest of the system uses rather than a filter written again per handler.
 *
 * **There is no body route, and its absence is the design.** A route that
 * existed and refused would be a route somebody later makes conditional on a
 * setting; one that was never written cannot be. A client's own prompts are
 * reachable by the operator alone, through `/api/requests/:id/body`.
 */
export function clientRoutes(deps: ClientDeps) {
  const logger = deps.logger ?? noopLogger;
  const now = deps.now ?? (() => Date.now());

  return (
    new Elysia()
      .onError(apiErrorHandler)

      /**
       * Exchanges a raw gateway API key for a read-only session.
       *
       * The raw key is spent here and never stored by the browser: the response
       * carries a session cookie and nothing else. A browser holding the key in
       * `localStorage` would turn every XSS into credential theft rather than
       * session theft, and the key is the credential that can also spend money.
       */
      .post("/api/client/login", async ({ request, set }) => {
        const body = await readJsonRecord(request);
        const token = typeof body?.key === "string" ? await deps.admin.loginClient(body.key) : null;
        if (token === null) {
          // No distinction between "unknown key" and "revoked key". Both are
          // "this does not work", and telling them apart is an oracle for
          // whether a given key ever existed.
          logger.info("client login failed", { reason: "invalid credentials" });
          throw new GatewayError("AUTH", "invalid api key");
        }
        logger.info("client login succeeded");
        set.headers["set-cookie"] = sessionCookie(
          request,
          token,
          Math.floor(deps.sessionTtlMs / 1_000),
        );
        return { ok: true };
      })

      .post("/api/client/logout", async ({ request, set }) => {
        const token = readCookie(request, ADMIN_COOKIE);
        if (token !== null) deps.admin.logout(token);
        set.headers["set-cookie"] = sessionCookie(request, "", 0);
        return { ok: true };
      })

      /** The caller's own key: label, prefix, allowlist, limits, consumption. */
      .get("/api/client/summary", async ({ request }) => {
        const apiKeyId = await requireClient(request, deps.admin);
        return readOwnKey(deps.store, apiKeyId, now());
      })

      .get("/api/client/usage", async ({ request, query }) => {
        const apiKeyId = await requireClient(request, deps.admin);
        // The scope comes from the session, the rest of the query from the URL.
        // Two arguments because they have two provenances.
        return queryUsage(
          { store: deps.store, now },
          {
            grain: query.grain,
            groupBy: query.groupBy,
            splitBy: query.splitBy,
            since: query.since,
            until: query.until,
          },
          scopeOf({ kind: "client", apiKeyId }),
        );
      })

      .get("/api/client/logs", async ({ request, query }) => {
        const apiKeyId = await requireClient(request, deps.admin);
        const rows = await recentLogs(
          deps.store,
          logLimit(query.limit),
          scopeOf({ kind: "client", apiKeyId }),
        );
        // Projected, never returned raw. `RequestLog` is the operator's row and
        // names the account that served the request — in `credentialId` and,
        // less obviously, inside the `excluded:<credentialId>:<reason>` strings
        // in `degradations`. Both are the operator's infrastructure.
        return { logs: rows.map(toClientLog) };
      })

      /**
       * What room each provider account has left.
       *
       * Named accounts, unnamed ceilings: `@omni/control` converts every figure
       * to a fraction of the window it belongs to, so a client learns how full
       * an account is and never how large it is. The account labels are a
       * deliberate disclosure by the operator — see `AccountQuota`.
       */
      .get("/api/client/quota", async ({ request }) => {
        await requireClient(request, deps.admin);
        return { accounts: await accountQuota({ store: deps.store, now }) };
      })

      /**
       * The retained readings behind those figures, charted rather than printed.
       *
       * One series per account and window, so a client can see which account is
       * filling up rather than only that one of them is. The gateway's own token
       * rate — an aggregate over every key on the installation — is deliberately
       * not part of the answer.
       *
       * Clamping the span to what pruning left readable is `@omni/control`'s
       * rule, not this handler's, exactly as it is on the operator's route.
       */
      .get("/api/client/quota/history", async ({ request, query }) => {
        await requireClient(request, deps.admin);
        return accountQuotaHistory(
          { store: deps.store, now },
          { since: query.since, until: query.until },
        );
      })
  );
}

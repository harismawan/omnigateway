import type { ProviderId } from "@omni/ir";
import { ADAPTERS, type HttpClient, nodeHttpClient, type ProviderAdapter } from "@omni/providers";
import type { Store } from "@omni/store";
import { Elysia } from "elysia";
import { createAdminAuth } from "./auth/admin.ts";
import { OAUTH_PROVIDERS } from "./oauth/index.ts";
import { createRefresher } from "./oauth/refresh.ts";
import { adminRoutes } from "./routes/admin.ts";
import { connectRoutes } from "./routes/connect.ts";
import { proxyRoutes } from "./routes/proxy.ts";

export type AppDeps = {
  store: Store;
  baseUrl: string;
  now?: () => number;
  rand?: () => number;
  /** Overridden by the e2e tests to capture upstream bytes. */
  http?: HttpClient;
  adapters?: Readonly<Record<ProviderId, ProviderAdapter>>;
  requestId?: () => string;
};

const ADMIN_SESSION_TTL_MS = 12 * 60 * 60 * 1000;

export function createApp(deps: AppDeps) {
  const now = deps.now ?? (() => Date.now());
  const rand = deps.rand ?? Math.random;
  const http = deps.http ?? nodeHttpClient();
  const adapters = deps.adapters ?? ADAPTERS;
  const requestId = deps.requestId ?? (() => `req_${crypto.randomUUID()}`);

  const admin = createAdminAuth(deps.store, { now, sessionTtlMs: ADMIN_SESSION_TTL_MS });
  const refresh = createRefresher({
    store: deps.store,
    providers: OAUTH_PROVIDERS,
    http,
    now,
  });

  return new Elysia()
    .get("/health", () => ({ ok: true }))
    .use(proxyRoutes({ store: deps.store, adapters, http, now, rand, refresh, requestId }))
    .use(adminRoutes({ store: deps.store, admin, now, sessionTtlMs: ADMIN_SESSION_TTL_MS }))
    .use(
      connectRoutes({
        store: deps.store,
        admin,
        providers: OAUTH_PROVIDERS,
        http,
        now,
        baseUrl: deps.baseUrl,
      }),
    );
}

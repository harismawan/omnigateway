import { expect, test } from "bun:test";
import { ADMIN_COOKIE, createAdminAuth } from "@omni/control";
import type { Store } from "@omni/store";
import {
  memoryStore,
  requestLog,
  seedApiKey,
  seedCredential,
  target,
  virtualModel,
} from "@omni/testkit";
import { type AdminDeps, adminRoutes } from "../../src/routes/admin.ts";

const NOW = 1_000_000;
const SESSION_TTL_MS = 60_000;

type HarnessOptions = {
  configured?: boolean;
  console?: AdminDeps["console"];
  /** For routes whose spans are measured back from the clock. */
  now?: number;
};

async function harness({
  configured = true,
  console: consoleDeps,
  now = NOW,
}: HarnessOptions = {}) {
  const store = await memoryStore();
  const admin = createAdminAuth(store, { now: () => now, sessionTtlMs: SESSION_TTL_MS });

  let cookie = "";
  if (configured) {
    await admin.setPassword("hunter2hunter2");
    const token = await admin.login("hunter2hunter2");
    if (token === null) throw new Error("test admin login failed");
    cookie = `${ADMIN_COOKIE}=${token}`;
  }

  const app = adminRoutes({
    store,
    admin,
    baseUrl: "http://localhost:9000",
    now: () => now,
    sessionTtlMs: SESSION_TTL_MS,
    ...(consoleDeps === undefined ? {} : { console: consoleDeps }),
  });

  const call = (
    method: string,
    path: string,
    body?: unknown,
    auth = true,
    protocol: "http" | "https" = "http",
  ) =>
    app.handle(
      new Request(`${protocol}://localhost${path}`, {
        method,
        headers: {
          "content-type": "application/json",
          ...(auth && cookie.length > 0 ? { cookie } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );

  return { store, app, admin, call };
}

test("status reports an unconfigured gateway without a session", async () => {
  const { call } = await harness({ configured: false });
  const body = (await (await call("GET", "/api/status", undefined, false)).json()) as {
    configured: boolean;
    authenticated: boolean;
  };
  expect(body.configured).toBe(false);
  expect(body.authenticated).toBe(false);
});

test("setup sets the first password and refuses a second time", async () => {
  const { call } = await harness({ configured: false });
  const created = await call("POST", "/api/setup", { password: "hunter2hunter2" }, false);
  expect(created.status).toBe(200);
  expect(created.headers.get("set-cookie")).toContain("Max-Age=60");
  expect((await call("POST", "/api/setup", { password: "another-password" }, false)).status).toBe(
    409,
  );
});

test("concurrent setup permits only the response winner to log in", async () => {
  const { admin, call } = await harness({ configured: false });
  const attempts = [
    {
      password: "first-password",
      response: call("POST", "/api/setup", { password: "first-password" }, false),
    },
    {
      password: "second-password",
      response: call("POST", "/api/setup", { password: "second-password" }, false),
    },
  ];
  const results = await Promise.all(
    attempts.map(async ({ password, response }) => ({ password, response: await response })),
  );
  const winner = results.find(({ response }) => response.status === 200);
  const loser = results.find(({ response }) => response.status === 409);
  expect(winner).toBeDefined();
  expect(loser).toBeDefined();
  expect(await admin.login(winner?.password ?? "")).not.toBeNull();
  expect(await admin.login(loser?.password ?? "")).toBeNull();
});

test("configured setup returns identical conflicts before checking the password", async () => {
  const { call } = await harness();
  const valid = await call("POST", "/api/setup", { password: "another-password" }, false);
  const tooShort = await call("POST", "/api/setup", { password: "short" }, false);
  expect(valid.status).toBe(409);
  expect(tooShort.status).toBe(409);
  expect(await tooShort.text()).toBe(await valid.text());
});

test("setup rejects null and malformed bodies as bad requests", async () => {
  const { app, call } = await harness({ configured: false });
  expect((await call("POST", "/api/setup", null, false)).status).toBe(400);
  expect(
    (
      await app.handle(
        new Request("http://localhost/api/setup", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "not json",
        }),
      )
    ).status,
  ).toBe(400);
});

test("login rejects a missing password as invalid credentials", async () => {
  const { call } = await harness();
  expect((await call("POST", "/api/login", null, false)).status).toBe(401);
});

test("login rejects malformed JSON with the canonical API error", async () => {
  const { app } = await harness();
  const response = await app.handle(
    new Request("http://localhost/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    }),
  );

  expect(response.status).toBe(400);
  expect((await response.json()) as { error: { code: string; message: string } }).toEqual({
    error: { code: "BAD_REQUEST", message: "invalid JSON body" },
  });
});

test("login sets a secure session cookie only over https", async () => {
  const { call } = await harness();
  const httpResponse = await call("POST", "/api/login", { password: "hunter2hunter2" }, false);
  expect(httpResponse.status).toBe(200);
  const httpCookie = httpResponse.headers.get("set-cookie") ?? "";
  expect(httpCookie).toContain(`${ADMIN_COOKIE}=`);
  expect(httpCookie.toLowerCase()).toContain("httponly");
  expect(httpCookie.toLowerCase()).toContain("samesite=strict");
  expect(httpCookie.toLowerCase()).not.toContain("secure");
  expect(httpCookie).toContain("Max-Age=60");

  const httpsResponse = await call(
    "POST",
    "/api/login",
    { password: "hunter2hunter2" },
    false,
    "https",
  );
  expect(httpsResponse.status).toBe(200);
  const httpsCookie = httpsResponse.headers.get("set-cookie") ?? "";
  expect(httpsCookie.toLowerCase()).toContain("httponly");
  expect(httpsCookie.toLowerCase()).toContain("samesite=strict");
  expect(httpsCookie.toLowerCase()).toContain("secure");
  expect(httpsCookie).toContain("Max-Age=60");
});

test("login rejects the wrong password", async () => {
  const { call } = await harness();
  expect((await call("POST", "/api/login", { password: "wrong-password-x" }, false)).status).toBe(
    401,
  );
});

test("every data route requires a session", async () => {
  const { call } = await harness();
  for (const path of [
    "/api/credentials",
    "/api/credentials/health",
    "/api/credentials/quota/history",
    "/api/models",
    "/api/keys",
    "/api/settings",
    "/api/usage",
    "/api/logs",
    "/api/console",
    "/api/agent-setup",
  ]) {
    expect((await call("GET", path, undefined, false)).status).toBe(401);
  }
});

test("custom API-key credentials are created behind admin auth", async () => {
  const { call, store } = await harness();
  const input = {
    provider: "custom",
    apiKey: "test-provider-key",
    endpointId: "local",
    endpointLabel: "Local",
    origin: "http://localhost:8000",
    protocol: "chat_completions",
  };

  expect((await call("POST", "/api/credentials", input, false)).status).toBe(401);
  const response = await call("POST", "/api/credentials", input);
  expect(response.status).toBe(200);
  expect(await response.text()).not.toContain("test-provider-key");
  expect((await store.credentials.list())[0]?.providerData).toMatchObject({ endpointId: "local" });
});

test("custom credential endpoint conflicts return 409", async () => {
  const { call } = await harness();
  const input = {
    provider: "custom",
    apiKey: "first-test-key",
    endpointId: "local",
    endpointLabel: "Local",
    origin: "https://example.com",
    protocol: "responses",
  };
  expect((await call("POST", "/api/credentials", input)).status).toBe(200);
  const conflict = await call("POST", "/api/credentials", {
    ...input,
    apiKey: "second-test-key",
    origin: "https://other.example.com",
  });
  expect(conflict.status).toBe(409);
  expect(await conflict.text()).not.toContain("second-test-key");
});

test("credentials are listed without their secrets", async () => {
  const { call, store } = await harness();
  await seedCredential(store, {
    id: "c1",
    label: "work",
    accessToken: "test-token-1",
    refreshToken: "test-token-2",
  });

  const res = await call("GET", "/api/credentials");
  const text = await res.text();
  expect(text).not.toContain("test-token-1");
  expect(text).not.toContain("test-token-2");
  expect(text).not.toContain("secrets");
  expect(text).not.toContain("accessToken");
  expect(text).not.toContain("refreshToken");
  const body = JSON.parse(text) as {
    credentials: Array<{ label: string; hasRefreshToken: boolean }>;
  };
  expect(body.credentials[0]?.label).toBe("work");
  expect(body.credentials[0]?.hasRefreshToken).toBe(true);
});

test("patching a credential updates tier, weight and enabled", async () => {
  const { call, store } = await harness();
  await seedCredential(store, { id: "c1", accessToken: "test-token-1", refreshToken: null });

  expect(
    (await call("PATCH", "/api/credentials/c1", { tier: 2, weight: 0.5, enabled: false })).status,
  ).toBe(200);
  const reloaded = await store.credentials.get("c1");
  expect(reloaded?.tier).toBe(2);
  expect(reloaded?.weight).toBe(0.5);
  expect(reloaded?.enabled).toBe(false);
});

test("the operator's own toggle is recorded as a manual disable", async () => {
  const { call, store } = await harness();
  await seedCredential(store, { id: "c1", accessToken: "test-token-1", refreshToken: null });

  await call("PATCH", "/api/credentials/c1", { enabled: false });
  const disabled = await store.credentials.get("c1");
  expect(disabled?.disabledReason).toBe("manual");
  expect(disabled?.disabledAt).toBe(NOW);

  await call("PATCH", "/api/credentials/c1", { enabled: true });
  const reenabled = await store.credentials.get("c1");
  expect(reenabled?.disabledReason).toBeNull();
  expect(reenabled?.disabledAt).toBeNull();
});

test("the credential list carries why an account stopped routing", async () => {
  const { call, store } = await harness();
  await seedCredential(store, { id: "c1", accessToken: "test-token-1", refreshToken: null });
  await store.credentials.update("c1", {
    enabled: false,
    disabledReason: "tokenRejected",
    disabledAt: NOW,
  });

  const body = (await (await call("GET", "/api/credentials")).json()) as {
    credentials: Array<{ disabledReason: string | null; disabledAt: number | null }>;
  };
  expect(body.credentials[0]?.disabledReason).toBe("tokenRejected");
  expect(body.credentials[0]?.disabledAt).toBe(NOW);
});

test("patching a credential cannot inject a token", async () => {
  const { call, store } = await harness();
  await seedCredential(store, { id: "c1", accessToken: "test-token-1", refreshToken: null });

  const rejected = await call("PATCH", "/api/credentials/c1", { accessToken: "test-token-2" });
  expect(rejected.status).toBe(400);
  expect((await rejected.json()) as { error: { code: string; message: string } }).toEqual({
    error: {
      code: "BAD_REQUEST",
      message: ': Unrecognized key: "accessToken"',
    },
  });
  const view = await store.credentials.get("c1");
  expect((await view?.secrets())?.accessToken).toBe("test-token-1");
});

test("deleting a credential removes it", async () => {
  const { call, store } = await harness();
  await seedCredential(store, { id: "c1", accessToken: "test-token-1", refreshToken: null });

  expect((await call("DELETE", "/api/credentials/c1")).status).toBe(200);
  expect(await store.credentials.get("c1")).toBeNull();
});

test("models can be created, listed and deleted", async () => {
  const { call } = await harness();
  const model = virtualModel({ id: "fast", targets: [target()] });

  expect((await call("PUT", "/api/models/fast", model)).status).toBe(200);
  const body = (await (await call("GET", "/api/models")).json()) as {
    models: Array<{ id: string }>;
  };
  expect(body.models.map((model) => model.id)).toEqual(["fast"]);
  expect((await call("DELETE", "/api/models/fast")).status).toBe(200);
  const deleted = (await (await call("GET", "/api/models")).json()) as { models: unknown[] };
  expect(deleted.models).toHaveLength(0);
});

test("a model with no targets is rejected", async () => {
  const { call } = await harness();
  expect((await call("PUT", "/api/models/empty", virtualModel({ id: "empty" }))).status).toBe(400);
});

test("a model whose path id and body id disagree is rejected", async () => {
  const { call } = await harness();
  const model = virtualModel({ id: "other", targets: [target()] });
  expect((await call("PUT", "/api/models/fast", model)).status).toBe(400);
});

test("creating an api key returns the raw value exactly once", async () => {
  const { call } = await harness();
  const created = (await (await call("POST", "/api/keys", { label: "cli" })).json()) as {
    key: string;
  };
  expect(created.key).toMatch(/^sk-omni-/);

  const listed = (await (await call("GET", "/api/keys")).json()) as {
    keys: Array<{ label: string; key?: string; hash?: string; prefix: string }>;
  };
  expect(listed.keys[0]?.label).toBe("cli");
  expect(listed.keys[0]?.key).toBeUndefined();
  expect(listed.keys[0]?.hash).toBeUndefined();
  expect(listed.keys[0]?.prefix).toBe(created.key.slice(0, 12));
  expect(JSON.stringify(listed)).not.toContain(created.key);
});

test("an api key is revoked rather than deleted, so usage keeps its attribution", async () => {
  const { call, store } = await harness();
  const created = (await (await call("POST", "/api/keys", { label: "cli" })).json()) as {
    id: string;
  };

  expect((await call("DELETE", `/api/keys/${created.id}`)).status).toBe(200);
  const listed = await store.keys.list();
  expect(listed).toHaveLength(1);
  expect(listed[0]?.revokedAt).not.toBeNull();
});

test("settings round-trip and reject an unknown weight", async () => {
  const { call } = await harness();
  const current = (await (await call("GET", "/api/settings")).json()) as {
    settings: { weights: { tier: number } } & Record<string, unknown>;
  };
  expect(current.settings.weights.tier).toBe(10);

  const next = { ...current.settings, weights: { ...current.settings.weights, tier: 20 } };
  expect((await call("PUT", "/api/settings", next)).status).toBe(200);
  const updated = (await (await call("GET", "/api/settings")).json()) as {
    settings: { weights: { tier: number } };
  };
  expect(updated.settings.weights.tier).toBe(20);

  expect(
    (await call("PUT", "/api/settings", { ...next, weights: { ...next.weights, bogus: 1 } }))
      .status,
  ).toBe(400);
});

test("usage aggregates by the requested dimension", async () => {
  const { call, store } = await harness();
  await store.usage.append(
    requestLog({
      id: "r1",
      at: NOW,
      inputTokens: 10,
      outputTokens: 5,
      ttftMs: 40,
      rtkApplied: true,
      rtkEstimatedTokensSaved: 25,
    }),
  );

  const body = (await (await call("GET", "/api/usage?groupBy=model")).json()) as {
    rows: Array<{
      key: string;
      requests: number;
      outputTokens: number;
      rtkSavedTokens: number;
      rtkAppliedRequests: number;
    }>;
  };
  expect(body.rows[0]).toMatchObject({
    key: "claude-opus-4",
    requests: 1,
    outputTokens: 5,
    rtkSavedTokens: 25,
    rtkAppliedRequests: 1,
  });
});

test("usage rejects an unknown groupBy rather than passing it to sql", async () => {
  const { call } = await harness();
  expect((await call("GET", "/api/usage?groupBy=1;DROP+TABLE+usage")).status).toBe(400);
});

test("usage reads the daily rollup when asked for the daily grain", async () => {
  const { call, store } = await harness();
  await store.usage.append(requestLog({ id: "r1", at: NOW, inputTokens: 10, outputTokens: 5 }));

  const body = (await (
    await call("GET", `/api/usage?grain=daily&groupBy=day&since=${NOW - 86_400_000}`)
  ).json()) as { rows: Array<{ key: string; requests: number; cacheReadTokens: number }> };
  expect(body.rows).toHaveLength(1);
  expect(body.rows[0]?.requests).toBe(1);
  // A field the raw endpoint never carried before this grain existed.
  expect(body.rows[0]?.cacheReadTokens).toBe(0);
});

test("usage splits one time series into a bucket per provider", async () => {
  const { call, store } = await harness();
  await store.usage.append(requestLog({ id: "r1", at: NOW }));
  await store.usage.append(requestLog({ id: "r2", at: NOW, resolvedProvider: "openai" }));

  const body = (await (
    await call("GET", "/api/usage?groupBy=hour&splitBy=provider&since=0")
  ).json()) as { rows: Array<{ key: string; split: string }> };
  expect(body.rows.map((row) => row.split).sort()).toEqual(["anthropic", "openai"]);
  expect(new Set(body.rows.map((row) => row.key)).size).toBe(1);
});

test("usage refuses a dimension the grain cannot answer", async () => {
  const { call } = await harness();
  expect((await call("GET", "/api/usage?grain=daily&groupBy=hour")).status).toBe(400);
  expect((await call("GET", "/api/usage?grain=raw&groupBy=day")).status).toBe(400);
  expect((await call("GET", "/api/usage?groupBy=hour&splitBy=day")).status).toBe(400);
  expect((await call("GET", "/api/usage?grain=weekly&groupBy=day")).status).toBe(400);
});

test("logs are returned newest first, capped, and normalize fractional limits", async () => {
  const { call, store } = await harness();
  for (let i = 0; i < 3; i += 1) {
    await store.usage.append(requestLog({ id: `r${i}`, at: NOW + i }));
  }

  const body = (await (await call("GET", "/api/logs?limit=2")).json()) as {
    logs: Array<{ id: string }>;
  };
  expect(body.logs).toHaveLength(2);
  expect(body.logs[0]?.id).toBe("r2");

  const fractional = await call("GET", "/api/logs?limit=2.5");
  expect(fractional.status).toBe(200);
  const fractionalBody = (await fractional.json()) as { logs: Array<{ id: string }> };
  expect(fractionalBody.logs).toHaveLength(2);
});

test("credential health returns the health and quota rows the dashboard renders", async () => {
  const { store, call } = await harness();
  await seedCredential(store, { id: "c1", provider: "anthropic" });
  await store.credentials.saveHealth([
    {
      credentialId: "c1",
      model: "claude-opus-4",
      breakerState: "closed",
      consecutiveFailures: 0,
      openedAt: null,
      rateLimitedUntil: null,
      ewmaTtftMs: 400,
      lastUsedAt: NOW,
    },
  ]);
  await store.credentials.saveQuota([
    {
      credentialId: "c1",
      windowType: "fiveHour",
      startsAt: NOW,
      used: 250,
      limit: 1_000,
      resetsAt: NOW + 3_600_000,
      observedAt: NOW,
      windowMs: null,
    },
  ]);

  const response = await call("GET", "/api/credentials/health");
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    health: Array<{ credentialId: string; model: string; consecutiveFailures: number }>;
    quota: Array<{ credentialId: string; windowType: string; used: number; limit: number | null }>;
  };
  expect(body.health).toHaveLength(1);
  expect(body.health[0]).toMatchObject({
    credentialId: "c1",
    model: "claude-opus-4",
    consecutiveFailures: 0,
  });
  expect(body.quota[0]).toMatchObject({
    credentialId: "c1",
    windowType: "fiveHour",
    used: 250,
    limit: 1_000,
  });
});

test("credential health carries the burn estimate beside the reading", async () => {
  const { store, call } = await harness();
  await seedCredential(store, { id: "c1", provider: "anthropic" });
  await store.credentials.saveQuota([
    {
      credentialId: "c1",
      windowType: "fiveHour",
      startsAt: NOW,
      used: 100,
      limit: 1_000,
      // Two hours into a five-hour window.
      resetsAt: NOW + 3 * 3_600_000,
      observedAt: NOW,
      windowMs: null,
    },
  ]);

  const body = (await (await call("GET", "/api/credentials/health")).json()) as {
    quota: unknown[];
    burn: Array<{
      credentialId: string;
      windowType: string;
      windowStartsAt: number | null;
      ratePerHour: number | null;
      exhaustsAt: number | null;
      survives: boolean | null;
      gatewayRatePerHour: number | null;
      stale: boolean;
    }>;
  };

  expect(body.quota).toHaveLength(1);
  expect(body.burn).toEqual([
    {
      credentialId: "c1",
      windowType: "fiveHour",
      windowStartsAt: NOW - 2 * 3_600_000,
      ratePerHour: 50,
      exhaustsAt: NOW + 18 * 3_600_000,
      survives: true,
      gatewayRatePerHour: 0,
      stale: false,
    },
  ]);
});

/** A clock far enough from the epoch that a span may reach backwards. */
const CLOCK = 1_700_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;

async function reading(store: Store, credentialId: string, observedAt: number, used: number) {
  await store.credentials.saveQuota([
    {
      credentialId,
      windowType: "fiveHour",
      startsAt: observedAt,
      used,
      limit: 100,
      resetsAt: observedAt + 3_600_000,
      observedAt,
      windowMs: null,
    },
  ]);
}

test("quota history returns samples for the requested span and credential", async () => {
  const { store, call } = await harness({ now: CLOCK });
  await seedCredential(store, { id: "c1", provider: "anthropic" });
  await seedCredential(store, { id: "c2", provider: "anthropic" });
  await reading(store, "c1", CLOCK - 7_200_000, 10);
  await reading(store, "c1", CLOCK - 3_600_000, 20);
  await reading(store, "c2", CLOCK - 3_600_000, 30);

  const all = (await (await call("GET", "/api/credentials/quota/history?since=0")).json()) as {
    samples: Array<{ credentialId: string; used: number; observedAt: number }>;
  };
  expect(all.samples.map((s) => s.used).sort()).toEqual([10, 20, 30]);

  const one = (await (
    await call("GET", "/api/credentials/quota/history?since=0&credentialId=c1")
  ).json()) as { samples: Array<{ credentialId: string; used: number }> };
  expect(one.samples.map((s) => s.used)).toEqual([10, 20]);

  const span = (await (
    await call("GET", `/api/credentials/quota/history?since=${CLOCK - 3_600_000}&credentialId=c1`)
  ).json()) as { samples: Array<{ used: number }> };
  expect(span.samples.map((s) => s.used)).toEqual([20]);
});

test("quota history clamps a span reaching past the retention window", async () => {
  const { store, call } = await harness({ now: CLOCK });
  await store.config.putSettings({ logRetentionDays: 1 });
  await seedCredential(store, { id: "c1", provider: "anthropic" });
  await reading(store, "c1", CLOCK - 2 * DAY_MS, 10);
  await reading(store, "c1", CLOCK - 3_600_000, 20);

  const body = (await (
    await call("GET", `/api/credentials/quota/history?since=${CLOCK - 30 * DAY_MS}`)
  ).json()) as { samples: Array<{ used: number }> };

  expect(body.samples.map((s) => s.used)).toEqual([20]);
});

test("credential health hides unexpected repository errors", async () => {
  const { store, call } = await harness();
  const listHealth = store.credentials.listHealth;
  store.credentials.listHealth = async () => {
    throw new Error("sqlite failure leaked-secret-token");
  };

  const response = await call("GET", "/api/credentials/health");
  store.credentials.listHealth = listHealth;

  expect(response.status).toBe(500);
  expect((await response.json()) as { error: { code: string; message: string } }).toEqual({
    error: { code: "INTERNAL", message: "internal error" },
  });
});

test("credential health carries no token material", async () => {
  const { store, call } = await harness();
  await seedCredential(store, { id: "c1", provider: "anthropic" });

  const text = await (await call("GET", "/api/credentials/health")).text();
  expect(text).not.toContain("token");
  expect(text).not.toContain("secret");
});

test("credential health requires an admin session", async () => {
  const { call } = await harness();
  expect((await call("GET", "/api/credentials/health", undefined, false)).status).toBe(401);
});

test("logout clears the session cookie with matching http flags and invalidates it", async () => {
  const { call } = await harness();
  const response = await call("POST", "/api/logout");
  expect(response.status).toBe(200);
  const cookie = response.headers.get("set-cookie") ?? "";
  expect(cookie).toContain(`${ADMIN_COOKIE}=`);
  expect(cookie.toLowerCase()).toContain("httponly");
  expect(cookie.toLowerCase()).toContain("samesite=strict");
  expect(cookie.toLowerCase()).not.toContain("secure");
  expect(cookie).toContain("Max-Age=0");
  expect((await call("GET", "/api/credentials")).status).toBe(401);
});

test("logout clears the session cookie with secure over https", async () => {
  const { call } = await harness();
  const response = await call("POST", "/api/logout", undefined, true, "https");
  expect(response.status).toBe(200);
  const cookie = response.headers.get("set-cookie") ?? "";
  expect(cookie.toLowerCase()).toContain("httponly");
  expect(cookie.toLowerCase()).toContain("samesite=strict");
  expect(cookie.toLowerCase()).toContain("secure");
  expect(cookie).toContain("Max-Age=0");
});

/** A console source over a fake log file, recording what it was asked to run. */
function consoleHarness(contents: string) {
  const argv: string[][] = [];
  const deps: AdminDeps["console"] = {
    source: { kind: "file", path: "/tmp/gateway.log" },
    deps: {
      readFile: (path) => (path === "/tmp/gateway.log" ? contents : null),
      run: async (args) => {
        argv.push([...args]);
        return { code: 0, stdout: "", stderr: "" };
      },
    },
  };
  return { argv, console: deps };
}

const CONSOLE_LINES = [
  "2026-08-09T04:12:03.114Z INFO  omnigateway listening  port=9000",
  "2026-08-09T04:12:04.000Z WARN  scheduled token refresh failed  credentialId=c1",
  "2026-08-09T04:12:05.000Z ERROR quota poll failed  reason=boom",
].join("\n");

test("the console route returns the gateway's own output and the file it read", async () => {
  const { console: consoleDeps } = consoleHarness(CONSOLE_LINES);
  const { call } = await harness({ console: consoleDeps });

  const body = (await (await call("GET", "/api/console")).json()) as {
    source: string;
    path: string;
    lines: Array<{ raw: string; level: string | null; msg: string | null }>;
  };
  expect(body.source).toBe("file");
  expect(body.path).toBe("/tmp/gateway.log");
  expect(body.lines.map((l) => l.msg)).toEqual([
    "omnigateway listening",
    "scheduled token refresh failed",
    "quota poll failed",
  ]);
});

test("the console route filters by level", async () => {
  const { console: consoleDeps } = consoleHarness(CONSOLE_LINES);
  const { call } = await harness({ console: consoleDeps });

  const body = (await (await call("GET", "/api/console?level=warn")).json()) as {
    lines: Array<{ msg: string | null }>;
  };
  expect(body.lines.map((l) => l.msg)).toEqual([
    "scheduled token refresh failed",
    "quota poll failed",
  ]);
});

test("the console route ignores a level it does not recognise rather than failing", async () => {
  const { console: consoleDeps } = consoleHarness(CONSOLE_LINES);
  const { call } = await harness({ console: consoleDeps });

  const res = await call("GET", "/api/console?level=verbose");
  expect(res.status).toBe(200);
  expect(((await res.json()) as { lines: unknown[] }).lines).toHaveLength(3);
});

test("the console route clamps the page size", async () => {
  const { console: consoleDeps } = consoleHarness(CONSOLE_LINES);
  const { call } = await harness({ console: consoleDeps });

  const one = (await (await call("GET", "/api/console?lines=1")).json()) as { lines: unknown[] };
  expect(one.lines).toHaveLength(1);

  // Over the cap and below the floor both resolve rather than erroring.
  for (const query of ["lines=100000", "lines=0", "lines=-5", "lines=abc"]) {
    expect((await call("GET", `/api/console?${query}`)).status).toBe(200);
  }
});

test("the console route reports that nothing captured stdout, and shells out to nothing", async () => {
  const { call } = await harness();
  const body = (await (await call("GET", "/api/console")).json()) as {
    source: string;
    lines: unknown[];
  };
  expect(body).toEqual({ source: "none", lines: [] });
});

test("agent setup returns one Claude settings file for the explicit mapping", async () => {
  const { call, store } = await harness();
  await seedCredential(store, { id: "c1", provider: "anthropic" });
  await store.config.putModel(
    virtualModel({
      id: "opus",
      targets: [target({ provider: "anthropic", model: "claude-opus-5" })],
    }),
  );

  const body = (await (
    await call(
      "GET",
      "/api/agent-setup?client=claude&defaultModel=opus&fableModel=opus&opusModel=opus",
    )
  ).json()) as {
    client: string;
    files: { path: string; contents: string }[];
  };

  expect(body.client).toBe("claude");
  expect(body.files.map((file) => file.path)).toEqual(["settings.json"]);
  expect(body.files[0]?.contents).toContain('"ANTHROPIC_MODEL": "opus"');
  expect(body.files[0]?.contents).toContain('"ANTHROPIC_DEFAULT_FABLE_MODEL": "opus"');
  expect(body.files[0]?.contents).not.toContain("CLAUDE_CODE_MAX_CONTEXT_TOKENS");
});

test("agent setup requires and forwards opencode mappings", async () => {
  const { call, store } = await harness();
  await store.config.putModel(virtualModel({ id: "opus" }));
  await store.config.putModel(virtualModel({ id: "haiku" }));

  const missing = await call("GET", "/api/agent-setup?client=opencode");
  expect(missing.status).toBe(400);
  expect(await missing.text()).toContain("defaultModel");

  const response = await call(
    "GET",
    "/api/agent-setup?client=opencode&defaultModel=opus&fableModel=opus&haikuModel=haiku",
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as { files: { contents: string }[] };
  const config = JSON.parse(body.files[0]?.contents ?? "") as {
    model: string;
    provider: { omnigateway: { models: Record<string, unknown> } };
  };
  expect(config.model).toBe("omnigateway/opus");
  expect(Object.keys(config.provider.omnigateway.models)).toEqual(["opus", "haiku"]);
});

test("agent setup rejects missing and stale mappings", async () => {
  const { call, store } = await harness();
  await store.config.putModel(virtualModel({ id: "opus" }));

  const missing = await call("GET", "/api/agent-setup?client=claude");
  expect(missing.status).toBe(400);
  expect(await missing.text()).toContain("defaultModel");

  const stale = await call("GET", "/api/agent-setup?client=claude&defaultModel=missing");
  expect(stale.status).toBe(400);
  expect(await stale.text()).toContain("defaultModel");
  const staleOpencode = await call(
    "GET",
    "/api/agent-setup?client=opencode&defaultModel=opus&haikuModel=missing",
  );
  expect(staleOpencode.status).toBe(400);
  expect(await staleOpencode.text()).toContain("haikuModel");
});

// The store keeps only hashes, so there is no real key to render — but a
// snippet that carried one would leak it into every screenshot of this screen.
test("agent setup never renders a key", async () => {
  const { call, store } = await harness();
  await seedCredential(store, { id: "c1", provider: "anthropic" });
  await store.config.putModel(
    virtualModel({
      id: "opus",
      targets: [target({ provider: "anthropic", model: "claude-opus-5" })],
    }),
  );
  const { raw } = await seedApiKey(store, { label: "live" });

  const body = (await (
    await call("GET", "/api/agent-setup?client=opencode&defaultModel=opus")
  ).json()) as {
    files: { contents: string }[];
  };
  const contents = body.files.map((file) => file.contents).join("");
  expect(contents).toContain("<your OmniGateway key>");
  expect(contents).not.toContain(raw);
});

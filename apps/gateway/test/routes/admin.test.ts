import { expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CatalogProvider as ServerCatalogProvider } from "@omni/control";
import { ADMIN_COOKIE, createAdminAuth } from "@omni/control";
import { GatewayError } from "@omni/ir";
import { PROVIDER_DESCRIPTORS } from "@omni/providers/descriptors";
import { type BodyArtifact, createStore, deriveKey, type Store } from "@omni/store";
import {
  captureLogger,
  entryOf,
  memoryStore,
  requestLog,
  seedApiKey,
  seedCredential,
  target,
  virtualModel,
} from "@omni/testkit";
import type { CatalogProvider as ConsoleCatalogProvider } from "../../../dashboard/src/api/types.ts";
import { type AdminDeps, adminRoutes } from "../../src/routes/admin.ts";

/**
 * The console's mirror, pinned to the server's own type.
 *
 * Both directions, because each catches what the other cannot: a server field
 * the console never declared, and a console rename the server knows nothing
 * about. The runtime key list below catches neither on its own — it is a third
 * independent restatement, and renaming `colour` to `color` in the console plus
 * its fixtures left every suite green while production painted
 * `--p-<id>: undefined`.
 *
 * A `satisfies`-style assignment rather than a runtime assertion, because these
 * are types: the check runs under `bun run typecheck` and reports there. Written
 * as two declarations rather than a conditional type so the compiler names the
 * offending field instead of collapsing the answer to `false`.
 *
 * Deliberately **not** `toEqual` on a sample response. Optional fields are
 * absent on most providers, so a value-level comparison would pass while the
 * types disagreed about everything optional — which is where a mirror actually
 * drifts.
 */
const _consoleAcceptsServer: ConsoleCatalogProvider = {} as ServerCatalogProvider;
const _serverAcceptsConsole: ServerCatalogProvider = {} as ConsoleCatalogProvider;

const NOW = 1_000_000;
const SESSION_TTL_MS = 60_000;

type HarnessOptions = {
  configured?: boolean;
  console?: AdminDeps["console"];
  /** For routes whose spans are measured back from the clock. */
  now?: number;
  /**
   * A store built by the test, for the one route whose data lives on disk.
   * Everything else is happy with an in-memory database.
   */
  store?: Store;
  /** Whether `OMNI_BODY_LOGGING_ALLOWED` was set at boot. */
  bodyLoggingAllowed?: boolean;
  /** For the merged (`node=all`) console read, which needs more than one process. */
  consoleFleet?: AdminDeps["consoleFleet"];
  /** For the routes whose only visible effect is a line on stdout. */
  logger?: AdminDeps["logger"];
};

async function harness({
  configured = true,
  console: consoleDeps,
  now = NOW,
  store: provided,
  bodyLoggingAllowed,
  consoleFleet,
  logger,
}: HarnessOptions = {}) {
  const store = provided ?? (await memoryStore());
  const admin = createAdminAuth(store, { now: () => now, sessionTtlMs: SESSION_TTL_MS });

  let cookie = "";
  if (configured) {
    await admin.setPassword("hunter2hunter2");
    const token = await admin.login("hunter2hunter2");
    if (token === null) throw new Error("test admin login failed");
    cookie = `${ADMIN_COOKIE}=${token}`;
  }

  /**
   * The topics this surface announced, in order.
   *
   * Attached to every harness rather than to the one test that reads it: the
   * routes take the broadcaster as an option, so a harness that omitted it
   * would make "emits nothing" indistinguishable from "was never wired up".
   */
  const topics: string[] = [];

  const app = adminRoutes({
    store,
    admin,
    baseUrl: "http://localhost:9000",
    nodeId: "test-node",
    now: () => now,
    sessionTtlMs: SESSION_TTL_MS,
    broadcaster: { invalidate: (topic) => void topics.push(topic) },
    ...(consoleDeps === undefined ? {} : { console: consoleDeps }),
    ...(consoleFleet === undefined ? {} : { consoleFleet }),
    ...(bodyLoggingAllowed === undefined ? {} : { bodyLoggingAllowed }),
    ...(logger === undefined ? {} : { logger }),
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

  return { store, app, admin, call, topics };
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
    "/api/catalog",
    "/api/keys",
    "/api/settings",
    "/api/usage",
    "/api/logs",
    "/api/console",
    "/api/agent-setup",
    "/api/requests/req-1/body",
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

test("the route refuses a provider this gateway does not have", async () => {
  // At the route, not only at `createApiKeyCredential`. Existence is now an
  // injectable `ProviderExists` predicate defaulting to `isProviderId`, because
  // the CLI has to answer it from plugin manifests — it never loads plugins. The
  // gateway does load them, so its own registry is the whole answer and it must
  // keep passing nothing. Pinned here because the function-level test says
  // nothing about which argument this call site supplies, and threading a
  // fourth one through by mistake would silently let an operator mint an account
  // for a provider that cannot serve it: stored, listed, and failing on first
  // dispatch.
  const { call, store } = await harness();

  const rejected = await call("POST", "/api/credentials", {
    provider: "nonesuch",
    apiKey: "test-provider-key",
  });
  expect(rejected.status).toBe(400);
  expect(await rejected.text()).toContain("no provider named");

  // Format and existence are separate questions with separate messages, so an
  // operator learns which one they got wrong.
  const malformed = await call("POST", "/api/credentials", {
    provider: "Acme Corp",
    apiKey: "test-provider-key",
  });
  expect(malformed.status).toBe(400);

  // Nothing stored by either — the failure being closed is what matters, not the
  // status code, and a route that 400s while writing would pass the assertions
  // above.
  expect(await store.credentials.list()).toEqual([]);

  // The positive control: a real provider still mints, so "refuses everything"
  // cannot pass this test.
  expect(
    (await call("POST", "/api/credentials", { provider: "anthropic", apiKey: "test-provider-key" }))
      .status,
  ).toBe(200);
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
      message: '(root): unrecognized key "accessToken"',
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

/**
 * Limits are the one part of a key that is editable after minting.
 *
 * `bodyLoggingOptOut` has no route like this on purpose: it is a promise to
 * whoever holds the key. A limit is the operator's own ceiling on their own
 * installation, and a weekly spend cap that cannot be adjusted without minting a
 * new key and redeploying every client is a cap that gets set to unlimited.
 */
test("a key's limits are editable behind admin auth, and the matrix is replaced whole", async () => {
  const { call, store } = await harness();
  const created = (await (
    await call("POST", "/api/keys", { label: "cli", limits: { requests: { "1m": 60 } } })
  ).json()) as { id: string };

  const body = { limits: { tokens: { "1w": 50_000_000 }, concurrency: 8 } };
  expect((await call("PUT", `/api/keys/${created.id}/limits`, body, false)).status).toBe(401);

  const saved = await call("PUT", `/api/keys/${created.id}/limits`, body);
  expect(saved.status).toBe(200);
  const listed = await store.keys.list();
  expect(listed[0]?.limits).toEqual({ tokens: { "1w": 50_000_000 }, concurrency: 8 });
});

test("a malformed limit matrix is refused rather than stored", async () => {
  const { call, store } = await harness();
  const created = (await (
    await call("POST", "/api/keys", { label: "cli", limits: { requests: { "1m": 60 } } })
  ).json()) as { id: string };

  for (const body of [
    // An unknown dimension or window read back later as "no limit" would fail
    // open on a control the operator explicitly set.
    { limits: { bandwidth: { "1m": 5 } } },
    { limits: { requests: { "2m": 60 } } },
    { limits: { spend: { "1m": 5 } } },
    // Zero is a revoked key, not a ceiling.
    { limits: { requests: { "1m": 0 } } },
    { limits: null },
    {},
  ]) {
    expect((await call("PUT", `/api/keys/${created.id}/limits`, body)).status).toBe(400);
  }
  expect((await store.keys.list())[0]?.limits).toEqual({ requests: { "1m": 60 } });
});

/**
 * Models are the other part of a key that is editable after minting, for the
 * same reason the matrix is: an allowlist that cannot be adjusted without
 * minting a new key and redeploying every client is one that gets set to
 * unrestricted instead. `null` (every model) and `[]` (none) are distinct
 * facts and both must survive the write.
 */
test("a key's allowed models are editable behind admin auth, and the list is replaced whole", async () => {
  const { call, store } = await harness();
  const created = (await (
    await call("POST", "/api/keys", { label: "cli", modelAllowlist: ["fast"] })
  ).json()) as { id: string };

  expect((await call("PUT", `/api/keys/${created.id}/models`, {}, false)).status).toBe(401);

  const saved = await call("PUT", `/api/keys/${created.id}/models`, {
    modelAllowlist: ["fast", "smart"],
  });
  expect(saved.status).toBe(200);
  expect(((await saved.json()) as { modelAllowlist: string[] }).modelAllowlist).toEqual([
    "fast",
    "smart",
  ]);
  expect((await store.keys.list())[0]?.modelAllowlist).toEqual(["fast", "smart"]);

  // [] denies every model; null restores unrestricted. Neither may silently
  // become the other.
  await call("PUT", `/api/keys/${created.id}/models`, { modelAllowlist: [] });
  expect((await store.keys.list())[0]?.modelAllowlist).toEqual([]);

  await call("PUT", `/api/keys/${created.id}/models`, { modelAllowlist: null });
  expect((await store.keys.list())[0]?.modelAllowlist).toBeNull();
});

test("a malformed models body is refused rather than stored", async () => {
  const { call, store } = await harness();
  const created = (await (await call("POST", "/api/keys", { label: "cli" })).json()) as {
    id: string;
  };

  for (const body of [
    // Absent is not "unrestricted": an edit must say which fact it means.
    {},
    { modelAllowlist: "fast" },
    { modelAllowlist: [""] },
    { modelAllowlist: ["fast"], label: "sneaking a second field past" },
  ]) {
    expect((await call("PUT", `/api/keys/${created.id}/models`, body)).status).toBe(400);
  }
  expect((await store.keys.list())[0]?.modelAllowlist).toBeNull();
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

test("an empty span param reads as absent rather than as the epoch", async () => {
  const { call, store } = await harness();
  await store.usage.append(requestLog({ id: "r1", at: NOW }));

  // `?since=&until=` is what a form or a hand-built query string produces.
  // `Number("")` is 0, so an unguarded upper bound clamps to the epoch and
  // answers "no usage" where the operator asked for all of it.
  const body = (await (await call("GET", "/api/usage?groupBy=model&since=&until=")).json()) as {
    rows: Array<{ requests: number }>;
  };
  expect(body.rows[0]?.requests).toBe(1);

  // A zero the operator actually sent is still a bound.
  const zero = (await (await call("GET", "/api/usage?groupBy=model&until=0")).json()) as {
    rows: unknown[];
  };
  expect(zero.rows).toEqual([]);
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

  // `Number("")` is 0, and the floor turns that into a page of one row rather
  // than the default page the operator asked for by sending nothing.
  const blank = (await (await call("GET", "/api/logs?limit=")).json()) as {
    logs: Array<{ id: string }>;
  };
  expect(blank.logs).toHaveLength(3);
});

/* ------------------------------------------------------- captured bodies -- */

const BODY_AT = Date.UTC(2026, 7, 17, 12, 0, 0);
const BODY_REQUEST_ID = "req_11111111-2222-4333-8444-555555555555";
/** UTC shard layout, spelled out so the test does not agree with any layout. */
const BODY_REL_PATH = `2026/08/17/${BODY_REQUEST_ID}.json.enc`;

/**
 * A store on disk, because artifacts live beside the database file and an
 * in-memory database has nowhere to put a tree.
 */
async function bodyHarness(): Promise<{
  store: Store;
  root: string;
  dir: string;
  call: Awaited<ReturnType<typeof harness>>["call"];
}> {
  const root = join(tmpdir(), `omni-admin-bodies-${crypto.randomUUID()}`);
  await mkdir(root, { recursive: true });
  const store = await createStore({
    path: join(root, "omnigateway.db"),
    encryptionKey: await deriveKey("test-secret-value-for-unit-tests"),
  });
  const { call } = await harness({ store });
  return { store, root, dir: join(root, "request_bodies"), call };
}

function bodyArtifact(overrides: Partial<BodyArtifact> = {}): BodyArtifact {
  return {
    schemaVersion: 1,
    requestId: BODY_REQUEST_ID,
    at: BODY_AT,
    client: { request: { model: "fast" }, response: { ok: true }, truncated: false },
    attempts: [
      {
        attempt: 1,
        provider: "anthropic",
        request: { model: "claude-haiku-4-5" },
        response: { ok: true },
        streamChunks: null,
        truncated: false,
      },
    ],
    error: null,
    ...overrides,
  };
}

type BodyResponse = {
  requestId: string;
  detailState: string;
  truncated: boolean;
  sizeBytes: number;
  at: number | null;
  artifact: BodyArtifact | null;
};

test("a captured request's bodies are served decrypted to an admin", async () => {
  const { store, root, call } = await bodyHarness();
  try {
    await store.bodies.put(bodyArtifact());

    const response = await call("GET", `/api/requests/${BODY_REQUEST_ID}/body`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as BodyResponse;
    expect(body.detailState).toBe("ready");
    expect(body.artifact?.client.request).toEqual({ model: "fast" });
    expect(body.artifact?.attempts[0]?.provider).toBe("anthropic");
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

/**
 * The most sensitive thing this gateway serves. There is no unauthenticated
 * form of this route, and a caller without a session learns nothing about
 * whether the request even exists.
 */
test("captured bodies are refused to a caller with no admin session", async () => {
  const { store, root, call } = await bodyHarness();
  try {
    await store.bodies.put(bodyArtifact());

    const response = await call("GET", `/api/requests/${BODY_REQUEST_ID}/body`, undefined, false);
    expect(response.status).toBe(401);
    const text = await response.text();
    expect(text).not.toContain("claude-haiku-4-5");
    expect(text).not.toContain("ready");
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

/** Capture is off by default, so "never captured" is the ordinary answer. */
test("a request that was never captured answers none rather than 404", async () => {
  const { store, root, call } = await bodyHarness();
  try {
    const response = await call("GET", "/api/requests/req_nothing-here/body");
    expect(response.status).toBe(200);
    const body = (await response.json()) as BodyResponse;
    expect(body.detailState).toBe("none");
    expect(body.artifact).toBeNull();
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("an artifact deleted underneath its row answers missing rather than 500", async () => {
  const { store, root, dir, call } = await bodyHarness();
  try {
    await store.bodies.put(bodyArtifact());
    await rm(join(dir, BODY_REL_PATH));

    const response = await call("GET", `/api/requests/${BODY_REQUEST_ID}/body`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as BodyResponse;
    expect(body.detailState).toBe("missing");
    expect(body.artifact).toBeNull();
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("an artifact that no longer decrypts answers corrupt rather than 500", async () => {
  const { store, root, dir, call } = await bodyHarness();
  try {
    await store.bodies.put(bodyArtifact());
    await writeFile(join(dir, BODY_REL_PATH), "not the ciphertext that was written");

    const response = await call("GET", `/api/requests/${BODY_REQUEST_ID}/body`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as BodyResponse;
    expect(body.detailState).toBe("corrupt");
    expect(body.artifact).toBeNull();
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

/**
 * Neither the answer nor its failure modes may describe the installation. A path
 * names where the prompt corpus lives, a credential id names an account, and a
 * stack names the code — none of which a console needs and all of which an
 * attacker with a session would take.
 */
test("the body response names no path, credential, or stack", async () => {
  const { store, root, dir, call } = await bodyHarness();
  try {
    await seedCredential(store, { id: "cred-secret-1", accessToken: "test-token-1" });
    await store.bodies.put(bodyArtifact());
    const ready = await (await call("GET", `/api/requests/${BODY_REQUEST_ID}/body`)).text();

    await writeFile(join(dir, BODY_REL_PATH), "corrupted");
    const broken = await (await call("GET", `/api/requests/${BODY_REQUEST_ID}/body`)).text();

    for (const text of [ready, broken]) {
      expect(text).not.toContain("cred-secret-1");
      expect(text).not.toContain("request_bodies");
      expect(text).not.toContain(root);
      expect(text).not.toContain("relPath");
      expect(text).not.toContain("sha256");
      expect(text).not.toContain("at Object.");
    }
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------ two keys -- */

/**
 * The environment half of the capture contract, reported beside the setting it
 * governs. Without it the console renders a switch that saves fine and records
 * nothing, which is a bug report rather than a feature.
 */
test("settings report whether the environment permits body capture", async () => {
  const permitted = await harness({ bodyLoggingAllowed: true });
  const body = (await (await permitted.call("GET", "/api/settings")).json()) as {
    settings: { bodyLoggingEnabled: boolean };
    bodyLoggingAllowed: boolean;
  };
  expect(body.bodyLoggingAllowed).toBe(true);
  // The setting itself is untouched by the environment: off until an operator
  // turns it on, and turning it on is what the other key permits.
  expect(body.settings.bodyLoggingEnabled).toBe(false);

  const forbidden = await harness();
  const off = (await (await forbidden.call("GET", "/api/settings")).json()) as {
    bodyLoggingAllowed: boolean;
  };
  expect(off.bodyLoggingAllowed).toBe(false);
});

test("a key can be issued that is never captured, and says so when listed", async () => {
  const { call, store } = await harness();
  const created = (await (
    await call("POST", "/api/keys", { label: "private-client", bodyLoggingOptOut: true })
  ).json()) as { id: string };

  const listed = (await (await call("GET", "/api/keys")).json()) as {
    keys: Array<{ id: string; bodyLoggingOptOut: boolean }>;
  };
  expect(listed.keys.find((key) => key.id === created.id)?.bodyLoggingOptOut).toBe(true);
  // Persisted, not merely echoed: the proxy reads it off the key on every
  // request before any capture work begins.
  expect((await store.keys.list())[0]?.bodyLoggingOptOut).toBe(true);
});

test("a key that says nothing inherits the installation's capture policy", async () => {
  const { call } = await harness();
  await call("POST", "/api/keys", { label: "ordinary" });

  const listed = (await (await call("GET", "/api/keys")).json()) as {
    keys: Array<{ bodyLoggingOptOut: boolean }>;
  };
  expect(listed.keys[0]?.bodyLoggingOptOut).toBe(false);
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

test("quota history carries the gateway rate the health route no longer does", async () => {
  const { store, call } = await harness({ now: CLOCK });
  await seedCredential(store, { id: "c1", provider: "anthropic" });
  await reading(store, "c1", CLOCK, 20);

  const history = (await (
    await call("GET", "/api/credentials/quota/history?since=0&credentialId=c1")
  ).json()) as {
    gatewayRates: Array<{ credentialId: string; windowType: string; gatewayRatePerHour: number }>;
  };
  const health = (await (await call("GET", "/api/credentials/health")).json()) as {
    burn: Array<Record<string, unknown>>;
  };

  expect(history.gatewayRates).toEqual([
    { credentialId: "c1", windowType: "fiveHour", gatewayRatePerHour: 0 },
  ]);
  // The estimate stays on the health route; only the request-log aggregate moved.
  expect(health.burn[0]).not.toHaveProperty("gatewayRatePerHour");
  expect(health.burn[0]).toHaveProperty("ratePerHour");
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

/** A store whose fleet is `ids`, for the merged console read. */
async function fleetStore(ids: string[]): Promise<Store> {
  const store = await memoryStore();
  return {
    ...store,
    maintenance: { ...store.maintenance, nodes: async () => ids.map((id) => ({ id, seenAt: 0 })) },
  };
}

test("the merged console read reports a fleet capturing nothing as `none`", async () => {
  // What a container deployment looks like: stdout goes to the runtime, no
  // process names an `OMNI_LOG_FILE`. `fleet` with no lines would tell the
  // console the log is merely empty.
  const store = await fleetStore(["test-node", "other"]);
  const { call } = await harness({
    store,
    consoleFleet: { read: async () => ({ source: "none", lines: [] }), stop: () => {} },
  });

  const body = (await (await call("GET", "/api/console?node=all")).json()) as { source: string };
  expect(body.source).toBe("none");
});

test("the merged console read stays a fleet when one process captures output", async () => {
  const store = await fleetStore(["test-node", "other"]);
  const { call } = await harness({
    store,
    consoleFleet: {
      read: async (nodeId) =>
        nodeId === "other"
          ? {
              source: "file",
              path: "/tmp/other.log",
              lines: [{ raw: "hi", at: 1, level: null, msg: null }],
            }
          : { source: "none", lines: [] },
      stop: () => {},
    },
  });

  const body = (await (await call("GET", "/api/console?node=all")).json()) as {
    source: string;
    lines: Array<{ raw: string; nodeId: string }>;
  };
  expect(body.source).toBe("fleet");
  expect(body.lines.map((line) => [line.nodeId, line.raw])).toEqual([["other", "hi"]]);
});

test("the merged console read names a process that did not answer", async () => {
  // The one capturing process timing out must not read as a fleet capturing
  // nothing: the verdict is the answering processes' own, and the silent one
  // is listed rather than folded into it.
  const store = await fleetStore(["test-node", "other"]);
  const { call } = await harness({
    store,
    consoleFleet: {
      read: async (nodeId) => {
        if (nodeId === "other") throw new GatewayError("TIMEOUT", "no answer");
        return { source: "none", lines: [] };
      },
      stop: () => {},
    },
  });

  const body = (await (await call("GET", "/api/console?node=all")).json()) as {
    source: string;
    unreachable?: string[];
  };
  expect(body.source).toBe("none");
  expect(body.unreachable).toEqual(["other"]);
});

test("the merged console read times out when no process answers", async () => {
  const store = await fleetStore(["test-node", "other"]);
  const { call } = await harness({
    store,
    consoleFleet: {
      read: async () => {
        throw new GatewayError("TIMEOUT", "no answer");
      },
      stop: () => {},
    },
  });

  const res = await call("GET", "/api/console?node=all");
  expect(res.status).toBe(504);
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

  // An empty param is absent, not zero: the floor would otherwise answer one
  // line where the operator asked for the default page.
  const blank = (await (await call("GET", "/api/console?lines=")).json()) as { lines: unknown[] };
  expect(blank.lines).toHaveLength(3);
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
  // Written as the mirrored id: the picker this file configures lists nothing
  // else, and ingress unwinds the prefix before the allowlist runs.
  expect(body.files[0]?.contents).toContain('"ANTHROPIC_MODEL": "claude/opus"');
  expect(body.files[0]?.contents).toContain('"ANTHROPIC_DEFAULT_FABLE_MODEL": "claude/opus"');
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

/**
 * Every mutating route on this surface and the topic it announces.
 *
 * A table rather than a test each, because the property is about the set. A
 * fifteenth handler added without an emit is a console that silently keeps
 * polling one resource while pushing the rest, and nothing about the change
 * that broke it would look wrong — so it is caught by the completeness check
 * below rather than by whoever happens to remember this file exists.
 *
 * `topics: []` is a decision and not a gap; the reasoning for each is beside
 * `changed` in `adminRoutes`, and the point of listing them here is that they
 * are listed rather than absent.
 */
const MUTATIONS: ReadonlyArray<{
  /** The pattern Elysia registered, which is what the completeness check reads. */
  route: string;
  method: string;
  /** The same route with this harness's fixtures in it. `:key` is the seeded key's id. */
  path: string;
  body?: unknown;
  topics: readonly string[];
}> = [
  // Before any admin session can exist, so no socket is subscribed to be told.
  {
    route: "/api/setup",
    method: "POST",
    path: "/api/setup",
    body: { password: "hunter2hunter2" },
    topics: [],
  },
  {
    route: "/api/login",
    method: "POST",
    path: "/api/login",
    body: { password: "hunter2hunter2" },
    topics: [],
  },
  { route: "/api/logout", method: "POST", path: "/api/logout", topics: [] },
  {
    route: "/api/credentials",
    method: "POST",
    path: "/api/credentials",
    body: {
      provider: "custom",
      apiKey: "test-provider-key",
      endpointId: "local",
      endpointLabel: "Local",
      origin: "http://localhost:8000",
      protocol: "chat_completions",
    },
    topics: ["res:credentials"],
  },
  {
    route: "/api/credentials/:id",
    method: "PATCH",
    path: "/api/credentials/c1",
    body: { tier: 2 },
    topics: ["res:credentials"],
  },
  {
    route: "/api/credentials/:id",
    method: "DELETE",
    path: "/api/credentials/c1",
    topics: ["res:credentials"],
  },
  {
    route: "/api/models/:id",
    method: "PUT",
    path: "/api/models/fast",
    body: "model",
    topics: ["res:models"],
  },
  {
    route: "/api/models/:id",
    method: "DELETE",
    path: "/api/models/fast",
    topics: ["res:models"],
  },
  {
    route: "/api/keys",
    method: "POST",
    path: "/api/keys",
    body: { label: "cli" },
    topics: ["res:keys"],
  },
  {
    route: "/api/keys/:id/limits",
    method: "PUT",
    path: "/api/keys/:key/limits",
    body: { limits: { requests: { "1m": 60 } } },
    topics: ["res:keys"],
  },
  {
    route: "/api/keys/:id/models",
    method: "PUT",
    path: "/api/keys/:key/models",
    body: { modelAllowlist: ["fast"] },
    topics: ["res:keys"],
  },
  { route: "/api/keys/:id", method: "DELETE", path: "/api/keys/:key", topics: ["res:keys"] },
  {
    route: "/api/settings",
    method: "PUT",
    path: "/api/settings",
    body: "settings",
    topics: ["res:settings"],
  },
  // Granting or withdrawing read-only access. Announces `res:settings` because
  // that is where the console renders whether the access exists.
  {
    route: "/api/settings/viewer-password",
    method: "PUT",
    path: "/api/settings/viewer-password",
    body: { password: "read-only-pass-1" },
    topics: ["res:settings"],
  },
  // The operator's own credential. Announces nothing: no board renders it, and
  // every session is gone by the time a client could act on a frame anyway.
  {
    route: "/api/settings/password",
    method: "PUT",
    path: "/api/settings/password",
    body: { current: "hunter2hunter2", password: "a-longer-new-password" },
    topics: [],
  },
  // A POST that writes nothing: it ranks the targets a model already has.
  {
    route: "/api/models/:id/dry-run",
    method: "POST",
    path: "/api/models/fast/dry-run",
    body: {},
    topics: [],
  },
];

test("every admin mutation announces its own resource, and only its own", async () => {
  for (const mutation of MUTATIONS) {
    const { call, store, topics } = await harness({
      configured: mutation.path !== "/api/setup",
    });
    await seedCredential(store, { id: "c1", accessToken: "test-token-1", refreshToken: null });
    const model = virtualModel({
      id: "fast",
      targets: [target({ provider: "anthropic", model: "claude-opus-5" })],
    });
    await store.config.putModel(model);
    const { key } = await seedApiKey(store, { label: "table" });

    // Settings are read back rather than invented: `putSettings` refuses a
    // partial document, and a 400 would make this row prove nothing.
    const settings = (await (await call("GET", "/api/settings")).json()) as {
      settings: Record<string, unknown>;
    };
    const body =
      mutation.body === "model"
        ? model
        : mutation.body === "settings"
          ? settings.settings
          : mutation.body;

    // `/api/setup` is the one row that runs unauthenticated, because it is the
    // one route that exists to create the session everything else needs.
    const authenticated = mutation.path !== "/api/setup";
    const before = topics.length;
    const response = await call(
      mutation.method,
      mutation.path.replace(":key", key.id),
      body,
      authenticated,
    );

    // The emit sits after the write, so a row whose request was refused would
    // pass an "emitted nothing" assertion for the wrong reason.
    expect({ path: mutation.path, status: response.status }).toEqual({
      path: mutation.path,
      status: 200,
    });
    expect({ path: mutation.path, topics: topics.slice(before) }).toEqual({
      path: mutation.path,
      topics: [...mutation.topics],
    });
  }
});

/**
 * The guard that makes the table above worth having.
 *
 * Without it the table is a list someone has to remember to extend, which is
 * exactly the kind of list that stops being complete. Elysia already holds the
 * routing table this surface registered, so the set of mutating routes is a
 * fact to be read rather than one to be restated.
 */
test("the mutation table covers every mutating route this surface registers", async () => {
  const { app } = await harness();
  const registered = (app as unknown as { routes: { method: string; path: string }[] }).routes
    .filter((route) => route.method !== "GET")
    .map((route) => `${route.method} ${route.path}`)
    .sort();

  const covered = MUTATIONS.map((mutation) => `${mutation.method} ${mutation.route}`).sort();

  expect(covered).toEqual(registered);
});

/**
 * Changing the operator's own password.
 *
 * The session cookie alone must not be enough: an admin session is a cookie in
 * a browser that may be sitting unattended, and one that could rewrite the
 * credential behind it turns "left the tab open" into "locked out".
 */
test("changing the admin password requires the current one", async () => {
  const { call, admin } = await harness();

  const wrong = await call("PUT", "/api/settings/password", {
    current: "not-the-password",
    password: "a-longer-new-password",
  });
  expect(wrong.status).toBe(401);
  // Nothing moved: the old password still opens a session and the new one does
  // not. Asserted through `login`, which is the only thing that can tell.
  expect(await admin.login("hunter2hunter2")).not.toBeNull();
  expect(await admin.login("a-longer-new-password")).toBeNull();
});

test("a correct current password replaces it and ends every session", async () => {
  const { call, admin } = await harness();
  const before = await admin.login("hunter2hunter2");
  if (before === null) throw new Error("expected a session to end");

  const response = await call("PUT", "/api/settings/password", {
    current: "hunter2hunter2",
    password: "a-longer-new-password",
  });
  expect(response.status).toBe(200);

  expect(await admin.login("a-longer-new-password")).not.toBeNull();
  expect(await admin.login("hunter2hunter2")).toBeNull();
  // Including the one that asked for the change: a password change is a "log
  // everyone out" event, and the caller is not exempt from it.
  expect(await admin.verify(before)).toBeNull();
});

test("a new password too short to be one is refused, and changes nothing", async () => {
  const { call, admin } = await harness();

  const response = await call("PUT", "/api/settings/password", {
    current: "hunter2hunter2",
    password: "short",
  });
  expect(response.status).toBe(400);
  expect(await admin.login("hunter2hunter2")).not.toBeNull();
});

test("the password change route needs both fields, and says so", async () => {
  const { call } = await harness();

  expect((await call("PUT", "/api/settings/password", { password: "a-longer-one" })).status).toBe(
    400,
  );
  expect((await call("PUT", "/api/settings/password", { current: "hunter2hunter2" })).status).toBe(
    400,
  );
});

/**
 * The read-only password, which is optional and therefore has an "off".
 *
 * `null` removes it; an absent field is a malformed request rather than a
 * quieter spelling of removal.
 */
test("the viewer password can be set, replaced, and withdrawn", async () => {
  const { call, admin } = await harness();
  expect(await admin.isViewerConfigured()).toBe(false);
  // Nothing to guess at: with no password set, no password works.
  expect(await admin.loginViewer("")).toBeNull();

  expect(
    (await call("PUT", "/api/settings/viewer-password", { password: "read-only-pass-1" })).status,
  ).toBe(200);
  expect(await admin.isViewerConfigured()).toBe(true);
  expect(await admin.loginViewer("read-only-pass-1")).not.toBeNull();

  expect(
    (await call("PUT", "/api/settings/viewer-password", { password: "read-only-pass-2" })).status,
  ).toBe(200);
  expect(await admin.loginViewer("read-only-pass-1")).toBeNull();
  expect(await admin.loginViewer("read-only-pass-2")).not.toBeNull();

  expect((await call("PUT", "/api/settings/viewer-password", { password: null })).status).toBe(200);
  expect(await admin.isViewerConfigured()).toBe(false);
  expect(await admin.loginViewer("read-only-pass-2")).toBeNull();
});

test("withdrawing viewer access leaves the operator signed in", async () => {
  const { call, admin } = await harness();
  await call("PUT", "/api/settings/viewer-password", { password: "read-only-pass-1" });
  const mine = await admin.login("hunter2hunter2");
  if (mine === null) throw new Error("expected an admin session");

  await call("PUT", "/api/settings/viewer-password", { password: null });

  // Someone else's access was withdrawn; the operator's own was not touched.
  expect(await admin.verify(mine)).toEqual({ kind: "admin" });
});

/**
 * The discriminating pair, which the two tests above miss between them.
 *
 * A wrong current password and a short new one, against a correct current
 * password and the same short new one. If those answer differently, then
 * `{current: guess, password: "x"}` is a free, unlimited, non-destructive
 * oracle for the admin password — and the caller already holds a session, so
 * "they are authenticated anyway" is not an answer: the whole point of asking
 * for the current password is that a cookie is not proof of knowing it.
 */
test("a wrong current password is indistinguishable from a short new one", async () => {
  const { call, admin } = await harness();

  const wrongCurrent = await call("PUT", "/api/settings/password", {
    current: "not-the-password",
    password: "short",
  });
  const rightCurrent = await call("PUT", "/api/settings/password", {
    current: "hunter2hunter2",
    password: "short",
  });

  expect(rightCurrent.status).toBe(wrongCurrent.status);
  expect(await rightCurrent.text()).toBe(await wrongCurrent.text());
  // And neither attempt moved anything.
  expect(await admin.login("hunter2hunter2")).not.toBeNull();
});

/**
 * The guard that makes the table above worth having.
 *
 * Without it the table is a list someone has to remember to extend, which is
 * exactly the kind of list that stops being complete. Elysia already holds the
 * routing table this surface registered, so the set of mutating routes is a
 * fact to be read rather than one to be restated.
 */
test("the mutation table covers every mutating route this surface registers", async () => {
  const { app } = await harness();
  const registered = (app as unknown as { routes: { method: string; path: string }[] }).routes
    .filter((route) => route.method !== "GET")
    .map((route) => `${route.method} ${route.path}`)
    .sort();

  const covered = MUTATIONS.map((mutation) => `${mutation.method} ${mutation.route}`).sort();

  expect(covered).toEqual(registered);
});

/**
 * The companion to the mutation table, and the same argument.
 *
 * The session list above is hand-maintained, so a new unguarded GET simply is
 * not in it — which is how `/api/catalog` shipped with the guard written
 * correctly and nothing that would have noticed if it had not been. Rather than
 * reconcile two lists, this drives every GET the surface actually registers.
 */
test("every GET route this surface registers refuses an anonymous caller", async () => {
  const { app } = await harness();
  const registered = (app as unknown as { routes: { method: string; path: string }[] }).routes
    .filter((route) => route.method === "GET")
    // `/api/status` answers without a session by design: it is what the login
    // screen asks *before* there is one.
    .filter((route) => route.path !== "/api/status")
    .map((route) => route.path);

  expect(registered.length).toBeGreaterThan(5);

  const refused: string[] = [];
  for (const path of registered) {
    // A concrete instance of a parameterised path. The value need not exist —
    // the session check runs before anything looks it up.
    const concrete = path.replace(/:[^/]+/g, "probe");
    const response = await app.handle(new Request(`http://localhost${concrete}`));
    if (response.status !== 401) refused.push(`${concrete} -> ${response.status}`);
  }

  expect(refused).toEqual([]);
});

test("a provider whose colour had to be repaired is said out loud, once", async () => {
  // `providerCatalog` refuses a value that would close the declaration it is
  // written into and serves a neutral instead. Substituting quietly is the
  // other failure — grey is a colour somebody might have chosen — so the route
  // is what turns the substitution into a line an operator can find.
  //
  // Once, not once per request: the catalog is assembled from a registry fixed
  // at boot, so the same repair would otherwise be announced every time a
  // console loads.
  const logger = captureLogger();
  const { call } = await harness({ logger });
  const presentation = entryOf(PROVIDER_DESCRIPTORS, "anthropic", "PROVIDER_DESCRIPTORS")
    .presentation as {
    colour: { light: string; dark: string };
  };
  const original = presentation.colour;
  try {
    presentation.colour = { light: "red; } body { display: none; ", dark: original.dark };
    const first = (await (await call("GET", "/api/catalog")).json()) as {
      providers: Array<{ id: string; colour: { light: string } }>;
    };
    await call("GET", "/api/catalog");

    expect(first.providers.find((p) => p.id === "anthropic")?.colour.light).not.toContain(";");
  } finally {
    presentation.colour = original;
  }

  const repaired = logger.records.filter((line) => line.msg === "provider catalog repaired");
  expect(repaired).toHaveLength(1);
  expect(repaired[0]?.level).toBe("warn");
  expect(repaired[0]?.fields.reason).toContain("anthropic colour.light");
});

/**
 * The wire boundary between this response and the console's mirror of it.
 *
 * Boundary rule 12 forbids the console importing `@omni/providers`, so
 * `apps/dashboard/src/api/types.ts` restates `CatalogProvider` by hand and every
 * console test builds fixtures from that restatement. Two independent
 * declarations with no test between them: `packages/control/test/catalog.test.ts`
 * pins the *server* half against the real descriptors, and the console's fixtures
 * pin the *client* half against the mirror, so renaming or dropping a field
 * leaves both suites green while production sends a shape the console cannot
 * read.
 *
 * What that looks like: drop `colour` and `theme/GlobalStyle.ts` writes
 * `--p-anthropic: undefined` into the stylesheet by string concatenation, in both
 * themes; drop `defaultModel` and the model picker preselects nothing; drop
 * `authTypes` and the credential dialog offers no way in. The shell gate does not
 * help — the response still parses.
 *
 * The key set is written out here rather than derived, which is the point: it is
 * the console's contract restated independently. Same instrument as
 * `packages/store/test/swap.test.ts` reading the forwarder's source, and for the
 * same reason — a behavioural test covers the field it names and says nothing
 * about the next one.
 *
 * **But a restatement pins one side only, and this docstring used to claim both.**
 * "A change to either side has to come through this list" was false for the
 * console: renaming `colour` to `color` in `apps/dashboard/src/api/types.ts` and
 * in its fixtures left the dashboard typechecking, both suites green, and
 * production painting `--p-<id>: undefined` in both themes. The list is a third
 * independent copy pinned to the server, not a bridge between the two.
 *
 * So the response is also assigned to the console's own type below. That is a
 * compile-time check and it runs under `bun run typecheck`, not `bun test` — a
 * drift shows up there rather than here, which is why the runtime list stays as
 * well. The two catch different things: the assignment catches a console-side
 * rename, the list catches a server-side field the console never declared.
 */
test("the catalog response carries exactly the keys the console declares", async () => {
  const { call } = await harness();

  const raw = (await (await call("GET", "/api/catalog")).json()) as {
    providers: Record<string, unknown>[];
  };
  expect(raw.providers.length).toBeGreaterThan(0);

  const body = raw;

  // Optional in the console's type, so present on some providers and not others.
  const OPTIONAL = new Set(["pasteHint", "callback"]);
  const REQUIRED = ["id", "label", "order", "colour", "defaultModel", "authTypes", "models"];

  for (const provider of body.providers) {
    const keys = Object.keys(provider);
    expect(keys.filter((key) => !OPTIONAL.has(key)).sort()).toEqual([...REQUIRED].sort());
    expect(keys.every((key) => REQUIRED.includes(key) || OPTIONAL.has(key))).toBe(true);
  }

  // The model entries too, since the picker and the price display read them and
  // a dropped `pricing` renders as a blank rather than as an error.
  //
  // Across **every** provider, not the first one holding models. Checking one
  // let an unmirrored key on every other provider through — and per-provider
  // divergence is exactly where a plugin-supplied catalog would differ.
  //
  // `oauthLimits` is optional-and-asserted rather than filtered out. Filtering
  // it unconditionally meant the server could stop sending it entirely and this
  // test — whose whole purpose is pinning the wire shape — stayed green.
  const MODEL_REQUIRED = ["id", "label", "pricing", "limits", "auth"];
  const MODEL_OPTIONAL = new Set(["oauthLimits"]);
  let modelsSeen = 0;
  for (const provider of body.providers) {
    for (const model of provider.models as Record<string, unknown>[]) {
      modelsSeen += 1;
      const keys = Object.keys(model);
      expect(keys.filter((key) => !MODEL_OPTIONAL.has(key)).sort()).toEqual(
        [...MODEL_REQUIRED].sort(),
      );
      expect(keys.every((key) => MODEL_REQUIRED.includes(key) || MODEL_OPTIONAL.has(key))).toBe(
        true,
      );
    }
  }
  expect(modelsSeen).toBeGreaterThan(0);

  // And `oauthLimits` really does reach the wire where a model states one, so
  // "optional" above cannot quietly become "never sent".
  const withOauth = body.providers
    .flatMap((provider) => provider.models as Record<string, unknown>[])
    .filter((model) => model.oauthLimits !== undefined);
  expect(withOauth.length).toBeGreaterThan(0);
});

test("a catalog with nothing to repair says nothing", async () => {
  // The other half, and the one that keeps the assertion above honest: a route
  // that logged unconditionally would satisfy it too.
  const logger = captureLogger();
  const { call } = await harness({ logger });
  await call("GET", "/api/catalog");

  expect(logger.records.filter((line) => line.msg === "provider catalog repaired")).toEqual([]);
});

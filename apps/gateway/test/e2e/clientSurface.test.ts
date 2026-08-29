import { expect, test } from "bun:test";
import type { Store } from "@omni/store";
import {
  memoryStore,
  seedApiKey,
  seedCredential as seedCredentialRow,
  target,
  virtualModel,
} from "@omni/testkit";
import { createApp } from "../../src/app.ts";
import { ANTHROPIC_STREAM, createStubUpstream, type StubUpstream } from "./upstream.ts";

const NOW = 1_000_000;

/**
 * The client surface against the app that actually ships.
 *
 * Every other test of this surface mounts `adminRoutes().use(clientRoutes())`
 * and writes its log rows with `store.usage.append(requestLog(...))` — so the
 * `apiKeyId` a row carries is supplied by the fixture, and the id
 * `loginClient` puts in the session is compared against a fixture too. Both
 * halves can agree in unit tests and disagree in the one configuration that
 * ships, and the symptom would be a client dashboard that is permanently
 * empty with no error anywhere.
 *
 * Here the id is written by `beginLog` on the real proxy path and read back
 * through the real route, so nothing in the chain is asserted against itself.
 */
async function harness(): Promise<{
  store: Store;
  upstream: StubUpstream;
  serve: (rawKey: string) => Promise<Response>;
  serveStreaming: (rawKey: string) => Promise<Response>;
  api: (path: string, cookie?: string) => Promise<Response>;
  login: (rawKey: string) => Promise<string>;
  loginAdmin: () => Promise<string>;
}> {
  const store = await memoryStore();
  await store.config.putModel(
    virtualModel({
      id: "fast",
      strategy: "priority",
      targets: [target({ provider: "anthropic", model: "claude-opus-4" })],
    }),
  );
  await seedCredentialRow(store, {
    id: "cred-OPERATOR-ACCOUNT",
    tier: 1,
    expiresAt: NOW + 3_600_000,
    accessToken: "test-token-a",
    refreshToken: "test-token-refresh",
  });

  const upstream = createStubUpstream();
  let n = 0;
  // `createApp`, not a hand-composed subset: the client routes have to survive
  // the real mount order, the quiesce latch and the static catch-all. A route
  // shadowed by the catch-all 404s, and no unit test can see that.
  const app = createApp({
    store,
    baseUrl: "http://localhost:8787",
    now: () => NOW,
    rand: () => 0.5,
    http: upstream.http,
    requestId: () => `req_${++n}`,
  });

  const serve = (rawKey: string) =>
    app.handle(
      new Request("http://localhost/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${rawKey}` },
        body: JSON.stringify({
          model: "fast",
          max_tokens: 100,
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
    );

  const serveStreaming = (rawKey: string) =>
    app.handle(
      new Request("http://localhost/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${rawKey}` },
        body: JSON.stringify({
          model: "fast",
          max_tokens: 100,
          stream: true,
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
    );

  const api = (path: string, cookie?: string) =>
    app.handle(
      new Request(`http://localhost${path}`, {
        headers: {
          "content-type": "application/json",
          ...(cookie === undefined ? {} : { cookie }),
        },
      }),
    );

  const login = async (rawKey: string): Promise<string> => {
    const res = await app.handle(
      new Request("http://localhost/api/client/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: rawKey }),
      }),
    );
    expect(res.status).toBe(200);
    // The cookie as a browser would send it back, taken from the response
    // rather than minted here: this is the exchange under test.
    const setCookie = res.headers.get("set-cookie") ?? "";
    const value = setCookie.split(";")[0] ?? "";
    expect(value).toContain("omni_admin=");
    return value;
  };

  const post = (path: string, body: unknown) =>
    app.handle(
      new Request(`http://localhost${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );

  /** An operator session through the real setup and login routes. */
  const loginAdmin = async (): Promise<string> => {
    const res = await post("/api/setup", { password: "hunter2hunter2" });
    expect(res.status).toBe(200);
    const setCookie = res.headers.get("set-cookie") ?? "";
    return setCookie.split(";")[0] ?? "";
  };

  return { store, upstream, serve, serveStreaming, api, login, loginAdmin };
}

test("a key holder sees the request it served, end to end", async () => {
  const { store, upstream, serve, api, login } = await harness();
  const mine = await seedApiKey(store, { label: "mine" });
  upstream.queue(ANTHROPIC_STREAM);

  expect((await serve(mine.raw)).status).toBe(200);

  const cookie = await login(mine.raw);

  const logs = (await (await api("/api/client/logs", cookie)).json()) as {
    logs: { id: string; requestedModel: string; status: number }[];
  };
  // The row was written by `beginLog` under the id the proxy resolved from the
  // key, and read back under the id the session carries. Nothing in between is
  // a fixture.
  expect(logs.logs).toHaveLength(1);
  expect(logs.logs[0]?.id).toBe("req_1");
  expect(logs.logs[0]?.requestedModel).toBe("fast");
  expect(logs.logs[0]?.status).toBe(200);

  const buckets = (await (await api("/api/client/usage?groupBy=model", cookie)).json()) as {
    key: string;
    requests: number;
  }[];
  expect(buckets).toHaveLength(1);
  expect(buckets[0]?.requests).toBe(1);

  const summary = (await (await api("/api/client/summary", cookie)).json()) as {
    id: string;
    label: string;
  };
  expect(summary.id).toBe(mine.key.id);
  expect(summary.label).toBe("mine");
  store.close();
});

test("two keys on one gateway never see each other's traffic", async () => {
  const { store, upstream, serve, api, login } = await harness();
  const mine = await seedApiKey(store, { label: "mine" });
  const theirs = await seedApiKey(store, { label: "theirs" });

  upstream.queue(ANTHROPIC_STREAM);
  expect((await serve(mine.raw)).status).toBe(200);
  upstream.queue(ANTHROPIC_STREAM);
  upstream.queue(ANTHROPIC_STREAM);
  expect((await serve(theirs.raw)).status).toBe(200);
  expect((await serve(theirs.raw)).status).toBe(200);

  const rowsFor = async (rawKey: string): Promise<string[]> => {
    const cookie = await login(rawKey);
    const body = (await (await api("/api/client/logs", cookie)).json()) as {
      logs: { id: string }[];
    };
    return body.logs.map((row) => row.id);
  };

  // Exact sets. The other key's rows are newer, so an unscoped read returns
  // them first and a count-based assertion would pass on the wrong rows.
  expect(await rowsFor(mine.raw)).toEqual(["req_1"]);
  expect((await rowsFor(theirs.raw)).sort()).toEqual(["req_2", "req_3"]);
  store.close();
});

/**
 * The columns, not just the rows.
 *
 * `credentialId` reached the client for one commit while every row-scoping
 * test was green, because those tests all asked *which rows* and none asked
 * *which fields*. Asserted here on the raw response text, which is what a
 * browser's network tab shows.
 */
test("no operator identity reaches the wire on the client surface", async () => {
  const { store, upstream, serve, api, login } = await harness();
  const mine = await seedApiKey(store, { label: "mine" });
  upstream.queue(ANTHROPIC_STREAM);
  expect((await serve(mine.raw)).status).toBe(200);

  const cookie = await login(mine.raw);

  // The two quota routes are excluded on purpose and are covered by the test
  // below: the operator chose to publish account names there, and a route that
  // is allowed to name accounts is not evidence about the routes that are not.
  for (const path of [
    "/api/client/logs",
    "/api/client/usage?groupBy=model",
    "/api/client/usage?groupBy=provider",
    "/api/client/summary",
  ]) {
    const body = await (await api(path, cookie)).text();
    expect({ path, hasCredential: body.includes("cred-OPERATOR-ACCOUNT") }).toEqual({
      path,
      hasCredential: false,
    });
    expect({ path, hasField: body.includes("credentialId") }).toEqual({ path, hasField: false });
    // The key's own hash is never published either.
    expect({ path, hasHash: body.includes(mine.key.hash) }).toEqual({ path, hasHash: false });
  }
  store.close();
});

/**
 * What the quota routes do disclose, stated as a test rather than left implied.
 *
 * Account labels reach every key holder here by the operator's decision — a
 * screen that collapsed a provider's accounts could not say which one was
 * filling up. The ceilings behind the fractions are still withheld, and that
 * half is the part a future change could quietly lose: `used` and `limit` are
 * one property spread away from the payload.
 */
test("the quota routes name accounts and still withhold their size", async () => {
  const { store, upstream, serve, api, login } = await harness();
  const mine = await seedApiKey(store, { label: "mine" });
  upstream.queue(ANTHROPIC_STREAM);
  expect((await serve(mine.raw)).status).toBe(200);

  // A window the provider reported, since only a probed account has quota.
  await store.credentials.saveQuota([
    {
      credentialId: "cred-OPERATOR-ACCOUNT",
      windowType: "fiveHour",
      startsAt: NOW - 3_600_000,
      used: 250,
      limit: 1_000,
      resetsAt: NOW + 3_600_000,
      observedAt: NOW,
      windowMs: null,
    },
  ]);

  const cookie = await login(mine.raw);
  const body = await (await api("/api/client/quota", cookie)).text();

  // `seedCredential` labels an account after its id, so this is the operator's
  // own name for it reaching a key holder.
  expect(body).toContain("cred-OPERATOR-ACCOUNT");
  expect(body).toContain("usedRatio");
  // The provider's own counters are what stay behind: a fraction says how full
  // an account is, and these would say how large it is.
  expect(body).not.toContain('"used"');
  expect(body).not.toContain('"limit"');
  expect(body).not.toContain('"ratePerHour"');
  expect(body).not.toContain(mine.key.hash);
  store.close();
});

test("the credential dimension is refused rather than answered", async () => {
  const { store, upstream, serve, api, login } = await harness();
  const mine = await seedApiKey(store, { label: "mine" });
  upstream.queue(ANTHROPIC_STREAM);
  await serve(mine.raw);
  const cookie = await login(mine.raw);

  for (const query of ["groupBy=credential", "groupBy=model&splitBy=credential"]) {
    const res = await api(`/api/client/usage?${query}`, cookie);
    expect({ query, status: res.status }).toEqual({ query, status: 400 });
    expect(await res.text()).not.toContain("cred-OPERATOR-ACCOUNT");
  }
  store.close();
});

/**
 * The console's own routes stay shut to this session, through the whole app.
 *
 * The guards are unit-tested, but only `createApp` puts them behind the real
 * mount order — including the plugin groups and the static catch-all, either of
 * which could in principle answer a path before the guarded route does.
 */
test("a client session reaches nothing on the operator's surface", async () => {
  const { store, upstream, serve, api, login } = await harness();
  const mine = await seedApiKey(store, { label: "mine" });
  upstream.queue(ANTHROPIC_STREAM);
  await serve(mine.raw);
  const cookie = await login(mine.raw);

  const refused: string[] = [];
  for (const path of [
    "/api/logs",
    "/api/usage",
    "/api/keys",
    "/api/credentials",
    "/api/credentials/health",
    "/api/models",
    "/api/settings",
    "/api/console",
    "/api/requests/req_1/body",
    "/api/database",
    "/api/database/snapshots",
    "/api/plugins",
  ]) {
    const res = await api(path, cookie);
    if (res.status !== 401) refused.push(`${path} -> ${res.status}`);
  }
  expect(refused).toEqual([]);
  store.close();
});

/**
 * The client routes refuse everyone who is not a client, through the real app.
 *
 * The complement of the test above, and it is not redundant: loosening
 * `requireClient` was invisible to every other test here, because they all call
 * `/api/client/*` holding a valid client cookie. A guard that admits everybody
 * satisfies all of them.
 */
test("the client surface refuses a session that is not a client", async () => {
  const { store, upstream, serve, api, login, loginAdmin } = await harness();
  const mine = await seedApiKey(store, { label: "mine" });
  upstream.queue(ANTHROPIC_STREAM);
  await serve(mine.raw);
  const clientCookie = await login(mine.raw);
  const adminCookie = await loginAdmin();

  const CLIENT_ROUTES = [
    "/api/client/summary",
    "/api/client/usage",
    "/api/client/logs",
    "/api/client/quota",
    "/api/client/quota/history",
  ];

  const wrong: string[] = [];
  for (const path of CLIENT_ROUTES) {
    // No cookie at all.
    const anonymous = await api(path);
    if (anonymous.status !== 401) wrong.push(`${path} anonymous -> ${anonymous.status}`);

    // A syntactically valid cookie carrying a token nobody issued.
    const forged = await api(path, "omni_admin=not-a-real-session-token");
    if (forged.status !== 401) wrong.push(`${path} forged -> ${forged.status}`);

    // The operator's own session, which is authenticated and still not a
    // client. Without this row, loosening `requireClient` to "any valid
    // session" is invisible: every other case here resolves to no principal
    // at all, and a guard that only checks for null still refuses those.
    const operator = await api(path, adminCookie);
    if (operator.status !== 401) wrong.push(`${path} admin -> ${operator.status}`);

    // And the holder is still admitted, so this is not passing by refusing all.
    const ok = await api(path, clientCookie);
    if (ok.status !== 200) wrong.push(`${path} client -> ${ok.status}`);
  }
  expect(wrong).toEqual([]);
  store.close();
});

test("revoking the key ends the live session against the running app", async () => {
  const { store, upstream, serve, api, login } = await harness();
  const mine = await seedApiKey(store, { label: "mine" });
  upstream.queue(ANTHROPIC_STREAM);
  await serve(mine.raw);

  const cookie = await login(mine.raw);
  expect((await api("/api/client/summary", cookie)).status).toBe(200);

  await store.keys.revoke(mine.key.id);

  // No restart and no clock movement: the next request through the same cookie
  // is refused, because `verify` re-reads the key row.
  expect((await api("/api/client/summary", cookie)).status).toBe(401);
  expect((await api("/api/client/logs", cookie)).status).toBe(401);
  store.close();
});

/**
 * The row a client sees while their request is still running.
 *
 * A streaming handler returns at head-send, so the row sits `pending` until the
 * body drains — and `res:logs` emits from `beginLog`, so this is exactly what a
 * client's log list shows mid-request. Every other test here waits for the
 * completed row, and `finishLog` rewrites `api_key_id` on the way out, so a
 * wrong id written by `beginLog` is overwritten before those assertions look.
 *
 * Found by mutation: replacing the id in `beginLog` with a literal, and with
 * null, left this file green until this test existed.
 */
test("an in-flight row is attributed to the key that started it", async () => {
  const { store, upstream, serveStreaming, api, login } = await harness();
  const mine = await seedApiKey(store, { label: "mine" });
  const theirs = await seedApiKey(store, { label: "theirs" });
  upstream.queue(ANTHROPIC_STREAM);

  const res = await serveStreaming(mine.raw);
  expect(res.status).toBe(200);

  // Read before draining the body: the request has not finished, so the row is
  // whatever `beginLog` wrote and nothing has rewritten it.
  const mineCookie = await login(mine.raw);
  const inflight = (await (await api("/api/client/logs", mineCookie)).json()) as {
    logs: { id: string; state: string }[];
  };
  expect(inflight.logs.map((row) => row.id)).toEqual(["req_1"]);
  expect(inflight.logs[0]?.state).toBe("pending");

  // And the other key sees nothing at all, not merely a different row.
  const theirsCookie = await login(theirs.raw);
  const others = (await (await api("/api/client/logs", theirsCookie)).json()) as {
    logs: { id: string }[];
  };
  expect(others.logs).toEqual([]);

  await res.text();
  store.close();
});

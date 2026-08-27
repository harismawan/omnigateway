import { expect, test } from "bun:test";
import { ADMIN_COOKIE, createAdminAuth } from "@omni/control";
import { memoryStore, requestLog, seedApiKey, seedCredential } from "@omni/testkit";
import { adminRoutes } from "../../src/routes/admin.ts";
import { clientRoutes } from "../../src/routes/client.ts";

const NOW = 1_000_000;
const SESSION_TTL_MS = 60_000;

/**
 * Every surface mounted together, and one cookie per principal.
 *
 * Mounted together because that is how they run: a guard that refuses the right
 * principal on its own route but is bypassable through a neighbouring one is
 * the failure this file exists to catch.
 */
async function matrix() {
  const store = await memoryStore();
  const admin = createAdminAuth(store, { now: () => NOW, sessionTtlMs: SESSION_TTL_MS });

  await admin.setPassword("hunter2hunter2");
  await admin.setViewerPassword("read-only-pass-1");
  await seedCredential(store, { id: "c1", accessToken: "test-token-1", refreshToken: null });
  const mine = await seedApiKey(store, { label: "mine" });
  const theirs = await seedApiKey(store, { label: "theirs" });

  await store.usage.append(
    requestLog({ id: "m1", at: NOW - 2_000, apiKeyId: mine.key.id, costUsd: 1 }),
  );
  await store.usage.append(
    requestLog({ id: "t1", at: NOW - 1_000, apiKeyId: theirs.key.id, costUsd: 99 }),
  );

  const deps = { store, admin, sessionTtlMs: SESSION_TTL_MS, now: () => NOW };
  const app = adminRoutes({ ...deps, baseUrl: "http://localhost:9000" }).use(clientRoutes(deps));

  const token = async (kind: "admin" | "viewer" | "client"): Promise<string> => {
    const value =
      kind === "admin"
        ? await admin.login("hunter2hunter2")
        : kind === "viewer"
          ? await admin.loginViewer("read-only-pass-1")
          : await admin.loginClient(mine.raw);
    if (value === null) throw new Error(`could not open a ${kind} session`);
    return value;
  };

  const cookies = {
    admin: `${ADMIN_COOKIE}=${await token("admin")}`,
    viewer: `${ADMIN_COOKIE}=${await token("viewer")}`,
    client: `${ADMIN_COOKIE}=${await token("client")}`,
    none: "",
  };

  const call = async (
    method: string,
    path: string,
    as: keyof typeof cookies,
    body?: unknown,
  ): Promise<Response> =>
    app.handle(
      new Request(`http://localhost${path}`, {
        method,
        headers: {
          "content-type": "application/json",
          ...(cookies[as] === "" ? {} : { cookie: cookies[as] }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );

  return { call, store, mine, theirs };
}

type Who = "admin" | "viewer" | "client" | "none";
const EVERYONE: Who[] = ["admin", "viewer", "client", "none"];

/**
 * Who may reach each route.
 *
 * Written as an allowlist per route, and the test asserts the *complement* too.
 * A table of grants alone would pass for a guard that admits everybody, which
 * is the only failure mode worth writing this file for.
 */
const ROUTES: ReadonlyArray<{
  method: string;
  path: string;
  allow: Who[];
  body?: unknown;
  /**
   * Needs a harness nobody else shares.
   *
   * Only for a route whose success invalidates another principal's session —
   * setting the viewer password drops viewer sessions by design, so running it
   * against the shared harness would make every later viewer row fail for a
   * reason that has nothing to do with its guard.
   */
  isolate?: true;
}> = [
  // Read routes an operator and a read-only administrator share.
  { method: "GET", path: "/api/credentials", allow: ["admin", "viewer"] },
  { method: "GET", path: "/api/models", allow: ["admin", "viewer"] },
  { method: "GET", path: "/api/keys", allow: ["admin", "viewer"] },
  { method: "GET", path: "/api/settings", allow: ["admin", "viewer"] },
  { method: "GET", path: "/api/usage", allow: ["admin", "viewer"] },
  { method: "GET", path: "/api/logs", allow: ["admin", "viewer"] },

  // Metadata is readable by a reader; the payload behind it is not. A viewer
  // may diagnose an installation without being handed every prompt in it.
  { method: "GET", path: "/api/requests/m1/body", allow: ["admin"] },

  // Mutations, and the operator alone.
  { method: "POST", path: "/api/keys", allow: ["admin"], body: { label: "x" } },
  { method: "DELETE", path: "/api/keys/nope", allow: ["admin"] },
  { method: "PUT", path: "/api/models/x", allow: ["admin"], body: {} },
  { method: "DELETE", path: "/api/credentials/c1", allow: ["admin"] },
  {
    method: "PUT",
    path: "/api/settings/viewer-password",
    allow: ["admin"],
    body: { password: null },
    isolate: true,
  },

  // The client's own surface, which the operator is deliberately not on: an
  // admin session is not a client session and has no key to be scoped to.
  { method: "GET", path: "/api/client/summary", allow: ["client"] },
  { method: "GET", path: "/api/client/usage", allow: ["client"] },
  { method: "GET", path: "/api/client/logs", allow: ["client"] },
  { method: "GET", path: "/api/client/quota", allow: ["client"] },
];

test("every route admits exactly the principals it names, and refuses the rest", async () => {
  const refusals: string[] = [];
  const wrongGrants: string[] = [];

  // One harness for the whole table. Each row is checked for admitted-or-not
  // rather than for its result, so an earlier row's write changing a later
  // row's status code (200 to 404, say) does not change what is asserted.
  const shared = await matrix();

  for (const route of ROUTES) {
    for (const who of EVERYONE) {
      const { call } = route.isolate === true ? await matrix() : shared;
      const response = await call(route.method, route.path, who, route.body);
      const label = `${route.method} ${route.path} as ${who}`;

      if (route.allow.includes(who)) {
        // Anything but 401 counts as admitted: a 400 or a 404 means the guard
        // let it through and the handler then had an opinion, which is the
        // question this table is asking.
        if (response.status === 401) refusals.push(`${label} -> 401`);
      } else {
        if (response.status !== 401) wrongGrants.push(`${label} -> ${response.status}`);
      }
    }
  }

  expect({ wrongGrants, refusals }).toEqual({ wrongGrants: [], refusals: [] });
});

test("a client session reads its own rows through the client surface", async () => {
  const { call, mine } = await matrix();

  const summary = (await (await call("GET", "/api/client/summary", "client")).json()) as {
    id: string;
    label: string;
  };
  expect(summary.id).toBe(mine.key.id);
  expect(summary.label).toBe("mine");

  const logs = (await (await call("GET", "/api/client/logs", "client")).json()) as {
    logs: { id: string }[];
  };
  // The other key's row exists and is newer, so an unscoped read would return
  // it first. Asserted as an exact set.
  expect(logs.logs.map((row) => row.id)).toEqual(["m1"]);
});

/**
 * Asserted through the route, not against the projection.
 *
 * `toClientLog` has its own unit test; this one proves the handler actually
 * calls it. A projection nobody applies is a projection that ships nothing, and
 * the two failures look identical from the control package.
 */
test("a client's log rows name no credential, over the wire", async () => {
  const { call, store } = await matrix();
  await store.usage.append(
    requestLog({
      id: "m2",
      at: NOW - 500,
      apiKeyId: (await store.keys.list()).find((k) => k.label === "mine")?.id ?? "",
      credentialId: "cred-secret-account",
      degradations: ["excluded:cred-secret-account:disabled", "anthropic:context-1m-dropped"],
    }),
  );

  const body = await (await call("GET", "/api/client/logs", "client")).text();

  expect(body).not.toContain("cred-secret-account");
  expect(body).not.toContain("credentialId");
  expect(body).not.toContain("excluded:");
  // What the client is owed survives.
  expect(body).toContain("anthropic:context-1m-dropped");
});

test("a client's usage totals over the wire exclude another key's spend", async () => {
  const { call } = await matrix();
  const buckets = (await (
    await call("GET", "/api/client/usage?groupBy=provider", "client")
  ).json()) as { costUsd: number }[];

  const total = buckets.reduce((sum, bucket) => sum + bucket.costUsd, 0);
  // 1, never 100: the other key spent 99 in the same window.
  expect(total).toBeCloseTo(1, 6);
});

test("there is no client route that serves a request body", async () => {
  const { call } = await matrix();
  // Absent rather than refusing. Asserted so that adding one later has to
  // delete this test, which is a conversation rather than an oversight.
  for (const path of [
    "/api/client/requests/m1/body",
    "/api/client/bodies/m1",
    "/api/client/logs/m1/body",
  ]) {
    expect((await call("GET", path, "client")).status).toBe(404);
  }
  // And the operator's body route stays closed to a client session.
  expect((await call("GET", "/api/requests/m1/body", "client")).status).toBe(401);
});

/**
 * The exact requests that leaked, over the wire.
 *
 * Row scoping was correct and every row-scoping test was green while these
 * returned the operator's account ids as bucket keys. Kept as literal query
 * strings rather than as a loop over dimensions, because these four are the
 * reproduction and a future reader should be able to paste one into a browser.
 */
test("a client cannot ask for its usage bucketed by the operator's accounts", async () => {
  const { call, store } = await matrix();
  await seedCredential(store, { id: "cred-OPERATOR-SECRET", accessToken: "t", refreshToken: null });
  await store.usage.append(
    requestLog({
      id: "m3",
      at: NOW - 400,
      apiKeyId: (await store.keys.list()).find((k) => k.label === "mine")?.id ?? "",
      credentialId: "cred-OPERATOR-SECRET",
    }),
  );

  for (const query of [
    "groupBy=credential",
    "groupBy=credential&grain=daily",
    "groupBy=model&splitBy=credential",
    "groupBy=provider&splitBy=credential",
  ]) {
    const response = await call("GET", `/api/client/usage?${query}`, "client");
    const body = await response.text();
    expect({ query, status: response.status }).toEqual({ query, status: 400 });
    expect(body).not.toContain("cred-OPERATOR-SECRET");
  }

  // And the operator, for whom that breakdown exists, still gets it.
  const admin = await call("GET", "/api/usage?groupBy=credential", "admin");
  expect(admin.status).toBe(200);
});

test("a client cannot widen its own scope through a query parameter", async () => {
  const { call, mine, theirs } = await matrix();

  // `groupBy=apiKey` is the one dimension that would enumerate other keys, and
  // it arrives from the URL, where the client controls it.
  const buckets = (await (
    await call("GET", "/api/client/usage?groupBy=apiKey&grain=daily", "client")
  ).json()) as { key: string }[];

  // The exact set, not a bound. `toBeLessThanOrEqual(1)` passes for `[]`, so a
  // route that returned nothing at all would have satisfied it — which is the
  // failure mode a scoping test is least able to distinguish from success.
  expect(buckets.map((b) => b.key)).toEqual([mine.key.id]);
  expect(buckets.map((b) => b.key)).not.toContain(theirs.key.id);
});

test("an expired or revoked client session stops working mid-surface", async () => {
  const { call, store, mine } = await matrix();
  expect((await call("GET", "/api/client/summary", "client")).status).toBe(200);

  await store.keys.revoke(mine.key.id);

  // No restart, no clock movement: the next request through the live cookie is
  // refused, because verify re-reads the key row.
  expect((await call("GET", "/api/client/summary", "client")).status).toBe(401);
  expect((await call("GET", "/api/client/logs", "client")).status).toBe(401);
});

import { expect, test } from "bun:test";
import { memoryStore, requestLog, seedApiKey, seedCredential } from "@omni/testkit";
import { createApp } from "../../src/app.ts";

const NOW = 1_000_000;

/**
 * Every surface mounted together, and one cookie per principal.
 *
 * Mounted together because that is how they run: a guard that refuses the right
 * principal on its own route but is bypassable through a neighbouring one is
 * the failure this file exists to catch.
 */
async function matrix() {
  const store = await memoryStore();
  await seedCredential(store, { id: "c1", accessToken: "test-token-1", refreshToken: null });
  const mine = await seedApiKey(store, { label: "mine" });
  const theirs = await seedApiKey(store, { label: "theirs" });

  await store.usage.append(
    requestLog({ id: "m1", at: NOW - 2_000, apiKeyId: mine.key.id, costUsd: 1 }),
  );
  await store.usage.append(
    requestLog({ id: "t1", at: NOW - 1_000, apiKeyId: theirs.key.id, costUsd: 99 }),
  );

  // `createApp`, so the table is checked against every route group the gateway
  // actually mounts — database, connect and plugins included — rather than the
  // two this file used to compose by hand.
  const app = createApp({ store, baseUrl: "http://localhost:9000", now: () => NOW });
  const routes = (app as unknown as { routes: { method: string; path: string }[] }).routes;

  const send = (method: string, path: string, body?: unknown, cookie?: string) =>
    app.handle(
      new Request(`http://localhost${path}`, {
        method,
        headers: {
          "content-type": "application/json",
          ...(cookie === undefined || cookie === "" ? {} : { cookie }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );

  /**
   * Cookies minted through the app's own routes.
   *
   * `createApp` builds its own `AdminAuth`, and sessions live in memory on that
   * instance — a token issued by a second `createAdminAuth` over the same store
   * is unknown to it, and every request would 401 for a reason that has nothing
   * to do with the guard under test.
   */
  const cookieFrom = async (path: string, body: unknown): Promise<string> => {
    const res = await send("POST", path, body);
    const header = res.headers.get("set-cookie");
    if (header === null) throw new Error(`${path} set no cookie (${res.status})`);
    return header.split(";")[0] ?? "";
  };

  const cookies = {
    admin: await cookieFrom("/api/setup", { password: "hunter2hunter2" }),
    viewer: "",
    client: await cookieFrom("/api/client/login", { key: mine.raw }),
    none: "",
  };
  // The viewer password is set by the operator, so that route runs first.
  await send(
    "PUT",
    "/api/settings/viewer-password",
    { password: "read-only-pass-1" },
    cookies.admin,
  );
  cookies.viewer = await cookieFrom("/api/login", {
    password: "read-only-pass-1",
    mode: "viewer",
  });

  const call = (
    method: string,
    path: string,
    as: keyof typeof cookies,
    body?: unknown,
  ): Promise<Response> => send(method, path, body, cookies[as]);

  return { call, store, mine, theirs, routes };
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
  /**
   * Check the refusals, never the grant.
   *
   * For a route whose handler does something a test must not do — restore a
   * database, restart the process, delete a snapshot. A 401 is decided by the
   * guard before the handler runs, so the refusal rows are safe to drive; the
   * grant row would execute it.
   */
  refusalOnly?: true;
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

  // The remaining reader widenings, which the hand-written table missed.
  { method: "GET", path: "/api/credentials/health", allow: ["admin", "viewer"] },
  { method: "GET", path: "/api/credentials/quota/history", allow: ["admin", "viewer"] },
  { method: "GET", path: "/api/agent-setup", allow: ["admin", "viewer"] },
  // Stdout is a diagnostic, and a viewer is the operator minus mutations and
  // secrets. Argued for in the source; asserted here.
  { method: "GET", path: "/api/console", allow: ["admin", "viewer"] },

  // Operator-only reads. A snapshot carries encrypted credentials and API-key
  // hashes, so it is the sharpest row in the table.
  { method: "GET", path: "/api/database", allow: ["admin"] },
  { method: "GET", path: "/api/database/snapshots", allow: ["admin"] },
  { method: "GET", path: "/api/database/snapshots/nope/download", allow: ["admin"] },
  { method: "GET", path: "/api/lifecycle", allow: ["admin"] },
  { method: "GET", path: "/api/plugins", allow: ["admin"] },

  // Operator-only mutations, refusals only.
  { method: "POST", path: "/api/database/vacuum", allow: ["admin"], refusalOnly: true },
  { method: "POST", path: "/api/database/snapshots", allow: ["admin"], refusalOnly: true },
  { method: "DELETE", path: "/api/database/snapshots/nope", allow: ["admin"], refusalOnly: true },
  {
    method: "POST",
    path: "/api/database/snapshots/nope/restore",
    allow: ["admin"],
    refusalOnly: true,
  },
  { method: "POST", path: "/api/database/import", allow: ["admin"], refusalOnly: true },
  { method: "PUT", path: "/api/database/retention", allow: ["admin"], refusalOnly: true },
  { method: "POST", path: "/api/lifecycle/restart", allow: ["admin"], refusalOnly: true },
  { method: "POST", path: "/api/lifecycle/shutdown", allow: ["admin"], refusalOnly: true },
  { method: "POST", path: "/api/connect/start", allow: ["admin"], refusalOnly: true },
  { method: "POST", path: "/api/connect/finish", allow: ["admin"], refusalOnly: true },
  { method: "POST", path: "/api/connect/poll", allow: ["admin"], refusalOnly: true },
  { method: "PATCH", path: "/api/credentials/c1", allow: ["admin"], body: {} },
  { method: "PUT", path: "/api/settings", allow: ["admin"], body: {} },
  { method: "PUT", path: "/api/keys/nope/limits", allow: ["admin"], body: {} },
  { method: "PUT", path: "/api/keys/nope/models", allow: ["admin"], body: {} },
  { method: "POST", path: "/api/models/x/dry-run", allow: ["admin"] },
  // Found by the completeness check below on its first run, along with
  // `DELETE /api/models/:id` and the ws route — three rows a hand-written table
  // had simply never listed.
  { method: "POST", path: "/api/credentials", allow: ["admin"], body: {} },
  { method: "DELETE", path: "/api/models/x", allow: ["admin"] },
];

/**
 * Routes that answer without a session, and why each one has to.
 *
 * Enumerated rather than pattern-matched: this is the list the completeness
 * check subtracts, so a new unauthenticated route has to be added here by hand
 * and defended in review. A regex over `/api/(status|login|...)` would swallow
 * the next one silently.
 */
const UNAUTHENTICATED = new Set([
  // The one route that answers before a session can exist, and the one that
  // creates the first one.
  "GET /api/status",
  "POST /api/setup",
  // Establish and end a session; they are how a cookie comes to exist.
  "POST /api/login",
  "POST /api/logout",
  "POST /api/client/login",
  "POST /api/client/logout",
  // Guarded inside `beforeHandle` on the ws route rather than by a guard
  // function, and covered by `test/stream/principals.test.ts`. The plain GET
  // exists so a browser hitting it gets 426 instead of the static catch-all.
  "GET /api/stream",
  // The upgrade itself. Elysia registers the ws route under its own method, and
  // it authenticates inside `beforeHandle` rather than through a guard
  // function — driven per principal in `test/stream/principals.test.ts`.
  "WS /api/stream",
]);

/**
 * The guard that makes the table above worth having.
 *
 * Without it the table is a list somebody has to remember to extend, which is
 * exactly the kind of list that stops being complete — it covered 17 of 51
 * routes when this was written, and the four reader widenings it missed
 * included the stdout tail. Elysia already holds the routing table the app
 * registered, so the set of guarded routes is a fact to be read rather than one
 * to be restated.
 */
test("every /api route is either in the table or named as unauthenticated", async () => {
  const { routes } = await matrix();

  const registered = routes
    .filter((route) => route.path.startsWith("/api/"))
    .map((route) => `${route.method} ${route.path}`)
    .sort();

  // Asserted first: zero registered routes is also what a broken accessor
  // reports, and it would make the rest of this test vacuously pass.
  expect(registered.length).toBeGreaterThan(40);

  // The table's paths carry fixtures (`/api/keys/nope`), so they are matched
  // back to the registered patterns by shape rather than by string equality.
  const covered = new Set(
    ROUTES.map((route) => {
      const pattern = registered.find((entry) => {
        const [method, path] = entry.split(" ");
        if (method !== route.method || path === undefined) return false;
        const rx = new RegExp(`^${path.replace(/:[^/]+/g, "[^/]+")}$`);
        return rx.test(route.path);
      });
      return pattern ?? `UNMATCHED ${route.method} ${route.path}`;
    }),
  );

  // A table row matching no registered route is a row testing nothing.
  expect([...covered].filter((entry) => entry.startsWith("UNMATCHED"))).toEqual([]);

  const missing = registered.filter((entry) => !covered.has(entry) && !UNAUTHENTICATED.has(entry));
  expect(missing).toEqual([]);
});

test("every route admits exactly the principals it names, and refuses the rest", async () => {
  const refusals: string[] = [];
  const wrongGrants: string[] = [];

  // One harness for the whole table. Each row is checked for admitted-or-not
  // rather than for its result, so an earlier row's write changing a later
  // row's status code (200 to 404, say) does not change what is asserted.
  const shared = await matrix();

  for (const route of ROUTES) {
    for (const who of EVERYONE) {
      const allowed = route.allow.includes(who);
      // The grant is never driven for a destructive route. A 401 is decided by
      // the guard before the handler runs, so refusals are safe; the grant row
      // would vacuum the database, take a snapshot, or ask systemd to restart.
      if (allowed && route.refusalOnly === true) continue;

      const { call } = route.isolate === true ? await matrix() : shared;
      const response = await call(route.method, route.path, who, route.body);
      const label = `${route.method} ${route.path} as ${who}`;

      if (allowed) {
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

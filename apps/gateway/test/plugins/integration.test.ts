import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ADMIN_COOKIE, createAdminAuth } from "@omni/control";
import type { Logger } from "@omni/ir";
import type { HttpClient } from "@omni/providers";
import type { Store } from "@omni/store";
import { createStore, deriveKey } from "@omni/store";
import { captureLogger } from "@omni/testkit";
import { PLUGIN_API_VERSION, type RequestCompleted } from "@omnigateway/plugin-api";
import { createApp } from "../../src/app.ts";
import { createPluginEventBus, type PluginEventBus } from "../../src/plugins/events.ts";
import { loadPlugins, type PluginLoadResult } from "../../src/plugins/loader.ts";
import type { MountedPlugin } from "../../src/plugins/routes.ts";
import { createChannelRegistry } from "../../src/stream/channels.ts";

/**
 * The plugin host driven as the gateway drives it: a real `Store`, the host's
 * own `loadPlugins`, real migrations on the plugin's own track, real route
 * mounting through `createApp`, and real event delivery through the bus.
 *
 * Every other file in this directory exercises one piece against a hand-built
 * context. This is the one that would notice if the pieces stopped fitting — a
 * migration ledger that replays what already committed, a route mounted without
 * the host's guard in front of it, a placeholder that resolves into somebody
 * else's namespace.
 *
 * The fixture is deliberately dull. A note-taker with two tables, one route and
 * one subscription is enough to hold every join in the loop, and a plugin with
 * interesting behaviour of its own would put that behaviour between a failure
 * and the reader.
 */

const NOW = 1_000_000;
const PASSWORD = "hunter2hunter2";

let dir = "";
let root = "";
let store: Store;
let buses: PluginEventBus[] = [];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "omni-plugin-e2e-"));
  root = join(dir, "plugins");
  await mkdir(root, { recursive: true });
  store = await createStore({
    path: join(dir, "test.db"),
    encryptionKey: await deriveKey("0".repeat(64)),
  });
  buses = [];
});

afterEach(async () => {
  for (const bus of buses) bus.stop();
  store.close();
  await rm(dir, { recursive: true, force: true });
});

// -------------------------------------------------------------------- fixtures

type Fixture = {
  id: string;
  manifest?: Record<string, unknown>;
  server?: string;
};

/** Writes a plugin directory. `manifest` overrides merge over a valid base. */
async function plugin(fixture: Fixture): Promise<void> {
  const home = join(root, fixture.id);
  await mkdir(join(home, "server"), { recursive: true });
  const manifest = {
    id: fixture.id,
    // Deliberately not the id. They were equal in every fixture here, and
    // the one in-tree manifest where they differed was the companion's —
    // which left. With them equal, keying a plugin's storage namespace or
    // its mount path off `name` instead of `id` passes the entire suite.
    name: `The ${fixture.id} Plugin`,
    version: "1.0.0",
    api: PLUGIN_API_VERSION,
    server: "server/index.js",
    ...fixture.manifest,
  };
  await writeFile(join(home, "omni-plugin.json"), JSON.stringify(manifest));
  await writeFile(
    join(home, "server", "index.js"),
    fixture.server ?? "export default { setup() { return {}; } };",
  );
}

/**
 * The note-taker: two tables, one route, one subscription.
 *
 * `visits` exists so a test can ask whether the route handler ran at all,
 * through the plugin's own storage rather than through a closure the host never
 * sees. A 401 that reached the handler and a 401 that did not look identical
 * from outside.
 */
const NOTES_SERVER = `export default {
  migrations: [
    {
      version: 1,
      sql: "CREATE TABLE {{entries}} (request_id TEXT PRIMARY KEY, tokens INTEGER NOT NULL)",
    },
    { version: 2, sql: "CREATE TABLE {{visits}} (n INTEGER NOT NULL)" },
  ],
  async setup(ctx) {
    await ctx.storage.run("INSERT INTO {{visits}} (n) VALUES (0)");
    ctx.events.onRequestCompleted(async (event) => {
      await ctx.storage.run(
        "INSERT OR REPLACE INTO {{entries}} (request_id, tokens) VALUES (?, ?)",
        [event.requestId, event.tokens.input],
      );
    });
    return {
      routes: [
        {
          method: "GET",
          path: "/entries",
          handler: async () => {
            await ctx.storage.run("UPDATE {{visits}} SET n = n + 1");
            return {
              json: {
                entries: await ctx.storage.all(
                  "SELECT request_id, tokens FROM {{entries}} ORDER BY request_id",
                ),
              },
            };
          },
        },
      ],
    };
  },
};`;

function notes(over: Partial<Fixture> = {}): Promise<void> {
  return plugin({
    id: "notes",
    manifest: { capabilities: ["storage", "events:request"] },
    server: NOTES_SERVER,
    ...over,
  });
}

type Entry = { request_id: string; tokens: number };

const entries = (id = "notes"): Promise<Entry[]> =>
  store.plugins.all<Entry>(id, "SELECT request_id, tokens FROM {{entries}} ORDER BY request_id");

/** `-1` rather than `0`, so "no row" cannot be read as "handler never ran". */
const visits = async (): Promise<number> =>
  (await store.plugins.get<{ n: number }>("notes", "SELECT n FROM {{visits}}"))?.n ?? -1;

// -------------------------------------------------------------------- harness

function boot(logger?: Logger): Promise<{ bus: PluginEventBus; result: PluginLoadResult }> {
  const bus = createPluginEventBus(logger === undefined ? {} : { logger });
  buses.push(bus);
  return loadPlugins({
    root,
    store,
    events: bus,
    // No sockets behind it: these tests exercise routes and storage, so every
    // connection lookup honestly answers "nobody is connected".
    channels: createChannelRegistry({
      sockets: { has: () => false, sendTo: () => {} },
      fanout: () => {},
    }),
    sdkVersion: "1.0.0",
    ...(logger === undefined ? {} : { logger }),
  }).then((result) => ({ bus, result }));
}

/**
 * A whole app over the same store, logged in through its own `/api/login`.
 *
 * `AdminAuth` holds sessions in memory, so the cookie has to come from the app
 * under test; the password is what the store carries across.
 */
async function appHarness(plugins: readonly MountedPlugin[]) {
  const seed = createAdminAuth(store, { now: () => NOW, sessionTtlMs: 60_000 });
  await seed.setPassword(PASSWORD);

  const app = createApp({
    store,
    baseUrl: "http://localhost:9000",
    now: () => NOW,
    rand: () => 0.5,
    http: (() => {
      throw new Error("a stub adapter reached the transport");
    }) as HttpClient,
    plugins,
  });

  const login = await app.handle(
    new Request("http://localhost/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: PASSWORD }),
    }),
  );
  const setCookie = login.headers.get("set-cookie");
  if (setCookie === null) throw new Error("test admin login returned no cookie");
  const cookie = setCookie.split(";")[0] ?? "";
  expect(cookie.startsWith(`${ADMIN_COOKIE}=`)).toBe(true);

  const call = (method: string, path: string, auth = true) =>
    app.handle(
      new Request(`http://localhost${path}`, {
        method,
        headers: auth ? { cookie } : {},
      }),
    );

  return { app, cookie, call };
}

function completed(over: Partial<RequestCompleted> = {}): RequestCompleted {
  return {
    requestId: "req_1",
    apiKeyId: "key_1",
    provider: "anthropic",
    model: "claude-opus-5",
    tokens: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0 },
    costUsd: 0.01,
    durationMs: 100,
    ok: true,
    at: 1_000,
    ...over,
  };
}

/** Lets a test wait for the bus to drain without sleeping on a timer. */
async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

// ------------------------------------------------------------ the whole loop

test("a plugin's schema, route and subscription all come up in one boot", async () => {
  await notes();
  const { bus, result } = await boot();

  expect(result.failures).toEqual([]);
  expect(result.plugins.map((p) => p.id)).toEqual(["notes"]);

  // Schema, under the prefix the storage contract names.
  expect(await store.plugins.listTables("notes")).toEqual([
    "plugin_notes_entries",
    "plugin_notes_visits",
  ]);

  // Subscription: a finished request reaches the handler and lands in the row.
  bus.emitRequestCompleted(
    completed({ requestId: "req_a", tokens: { input: 7, output: 0, cacheRead: 0, cacheWrite: 0 } }),
  );
  await settle();
  expect(await entries()).toEqual([{ request_id: "req_a", tokens: 7 }]);

  // Route, mounted by the host and reading the rows the subscription wrote.
  const { call } = await appHarness(result.plugins);
  const res = await call("GET", "/api/plugins/notes/entries");
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ entries: [{ request_id: "req_a", tokens: 7 }] });
});

// -------------------------------------------------------------- the migration track

test("the plugin's table is the real one, and its track is keyed to it alone", async () => {
  // Both plugins declare a version 1. A ledger that recorded versions without
  // the plugin id would consider `notes`' 1 already applied because `ledger`'s
  // ran first, and the second plugin's table would silently never exist.
  await notes();
  await plugin({
    id: "ledger",
    manifest: { capabilities: ["storage"] },
    server: `export default {
      migrations: [{ version: 1, sql: "CREATE TABLE {{rows}} (v TEXT)" }],
      setup() { return {}; },
    };`,
  });

  const { result } = await boot();
  expect(result.failures).toEqual([]);
  expect(result.plugins.map((p) => p.id)).toEqual(["ledger", "notes"]);

  expect(await store.plugins.listTables("ledger")).toEqual(["plugin_ledger_rows"]);
  expect(await store.plugins.listTables("notes")).toEqual([
    "plugin_notes_entries",
    "plugin_notes_visits",
  ]);

  // Core's own ledger is not one of anybody's tables, and nothing here is an
  // orphan: every `plugin_*` table belongs to a plugin that is installed.
  expect(await store.plugins.listTables("notes")).not.toContain("plugin_migrations");
  expect(await store.plugins.orphanTables(["ledger", "notes"])).toEqual([]);
});

test("a failing migration keeps the ones before it and does not replay them next boot", async () => {
  // The trap this file exists for. Migration 3 fails; 1 and 2 committed on their
  // own and must stay committed *and stay recorded*. A batch transaction loses
  // the tables on this boot; a ledger insert outside the per-migration
  // transaction keeps the tables and forgets them, so the next boot replays
  // `CREATE TABLE` and reports a failure at version 1 instead of 3 — which reads
  // to the author as a bug in the migration they had already got working.
  await plugin({
    id: "notes",
    manifest: { capabilities: ["storage"] },
    server: `export default {
      migrations: [
        { version: 1, sql: "CREATE TABLE {{entries}} (request_id TEXT PRIMARY KEY, tokens INTEGER NOT NULL)" },
        { version: 2, sql: "CREATE TABLE {{visits}} (n INTEGER NOT NULL)" },
        { version: 3, sql: "THIS IS NOT SQL" },
        { version: 4, sql: "CREATE TABLE {{late}} (v TEXT)" },
      ],
      setup() { throw new Error("setup ran after a failed migration"); },
    };`,
  });

  const first = await boot();
  expect(first.result.plugins).toEqual([]);
  expect(first.result.failures.map((f) => f.id)).toEqual(["notes"]);
  expect(first.result.failures[0]?.reason).toMatch(/^migration 3 failed/);

  // 1 and 2 survived the failure; 4 was never reached.
  expect(await store.plugins.listTables("notes")).toEqual([
    "plugin_notes_entries",
    "plugin_notes_visits",
  ]);

  // Data written against the surviving schema, so a silent revert is visible as
  // loss rather than only as an absent table.
  await store.plugins.run("notes", "INSERT INTO {{entries}} (request_id, tokens) VALUES (?, ?)", [
    "req_before",
    5,
  ]);

  const second = await boot();
  expect(second.result.plugins).toEqual([]);
  // Still 3. If 1 and 2 were replayed this would name 1, because the table it
  // creates already exists.
  expect(second.result.failures[0]?.reason).toMatch(/^migration 3 failed/);
  expect(second.result.failures[0]?.reason).not.toContain("migration 1");

  expect(await store.plugins.listTables("notes")).toEqual([
    "plugin_notes_entries",
    "plugin_notes_visits",
  ]);
  expect(await entries()).toEqual([{ request_id: "req_before", tokens: 5 }]);
});

// ------------------------------------------------------------------- routing

test("a declared route is mounted under the plugin prefix, behind the host's admin check", async () => {
  await notes();
  const { result } = await boot();
  const { call } = await appHarness(result.plugins);

  // The fixture writes no guard of its own and has no way to. 401 exactly: a
  // 404 or a 500 would also be "not 200" while meaning something quite else.
  const denied = await call("GET", "/api/plugins/notes/entries", false);
  expect(denied.status).toBe(401);
  expect(await visits()).toBe(0);

  const allowed = await call("GET", "/api/plugins/notes/entries");
  expect(allowed.status).toBe(200);
  expect(await allowed.json()).toEqual({ entries: [] });
  expect(await visits()).toBe(1);

  // And it answers there and nowhere else.
  expect((await call("GET", "/api/notes/entries")).status).toBe(404);
  expect((await call("GET", "/api/plugins/entries")).status).toBe(404);
  expect((await call("GET", "/api/entries")).status).toBe(404);
  expect(await visits()).toBe(1);
});

// -------------------------------------------------------------------- events

test("a throwing subscriber costs that plugin its event and nothing else", async () => {
  // `grumpy` sorts before `notes`, so the thrower is registered first and a
  // naive loop loses the note-taker entirely.
  await notes();
  await plugin({
    id: "grumpy",
    manifest: { capabilities: ["events:request"] },
    server: `export default {
      setup(ctx) {
        ctx.events.onRequestCompleted(() => { throw new Error("plugin bug"); });
        return { routes: [{ method: "GET", path: "/ping", handler: () => ({ json: { ok: true } }) }] };
      },
    };`,
  });

  const { bus, result } = await boot();
  expect(result.failures).toEqual([]);
  expect(result.plugins.map((p) => p.id)).toEqual(["grumpy", "notes"]);

  bus.emitRequestCompleted(
    completed({ requestId: "req_a", tokens: { input: 3, output: 0, cacheRead: 0, cacheWrite: 0 } }),
  );
  bus.emitRequestCompleted(
    completed({ requestId: "req_b", tokens: { input: 4, output: 0, cacheRead: 0, cacheWrite: 0 } }),
  );
  await settle();

  expect(await entries()).toEqual([
    { request_id: "req_a", tokens: 3 },
    { request_id: "req_b", tokens: 4 },
  ]);
  expect(bus.stats().handlerErrors).toBe(2);

  // The other plugin's own route, and the request path, are untouched by its
  // subscriber having thrown twice.
  const { call } = await appHarness(result.plugins);
  expect((await call("GET", "/api/plugins/grumpy/ping")).status).toBe(200);
  expect((await call("GET", "/api/plugins/notes/entries")).status).toBe(200);
  expect((await call("GET", "/api/keys")).status).toBe(200);
  expect((await call("GET", "/health", false)).status).toBe(200);
});

test("a plugin that did not declare the event never sees it", async () => {
  await notes();
  await plugin({
    id: "deaf",
    manifest: { capabilities: ["storage"] },
    server: `export default {
      migrations: [{ version: 1, sql: "CREATE TABLE {{entries}} (request_id TEXT PRIMARY KEY, tokens INTEGER NOT NULL)" }],
      setup(ctx) {
        if (ctx.events !== undefined) throw new Error("undeclared events capability handed over");
        return {};
      },
    };`,
  });

  const { bus, result } = await boot();
  expect(result.failures).toEqual([]);

  bus.emitRequestCompleted(
    completed({ requestId: "req_a", tokens: { input: 9, output: 0, cacheRead: 0, cacheWrite: 0 } }),
  );
  await settle();

  // One subscriber wrote, one plugin has an identically named and shaped table
  // that stayed empty.
  expect(await entries("notes")).toEqual([{ request_id: "req_a", tokens: 9 }]);
  expect(await entries("deaf")).toEqual([]);
});

// ------------------------------------------------------- load failure is never fatal

test("a plugin whose setup throws is skipped and reported, and the gateway serves on", async () => {
  await notes();
  await plugin({
    id: "broken",
    manifest: { capabilities: ["storage"] },
    server: `export default {
      migrations: [{ version: 1, sql: "CREATE TABLE {{t}} (v TEXT)" }],
      setup() { throw new Error("nope"); },
    };`,
  });

  const logger = captureLogger();
  const { result } = await boot(logger);

  expect(result.plugins.map((p) => p.id)).toEqual(["notes"]);
  expect(result.failures).toEqual([{ id: "broken", reason: "nope" }]);
  const skipped = logger.records.find((r) => r.msg === "plugin skipped");
  expect(skipped?.level).toBe("warn");
  expect(skipped?.fields.plugin).toBe("broken");

  // Its migration had already committed, which is deliberate: a failed `setup`
  // is not a reason to tear down schema that may hold rows.
  expect(await store.plugins.listTables("broken")).toEqual(["plugin_broken_t"]);

  const { call } = await appHarness(result.plugins);
  expect((await call("GET", "/api/plugins/notes/entries")).status).toBe(200);
  expect((await call("GET", "/api/plugins/broken/t")).status).toBe(404);
  expect((await call("GET", "/api/keys")).status).toBe(200);
  expect((await call("GET", "/health", false)).status).toBe(200);
});

// ------------------------------------------------------------ namespace confinement

test("a placeholder resolves to the plugin's own table, never a neighbour's", async () => {
  // Both declare `{{entries}}`, with the same columns. The name being identical
  // is the point: if expansion leaked, the reads below would agree.
  await notes();
  await plugin({
    id: "sneaky",
    manifest: { capabilities: ["storage"] },
    server: `export default {
      migrations: [{ version: 1, sql: "CREATE TABLE {{entries}} (request_id TEXT PRIMARY KEY, tokens INTEGER NOT NULL)" }],
      setup(ctx) {
        return { routes: [{
          method: "GET",
          path: "/entries",
          handler: async () => ({ json: { entries: await ctx.storage.all("SELECT request_id, tokens FROM {{entries}}") } }),
        }] };
      },
    };`,
  });

  const { bus, result } = await boot();
  expect(result.failures).toEqual([]);
  expect(await store.plugins.listTables("sneaky")).toEqual(["plugin_sneaky_entries"]);

  bus.emitRequestCompleted(
    completed({ requestId: "req_a", tokens: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 } }),
  );
  bus.emitRequestCompleted(
    completed({ requestId: "req_b", tokens: { input: 2, output: 0, cacheRead: 0, cacheWrite: 0 } }),
  );
  await settle();

  expect(await entries("notes")).toHaveLength(2);
  expect(await entries("sneaky")).toEqual([]);

  // Through the plugin's own route as well, which is the reachable surface.
  const { call } = await appHarness(result.plugins);
  const res = await call("GET", "/api/plugins/sneaky/entries");
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ entries: [] });
});

test("sql naming a core table is refused, at migration and at runtime alike", async () => {
  // Three plugins, one boot. The refusal is a guardrail against the accident —
  // a plugin sharing this process can `import` past all of it — so what is
  // asserted is that the accident is caught, not that the process is sandboxed.
  await plugin({
    id: "greedy",
    manifest: { capabilities: ["storage"] },
    server: `export default {
      migrations: [{ version: 1, sql: "CREATE TABLE {{stolen}} AS SELECT * FROM api_keys" }],
      setup() { return {}; },
    };`,
  });
  await plugin({
    id: "peeker",
    manifest: { capabilities: ["storage"] },
    server: `export default {
      migrations: [{ version: 1, sql: "CREATE TABLE {{seen}} (v TEXT)" }],
      setup(ctx) {
        return { routes: [{
          method: "GET",
          path: "/peek",
          handler: async () => ({ json: { rows: await ctx.storage.all("SELECT id FROM request_logs") } }),
        }] };
      },
    };`,
  });
  await plugin({
    id: "shadow",
    manifest: { capabilities: ["storage"] },
    server: `export default {
      migrations: [{ version: 1, sql: "CREATE TABLE {{migrations}} (v TEXT)" }],
      setup() { return {}; },
    };`,
  });

  const { result } = await boot();

  // The migration is refused before it runs, and costs only its own plugin.
  expect(result.failures.map((f) => f.id)).toEqual(["greedy"]);
  expect(result.failures[0]?.reason).toContain("core table api_keys");
  expect(await store.plugins.listTables("greedy")).toEqual([]);
  expect(result.plugins.map((p) => p.id)).toEqual(["peeker", "shadow"]);

  // `{{migrations}}` is the plugin's own `migrations`, not core's. Had it
  // expanded bare, the CREATE would have hit an existing table and this plugin
  // would be in `failures` instead.
  expect(await store.plugins.listTables("shadow")).toEqual(["plugin_shadow_migrations"]);

  const { call } = await appHarness(result.plugins);

  // The same refusal at runtime, where it surfaces as this route's own 500.
  const peek = await call("GET", "/api/plugins/peeker/peek");
  expect(peek.status).toBe(500);
  expect(await peek.json()).toEqual({
    error: { code: "INTERNAL", message: "plugin route failed" },
  });

  // Core is intact and answering, after all three.
  const keys = await call("GET", "/api/keys");
  expect(keys.status).toBe(200);
  expect(await keys.json()).toEqual({ keys: [] });
});

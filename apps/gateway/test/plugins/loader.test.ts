import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Store } from "@omni/store";
import { createStore, deriveKey } from "@omni/store";
import { captureLogger } from "@omni/testkit";
import { PLUGIN_API_VERSION } from "@omnigateway/plugin-api";
import { createPluginEventBus } from "../../src/plugins/events.ts";
import { loadPlugins } from "../../src/plugins/loader.ts";

let dir = "";
let root = "";
let store: Store;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "omni-loader-"));
  root = join(dir, "plugins");
  await mkdir(root, { recursive: true });
  store = await createStore({
    path: join(dir, "test.db"),
    encryptionKey: await deriveKey("0".repeat(64)),
  });
});

afterEach(async () => {
  store.close();
  await rm(dir, { recursive: true, force: true });
});

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

function load() {
  const bus = createPluginEventBus({});
  return loadPlugins({ root, store, events: bus, sdkVersion: "1.0.0" }).finally(() => bus.stop());
}

test("a well-formed plugin loads and reports its routes", async () => {
  await plugin({
    id: "good",
    server: `export default {
      setup(ctx) {
        return { routes: [{ method: "GET", path: "/ping", handler: () => ({ json: { ok: true } }) }] };
      },
    };`,
  });

  const result = await load();
  expect(result.failures).toEqual([]);
  expect(result.plugins).toHaveLength(1);
  expect(result.plugins[0]?.id).toBe("good");
  expect(result.plugins[0]?.routes).toHaveLength(1);
});

test("an absent plugins directory is not an error", async () => {
  // The overwhelming majority of installs have no plugins and never create the
  // directory. Treating that as a failure would put a warning in every boot log
  // for a feature nobody is using.
  await rm(root, { recursive: true, force: true });
  const result = await load();
  expect(result).toEqual({ plugins: [], failures: [] });
});

test("plugins load in a deterministic order regardless of filesystem enumeration", async () => {
  for (const id of ["zebra", "alpha", "mongoose"]) await plugin({ id });
  const result = await load();
  expect(result.plugins.map((p) => p.id)).toEqual(["alpha", "mongoose", "zebra"]);
});

// -------------------------------------------------- every failure is survivable

test("a malformed manifest is skipped and reported, and the rest still load", async () => {
  await plugin({ id: "good" });
  await mkdir(join(root, "broken"), { recursive: true });
  await writeFile(join(root, "broken", "omni-plugin.json"), "{ not json");

  const result = await load();
  expect(result.plugins.map((p) => p.id)).toEqual(["good"]);
  expect(result.failures.map((f) => f.id)).toEqual(["broken"]);
});

test("a manifest id disagreeing with its directory is refused", async () => {
  // The directory name is what the URL, the table prefix and the log field are
  // derived from downstream. Trusting the manifest over the path would let a
  // plugin claim another plugin's namespace by being unpacked next to it.
  await plugin({ id: "claimed", manifest: { id: "somethingelse" } });

  const result = await load();
  expect(result.plugins).toEqual([]);
  expect(result.failures[0]?.reason).toContain("directory");
});

test("an api major mismatch is skipped with a reason naming the version", async () => {
  await plugin({ id: "old", manifest: { api: PLUGIN_API_VERSION + 1 } });
  const result = await load();
  expect(result.plugins).toEqual([]);
  expect(result.failures[0]?.reason).toMatch(/api/i);
});

test("a server entry that throws on import is skipped, and the rest still load", async () => {
  await plugin({ id: "good" });
  await plugin({ id: "explodes", server: "throw new Error('boom');" });

  const result = await load();
  expect(result.plugins.map((p) => p.id)).toEqual(["good"]);
  expect(result.failures.map((f) => f.id)).toEqual(["explodes"]);
});

test("a server entry that throws inside setup is skipped, and the rest still load", async () => {
  await plugin({ id: "good" });
  await plugin({
    id: "badsetup",
    server: "export default { setup() { throw new Error('nope'); } };",
  });

  const result = await load();
  expect(result.plugins.map((p) => p.id)).toEqual(["good"]);
  expect(result.failures.map((f) => f.id)).toEqual(["badsetup"]);
});

test("a server entry with no usable default export is skipped", async () => {
  await plugin({ id: "empty", server: "export const notDefault = 1;" });
  const result = await load();
  expect(result.plugins).toEqual([]);
  expect(result.failures).toHaveLength(1);
});

test("a failing migration skips the plugin but leaves earlier ones applied", async () => {
  await plugin({
    id: "migrator",
    manifest: { capabilities: ["storage"] },
    server: `export default {
      migrations: [
        { version: 1, sql: "CREATE TABLE {{good}} (id TEXT PRIMARY KEY)" },
        { version: 2, sql: "THIS IS NOT SQL" },
      ],
      setup() { return {}; },
    };`,
  });

  const result = await load();
  expect(result.plugins).toEqual([]);
  expect(result.failures[0]?.id).toBe("migrator");
  // The first migration committed on its own, so it must still be recorded —
  // otherwise every boot replays it and a plugin author debugging migration 2
  // silently loses the table migration 1 made.
  expect(store.plugins.listTables("migrator")).toContain("plugin_migrator_good");
});

// -------------------------------------------------- capabilities

test("a plugin receives exactly the capabilities it declared, and no others", async () => {
  await plugin({
    id: "narrow",
    manifest: { capabilities: ["storage"] },
    server: `export default {
      setup(ctx) {
        return { routes: [{
          method: "GET", path: "/caps",
          handler: () => ({ json: {
            storage: ctx.storage !== undefined,
            files: ctx.files !== undefined,
            net: ctx.net !== undefined,
            events: ctx.events !== undefined,
          } }),
        }] };
      },
    };`,
  });

  const result = await load();
  const handler = result.plugins[0]?.routes[0]?.handler;
  expect(handler).toBeDefined();
  if (handler === undefined) return;
  const response = await handler({ params: {}, query: {}, body: null });
  expect(response.json).toEqual({ storage: true, files: false, net: false, events: false });
});

test("declaring one event capability does not hand over the other", async () => {
  await plugin({
    id: "onelimit",
    manifest: { capabilities: ["events:limit"] },
    server: `export default {
      setup(ctx) {
        return { routes: [{
          method: "GET", path: "/e",
          handler: () => ({ json: {
            request: ctx.events?.onRequestCompleted !== undefined,
            limit: ctx.events?.onLimitReached !== undefined,
          } }),
        }] };
      },
    };`,
  });

  const result = await load();
  const handler = result.plugins[0]?.routes[0]?.handler;
  expect(handler).toBeDefined();
  if (handler === undefined) return;
  const response = await handler({ params: {}, query: {}, body: null });
  expect(response.json).toEqual({ request: false, limit: true });
});

test("a plugin's storage is namespaced to it without the plugin naming a prefix", async () => {
  await plugin({
    id: "store-user",
    manifest: { capabilities: ["storage"] },
    server: `export default {
      migrations: [{ version: 1, sql: "CREATE TABLE {{notes}} (body TEXT)" }],
      setup(ctx) {
        ctx.storage.run("INSERT INTO {{notes}} (body) VALUES (?)", ["hi"]);
        return {};
      },
    };`,
  });

  const result = await load();
  expect(result.failures).toEqual([]);
  expect(store.plugins.listTables("store-user")).toEqual(["plugin_store-user_notes"]);
});

// -------------------------------------------------- ui compatibility

test("an sdk range the host does not satisfy disables the ui but keeps the server half", async () => {
  // Splitting the two is the point: a backend-only capability should not go dark
  // because the dashboard's React moved, and the operator should get a disabled
  // nav entry with a reason rather than a white screen.
  await plugin({
    id: "future-ui",
    manifest: { ui: "ui/index.js", sdk: "^9.0.0", nav: { label: "Future" } },
  });

  const result = await load();
  expect(result.failures).toEqual([]);
  expect(result.plugins[0]?.ui?.compatible).toBe(false);
  expect(result.plugins[0]?.ui?.reason).toContain("9");
});

test("a satisfied sdk range reports a mountable ui", async () => {
  await plugin({
    id: "ok-ui",
    manifest: { ui: "ui/index.js", sdk: "^1.0.0", nav: { label: "Fine" } },
  });

  const result = await load();
  expect(result.plugins[0]?.ui?.compatible).toBe(true);
});

test("a ui entry outside the ui/ directory is refused rather than served from the home", async () => {
  // Only ui/ is ever published, and bundles are unauthenticated. Accepting an
  // entry elsewhere would either advertise a URL that cannot resolve, or invite
  // widening the served root to the plugin home — which publishes server/ and
  // the manifest to anyone who asks.
  await plugin({ id: "sneaky", manifest: { ui: "server/index.js", sdk: "^1.0.0" } });

  const result = await load();
  expect(result.plugins).toEqual([]);
  expect(result.failures[0]?.reason).toContain("ui/");
});

// -------------------------------------------------- the plugin logger

/**
 * The one path from third-party code to stdout, and until now the one function
 * in this feature with no tests at all.
 *
 * `LogFields` is a closed allowlist and a redaction boundary — it is what makes
 * "a prompt never reaches stdout" a compiler guarantee rather than a review
 * habit. A plugin holds a logger that can reach exactly one free-text field,
 * capped and filtered. These assert that cap and that filter, because a comment
 * saying so is not a guarantee.
 */
async function logFrom(body: string): Promise<ReturnType<typeof captureLogger>> {
  await plugin({ id: "talker", server: body });
  const logger = captureLogger();
  const bus = createPluginEventBus({});
  await loadPlugins({ root, store, events: bus, sdkVersion: "1.0.0", logger }).finally(() =>
    bus.stop(),
  );
  return logger;
}

test("a plugin's log line is stamped with the id the host validated", async () => {
  const logger = await logFrom(
    `export default { setup(ctx) { ctx.logger.info("hello"); return {}; } };`,
  );
  const line = logger.records.find((r) => r.msg === "hello");
  expect(line?.fields.plugin).toBe("talker");
});

test("a plugin cannot forge the plugin field or pass fields of its own", async () => {
  // The id is bound by the host. A plugin passing `plugin` gets ignored, and
  // anything outside the three permitted keys never reaches a field at all.
  const logger = await logFrom(
    `export default { setup(ctx) {
       ctx.logger.info("hello", { plugin: "someone-else", requestId: "req_1", reason: "raw" });
       return {};
     } };`,
  );
  const line = logger.records.find((r) => r.msg === "hello");
  expect(line?.fields.plugin).toBe("talker");
  expect(line?.fields.requestId).toBeUndefined();
  // `reason` is reachable only through `event`, never by passing it directly.
  expect(line?.fields.reason).toBeUndefined();
});

test("a plugin's event label lands in reason, sanitised", async () => {
  const logger = await logFrom(
    `export default { setup(ctx) { ctx.logger.info("hi", { event: "egg.hatched:shiny-1" }); return {}; } };`,
  );
  expect(logger.records.find((r) => r.msg === "hi")?.fields.reason).toBe("egg.hatched:shiny-1");
});

test("an event label cannot smuggle prose, whitespace or punctuation into a log line", async () => {
  // The filter is the point. Anything a prompt or a token is made of — spaces,
  // slashes, quotes, newlines, equals signs — is stripped rather than quoted.
  const logger = await logFrom(
    `export default { setup(ctx) {
       ctx.logger.info("hi", { event: "user said: hello world / \\"quoted\\"\\nsecret=sk-abc" });
       return {};
     } };`,
  );
  const reason = logger.records.find((r) => r.msg === "hi")?.fields.reason;
  expect(reason).toBe("usersaid:helloworldquotedsecretsk-abc");
});

test("an event label is capped, so a body cannot ride along inside one", async () => {
  const logger = await logFrom(
    `export default { setup(ctx) { ctx.logger.info("hi", { event: "a".repeat(500) }); return {}; } };`,
  );
  expect(logger.records.find((r) => r.msg === "hi")?.fields.reason).toBe("a".repeat(64));
});

test("count and durationMs pass through, and nothing else does", async () => {
  const logger = await logFrom(
    `export default { setup(ctx) { ctx.logger.warn("m", { count: 3, durationMs: 12 }); return {}; } };`,
  );
  const line = logger.records.find((r) => r.msg === "m");
  expect(line?.fields).toEqual({ plugin: "talker", count: 3, durationMs: 12 });
});

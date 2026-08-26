import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore, deriveKey } from "@omni/store";
import { PLUGIN_API_VERSION, type PluginManifest, parseManifest } from "@omnigateway/plugin-api";
import { createPluginEventBus } from "../../src/plugins/events.ts";
import type { LoadedPlugin } from "../../src/plugins/loader.ts";
import { loadPlugins } from "../../src/plugins/loader.ts";
import { PLUGIN_ASSET_PREFIX, pluginCatalog, pluginUiRoutes } from "../../src/plugins/ui.ts";
import { createChannelRegistry } from "../../src/stream/channels.ts";

let dir = "";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "omni-plugin-ui-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function manifest(over: Record<string, unknown> = {}): PluginManifest {
  return parseManifest({
    id: "pokemon",
    name: "Pokémon Companion",
    version: "1.0.0",
    api: PLUGIN_API_VERSION,
    ui: "index.js",
    sdk: "^1.0.0",
    nav: { label: "Companion" },
    ...over,
  });
}

/** A plugin whose ui/ directory exists on disk, with one asset in it. */
async function withUi(opts: { compatible?: boolean; body?: string } = {}): Promise<LoadedPlugin> {
  const home = join(dir, "pokemon");
  await mkdir(join(home, "ui"), { recursive: true });
  await writeFile(join(home, "ui", "index.js"), opts.body ?? "export default {};");
  return {
    id: "pokemon",
    manifest: manifest(),
    routes: [],
    migrations: [],
    ui: { dir: home, entry: "index.js", compatible: opts.compatible ?? true },
  };
}

/** Admin auth that accepts nothing, so the gate is observable without a session. */
const denyAdmin = {
  async requireSession() {
    throw new Error("no session");
  },
} as unknown as Parameters<typeof pluginUiRoutes>[0]["admin"];

// ---------------------------------------------------------------- catalog

test("an incompatible ui is listed with its reason and NO entry url", () => {
  // The console must not receive a URL it could import by accident: the failure
  // would then arrive as a render crash instead of the disabled nav entry with a
  // reason, which is the whole point of splitting sdk from api.
  const entries = pluginCatalog([
    {
      id: "pokemon",
      manifest: manifest(),
      routes: [],
      migrations: [],
      ui: { dir: dir, entry: "index.js", compatible: false, reason: "requires sdk ^9.0.0" },
    },
  ]);

  expect(entries[0]?.ui).toEqual({
    entry: null,
    compatible: false,
    reason: "requires sdk ^9.0.0",
  });
});

test("a compatible ui gets a url under the asset prefix", () => {
  const entries = pluginCatalog([
    {
      id: "pokemon",
      manifest: manifest(),
      routes: [],
      migrations: [],
      ui: { dir: dir, entry: "index.js", compatible: true },
    },
  ]);
  expect(entries[0]?.ui?.entry).toBe(`${PLUGIN_ASSET_PREFIX}/pokemon/index.js?v=1.0.0`);
});

/** The catalog entry for one plugin at one version. */
function entryAt(version: string): string | null | undefined {
  return pluginCatalog([
    {
      id: "pokemon",
      manifest: manifest({ version }),
      routes: [],
      migrations: [],
      ui: { dir: dir, entry: "index.js", compatible: true },
    },
  ])[0]?.ui?.entry;
}

test("a reinstalled bundle gets a url the browser has not already resolved", () => {
  // The bug this closes was reported as "the console shows the new version but
  // the panel still behaves like the old one", and every layer below the
  // browser was correct: npm, disk, the restarted process, and the bytes on the
  // wire all carried the new build.
  //
  // The URL did not. It was the same string at every version, and two things
  // key off it — `PluginBoard`'s `useMemo` over the entry, and the browser's
  // own ES module map, which is keyed by URL for the lifetime of a document. So
  // a console tab open across a reinstall kept the old module while
  // `/api/plugins` reported the new version beside it. `cache-control:
  // no-cache` could not help: nothing was an HTTP cache hit, the module was
  // simply already resolved.
  expect(entryAt("1.0.0")).not.toBe(entryAt("1.0.1"));
});

test("a backend-only plugin is listed with no ui at all", () => {
  const entries = pluginCatalog([
    {
      id: "quiet",
      manifest: manifest({ id: "quiet", ui: undefined, sdk: undefined, server: "server/index.js" }),
      routes: [],
      migrations: [],
    },
  ]);
  expect(entries[0]?.ui).toBeNull();
  expect(entries[0]?.id).toBe("quiet");
});

// ---------------------------------------------------------------- catalog route

test("the catalog is admin-gated, and refuses the way every other /api route does", async () => {
  // Asserted as 401-with-an-envelope rather than "not 200". The weaker form is
  // what let this ship answering 500 with a plain-text body: the route was
  // genuinely gated, and the refusal was unmapped because no error handler was
  // attached. A console cannot tell "log in again" from "the gateway is broken"
  // from a 500, and neither can an operator reading a log.
  const app = pluginUiRoutes({ admin: denyAdmin, plugins: [] });
  const response = await app.handle(new Request("http://localhost/api/plugins"));

  expect(response.status).toBe(401);
  expect(response.headers.get("content-type")).toContain("application/json");
  expect(await response.json()).toMatchObject({ error: { code: "AUTH" } });
});

// ---------------------------------------------------------------- assets

test("a plugin's bundle is served without a session, like the console's own script", async () => {
  // Deliberate. The console's own JavaScript is unauthenticated too — what is
  // gated is the data behind /api, not the code that asks for it. Gating this
  // would also make an `import` depend on cookie behaviour, where a redirect
  // arrives as a syntax error rather than a 401.
  const plugin = await withUi({ body: "export const x = 1;" });
  const app = pluginUiRoutes({ admin: denyAdmin, plugins: [plugin] });

  const response = await app.handle(
    new Request(`http://localhost${PLUGIN_ASSET_PREFIX}/pokemon/index.js`),
  );

  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/javascript");
  expect(await response.text()).toBe("export const x = 1;");
});

test("a bundle is not cached immutably, because install replaces it in place", async () => {
  const plugin = await withUi();
  const app = pluginUiRoutes({ admin: denyAdmin, plugins: [plugin] });
  const response = await app.handle(
    new Request(`http://localhost${PLUGIN_ASSET_PREFIX}/pokemon/index.js`),
  );
  expect(response.headers.get("cache-control")).toBe("no-cache");
});

test("a versioned bundle url still serves, because the query is not part of the path", async () => {
  // The whole fix is worthless if the cache-buster reaches `resolve()` as part
  // of the filename: every bundle would 404 and every plugin panel would go
  // dark. The catalog's own URL is used rather than a hand-built one, so this
  // fails if the two ever disagree.
  const plugin = await withUi();
  const entry = pluginCatalog([plugin])[0]?.ui?.entry;
  expect(entry).toContain("?v=");
  if (entry === undefined || entry === null) return;

  const app = pluginUiRoutes({ admin: denyAdmin, plugins: [plugin] });
  const response = await app.handle(new Request(`http://localhost${entry}`));

  expect(response.status).toBe(200);
  expect(await response.text()).toContain("export default");
});

test("an incompatible plugin serves nothing at all", async () => {
  // Its catalog entry already has no URL; refusing here too means a hand-typed
  // URL cannot mount a bundle the host judged incompatible.
  const plugin = await withUi({ compatible: false });
  const app = pluginUiRoutes({ admin: denyAdmin, plugins: [plugin] });
  const response = await app.handle(
    new Request(`http://localhost${PLUGIN_ASSET_PREFIX}/pokemon/index.js`),
  );
  expect(response.status).toBe(404);
});

test("an unknown plugin id serves nothing", async () => {
  const app = pluginUiRoutes({ admin: denyAdmin, plugins: [] });
  const response = await app.handle(
    new Request(`http://localhost${PLUGIN_ASSET_PREFIX}/ghost/index.js`),
  );
  expect(response.status).toBe(404);
});

test("an encoded traversal reaches the handler and is refused by it", async () => {
  // The distinction this test exists to make: a LITERAL `../` never gets here at
  // all, because `URL` normalises it away and the route stops matching — so a
  // 404 for that input proves nothing about this code. Only the percent-encoded
  // forms survive normalisation and actually reach the guard, which is why they
  // are the only ones asserted here.
  //
  // An earlier version of this test asserted the literal form too, passed, and
  // went on passing with the traversal check deleted.
  const plugin = await withUi();
  await writeFile(join(dir, "secret.txt"), "credentials");
  const app = pluginUiRoutes({ admin: denyAdmin, plugins: [plugin] });

  for (const path of [
    `${PLUGIN_ASSET_PREFIX}/pokemon/..%2fsecret.txt`,
    `${PLUGIN_ASSET_PREFIX}/pokemon/%2e%2e%2fsecret.txt`,
    `${PLUGIN_ASSET_PREFIX}/pokemon/sub%2f..%2f..%2fsecret.txt`,
  ]) {
    const response = await app.handle(new Request(`http://localhost${path}`));
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("credentials");
  }
});

test("an asset whose name needs escaping is served, which is what decoding is for", async () => {
  // Decoding the wildcard is a correctness requirement before it is a security
  // one, and this is the assertion that pins it: leave the value encoded and
  // this file can never be found, however it is requested.
  const plugin = await withUi();
  await writeFile(join(dir, "pokemon", "ui", "sprite 25.png"), "PNG");
  const app = pluginUiRoutes({ admin: denyAdmin, plugins: [plugin] });

  const response = await app.handle(
    new Request(`http://localhost${PLUGIN_ASSET_PREFIX}/pokemon/sprite%2025.png`),
  );
  expect(response.status).toBe(200);
  expect(await response.text()).toBe("PNG");
});

test("a malformed percent escape is refused rather than guessed at", async () => {
  const plugin = await withUi();
  const app = pluginUiRoutes({ admin: denyAdmin, plugins: [plugin] });
  const response = await app.handle(
    new Request(`http://localhost${PLUGIN_ASSET_PREFIX}/pokemon/%zz.js`),
  );
  expect(response.status).toBe(404);
});

test("a symlink escaping the ui directory is refused", async () => {
  // The lexical check cannot see this one: the path contains no `..` at all.
  const plugin = await withUi();
  await writeFile(join(dir, "outside.txt"), "credentials");
  await symlink(join(dir, "outside.txt"), join(dir, "pokemon", "ui", "link.js"));
  const app = pluginUiRoutes({ admin: denyAdmin, plugins: [plugin] });

  const response = await app.handle(
    new Request(`http://localhost${PLUGIN_ASSET_PREFIX}/pokemon/link.js`),
  );
  expect(response.status).toBe(404);
});

test("one plugin cannot reach another's bundle", async () => {
  const pokemon = await withUi();
  const other = join(dir, "other", "ui");
  await mkdir(other, { recursive: true });
  await writeFile(join(other, "private.js"), "secret bundle");
  const app = pluginUiRoutes({ admin: denyAdmin, plugins: [pokemon] });

  const response = await app.handle(
    new Request(`http://localhost${PLUGIN_ASSET_PREFIX}/pokemon/..%2f..%2fother%2fui%2fprivate.js`),
  );
  expect(response.status).toBe(404);
});

// ------------------------------------------------- loader → catalog → assets

/**
 * The seam three test files each touch and none of them crossed.
 *
 * `ui.test.ts` hand-built a `LoadedPlugin` with an `entry` the loader never
 * produces; `loader.test.ts` used a real manifest but only asserted
 * `compatible`; the console's tests stub the module loader and fetch no URL at
 * all. So the catalog could publish a URL the asset route could not serve — and
 * it did, for every manifest shaped the way the spec, the manifest example and
 * `docs/writing-a-plugin.md` all prescribe.
 *
 * This test runs the real loader, the real catalog and the real asset route
 * against a spec-shaped plugin, because the bug lived precisely in the gap
 * between them.
 */
test("a spec-shaped plugin's advertised ui url actually serves", async () => {
  const home = join(dir, "pokemon");
  await mkdir(join(home, "server"), { recursive: true });
  await mkdir(join(home, "ui"), { recursive: true });
  await writeFile(
    join(home, "omni-plugin.json"),
    JSON.stringify({
      id: "pokemon",
      name: "Pokémon Companion",
      version: "1.0.0",
      api: PLUGIN_API_VERSION,
      server: "server/index.js",
      // Exactly what the spec and the docs prescribe.
      ui: "ui/index.js",
      sdk: "^1.0.0",
      nav: { label: "Companion" },
    }),
  );
  await writeFile(join(home, "server", "index.js"), "export default { setup() { return {}; } };");
  await writeFile(join(home, "ui", "index.js"), "export default { mount: () => null };");

  const store = await createStore({
    path: join(dir, "t.db"),
    encryptionKey: await deriveKey("0".repeat(64)),
  });
  const bus = createPluginEventBus({});
  try {
    const loaded = await loadPlugins({
      root: dir,
      store,
      events: bus,
      channels: createChannelRegistry({ sockets: { topics: () => [], sendTo: () => {} } }),
      sdkVersion: "1.0.0",
    });
    expect(loaded.failures).toEqual([]);

    const entry = pluginCatalog(loaded.plugins)[0]?.ui?.entry;
    expect(entry).toBeDefined();
    if (entry === undefined || entry === null) return;

    const app = pluginUiRoutes({ admin: denyAdmin, plugins: loaded.plugins });
    const response = await app.handle(new Request(`http://localhost${entry}`));

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("mount");
  } finally {
    bus.stop();
    store.close();
  }
});

test("the server entry and the manifest are never reachable as assets", async () => {
  // The other way to fix the url mismatch is to serve from the plugin home,
  // which would publish server/ and omni-plugin.json unauthenticated. This
  // pins that it was not the fix chosen.
  const home = join(dir, "pokemon");
  await mkdir(join(home, "server"), { recursive: true });
  await mkdir(join(home, "ui"), { recursive: true });
  await writeFile(join(home, "omni-plugin.json"), "{}");
  await writeFile(join(home, "server", "index.js"), "SECRET SERVER CODE");
  await writeFile(join(home, "ui", "index.js"), "ui");

  const plugin: LoadedPlugin = {
    id: "pokemon",
    manifest: manifest(),
    routes: [],
    migrations: [],
    ui: { dir: home, entry: "index.js", compatible: true },
  };
  const app = pluginUiRoutes({ admin: denyAdmin, plugins: [plugin] });

  for (const path of ["..%2fserver%2findex.js", "..%2fomni-plugin.json"]) {
    const response = await app.handle(
      new Request(`http://localhost${PLUGIN_ASSET_PREFIX}/pokemon/${path}`),
    );
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("SECRET SERVER CODE");
  }
});

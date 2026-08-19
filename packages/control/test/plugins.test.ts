import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GatewayError } from "@omni/ir";
import { nodePluginFs } from "../src/nodeFs.ts";
import {
  installPlugin,
  listPlugins,
  orphanPluginTables,
  type PluginDeps,
  type PluginStore,
  removePlugin,
  verifyPlugin,
} from "../src/plugins.ts";

/**
 * Real temporary directories rather than the in-memory filesystem the rest of
 * this package's tests use.
 *
 * The deliberate exception, and the reason is what these tests are for. Install
 * is a sequence of renames and removals whose whole value is what is on disk
 * after a failure — a fake filesystem would agree with a buggy implementation
 * about that, because both would be written from the same assumption. And the
 * promise that no code from the package runs is only observable against a real
 * one: a fake fs cannot execute a `postinstall`, so a test over it would pass
 * whether or not the installer tried.
 *
 * Everything is inside `mkdtemp`, nothing is spawned, and nothing resolves a
 * name.
 */
const roots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "omni-plugins-"));
  roots.push(root);
  return root;
}

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const deps: PluginDeps = { fs: nodePluginFs() };

/** The manifest every test starts from and then breaks in exactly one way. */
const MANIFEST = {
  id: "poke-dex",
  name: "Poke Dex",
  version: "1.4.2",
  api: 1,
  server: "server.js",
} as const;

type Files = Record<string, string>;

/** Writes a plugin straight into `<root>/plugins/<dir>`, bypassing `install`. */
function place(root: string, dir: string, manifest: unknown, files: Files = {}): string {
  const home = join(root, "plugins", dir);
  mkdirSync(home, { recursive: true });
  if (manifest !== undefined) {
    writeFileSync(
      join(home, "omni-plugin.json"),
      typeof manifest === "string" ? manifest : JSON.stringify(manifest),
    );
  }
  for (const [name, contents] of Object.entries({ "server.js": "export default {};", ...files })) {
    const path = join(home, name);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, contents);
  }
  return home;
}

/** A source tree for `install`, outside the installation root. */
function source(dir: string, manifest: unknown, files: Files = {}): string {
  const base = mkdtempSync(join(tmpdir(), "omni-plugin-src-"));
  roots.push(base);
  const home = join(base, dir);
  mkdirSync(home, { recursive: true });
  writeFileSync(
    join(home, "omni-plugin.json"),
    typeof manifest === "string" ? manifest : JSON.stringify(manifest),
  );
  for (const [name, contents] of Object.entries({ "server.js": "export default {};", ...files })) {
    const path = join(home, name);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, contents);
  }
  return home;
}

function fakeStore(tables: Record<string, string[]>): PluginStore & { dropped: string[] } {
  const dropped: string[] = [];
  return {
    dropped,
    plugins: {
      listTables: (id) => [...(tables[id] ?? [])],
      dropAll: (id) => {
        dropped.push(id);
        const count = (tables[id] ?? []).length;
        delete tables[id];
        return count;
      },
      orphanTables: (installed) =>
        Object.keys(tables)
          .filter((id) => !installed.includes(id))
          .flatMap((id) => tables[id] ?? [])
          .sort(),
    },
  };
}

/* --------------------------------------------------------------- tar fixtures */

const encoder = new TextEncoder();

/**
 * One ustar entry, header and padded body.
 *
 * Hand-built rather than shelled out to `tar`, so the fixture is the same on
 * every machine and no test spawns anything. The checksum is computed even
 * though the reader ignores it: a fixture that is not a real tar would let a
 * reader bug hide behind a fixture bug.
 */
function tarEntry(path: string, body: string, type = "0"): Uint8Array {
  const header = new Uint8Array(512);
  const put = (text: string, offset: number, length: number) => {
    header.set(encoder.encode(text).subarray(0, length), offset);
  };
  put(path, 0, 100);
  put("0000644\0", 100, 8);
  put("0000000\0", 108, 8);
  put("0000000\0", 116, 8);
  const bytes = encoder.encode(body);
  put(`${bytes.length.toString(8).padStart(11, "0")}\0`, 124, 12);
  put("00000000000\0", 136, 12);
  header[156] = type.charCodeAt(0);
  put("ustar\0", 257, 6);
  put("00", 263, 2);
  put("        ", 148, 8);
  let sum = 0;
  for (const byte of header) sum += byte;
  put(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8);

  const padded = new Uint8Array(512 + Math.ceil(bytes.length / 512) * 512);
  padded.set(header, 0);
  padded.set(bytes, 512);
  return padded;
}

function makeTarball(entries: Array<[string, string, string?]>): Uint8Array {
  const blocks = entries.map(([path, body, type]) => tarEntry(path, body, type ?? "0"));
  // Two zero blocks close an archive.
  const total = blocks.reduce((sum, block) => sum + block.length, 0) + 1024;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const block of blocks) {
    out.set(block, offset);
    offset += block.length;
  }
  return out;
}

function writeTarball(name: string, entries: Array<[string, string, string?]>): string {
  const base = mkdtempSync(join(tmpdir(), "omni-plugin-tgz-"));
  roots.push(base);
  const path = join(base, name);
  const tar = makeTarball(entries);
  writeFileSync(path, name.endsWith(".tgz") ? Bun.gzipSync(new Uint8Array(tar)) : tar);
  return path;
}

/* -------------------------------------------------------------------- verify */

describe("verifyPlugin", () => {
  test("a well-formed plugin would load, with nothing to report", () => {
    const root = makeRoot();
    place(root, "poke-dex", MANIFEST);

    const report = verifyPlugin(deps, root, "poke-dex");

    expect(report.loadable).toBe(true);
    expect(report.problems).toEqual([]);
    expect(report.manifest?.version).toBe("1.4.2");
  });

  test("an absent plugin is refused rather than reported as broken", () => {
    const root = makeRoot();
    expect(() => verifyPlugin(deps, root, "poke-dex")).toThrow(GatewayError);
  });

  test("a missing manifest is fatal", () => {
    const root = makeRoot();
    mkdirSync(join(root, "plugins", "poke-dex"), { recursive: true });

    const report = verifyPlugin(deps, root, "poke-dex");

    expect(report.loadable).toBe(false);
    expect(report.problems[0]?.check).toBe("manifest");
    expect(report.problems[0]?.reason).toContain("omni-plugin.json");
    // `fatal` is asserted separately from `loadable`: the two are computed at
    // different points, and it is `fatal` that decides whether a reader paints
    // this red or files it under "worth fixing eventually".
    expect(report.problems[0]?.fatal).toBe(true);
  });

  test("a manifest that is not JSON is fatal, and says so", () => {
    const root = makeRoot();
    place(root, "poke-dex", "{ not json");

    const report = verifyPlugin(deps, root, "poke-dex");

    expect(report.loadable).toBe(false);
    expect(report.problems[0]?.check).toBe("manifest");
    expect(report.problems[0]?.reason).toContain("not valid JSON");
    expect(report.problems[0]?.fatal).toBe(true);
  });

  test("a schema violation is fatal and carries the schema's own reason", () => {
    const root = makeRoot();
    place(root, "poke-dex", { ...MANIFEST, capabilities: ["storage", "telepathy"] });

    const report = verifyPlugin(deps, root, "poke-dex");

    expect(report.loadable).toBe(false);
    expect(report.problems[0]?.check).toBe("manifest");
    // Straight from `safeParseManifest`, not restated here: the whole point is
    // that verify agrees with the host's own validator.
    expect(report.problems[0]?.reason).toContain("capabilities");
  });

  test("an id that fails the pattern is caught by the schema", () => {
    const root = makeRoot();
    // Uppercase: a table prefix and a URL segment could not carry it.
    place(root, "poke-dex", { ...MANIFEST, id: "Poke-Dex" });

    const report = verifyPlugin(deps, root, "poke-dex");

    expect(report.loadable).toBe(false);
    expect(report.problems.map((p) => p.check)).toContain("manifest");
  });

  test("a manifest id disagreeing with its directory is fatal", () => {
    const root = makeRoot();
    place(root, "poke-dex", { ...MANIFEST, id: "impostor" });

    const report = verifyPlugin(deps, root, "poke-dex");

    expect(report.loadable).toBe(false);
    const problem = report.problems.find((p) => p.check === "id");
    expect(problem?.fatal).toBe(true);
    expect(problem?.reason).toContain("impostor");
    expect(problem?.reason).toContain("poke-dex");
  });

  test("an incompatible api major is fatal", () => {
    const root = makeRoot();
    place(root, "poke-dex", { ...MANIFEST, api: 99 });

    const report = verifyPlugin(deps, root, "poke-dex");

    expect(report.loadable).toBe(false);
    const problem = report.problems.find((p) => p.check === "api");
    expect(problem?.fatal).toBe(true);
    expect(problem?.reason).toContain("99");
  });

  test("a declared server entry that is not there is fatal", () => {
    const root = makeRoot();
    const home = place(root, "poke-dex", MANIFEST);
    rmSync(join(home, "server.js"));

    const report = verifyPlugin(deps, root, "poke-dex");

    expect(report.loadable).toBe(false);
    const problem = report.problems.find((p) => p.check === "entry");
    expect(problem?.fatal).toBe(true);
    expect(problem?.reason).toContain("server.js");
  });

  test("a missing ui bundle is reported but does not stop the plugin loading", () => {
    const root = makeRoot();
    place(root, "poke-dex", { ...MANIFEST, ui: "ui/index.js", sdk: "^1.0.0" });

    const report = verifyPlugin(deps, root, "poke-dex");

    // The loader mounts the server half regardless; the UI 404s. Reporting this
    // as a failure would have an operator hold a restart over a nav entry.
    expect(report.loadable).toBe(true);
    const problem = report.problems.find((p) => p.check === "entry");
    expect(problem?.fatal).toBe(false);
    expect(problem?.reason).toContain("ui/index.js");
  });

  test("an sdk range the host does not satisfy is a warning, never a failure", () => {
    const root = makeRoot();
    place(root, "poke-dex", { ...MANIFEST, ui: "ui.js", sdk: "^2.0.0" }, { "ui.js": "" });

    const report = verifyPlugin({ ...deps, sdkVersion: "1.3.0" }, root, "poke-dex");

    expect(report.loadable).toBe(true);
    const problem = report.problems.find((p) => p.check === "sdk");
    expect(problem?.fatal).toBe(false);
    expect(problem?.reason).toContain("^2.0.0");
    expect(problem?.reason).toContain("1.3.0");
  });

  test("an sdk range is not judged at all when the host cannot state a version", () => {
    const root = makeRoot();
    place(root, "poke-dex", { ...MANIFEST, ui: "ui.js", sdk: "^2.0.0" }, { "ui.js": "" });

    // Unknown is unknown. Inventing a pass would tell an operator a UI is
    // compatible when nothing compared anything.
    const report = verifyPlugin(deps, root, "poke-dex");

    expect(report.problems.find((p) => p.check === "sdk")).toBeUndefined();
  });

  test("an sdk range the host satisfies produces nothing", () => {
    const root = makeRoot();
    place(root, "poke-dex", { ...MANIFEST, ui: "ui.js", sdk: "^1.0.0" }, { "ui.js": "" });

    const report = verifyPlugin({ ...deps, sdkVersion: "1.3.0" }, root, "poke-dex");

    expect(report.problems).toEqual([]);
  });

  test("verify does not run the entry it is verifying", () => {
    const root = makeRoot();
    const home = place(root, "poke-dex", MANIFEST);
    const sentinel = join(root, "entry-ran");
    writeFileSync(
      join(home, "server.js"),
      `import { writeFileSync } from "node:fs";\n` +
        `writeFileSync(${JSON.stringify(sentinel)}, "ran");\n` +
        "export default { setup() {} };\n",
    );

    const report = verifyPlugin(deps, root, "poke-dex");

    expect(report.loadable).toBe(true);
    // The whole reason `verify` exists: an operator asks "would this load" when
    // they are not willing to find out by running it.
    expect(existsSync(sentinel)).toBe(false);
  });
});

/* ---------------------------------------------------------------------- list */

describe("listPlugins", () => {
  test("no plugins directory reads as no plugins", () => {
    expect(listPlugins(deps, makeRoot())).toEqual([]);
  });

  test("a broken plugin is reported, not thrown over, and its neighbours survive", () => {
    const root = makeRoot();
    place(root, "poke-dex", MANIFEST);
    place(root, "broken", "{{{");
    place(root, "wrong-api", { ...MANIFEST, id: "wrong-api", api: 42 });

    const plugins = listPlugins(deps, root);

    expect(plugins.map((p) => p.id)).toEqual(["broken", "poke-dex", "wrong-api"]);
    expect(plugins.find((p) => p.id === "broken")?.loadable).toBe(false);
    expect(plugins.find((p) => p.id === "broken")?.manifest).toBeNull();
    expect(plugins.find((p) => p.id === "wrong-api")?.loadable).toBe(false);
    // The healthy one is still fully described. A listing that degrades every
    // row because one is broken is how an operator loses the ability to find
    // the broken one.
    const good = plugins.find((p) => p.id === "poke-dex");
    expect(good?.loadable).toBe(true);
    expect(good?.version).toBe("1.4.2");
    expect(good?.api).toBe(1);
  });

  test("a directory whose name could never be a plugin id is reported", () => {
    const root = makeRoot();
    place(root, "Not_An_Id", MANIFEST);

    const plugins = listPlugins(deps, root);

    expect(plugins).toHaveLength(1);
    expect(plugins[0]?.loadable).toBe(false);
    expect(plugins[0]?.problems[0]?.check).toBe("id");
  });

  test("declared capabilities and origins are carried through", () => {
    const root = makeRoot();
    place(root, "poke-dex", {
      ...MANIFEST,
      capabilities: ["storage", "net:outbound"],
      origins: ["https://pokeapi.co"],
    });

    const plugins = listPlugins(deps, root);

    expect(plugins[0]?.capabilities).toEqual(["storage", "net:outbound"]);
    expect(plugins[0]?.origins).toEqual(["https://pokeapi.co"]);
  });
});

/* ------------------------------------------------------------------- install */

describe("installPlugin", () => {
  test("a local directory lands under the id the manifest declares", async () => {
    const root = makeRoot();
    const from = source("poke-dex", MANIFEST, { "data/seed.json": "[]" });

    const result = await installPlugin(deps, root, from);

    expect(result.id).toBe("poke-dex");
    expect(result.version).toBe("1.4.2");
    expect(result.replaced).toBe(false);
    expect(result.restartRequired).toBe(true);
    expect(existsSync(join(root, "plugins", "poke-dex", "omni-plugin.json"))).toBe(true);
    expect(readFileSync(join(root, "plugins", "poke-dex", "data", "seed.json"), "utf8")).toBe("[]");
    expect(verifyPlugin(deps, root, "poke-dex").loadable).toBe(true);
  });

  test("a manifest id disagreeing with its directory is refused, leaving nothing behind", async () => {
    const root = makeRoot();
    const from = source("poke-dex", { ...MANIFEST, id: "impostor" });

    await expect(installPlugin(deps, root, from)).rejects.toThrow(/does not match its directory/);

    // Neither the id the operator asked for nor the one the document claimed.
    // A half-created directory is a plugin the next boot reports as broken.
    expect(existsSync(join(root, "plugins", "poke-dex"))).toBe(false);
    expect(existsSync(join(root, "plugins", "impostor"))).toBe(false);
    expect(listPlugins(deps, root)).toEqual([]);
  });

  test("an invalid manifest is refused before anything is written", async () => {
    const root = makeRoot();
    const from = source("poke-dex", { ...MANIFEST, api: "one" });

    await expect(installPlugin(deps, root, from)).rejects.toThrow(GatewayError);

    expect(listPlugins(deps, root)).toEqual([]);
    expect(existsSync(join(root, "plugins", ".staging-poke-dex"))).toBe(false);
  });

  test("a source with no manifest is refused", async () => {
    const base = mkdtempSync(join(tmpdir(), "omni-plugin-src-"));
    roots.push(base);
    writeFileSync(join(base, "server.js"), "");

    await expect(installPlugin(deps, makeRoot(), base)).rejects.toThrow(/omni-plugin\.json/);
  });

  test("an npm tarball installs under the manifest id, ignoring its `package/` wrapper", async () => {
    const root = makeRoot();
    const archive = writeTarball("poke-dex-1.4.2.tgz", [
      ["package/omni-plugin.json", JSON.stringify(MANIFEST)],
      ["package/server.js", "export default {};"],
      ["package/package.json", JSON.stringify({ name: "poke-dex" })],
    ]);

    const result = await installPlugin(deps, root, archive);

    expect(result.id).toBe("poke-dex");
    expect(existsSync(join(root, "plugins", "poke-dex", "server.js"))).toBe(true);
    // `package` is npm's wrapper and names nothing, so it must not become a
    // directory inside the installed plugin.
    expect(existsSync(join(root, "plugins", "poke-dex", "package"))).toBe(false);
  });

  test("a tarball whose own root disagrees with the manifest is refused", async () => {
    const root = makeRoot();
    const archive = writeTarball("thing.tar", [
      ["other-name/omni-plugin.json", JSON.stringify(MANIFEST)],
      ["other-name/server.js", ""],
    ]);

    await expect(installPlugin(deps, root, archive)).rejects.toThrow(
      /does not match its directory/,
    );
    expect(listPlugins(deps, root)).toEqual([]);
  });

  test("a staging directory left by a crashed install is not merged into the next one", async () => {
    const root = makeRoot();
    const staging = join(root, "plugins", ".staging-poke-dex");
    mkdirSync(staging, { recursive: true });
    writeFileSync(join(staging, "junk.js"), "junk");

    await installPlugin(deps, root, source("poke-dex", MANIFEST));

    // Written into rather than replaced, the leftovers would become part of the
    // installed plugin — and a crashed install is exactly when there is no
    // record of what they were.
    expect(existsSync(join(root, "plugins", "poke-dex", "junk.js"))).toBe(false);
    expect(existsSync(staging)).toBe(false);
  });

  test("no code from the package is executed", async () => {
    const root = makeRoot();
    const sentinel = join(root, "install-script-ran");
    const side = `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(sentinel)}, "ran");\n`;
    const from = source("poke-dex", MANIFEST, {
      // Every hook an installer might be tempted to honour, plus a server entry
      // with a top-level effect. The installer parses bytes and writes bytes; it
      // has no path to a subprocess and never imports the entry.
      "package.json": JSON.stringify({
        name: "poke-dex",
        scripts: {
          preinstall: "node evil.js",
          install: "node evil.js",
          postinstall: "node evil.js",
        },
      }),
      "evil.js": side,
      "server.js": `${side}export default { setup() {} };\n`,
    });

    await installPlugin(deps, root, from);

    expect(existsSync(sentinel)).toBe(false);
    // It was copied, not run: the difference is the whole promise.
    expect(existsSync(join(root, "plugins", "poke-dex", "evil.js"))).toBe(true);
  });

  test("an archive containing a symlink is refused outright", async () => {
    const root = makeRoot();
    const archive = writeTarball("evil.tar", [
      ["package/omni-plugin.json", JSON.stringify(MANIFEST)],
      ["package/link", "/etc/passwd", "2"],
    ]);

    await expect(installPlugin(deps, root, archive)).rejects.toThrow(/link/);
    expect(listPlugins(deps, root)).toEqual([]);
  });

  test("an archive path escaping its root is refused", async () => {
    const root = makeRoot();
    const archive = writeTarball("evil.tar", [
      ["package/omni-plugin.json", JSON.stringify(MANIFEST)],
      ["package/../../escaped.js", "boom"],
    ]);

    await expect(installPlugin(deps, root, archive)).rejects.toThrow(/unsafe path/);
    expect(existsSync(join(root, "..", "escaped.js"))).toBe(false);
  });

  test("reinstalling replaces the tree rather than merging into it", async () => {
    const root = makeRoot();
    await installPlugin(deps, root, source("poke-dex", MANIFEST, { "old.js": "old" }));

    const result = await installPlugin(
      deps,
      root,
      source("poke-dex", { ...MANIFEST, version: "2.0.0" }, { "new.js": "new" }),
    );

    expect(result.replaced).toBe(true);
    expect(result.version).toBe("2.0.0");
    expect(existsSync(join(root, "plugins", "poke-dex", "new.js"))).toBe(true);
    // A file from the previous version surviving would be a plugin running
    // against code its manifest never described.
    expect(existsSync(join(root, "plugins", "poke-dex", "old.js"))).toBe(false);
    // The staging directory is not left for the next `readdir` to call a plugin.
    expect(existsSync(join(root, "plugins", ".staging-poke-dex"))).toBe(false);
    expect(listPlugins(deps, root).map((p) => p.id)).toEqual(["poke-dex"]);
  });

  test("a url spec is refused when the caller injected no fetcher", async () => {
    await expect(
      installPlugin(deps, makeRoot(), "https://example.invalid/plugin.tgz"),
    ).rejects.toThrow(GatewayError);
  });

  test("a url spec is unpacked through the injected fetcher and nothing else", async () => {
    const root = makeRoot();
    const asked: string[] = [];
    const tar = makeTarball([
      ["package/omni-plugin.json", JSON.stringify(MANIFEST)],
      ["package/server.js", ""],
    ]);
    const fetching: PluginDeps = {
      ...deps,
      fetchBytes: async (url) => {
        asked.push(url);
        return Bun.gzipSync(new Uint8Array(tar));
      },
    };

    const result = await installPlugin(fetching, root, "https://example.invalid/p.tgz");

    expect(asked).toEqual(["https://example.invalid/p.tgz"]);
    expect(result.id).toBe("poke-dex");
  });
});

/* -------------------------------------------------------------------- remove */

describe("removePlugin", () => {
  test("without purge the directory goes and the data stays", () => {
    const root = makeRoot();
    place(root, "poke-dex", MANIFEST);
    const store = fakeStore({ "poke-dex": ["plugin_poke-dex_caught"] });

    const result = removePlugin({ ...deps, store }, root, "poke-dex");

    expect(result.removed).toBe(true);
    expect(result.droppedTables).toEqual([]);
    expect(existsSync(join(root, "plugins", "poke-dex"))).toBe(false);
    // Uninstalling a plugin is not evidence its data is unwanted, and the
    // commonest reason to do it is to install another build a minute later.
    expect(store.dropped).toEqual([]);
    expect(store.plugins.listTables("poke-dex")).toEqual(["plugin_poke-dex_caught"]);
  });

  test("with purge the directory and only that plugin's tables go", () => {
    const root = makeRoot();
    place(root, "poke-dex", MANIFEST);
    place(root, "other", { ...MANIFEST, id: "other" });
    const store = fakeStore({
      "poke-dex": ["plugin_poke-dex_caught", "plugin_poke-dex_seen"],
      other: ["plugin_other_rows"],
    });

    const result = removePlugin({ ...deps, store }, root, "poke-dex", { purge: true });

    expect(result.removed).toBe(true);
    expect(result.droppedTables).toEqual(["plugin_poke-dex_caught", "plugin_poke-dex_seen"]);
    expect(store.dropped).toEqual(["poke-dex"]);
    expect(store.plugins.listTables("other")).toEqual(["plugin_other_rows"]);
    expect(existsSync(join(root, "plugins", "other"))).toBe(true);
  });

  test("purging needs a database, and says so rather than half-working", () => {
    const root = makeRoot();
    place(root, "poke-dex", MANIFEST);

    expect(() => removePlugin(deps, root, "poke-dex", { purge: true })).toThrow(GatewayError);
    // The refusal comes before anything is removed: a purge that dropped the
    // directory and then discovered it had no database would be the worst half.
    expect(existsSync(join(root, "plugins", "poke-dex"))).toBe(true);
  });

  test("purge still runs when only the tables are left, which is the orphan case", () => {
    const root = makeRoot();
    const store = fakeStore({ "poke-dex": ["plugin_poke-dex_caught"] });

    const result = removePlugin({ ...deps, store }, root, "poke-dex", { purge: true });

    expect(result.removed).toBe(false);
    expect(result.droppedTables).toEqual(["plugin_poke-dex_caught"]);
    expect(store.dropped).toEqual(["poke-dex"]);
  });

  test("an id that could never be a plugin is refused before any path is built", () => {
    const root = makeRoot();
    place(root, "poke-dex", MANIFEST);

    // `..` is the id that matters. Joined onto `<root>/plugins` it resolves to
    // the installation root itself — a real directory, so every "does this
    // exist" check downstream says yes and the removal takes the whole
    // installation with it. The pattern check is what stands between an operator
    // fat-fingering an argument and that.
    expect(() => removePlugin(deps, root, "..")).toThrow(/not a valid plugin id/);
    expect(existsSync(root)).toBe(true);
    expect(existsSync(join(root, "plugins", "poke-dex"))).toBe(true);

    expect(() => removePlugin(deps, root, "../../etc")).toThrow(/not a valid plugin id/);
  });

  test("a plugin that is not installed is refused", () => {
    expect(() => removePlugin(deps, makeRoot(), "poke-dex")).toThrow(GatewayError);
  });
});

/* ------------------------------------------------------------------- orphans */

describe("orphanPluginTables", () => {
  test("reports tables belonging to nothing installed, and drops nothing", () => {
    const root = makeRoot();
    place(root, "poke-dex", MANIFEST);
    const store = fakeStore({
      "poke-dex": ["plugin_poke-dex_caught"],
      gone: ["plugin_gone_rows"],
    });

    const orphans = orphanPluginTables(deps, root, store);

    expect(orphans).toEqual(["plugin_gone_rows"]);
    expect(store.dropped).toEqual([]);
    expect(store.plugins.listTables("gone")).toEqual(["plugin_gone_rows"]);
  });

  test("a plugin that will not load still counts as installed", () => {
    const root = makeRoot();
    // Broken, but present. Dropping its tables because it is currently skipped
    // would destroy the data an operator is about to repair the manifest for.
    place(root, "poke-dex", { ...MANIFEST, api: 99 });
    const store = fakeStore({ "poke-dex": ["plugin_poke-dex_caught"] });

    expect(orphanPluginTables(deps, root, store)).toEqual([]);
  });
});

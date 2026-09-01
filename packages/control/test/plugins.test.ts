import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { GatewayError } from "@omni/ir";
import { PLUGIN_API_VERSION } from "@omnigateway/plugin-api";
import { nodeFetchBytes, nodePluginFs } from "../src/nodeFs.ts";
import {
  INSTALL_RECORD_FILENAME,
  installPlugin,
  listPlugins,
  MAX_PLUGIN_BYTES,
  orphanPluginTables,
  type PluginDeps,
  type PluginStore,
  readInstallRecord,
  removePlugin,
  updatePlugin,
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
  api: PLUGIN_API_VERSION,
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
 *
 * `declaredSize` overrides the size field only, leaving the body as written. It
 * exists for the two archives a real `tar` will never produce and the reader
 * must still survive — one that promises more than it carries, and one that
 * promises more than the ceiling allows. It is written before the checksum, so
 * even those fixtures are headers a real tar reader would accept.
 */
function tarEntry(path: string, body: string, type = "0", declaredSize?: number): Uint8Array {
  const header = new Uint8Array(512);
  const put = (text: string, offset: number, length: number) => {
    header.set(encoder.encode(text).subarray(0, length), offset);
  };
  put(path, 0, 100);
  put("0000644\0", 100, 8);
  put("0000000\0", 108, 8);
  put("0000000\0", 116, 8);
  const bytes = encoder.encode(body);
  put(`${(declaredSize ?? bytes.length).toString(8).padStart(11, "0")}\0`, 124, 12);
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

/** Concatenates entry blocks and closes the archive with the two zero blocks. */
function seal(blocks: Uint8Array[]): Uint8Array {
  const total = blocks.reduce((sum, block) => sum + block.length, 0) + 1024;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const block of blocks) {
    out.set(block, offset);
    offset += block.length;
  }
  return out;
}

function makeTarball(entries: Array<[string, string, string?]>): Uint8Array {
  return seal(entries.map(([path, body, type]) => tarEntry(path, body, type ?? "0")));
}

/** Puts arbitrary bytes on disk under a name, for archives `makeTarball` cannot express. */
function writeArchive(name: string, bytes: Uint8Array): string {
  const base = mkdtempSync(join(tmpdir(), "omni-plugin-tgz-"));
  roots.push(base);
  const path = join(base, name);
  writeFileSync(path, name.endsWith(".tgz") ? Bun.gzipSync(new Uint8Array(bytes)) : bytes);
  return path;
}

function writeTarball(name: string, entries: Array<[string, string, string?]>): string {
  return writeArchive(name, makeTarball(entries));
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
    expect(good?.api).toBe(PLUGIN_API_VERSION);
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

  test("an absolute entry name is refused", async () => {
    // `..` is the escape everyone tests for; a leading `/` is the one that needs
    // no traversal at all. It matters that this is refused in the reader rather
    // than survived by the join later: `join(root, "/etc/passwd")` happens to
    // land back inside the root, so a reader that accepted the name would look
    // correct on this machine and be one path helper away from not being.
    const root = makeRoot();
    const archive = writeTarball("evil.tar", [
      ["package/omni-plugin.json", JSON.stringify(MANIFEST)],
      ["/etc/passwd", "root:x:0:0"],
    ]);

    await expect(installPlugin(deps, root, archive)).rejects.toThrow(/unsafe path/);
    expect(listPlugins(deps, root)).toEqual([]);
  });

  test("a GNU long-name entry names the file, and the ustar header it precedes does not", async () => {
    // A path over 100 bytes does not fit a ustar header, so GNU tar emits an `L`
    // entry carrying the real name and follows it with a header holding a stub.
    // The reader honours the `L` name — asserted here against a stub that could
    // never be mistaken for a truncation of it, so a reader that ignored the `L`
    // entry could not pass by accident.
    const root = makeRoot();
    const longPath =
      "package/gnu-longlink-needs-a-path-over-one-hundred-bytes/and-this-second-directory-takes-it-there/deep.js";
    expect(longPath.length).toBeGreaterThan(100);
    const archive = writeTarball("long.tar", [
      ["package/omni-plugin.json", JSON.stringify(MANIFEST)],
      ["././@LongLink", longPath, "L"],
      ["package/IGNORED-STUB", "export const deep = 1;\n"],
    ]);

    const result = await installPlugin(deps, root, archive);

    expect(result.id).toBe("poke-dex");
    const installed = join(root, "plugins", "poke-dex");
    expect(
      readFileSync(
        join(
          installed,
          "gnu-longlink-needs-a-path-over-one-hundred-bytes",
          "and-this-second-directory-takes-it-there",
          "deep.js",
        ),
        "utf8",
      ),
    ).toBe("export const deep = 1;\n");
    // The stub was a name, not a file. Anything landing under it means the `L`
    // entry was read as metadata and then thrown away.
    expect(existsSync(join(installed, "IGNORED-STUB"))).toBe(false);
  });

  test("a long name is path-checked exactly like a short one", async () => {
    // The check that matters. An `L` entry is a second way to name a file, and a
    // second way to name a file is a second place to forget the path check —
    // which would make every guard above bypassable by writing the same escape
    // one entry earlier.
    const root = makeRoot();
    const archive = writeTarball("evil.tar", [
      ["package/omni-plugin.json", JSON.stringify(MANIFEST)],
      ["././@LongLink", "package/../../escaped-by-longlink.js", "L"],
      ["package/harmless.js", "boom"],
    ]);

    await expect(installPlugin(deps, root, archive)).rejects.toThrow(/unsafe path/);
    expect(existsSync(join(root, "..", "escaped-by-longlink.js"))).toBe(false);
  });

  test("an archive declaring more than the ceiling is refused without carrying the bytes", async () => {
    // The tar bomb, and the reason the ceiling reads the header rather than the
    // body: this fixture is a few kilobytes on disk and claims to be 32MB. A
    // reader that unpacked first and measured after would have to allocate the
    // whole declared size to discover it was not allowed to, which is the
    // resource kill the ceiling exists to prevent — so the test asserts the
    // refusal happens on an archive that never carries the bytes at all.
    const root = makeRoot();
    const bomb = seal([
      tarEntry("package/omni-plugin.json", JSON.stringify(MANIFEST)),
      tarEntry("package/bomb.bin", "", "0", MAX_PLUGIN_BYTES + 1),
    ]);
    expect(bomb.byteLength).toBeLessThan(MAX_PLUGIN_BYTES);
    const archive = writeArchive("bomb.tar", bomb);

    await expect(installPlugin(deps, root, archive)).rejects.toThrow(
      new RegExp(`more than ${MAX_PLUGIN_BYTES} bytes`),
    );
    expect(listPlugins(deps, root)).toEqual([]);
  });

  test("the ceiling counts entries the reader skips, not only the files it keeps", async () => {
    // The same bomb hidden in metadata. pax and GNU headers are skipped for their
    // *content*, but their declared bodies are bytes the reader still has to walk
    // past, so a ceiling that counted only the files it kept could be walked
    // around by putting the size on an entry that is never stored. Declared on a
    // `g` header here — the one bsdtar emits by default, so it is the entry type
    // most likely to be trusted without thinking.
    const root = makeRoot();
    const archive = writeArchive(
      "pax-bomb.tar",
      seal([
        tarEntry("pax_global_header", "", "g", MAX_PLUGIN_BYTES + 1),
        tarEntry("package/omni-plugin.json", JSON.stringify(MANIFEST)),
      ]),
    );

    await expect(installPlugin(deps, root, archive)).rejects.toThrow(
      new RegExp(`more than ${MAX_PLUGIN_BYTES} bytes`),
    );
    expect(listPlugins(deps, root)).toEqual([]);
  });

  test("a truncated archive is refused rather than installed short", async () => {
    // `subarray` clamps instead of throwing, so a download cut off mid-entry
    // used to unpack into a file holding whatever arrived and install cleanly.
    // The plugin then fails at `import` time, in a message about its code rather
    // than about its delivery, and the operator debugs the wrong thing.
    const root = makeRoot();
    const whole = makeTarball([
      ["package/omni-plugin.json", JSON.stringify(MANIFEST)],
      ["package/server.js", "x".repeat(2000)],
    ]);
    // Drop the closing zero blocks and two blocks of the last body, leaving a
    // header that promises 2000 bytes above an archive that ends after 1024.
    const cut = whole.slice(0, whole.byteLength - 1024 - 1024);
    const archive = writeArchive("cut.tar", cut);

    await expect(installPlugin(deps, root, archive)).rejects.toThrow(/truncated/);
    expect(listPlugins(deps, root)).toEqual([]);
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

  test("a plaintext url is refused, and refused before the fetcher is consulted", async () => {
    // What comes back from this fetch is `import`ed into the gateway process, so
    // whoever sits on the wire picks what the gateway runs. The refusal is
    // asserted against a caller that *has* a fetcher, because the interesting
    // case is not "nobody wired one up" — it is the day somebody does. And the
    // fetcher must go untouched: refusing after the download would still have
    // pulled the bytes from a plaintext origin.
    const asked: string[] = [];
    const fetching: PluginDeps = {
      ...deps,
      fetchBytes: async (url) => {
        asked.push(url);
        return new Uint8Array(0);
      },
    };

    await expect(
      installPlugin(fetching, makeRoot(), "http://example.invalid/p.tgz"),
    ).rejects.toThrow(/https/);
    expect(asked).toEqual([]);
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

/* ------------------------------------------------------------- npm registry */

/**
 * A registry that exists entirely inside the test.
 *
 * `fetchBytes` is the only way out of the installer, so a fake that answers two
 * URLs and throws on a third is a complete network: anything the resolver
 * fetches that these tests did not arrange shows up as a thrown "unexpected
 * fetch" rather than as a silent request. `asked` is asserted as often as the
 * result is, because half of what this code promises is about requests it must
 * *not* make — a refusal that happens after the download is not the refusal
 * these tests are checking for.
 */
const REGISTRY = "https://registry.test";

function tgzFor(version: string): Uint8Array {
  return Bun.gzipSync(
    new Uint8Array(
      makeTarball([
        ["package/omni-plugin.json", JSON.stringify({ ...MANIFEST, version })],
        ["package/server.js", "export default {};"],
      ]),
    ),
  );
}

function sriFor(bytes: Uint8Array): string {
  return `sha512-${new Bun.CryptoHasher("sha512").update(bytes).digest("base64")}`;
}

function shasumFor(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha1").update(bytes).digest("hex");
}

/** One version as the packument advertises it. Every field has a usable default. */
type Advertised = {
  bytes?: Uint8Array;
  tarball?: string;
  /** `null` omits the field, which is how a registry with no SRI is expressed. */
  integrity?: string | null;
  shasum?: string;
};

type FakeRegistry = {
  deps: PluginDeps;
  asked: string[];
  accepts: Array<string | undefined>;
};

function fakeRegistry(input: {
  name: string;
  versions: Record<string, Advertised>;
  /** `null` serves a packument with no `dist-tags`. Defaults to the last version. */
  latest?: string | null;
  /** Tags beside `latest`, which must never be what an unversioned spec picks. */
  tags?: Record<string, string>;
  registry?: string;
  /** Serves this instead of a packument, for the documents JSON cannot describe. */
  packumentBytes?: Uint8Array;
}): FakeRegistry {
  const base = input.registry ?? REGISTRY;
  const asked: string[] = [];
  const accepts: Array<string | undefined> = [];
  const served = new Map<string, Uint8Array>();
  const versions: Record<string, unknown> = {};

  for (const [version, advertised] of Object.entries(input.versions)) {
    const bytes = advertised.bytes ?? tgzFor(version);
    const tarball = advertised.tarball ?? `${base}/${input.name}/-/pkg-${version}.tgz`;
    const dist: Record<string, unknown> = { tarball };
    if (advertised.integrity !== null) dist.integrity = advertised.integrity ?? sriFor(bytes);
    if (advertised.shasum !== undefined) dist.shasum = advertised.shasum;
    versions[version] = { name: input.name, version, dist };
    served.set(tarball, bytes);
  }

  const latest = input.latest === undefined ? Object.keys(input.versions).at(-1) : input.latest;
  const tags = {
    ...input.tags,
    ...(latest === null || latest === undefined ? {} : { latest }),
  };
  const document = {
    name: input.name,
    ...(Object.keys(tags).length === 0 ? {} : { "dist-tags": tags }),
    versions,
  };
  served.set(
    `${base}/${input.name.replace("/", "%2f")}`,
    input.packumentBytes ?? encoder.encode(JSON.stringify(document)),
  );

  return {
    asked,
    accepts,
    deps: {
      fs: nodePluginFs(),
      registry: base,
      fetchBytes: async (url, accept) => {
        asked.push(url);
        accepts.push(accept);
        const bytes = served.get(url);
        if (bytes === undefined) throw new Error(`unexpected fetch: ${url}`);
        return bytes;
      },
    },
  };
}

describe("installPlugin from the npm registry", () => {
  test("a bare name resolves through dist-tags.latest and installs", async () => {
    const root = makeRoot();
    const registry = fakeRegistry({
      name: "poke-dex",
      versions: { "1.0.0": {}, "1.4.2": {} },
      latest: "1.4.2",
    });

    const result = await installPlugin(registry.deps, root, "poke-dex");

    expect(result.id).toBe("poke-dex");
    expect(result.version).toBe("1.4.2");
    expect(existsSync(join(root, "plugins", "poke-dex", "server.js"))).toBe(true);
    // Two requests, in this order, and nothing else. No `npm`, no dependency
    // walk, no second registry round trip.
    expect(registry.asked).toEqual([
      `${REGISTRY}/poke-dex`,
      `${REGISTRY}/poke-dex/-/pkg-1.4.2.tgz`,
    ]);
    // The abbreviated packument is asked for by name; the tarball fetch carries
    // no preference at all.
    expect(registry.accepts[0]).toContain("vnd.npm.install-v1+json");
    expect(registry.accepts[1]).toBeUndefined();
  });

  test("an exact version installs that version rather than the latest", async () => {
    const root = makeRoot();
    const registry = fakeRegistry({
      name: "poke-dex",
      versions: { "1.4.2": {}, "2.0.0": {} },
      latest: "2.0.0",
    });

    const result = await installPlugin(registry.deps, root, "poke-dex@1.4.2");

    // The version is read out of the *installed manifest*, so this cannot pass
    // by the resolver picking the right URL and unpacking the other tarball.
    expect(result.version).toBe("1.4.2");
    expect(registry.asked[1]).toBe(`${REGISTRY}/poke-dex/-/pkg-1.4.2.tgz`);
  });

  test("a scoped name is one path segment, and its leading @ is not a version", async () => {
    const root = makeRoot();
    const registry = fakeRegistry({ name: "@team/poke-dex", versions: { "1.4.2": {} } });

    const result = await installPlugin(registry.deps, root, "@team/poke-dex");

    // Percent-encoded: the registry keeps a scoped package at one segment, and
    // a raw slash would be a different URL entirely.
    expect(registry.asked[0]).toBe(`${REGISTRY}/@team%2fpoke-dex`);
    // The package name and the plugin id are different namespaces. `@team/…`
    // could never be a plugin id, so the manifest decides where it lands.
    expect(result.id).toBe("poke-dex");
  });

  test("a scoped name with a version splits at the second @, not the first", async () => {
    const root = makeRoot();
    const registry = fakeRegistry({
      name: "@team/poke-dex",
      versions: { "1.4.2": {}, "2.0.0": {} },
      latest: "2.0.0",
    });

    const result = await installPlugin(registry.deps, root, "@team/poke-dex@1.4.2");

    expect(registry.asked[0]).toBe(`${REGISTRY}/@team%2fpoke-dex`);
    expect(result.version).toBe("1.4.2");
  });

  test("a version range is refused by name, before anything is fetched", async () => {
    const registry = fakeRegistry({ name: "poke-dex", versions: { "1.4.2": {} } });

    await expect(installPlugin(registry.deps, makeRoot(), "poke-dex@^1.0.0")).rejects.toThrow(
      /exact version/,
    );
    // The refusal is the point, but so is its timing: resolving a range would
    // mean reading the packument to compare against, so a range that reaches
    // the network has already been half-resolved.
    expect(registry.asked).toEqual([]);
  });

  test("a dist-tag other than latest is refused, naming what is accepted", async () => {
    const registry = fakeRegistry({ name: "poke-dex", versions: { "1.4.2": {} } });

    await expect(installPlugin(registry.deps, makeRoot(), "poke-dex@next")).rejects.toThrow(
      /poke-dex@1\.2\.3/,
    );
    expect(registry.asked).toEqual([]);
  });

  test("bytes that do not match the advertised integrity are refused", async () => {
    const root = makeRoot();
    const registry = fakeRegistry({
      name: "poke-dex",
      versions: {
        // The packument vouches for one archive and the registry serves
        // another: a compromised mirror, or a cache that answered the wrong
        // key. Either way the operator asked for the thing the digest names.
        "1.4.2": { integrity: sriFor(tgzFor("6.6.6")) },
      },
    });

    await expect(installPlugin(registry.deps, root, "poke-dex")).rejects.toThrow(/does not match/);
    // Downloaded, judged, and discarded: nothing reached the plugins directory.
    expect(listPlugins(registry.deps, root)).toEqual([]);
    expect(registry.asked).toHaveLength(2);
  });

  test("a sha1 shasum is verified when the registry advertises no integrity", async () => {
    const root = makeRoot();
    const bytes = tgzFor("1.4.2");
    const registry = fakeRegistry({
      name: "poke-dex",
      versions: { "1.4.2": { bytes, integrity: null, shasum: shasumFor(bytes) } },
    });

    const result = await installPlugin(registry.deps, root, "poke-dex");

    expect(result.version).toBe("1.4.2");
  });

  test("a shasum that does not match is refused like an integrity mismatch", async () => {
    const root = makeRoot();
    const registry = fakeRegistry({
      name: "poke-dex",
      versions: {
        "1.4.2": { integrity: null, shasum: shasumFor(tgzFor("6.6.6")) },
      },
    });

    await expect(installPlugin(registry.deps, root, "poke-dex")).rejects.toThrow(/does not match/);
    expect(listPlugins(registry.deps, root)).toEqual([]);
  });

  test("a package advertising neither integrity nor shasum is refused, undownloaded", async () => {
    const registry = fakeRegistry({
      name: "poke-dex",
      versions: { "1.4.2": { integrity: null } },
    });

    await expect(installPlugin(registry.deps, makeRoot(), "poke-dex")).rejects.toThrow(
      /no usable integrity or shasum/,
    );
    // One request. There is nothing to check these bytes against, so fetching
    // them would be downloading code on a promise nobody made.
    expect(registry.asked).toHaveLength(1);
  });

  test("an integrity naming only an algorithm this cannot compute is refused", async () => {
    const registry = fakeRegistry({
      name: "poke-dex",
      versions: { "1.4.2": { integrity: "md5-1B2M2Y8AsgTpgAmY7PhCfg==" } },
    });

    await expect(installPlugin(registry.deps, makeRoot(), "poke-dex")).rejects.toThrow(
      /no usable integrity or shasum/,
    );
    expect(registry.asked).toHaveLength(1);
  });

  test("an unknown algorithm beside a known one is ignored, not fatal", async () => {
    const root = makeRoot();
    const bytes = tgzFor("1.4.2");
    const registry = fakeRegistry({
      name: "poke-dex",
      // SRI lists alternatives. A registry that adds a hash this host has never
      // heard of must not thereby become uninstallable.
      versions: { "1.4.2": { bytes, integrity: `md5-abcd ${sriFor(bytes)}` } },
    });

    const result = await installPlugin(registry.deps, root, "poke-dex");

    expect(result.version).toBe("1.4.2");
  });

  test("a plaintext tarball url in the packument is refused, undownloaded", async () => {
    const registry = fakeRegistry({
      name: "poke-dex",
      versions: { "1.4.2": { tarball: "http://registry.test/poke-dex/-/pkg-1.4.2.tgz" } },
    });

    await expect(installPlugin(registry.deps, makeRoot(), "poke-dex")).rejects.toThrow(/https/);
    expect(registry.asked).toHaveLength(1);
  });

  test("a tarball on a host other than the registry's is refused, undownloaded", async () => {
    const registry = fakeRegistry({
      name: "poke-dex",
      // The packument is the document that names its own download location, so
      // an off-host tarball is an origin chosen by whoever served it.
      versions: { "1.4.2": { tarball: "https://cdn.evil.test/poke-dex/-/pkg-1.4.2.tgz" } },
    });

    await expect(installPlugin(registry.deps, makeRoot(), "poke-dex")).rejects.toThrow(
      /cdn\.evil\.test/,
    );
    expect(registry.asked).toHaveLength(1);
  });

  test("a registry on a different port is a different host", async () => {
    const registry = fakeRegistry({
      name: "poke-dex",
      registry: "https://registry.test:4873",
      versions: { "1.4.2": { tarball: "https://registry.test/poke-dex/-/pkg-1.4.2.tgz" } },
    });

    await expect(installPlugin(registry.deps, makeRoot(), "poke-dex")).rejects.toThrow(
      /registry\.test:4873/,
    );
  });

  test("a private registry serves its own tarballs and is believed", async () => {
    const root = makeRoot();
    const registry = fakeRegistry({
      name: "poke-dex",
      registry: "https://npm.corp.test:4873/repo",
      versions: { "1.4.2": {} },
    });

    const result = await installPlugin(registry.deps, root, "poke-dex");

    expect(registry.asked[0]).toBe("https://npm.corp.test:4873/repo/poke-dex");
    expect(result.version).toBe("1.4.2");
  });

  test("a plaintext registry is refused before it is consulted", async () => {
    const registry = fakeRegistry({
      name: "poke-dex",
      registry: "http://registry.test",
      versions: { "1.4.2": {} },
    });

    await expect(installPlugin(registry.deps, makeRoot(), "poke-dex")).rejects.toThrow(/https/);
    expect(registry.asked).toEqual([]);
  });

  test("the default registry is npm's, and it is not reached by accident", async () => {
    const asked: string[] = [];
    const fetching: PluginDeps = {
      ...deps,
      fetchBytes: async (url) => {
        asked.push(url);
        throw new Error("no network in tests");
      },
    };

    await expect(installPlugin(fetching, makeRoot(), "poke-dex")).rejects.toThrow();

    expect(asked).toEqual(["https://registry.npmjs.org/poke-dex"]);
  });

  test("a package name is refused when the caller injected no fetcher", async () => {
    await expect(installPlugin(deps, makeRoot(), "poke-dex")).rejects.toThrow(/registry/);
  });

  test("a version the registry does not have is refused, naming it", async () => {
    const registry = fakeRegistry({ name: "poke-dex", versions: { "1.4.2": {} } });

    await expect(installPlugin(registry.deps, makeRoot(), "poke-dex@9.9.9")).rejects.toThrow(
      /no version 9\.9\.9/,
    );
    expect(registry.asked).toHaveLength(1);
  });

  test("a packument with no dist-tags.latest asks for an exact version instead", async () => {
    const registry = fakeRegistry({
      name: "poke-dex",
      versions: { "1.4.2": {} },
      latest: null,
      // A tag *is* published, just not that one. No version means `latest` and
      // only `latest`: falling back to whatever tag happens to be there would
      // install a prerelease on an operator who typed no version at all.
      tags: { next: "1.4.2" },
    });

    await expect(installPlugin(registry.deps, makeRoot(), "poke-dex")).rejects.toThrow(
      /dist-tags\.latest/,
    );
    expect(registry.asked).toHaveLength(1);
  });

  test("latest is preferred over every other tag", async () => {
    const root = makeRoot();
    const registry = fakeRegistry({
      name: "poke-dex",
      versions: { "1.4.2": {}, "2.0.0": {} },
      latest: "1.4.2",
      tags: { next: "2.0.0" },
    });

    const result = await installPlugin(registry.deps, root, "poke-dex");

    expect(result.version).toBe("1.4.2");
  });

  test("a packument that is not JSON is refused as the registry's problem", async () => {
    const registry = fakeRegistry({
      name: "poke-dex",
      versions: { "1.4.2": {} },
      packumentBytes: encoder.encode("<html>404</html>"),
    });

    await expect(installPlugin(registry.deps, makeRoot(), "poke-dex")).rejects.toThrow(
      /not valid JSON/,
    );
  });

  test("no code from a registry package is executed", async () => {
    const root = makeRoot();
    const sentinel = join(root, "install-script-ran");
    const side = `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(sentinel)}, "ran");\n`;
    const bytes = Bun.gzipSync(
      new Uint8Array(
        makeTarball([
          ["package/omni-plugin.json", JSON.stringify(MANIFEST)],
          [
            "package/package.json",
            JSON.stringify({
              name: "poke-dex",
              scripts: { preinstall: "node evil.js", postinstall: "node evil.js" },
            }),
          ],
          ["package/evil.js", side],
          ["package/server.js", `${side}export default { setup() {} };\n`],
        ]),
      ),
    );
    const registry = fakeRegistry({ name: "poke-dex", versions: { "1.4.2": { bytes } } });

    await installPlugin(registry.deps, root, "poke-dex");

    // The remote path is the local path plus two fetches and a digest. It does
    // not acquire a subprocess on the way.
    expect(existsSync(sentinel)).toBe(false);
    expect(existsSync(join(root, "plugins", "poke-dex", "evil.js"))).toBe(true);
  });

  test("a spec that is neither a path nor a package name says both", async () => {
    const registry = fakeRegistry({ name: "poke-dex", versions: { "1.4.2": {} } });

    await expect(
      installPlugin(registry.deps, makeRoot(), "./nowhere/../Poke_Dex!"),
    ).rejects.toThrow(/not a package name/);
    expect(registry.asked).toEqual([]);
  });

  test("something on disk wins over a package of the same name", async () => {
    const root = makeRoot();
    const from = source("poke-dex", MANIFEST);
    const registry = fakeRegistry({ name: "poke-dex", versions: { "9.9.9": {} } });
    const cwd = process.cwd();

    try {
      process.chdir(join(from, ".."));
      const result = await installPlugin(registry.deps, root, "poke-dex");

      // The ambiguity is resolved towards the disk in every case. The other
      // order would turn a directory an operator is standing in into a silent
      // download, which is the version of this that cannot be undone by looking.
      expect(result.version).toBe("1.4.2");
      expect(registry.asked).toEqual([]);
    } finally {
      process.chdir(cwd);
    }
  });
});

/* ----------------------------------------------------------- the fetcher */

/**
 * `nodeFetchBytes` with its `fetch` injected, which is the only reason that
 * option exists. Nothing here opens a socket.
 */
type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

function stubFetch(handler: (url: string, init: FetchInit) => Response): typeof fetch {
  return (async (input: FetchInput, init?: FetchInit) =>
    handler(String(input), init)) as typeof fetch;
}

describe("nodeFetchBytes", () => {
  test("returns the body and forwards the accept hint", async () => {
    const seen: Array<string | undefined> = [];
    const fetchBytes = nodeFetchBytes({
      fetchImpl: stubFetch((_url, init) => {
        const headers = new Headers(init?.headers);
        seen.push(headers.get("accept") ?? undefined);
        return new Response(new Uint8Array([1, 2, 3]));
      }),
    });

    expect(await fetchBytes("https://registry.test/thing", "application/json")).toEqual(
      new Uint8Array([1, 2, 3]),
    );
    expect(seen).toEqual(["application/json"]);
  });

  test("refuses a plaintext url without making the request", async () => {
    let called = false;
    const fetchBytes = nodeFetchBytes({
      fetchImpl: stubFetch(() => {
        called = true;
        return new Response(new Uint8Array(0));
      }),
    });

    // Restated at the transport because this is the last place it can be true.
    await expect(fetchBytes("http://registry.test/thing")).rejects.toThrow(/https/);
    expect(called).toBe(false);
  });

  test("an error status is an error, not an empty download", async () => {
    const fetchBytes = nodeFetchBytes({
      fetchImpl: stubFetch(() => new Response("nope", { status: 404 })),
    });

    // A 404 body unpacked as a tarball would fail somewhere far away from the
    // typo that caused it.
    await expect(fetchBytes("https://registry.test/thing")).rejects.toThrow(/404/);
  });

  test("a body over the ceiling is refused and the transfer is cancelled", async () => {
    let cancelled = false;
    const fetchBytes = nodeFetchBytes({
      maxBytes: 8,
      fetchImpl: stubFetch(() => {
        // Ten four-byte chunks and no `content-length`. Finite on purpose: a
        // fixture that streamed forever would hang rather than fail if the
        // ceiling were ever removed, and a hang is not a failing test.
        let sent = 0;
        return new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              if (sent++ >= 10) {
                controller.close();
                return;
              }
              controller.enqueue(new Uint8Array(4));
            },
            cancel() {
              cancelled = true;
            },
          }),
        );
      }),
    });

    // An endless body: the ceiling has to be enforced while reading, because
    // there is no content-length here to have believed.
    await expect(fetchBytes("https://registry.test/thing")).rejects.toThrow(/more than 8 bytes/);
    expect(cancelled).toBe(true);
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

/* -------------------------------------------------------------------- update */

describe("the install record", () => {
  test("install writes the spec as typed, the resolved version, and when", async () => {
    const root = makeRoot();
    const from = source("poke-dex", MANIFEST);
    const at = Date.parse("2026-08-30T12:00:00.000Z");

    await installPlugin({ ...deps, now: () => at }, root, from);

    const record = readInstallRecord(deps, root, "poke-dex");
    expect(record).toEqual({
      spec: from,
      installedAt: "2026-08-30T12:00:00.000Z",
      version: "1.4.2",
    });
    // On disk beside the plugin, not in the database: a restore that predates
    // the install must not be able to take the record with it.
    expect(existsSync(join(root, "plugins", "poke-dex", INSTALL_RECORD_FILENAME))).toBe(true);
  });

  test("the record does not stop the plugin verifying", async () => {
    const root = makeRoot();
    await installPlugin(deps, root, source("poke-dex", MANIFEST));

    // A dot-prefixed file the manifest never names. `entrySchema` cannot name
    // one, so no manifest can claim it as an entry point either.
    expect(verifyPlugin(deps, root, "poke-dex").loadable).toBe(true);
    expect(verifyPlugin(deps, root, "poke-dex").problems).toEqual([]);
  });

  test("a relative path is recorded absolute, so an update means the same bytes anywhere", async () => {
    const root = makeRoot();
    const from = source("poke-dex", MANIFEST);
    // What an operator actually types — README and the plugin guide both
    // document this form. `loadPayload` resolves it against `process.cwd()`, so
    // recording it verbatim would make `omni plugin update` mean a different
    // directory's bytes when run from somewhere else, and `expectId` could not
    // catch that because the id would match.
    const typed = relative(process.cwd(), from);
    expect(isAbsolute(typed)).toBe(false);

    const result = await installPlugin(deps, root, typed);

    expect(isAbsolute(result.spec)).toBe(true);
    expect(readInstallRecord(deps, root, "poke-dex")?.spec).toBe(from);
  });

  test("a tarball path is recorded absolute too, and updates from it", async () => {
    const root = makeRoot();
    const archive = writeTarball("poke-dex-1.4.2.tgz", [
      ["poke-dex/omni-plugin.json", JSON.stringify(MANIFEST)],
      ["poke-dex/server.js", "export default {};"],
    ]);

    await installPlugin(deps, root, relative(process.cwd(), archive));
    expect(readInstallRecord(deps, root, "poke-dex")?.spec).toBe(archive);

    // And the recorded path is one `update` can actually re-read.
    const again = await updatePlugin(deps, root, "poke-dex");
    expect(again.version).toBe("1.4.2");
    expect(again.replaced).toBe(true);
  });

  test("a package name is recorded as typed, never resolved to a path", async () => {
    const root = makeRoot();
    const registry = fakeRegistry({ name: "poke-dex", versions: { "1.4.2": {} }, latest: "1.4.2" });

    await installPlugin(registry.deps, root, "poke-dex");

    // The other half of the rule: resolving a registry spec would silently pin
    // every install, which is what "as typed" was written to prevent.
    expect(readInstallRecord(deps, root, "poke-dex")?.spec).toBe("poke-dex");
  });

  test("a plugin with no record reads as null rather than throwing", () => {
    const root = makeRoot();
    place(root, "poke-dex", MANIFEST);

    expect(readInstallRecord(deps, root, "poke-dex")).toBeNull();
  });

  test("an unreadable record reads as null rather than as a spec", async () => {
    const root = makeRoot();
    await installPlugin(deps, root, source("poke-dex", MANIFEST));
    writeFileSync(join(root, "plugins", "poke-dex", INSTALL_RECORD_FILENAME), "{not json");

    expect(readInstallRecord(deps, root, "poke-dex")).toBeNull();
  });
});

describe("updatePlugin", () => {
  test("a bare package name re-resolves, so an update picks up the new latest", async () => {
    const root = makeRoot();
    const first = fakeRegistry({
      name: "poke-dex",
      versions: { "1.4.2": {} },
      latest: "1.4.2",
    });
    await installPlugin(first.deps, root, "poke-dex");
    expect(readInstallRecord(deps, root, "poke-dex")?.spec).toBe("poke-dex");

    const later = fakeRegistry({
      name: "poke-dex",
      versions: { "1.4.2": {}, "1.5.0": {} },
      latest: "1.5.0",
    });
    const result = await updatePlugin(later.deps, root, "poke-dex");

    expect(result.version).toBe("1.5.0");
    expect(result.replaced).toBe(true);
    expect(result.restartRequired).toBe(true);
    // Recorded as typed: the spec that re-resolves stays the spec on file, so
    // the next update re-resolves too rather than pinning 1.5.0 forever.
    expect(readInstallRecord(deps, root, "poke-dex")?.spec).toBe("poke-dex");
    expect(readInstallRecord(deps, root, "poke-dex")?.version).toBe("1.5.0");
  });

  test("an exact version reinstalls that version rather than the new latest", async () => {
    const root = makeRoot();
    const first = fakeRegistry({ name: "poke-dex", versions: { "1.4.2": {} }, latest: "1.4.2" });
    await installPlugin(first.deps, root, "poke-dex@1.4.2");

    const later = fakeRegistry({
      name: "poke-dex",
      versions: { "1.4.2": {}, "2.0.0": {} },
      latest: "2.0.0",
    });
    const result = await updatePlugin(later.deps, root, "poke-dex");

    expect(result.version).toBe("1.4.2");
    expect(later.asked).toEqual([`${REGISTRY}/poke-dex`, `${REGISTRY}/poke-dex/-/pkg-1.4.2.tgz`]);
  });

  test("a plugin that is not installed is refused the way remove refuses it", async () => {
    const root = makeRoot();

    await expect(updatePlugin(deps, root, "poke-dex")).rejects.toThrow(
      /no plugin "poke-dex" installed under/,
    );
  });

  test("a plugin with no record is refused, naming the repair", async () => {
    const root = makeRoot();
    place(root, "poke-dex", MANIFEST);

    // The fact and the repair, because the fact alone leaves an operator with a
    // plugin they cannot update and no idea what to type next.
    await expect(updatePlugin(deps, root, "poke-dex")).rejects.toThrow(
      /omni plugin install <spec>/,
    );
  });

  test("a package that renamed itself is refused rather than installed beside the old one", async () => {
    const root = makeRoot();
    const first = fakeRegistry({ name: "poke-dex", versions: { "1.4.2": {} }, latest: "1.4.2" });
    await installPlugin(first.deps, root, "poke-dex");

    const renamed = fakeRegistry({
      name: "poke-dex",
      versions: {
        "2.0.0": {
          bytes: Bun.gzipSync(
            new Uint8Array(
              makeTarball([
                [
                  "package/omni-plugin.json",
                  JSON.stringify({ ...MANIFEST, id: "dex", version: "2.0.0" }),
                ],
                ["package/server.js", "export default {};"],
              ]),
            ),
          ),
        },
      },
      latest: "2.0.0",
    });

    await expect(updatePlugin(renamed.deps, root, "poke-dex")).rejects.toThrow(/does not match/);
    // The whole point of recording the source: an update must never leave two
    // plugins where the operator had one.
    expect(existsSync(join(root, "plugins", "dex"))).toBe(false);
    expect(readInstallRecord(deps, root, "poke-dex")?.version).toBe("1.4.2");
  });

  test("a failed update leaves the previous tree and its record serving", async () => {
    const root = makeRoot();
    const from = source("poke-dex", MANIFEST, { "data/seed.json": "[]" });
    await installPlugin(deps, root, from);

    // The source goes bad between install and update, which is the ordinary
    // shape of a broken release.
    writeFileSync(join(from, "omni-plugin.json"), "{not json");

    await expect(updatePlugin(deps, root, "poke-dex")).rejects.toThrow(GatewayError);

    expect(verifyPlugin(deps, root, "poke-dex").loadable).toBe(true);
    expect(readFileSync(join(root, "plugins", "poke-dex", "data", "seed.json"), "utf8")).toBe("[]");
    expect(readInstallRecord(deps, root, "poke-dex")?.spec).toBe(from);
    expect(existsSync(join(root, "plugins", ".staging-poke-dex"))).toBe(false);
  });
});

describe("a record that is not this record", () => {
  /**
   * The third clause of `readInstallRecord`'s null, which was the untested one.
   *
   * Missing file and unparseable JSON were covered; a document that parses but
   * is not this shape was not, and it is the one that could hand
   * `installPlugin` something it never wrote — `{"spec": {"a": 1}}` coerces to
   * `"[object Object]"` under a bare `String(...)`, which is a path, which
   * resolves.
   */
  const cases: Record<string, unknown> = {
    "a non-string spec": { spec: { a: 1 }, installedAt: "2026-08-30T12:00:00.000Z", version: "1" },
    "an empty spec": { spec: "", installedAt: "2026-08-30T12:00:00.000Z", version: "1" },
    "a missing version": { spec: "poke-dex", installedAt: "2026-08-30T12:00:00.000Z" },
    "a top-level array": [{ spec: "poke-dex" }],
    "a bare string": "poke-dex",
    null: null,
  };

  for (const [what, document] of Object.entries(cases)) {
    test(`${what} reads as null, and update refuses with the reinstall hint`, async () => {
      const root = makeRoot();
      await installPlugin(deps, root, source("poke-dex", MANIFEST));
      writeFileSync(
        join(root, "plugins", "poke-dex", INSTALL_RECORD_FILENAME),
        JSON.stringify(document),
      );

      expect(readInstallRecord(deps, root, "poke-dex")).toBeNull();
      await expect(updatePlugin(deps, root, "poke-dex")).rejects.toThrow(
        /omni plugin install <spec>/,
      );
    });
  }
});

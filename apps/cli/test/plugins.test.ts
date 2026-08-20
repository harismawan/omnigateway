import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Prompt } from "../src/prompt.ts";
import { cli, fakeService, makeRoot, openStore, silentPrompt } from "./helpers/harness.ts";

/**
 * The plugin commands, driven the way a terminal drives them.
 *
 * Every root is a `mkdtemp` directory the harness made, so the real filesystem
 * these commands use can only reach a throwaway tree. Nothing is spawned and
 * nothing is fetched: `install` reads a directory the test wrote, and the one
 * command that needs a database opens the harness's own store.
 */

const MANIFEST = {
  id: "poke-dex",
  name: "Poke Dex",
  version: "1.4.2",
  api: 1,
  server: "server.js",
} as const;

/** Writes a plugin into an installation, bypassing `install`. */
function place(root: string, dir: string, manifest: unknown, files: Record<string, string> = {}) {
  const home = join(root, "plugins", dir);
  mkdirSync(home, { recursive: true });
  writeFileSync(
    join(home, "omni-plugin.json"),
    typeof manifest === "string" ? manifest : JSON.stringify(manifest),
  );
  for (const [name, contents] of Object.entries({ "server.js": "export default {};", ...files })) {
    writeFileSync(join(home, name), contents);
  }
  return home;
}

/** A package to install from, outside the installation. */
function source(dir: string, manifest: unknown, files: Record<string, string> = {}): string {
  const home = join(mkdtempSync(join(tmpdir(), "omni-cli-plugin-")), dir);
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "omni-plugin.json"), JSON.stringify(manifest));
  for (const [name, contents] of Object.entries({ "server.js": "export default {};", ...files })) {
    writeFileSync(join(home, name), contents);
  }
  return home;
}

/** A terminal whose operator says no. */
const refusingPrompt: Prompt = { ...silentPrompt, confirm: async () => false };

/** Creates one table for a plugin, the way its own migration would. */
async function giveTables(root: string, id: string): Promise<void> {
  const store = await openStore(root);
  store.plugins.migrate(id, [{ version: 1, sql: "CREATE TABLE {{caught}} (id TEXT)" }]);
  store.close();
}

async function tablesOf(root: string, id: string): Promise<string[]> {
  const store = await openStore(root);
  try {
    return store.plugins.listTables(id);
  } finally {
    store.close();
  }
}

describe("omni plugin list", () => {
  test("reports a broken plugin instead of failing", async () => {
    const root = makeRoot();
    place(root, "poke-dex", MANIFEST);
    place(root, "broken", "{{{ not json");

    const result = await cli(["plugin", "list"], { root });

    expect(result.code).toBe(0);
    expect(result.out).toContain("poke-dex");
    expect(result.out).toContain("broken");
    expect(result.out).toContain("will not load");
    // The reason, not just the verdict: an operator reading this should not have
    // to run a second command to learn what to fix.
    expect(result.out).toContain("not valid JSON");
  });

  test("says where to put one when there are none", async () => {
    const result = await cli(["plugin", "list"], { root: makeRoot() });

    expect(result.code).toBe(0);
    expect(result.out).toContain("no plugins installed");
  });

  test("--json carries the structured report", async () => {
    const root = makeRoot();
    place(root, "poke-dex", MANIFEST);

    const result = await cli(["plugin", "list", "--json"], { root });
    const parsed = JSON.parse(result.out) as { plugins: Array<{ id: string; loadable: boolean }> };

    expect(parsed.plugins).toHaveLength(1);
    expect(parsed.plugins[0]?.id).toBe("poke-dex");
    expect(parsed.plugins[0]?.loadable).toBe(true);
  });
});

describe("omni plugin verify", () => {
  test("exits zero and says so for a plugin that would load", async () => {
    const root = makeRoot();
    place(root, "poke-dex", MANIFEST);

    const result = await cli(["plugin", "verify", "poke-dex"], { root });

    expect(result.code).toBe(0);
    expect(result.out).toContain("would load");
  });

  test("exits non-zero for one that would be skipped, so a deploy can gate on it", async () => {
    const root = makeRoot();
    place(root, "poke-dex", { ...MANIFEST, api: 99 });

    const result = await cli(["plugin", "verify", "poke-dex"], { root });

    expect(result.code).not.toBe(0);
    expect(result.err).toContain("would not load");
  });

  test("exits zero for a warning, because a warning is not a failure", async () => {
    const root = makeRoot();
    place(root, "poke-dex", { ...MANIFEST, ui: "ui.js", sdk: "^1.0.0" });

    const result = await cli(["plugin", "verify", "poke-dex"], { root });

    expect(result.code).toBe(0);
    expect(result.out).toContain("ui.js");
  });

  test("refuses an id nothing is installed under", async () => {
    const result = await cli(["plugin", "verify", "poke-dex"], { root: makeRoot() });

    expect(result.code).not.toBe(0);
    expect(result.err).toContain("no plugin");
  });
});

describe("omni plugin install", () => {
  test("installs from a directory and asks for a restart", async () => {
    const root = makeRoot();

    const result = await cli(["plugin", "install", source("poke-dex", MANIFEST)], { root });

    expect(result.code).toBe(0);
    expect(result.out).toContain("Poke Dex 1.4.2");
    expect(result.out).toContain("omni restart");
    expect(existsSync(join(root, "plugins", "poke-dex", "omni-plugin.json"))).toBe(true);
  });

  test("refuses a manifest id that disagrees with its directory, leaving nothing behind", async () => {
    const root = makeRoot();

    const result = await cli(
      ["plugin", "install", source("poke-dex", { ...MANIFEST, id: "impostor" })],
      { root },
    );

    expect(result.code).not.toBe(0);
    expect(result.err).toContain("does not match its directory");
    expect(existsSync(join(root, "plugins", "poke-dex"))).toBe(false);
    expect(existsSync(join(root, "plugins", "impostor"))).toBe(false);
  });

  test("runs nothing from the package", async () => {
    const root = makeRoot();
    const sentinel = join(root, "ran");
    const from = source("poke-dex", MANIFEST, {
      "package.json": JSON.stringify({ scripts: { postinstall: "node evil.js" } }),
      "evil.js": `require("node:fs").writeFileSync(${JSON.stringify(sentinel)}, "x");`,
    });

    const result = await cli(["plugin", "install", from], { root });

    expect(result.code).toBe(0);
    expect(existsSync(sentinel)).toBe(false);
  });

  /**
   * The remote specs, driven through the CLI and reaching no network.
   *
   * Every case below is refused *before* the first request, which is what makes
   * them testable here at all: the harness has no seam for a stubbed fetcher, so
   * a test that got as far as a socket would be a test that opened one. That is
   * also why they are worth having — each one asserts that a refusal happens
   * early, and "early" is the property an end-to-end test can see that a unit
   * test of the resolver cannot.
   */
  test("a plaintext url is refused", async () => {
    const result = await cli(["plugin", "install", "http://example.invalid/p.tgz"], {
      root: makeRoot(),
    });

    expect(result.code).not.toBe(0);
    expect(result.err).toContain("https");
  });

  test("a version range is refused, naming what would be accepted", async () => {
    const result = await cli(["plugin", "install", "omni-plugin-nope@^1.0.0"], {
      root: makeRoot(),
    });

    expect(result.code).not.toBe(0);
    expect(result.err).toContain("exact version");
    expect(result.err).toContain("omni-plugin-nope@1.2.3");
  });

  test("a scoped name keeps its @ and takes its version from the second one", async () => {
    const result = await cli(["plugin", "install", "@team/omni-plugin-nope@1.x"], {
      root: makeRoot(),
    });

    expect(result.code).not.toBe(0);
    // The whole scoped name, and only the trailing `1.x` as the version. A
    // split at the first `@` would report the package as "" and the version as
    // "team/omni-plugin-nope@1.x".
    expect(result.err).toContain("@team/omni-plugin-nope@1.x is not an exact version");
  });

  test("--registry decides where a package name resolves, and must be https", async () => {
    const result = await cli(
      ["plugin", "install", "omni-plugin-nope", "--registry", "http://from-flag.test"],
      { root: makeRoot() },
    );

    expect(result.code).not.toBe(0);
    // Reaching this message means the CLI injected a fetcher *and* passed the
    // registry through: without the fetcher the refusal would be a different
    // one, about this caller not being able to install from a registry.
    expect(result.err).toContain("http://from-flag.test");
  });

  test("an installation's .env names a registry too", async () => {
    const root = makeRoot({ OMNI_PLUGIN_REGISTRY: "http://from-env.test" });

    const result = await cli(["plugin", "install", "omni-plugin-nope"], { root });

    expect(result.code).not.toBe(0);
    expect(result.err).toContain("http://from-env.test");
  });

  test("the flag wins over the environment, as --db does", async () => {
    const root = makeRoot({ OMNI_PLUGIN_REGISTRY: "http://from-env.test" });

    const result = await cli(
      ["plugin", "install", "omni-plugin-nope", "--registry", "http://from-flag.test"],
      { root },
    );

    expect(result.code).not.toBe(0);
    expect(result.err).toContain("http://from-flag.test");
    expect(result.err).not.toContain("from-env");
  });
});

describe("omni plugin remove", () => {
  test("without --purge the tables survive", async () => {
    const root = makeRoot();
    place(root, "poke-dex", MANIFEST);
    await giveTables(root, "poke-dex");

    const result = await cli(["plugin", "remove", "poke-dex"], { root, prompt: silentPrompt });

    expect(result.code).toBe(0);
    expect(existsSync(join(root, "plugins", "poke-dex"))).toBe(false);
    expect(await tablesOf(root, "poke-dex")).toEqual(["plugin_poke-dex_caught"]);
    expect(result.out).toContain("--purge");
  });

  test("--purge drops only that plugin's tables", async () => {
    const root = makeRoot();
    place(root, "poke-dex", MANIFEST);
    place(root, "other", { ...MANIFEST, id: "other" });
    await giveTables(root, "poke-dex");
    await giveTables(root, "other");

    const result = await cli(["plugin", "remove", "poke-dex", "--purge"], {
      root,
      prompt: silentPrompt,
    });

    expect(result.code).toBe(0);
    expect(result.out).toContain("plugin_poke-dex_caught");
    expect(await tablesOf(root, "poke-dex")).toEqual([]);
    expect(await tablesOf(root, "other")).toEqual(["plugin_other_caught"]);
  });

  test("--purge asks first, and a refusal changes nothing", async () => {
    const root = makeRoot();
    place(root, "poke-dex", MANIFEST);
    await giveTables(root, "poke-dex");

    const result = await cli(["plugin", "remove", "poke-dex", "--purge"], {
      root,
      prompt: refusingPrompt,
    });

    expect(result.code).not.toBe(0);
    expect(result.err).toContain("cancelled");
    // Both halves survive: the question is asked before anything is touched.
    expect(existsSync(join(root, "plugins", "poke-dex"))).toBe(true);
    expect(await tablesOf(root, "poke-dex")).toEqual(["plugin_poke-dex_caught"]);
  });

  test("without a terminal the decision has to have been made on the command line", async () => {
    const root = makeRoot();
    place(root, "poke-dex", MANIFEST);

    // The real prompt refuses without `--yes` when there is no tty, which is the
    // behaviour every other destructive command in this CLI has.
    const result = await cli(["plugin", "remove", "poke-dex", "--purge"], {
      root,
      prompt: {
        ...silentPrompt,
        confirm: async (question) => {
          throw new Error(`${question} — refusing without --yes`);
        },
      },
    });

    expect(result.code).not.toBe(0);
    expect(existsSync(join(root, "plugins", "poke-dex"))).toBe(true);
  });
});

describe("omni doctor", () => {
  test("reports plugins with versions and compatibility", async () => {
    const root = makeRoot();
    place(root, "poke-dex", MANIFEST);
    place(root, "wrong-api", { ...MANIFEST, id: "wrong-api", api: 99 });

    const result = await cli(["doctor"], { root, service: fakeService({ root }) });

    expect(result.out).toContain("poke-dex 1.4.2");
    expect(result.out).toContain("api 1");
    expect(result.out).toContain("wrong-api");
    expect(result.out).toContain("will not load");
  });

  test("reports orphan plugin tables and leaves them alone", async () => {
    const root = makeRoot();
    place(root, "poke-dex", MANIFEST);
    await giveTables(root, "poke-dex");
    // Installed once, gone from disk now. This is what a snapshot restored onto
    // an installation without the plugin leaves behind.
    await giveTables(root, "gone");

    const result = await cli(["doctor"], { root, service: fakeService({ root }) });

    expect(result.out).toContain("plugin_gone_caught");
    expect(result.out).not.toContain("plugin_poke-dex_caught");
    // Reported, never dropped: a restore is exactly when a plugin is most likely
    // to be temporarily missing.
    expect(await tablesOf(root, "gone")).toEqual(["plugin_gone_caught"]);
  });

  test("says none when there are no plugins", async () => {
    const root = makeRoot();

    const result = await cli(["doctor"], { root, service: fakeService({ root }) });

    expect(result.out).toContain("plugins");
    expect(result.out).toContain("none");
  });
});

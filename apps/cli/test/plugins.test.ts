import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PLUGIN_API_VERSION } from "@omnigateway/plugin-api";
import { pluginProviders } from "../src/commands/plugins.ts";
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
  api: PLUGIN_API_VERSION,
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

  test("a plugin built against the previous generation is refused, not run", async () => {
    // The gate fires *downwards* too, and that is the direction it was written
    // for. `ctx.provider.register` was removed in generation 2, so a plugin
    // published against 1 calls a member of `PluginContext` that no longer
    // exists — and the commit that removed it left `PLUGIN_API_VERSION` at 1, so
    // this command answered "this plugin would load" and the gateway then
    // reported `undefined is not an object (evaluating 'ctx.provider.register')`.
    // A raw TypeError where a version mismatch belongs, from the one command
    // whose purpose is confidence before a restart.
    //
    // `PLUGIN_API_VERSION - 1` rather than a literal `1`, so this keeps meaning
    // "the previous generation" after the next bump.
    const root = makeRoot();
    place(root, "poke-dex", { ...MANIFEST, api: PLUGIN_API_VERSION - 1 });

    const result = await cli(["plugin", "verify", "poke-dex"], { root });

    expect(result.code).not.toBe(0);
    expect(result.err).toContain("would not load");
    const listed = await cli(["plugin", "list", "--json"], { root });
    expect(JSON.parse(listed.out).plugins).toMatchObject([{ loadable: false }]);
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

describe("omni plugin update", () => {
  test("reinstalls from the recorded source without the operator retyping it", async () => {
    const root = makeRoot();
    const from = source("poke-dex", MANIFEST);
    expect((await cli(["plugin", "install", from], { root })).code).toBe(0);

    // The release the operator is picking up, published at the same place.
    writeFileSync(
      join(from, "omni-plugin.json"),
      JSON.stringify({ ...MANIFEST, version: "1.5.0" }),
    );

    const result = await cli(["plugin", "update", "poke-dex"], { root });

    expect(result.code).toBe(0);
    // "reinstalled", not "updated": re-running an unchanged spec is the ordinary
    // case, and reporting an update that did not happen is a claim the operator
    // has no way to check.
    expect(result.out).toContain("reinstalled Poke Dex 1.5.0");
    expect(result.out).toContain("omni restart");
    expect(
      JSON.parse(readFileSync(join(root, "plugins", "poke-dex", "omni-plugin.json"), "utf8"))
        .version,
    ).toBe("1.5.0");
  });

  test("the install record is stamped from the CLI's own clock", async () => {
    const root = makeRoot();
    // Injected, per rule 11, rather than left to control's global default —
    // which is untestable from here and which nothing else would notice.
    await cli(["plugin", "install", source("poke-dex", MANIFEST)], {
      root,
      now: () => 1_800_000_000_000,
    });

    const record = JSON.parse(
      readFileSync(join(root, "plugins", "poke-dex", ".omni-install.json"), "utf8"),
    ) as { installedAt: string };
    expect(record.installedAt).toBe(new Date(1_800_000_000_000).toISOString());
  });

  test("names the source it used, so the operator can see what was re-run", async () => {
    const root = makeRoot();
    const from = source("poke-dex", MANIFEST);
    await cli(["plugin", "install", from], { root });

    const result = await cli(["plugin", "update", "poke-dex", "--json"], { root });

    expect(result.code).toBe(0);
    expect(JSON.parse(result.out).spec).toBe(from);
  });

  test("a hand-copied plugin is refused with the command that would seed a record", async () => {
    const root = makeRoot();
    place(root, "poke-dex", MANIFEST);

    const result = await cli(["plugin", "update", "poke-dex"], { root });

    expect(result.code).not.toBe(0);
    expect(result.err).toContain("omni plugin install <spec>");
  });

  test("a plugin that is not installed is refused", async () => {
    const result = await cli(["plugin", "update", "poke-dex"], { root: makeRoot() });

    expect(result.code).not.toBe(0);
    expect(result.err).toContain('no plugin "poke-dex" installed');
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

/**
 * `omni credentials add-key` against a provider only a plugin supplies.
 *
 * The one way in a plugin-supplied provider has: `connect` covers OAuth flows
 * the built-ins declare, and a plugin declares none. It shipped broken and the
 * suite did not notice, because the CLI's own guard was widened to admit the id
 * and `createApiKeyCredential` then asked the built-in registry again and
 * refused it. Two guards, one of them dead.
 *
 * This process deliberately does not load plugins — `setup` opens channels, runs
 * migrations and registers a provider, none of which storing a key should do —
 * so the manifests on disk are the only thing that can answer, and the predicate
 * that reads them is now handed to control rather than checked and discarded.
 */
describe("omni credentials add-key", () => {
  const PROVIDER = {
    ...MANIFEST,
    id: "poke-dex",
    capabilities: ["provider"],
    origins: ["https://upstream.test"],
  } as const;
  /**
   * A server entry that actually declares one, since the capability alone is no
   * longer enough.
   *
   * It was for one commit, and that was the bug: the guard read the manifest,
   * whose `provider` capability is *permission* to supply a provider rather than
   * proof of one, so a plugin declaring the capability and nothing else minted a
   * live encrypted secret under an id that could never exist. The guard now
   * reads the declaration through `readPluginProviders`.
   */
  const DECLARES = `export default {
  providers: [
    {
      descriptor: {
        id: "poke-dex",
        capabilities: { tools: true, images: false, reasoning: false },
        writeOverInput: { fiveMinute: 1.25, oneHour: 2 },
        catalog: { defaultModel: "p-1", authTypes: ["apiKey"], models: [] },
        modelPrefixes: ["poke-"],
        presentation: {
          label: "Poke",
          order: 90,
          tone: "cyan",
          colour: { light: "oklch(0.5 0.03 258)", dark: "oklch(0.72 0.03 258)" },
        },
      },
      codec: {
        buildRequest: () => ({
          request: { url: "https://poke.test/v1", method: "POST", headers: [], body: "{}" },
        }),
        decode: async function* () {},
      },
    },
  ],
  setup() {
    return {};
  },
};`;
  const secret: Prompt = {
    isTty: false,
    secret: async () => "pk-secret",
    confirm: async () => true,
  };

  async function migrated(): Promise<string> {
    const root = makeRoot();
    expect((await cli(["db", "migrate"], { root })).code).toBe(0);
    return root;
  }

  test("stores a key for a provider a plugin supplies", async () => {
    const root = await migrated();
    place(root, "poke-dex", PROVIDER, { "server.js": DECLARES });

    const result = await cli(["credentials", "add-key", "poke-dex"], { root, prompt: secret });
    expect(result.code).toBe(0);

    const listed = await cli(["credentials", "list", "--json"], { root });
    const body = JSON.parse(listed.out) as { credentials: Array<Record<string, unknown>> };
    expect(body.credentials[0]).toMatchObject({ provider: "poke-dex", authType: "apiKey" });
    expect(listed.out).not.toContain("pk-secret");
  });

  test("refuses a plugin that declares the capability and supplies nothing", async () => {
    const root = await migrated();
    // Installed, loadable, well-formed id, and it *declares the capability* —
    // the only difference from the accepting case above is that its module
    // exports no `providers`. That gap is the whole finding: the capability is
    // permission to supply a provider, not proof of one, and reading the
    // manifest alone minted a live encrypted secret under an id that could
    // never exist. Asserted on the listing rather than trusting the fixture,
    // because what separates this test from the next lives entirely on disk.
    place(root, "poke-dex", PROVIDER);
    const before = await cli(["plugin", "list", "--json"], { root });
    expect(JSON.parse(before.out).plugins).toMatchObject([
      { id: "poke-dex", loadable: true, capabilities: ["provider"] },
    ]);

    const result = await cli(["credentials", "add-key", "poke-dex"], { root, prompt: secret });
    expect(result.code).not.toBe(0);
    expect(result.err).toContain("supplies one");

    // Nothing stored: the failure being closed is a secret at rest, so the
    // absence of the row is the assertion that matters.
    const after = await cli(["credentials", "list", "--json"], { root });
    expect(JSON.parse(after.out).credentials).toEqual([]);
  });

  test("the refusal names the plugin that failed, in both output modes", async () => {
    // The refusal throws before any `emit`, and `note()` is
    // `if (!ctx.json) writer.err(...)` — so under `--json` the failures reached
    // neither stream and a script saw "provider must be one of …" with the
    // cause deleted. That is the path the cause matters most on.
    const root = await migrated();
    place(
      root,
      "boomer",
      { ...PROVIDER, id: "boomer" },
      {
        "server.js": 'throw new Error("top-level boom");',
      },
    );

    const human = await cli(["credentials", "add-key", "ghost-ai"], { root, prompt: secret });
    expect(human.code).not.toBe(0);
    expect(human.err).toContain("plugin boomer: top-level boom");

    const json = await cli(["credentials", "add-key", "ghost-ai", "--json"], {
      root,
      prompt: secret,
    });
    expect(json.code).not.toBe(0);
    expect(json.err).toContain("plugin boomer: top-level boom");
  });

  test("refuses a provider nothing supplies", async () => {
    const root = await migrated();
    // Nothing on disk at all — the other half of the pair above. Asserted, so
    // that a `place()` that silently wrote to the wrong path cannot make both
    // tests pass for the same reason.
    const before = await cli(["plugin", "list", "--json"], { root });
    expect(JSON.parse(before.out).plugins).toEqual([]);

    const result = await cli(["credentials", "add-key", "poke-dex"], { root, prompt: secret });
    expect(result.code).not.toBe(0);
    expect(result.err).toContain("provider must be one of");
  });

  /**
   * A manifest declaring the capability is not a provider that will exist.
   *
   * Three of these shipped admitted for one commit, each minting a live
   * encrypted secret under an id routing can only answer with
   * `provider:missing`. `listPlugins` returns a full summary for a plugin the
   * host will refuse — deliberately, so `plugin list` survives a broken one —
   * and the first version of this guard read the summary without reading
   * `loadable`.
   */
  test("refuses a plugin the host would refuse to load", async () => {
    const cases: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
      // The manifest id disagrees with its directory: fatal, and it is the check
      // that stops a plugin claiming another's tables and topics.
      ["id mismatch", { ...PROVIDER, id: "somethingelse" }],
      // An api the host does not implement.
      ["unsupported api", { ...PROVIDER, api: 99 }],
    ];
    for (const [what, manifest] of cases) {
      const root = await migrated();
      place(root, "poke-dex", manifest);
      // The premise: the host says it will not load, and `plugin list` says so.
      const listed = await cli(["plugin", "list", "--json"], { root });
      expect(JSON.parse(listed.out).plugins, what).toMatchObject([{ loadable: false }]);

      const result = await cli(["credentials", "add-key", "poke-dex"], { root, prompt: secret });
      expect(result.code, what).not.toBe(0);
      // Nothing stored, not merely a non-zero exit: the failure this closes is a
      // secret at rest, so the absence of the row is the assertion that matters.
      const after = await cli(["credentials", "list", "--json"], { root });
      expect(JSON.parse(after.out).credentials, what).toEqual([]);
    }
  });

  /**
   * `doctor`'s net, for the account that outlives its plugin.
   *
   * `add-key` now reads the real declaration, so a plugin that supplies nothing
   * is refused at the front door — this test used to mint an account through
   * that gap. What it covers now is the state nothing at write time can
   * prevent: an account minted correctly, and the plugin removed afterwards. A
   * snapshot restored onto an installation without the plugin produces the same
   * thing, which is why the tables are kept and reported rather than dropped.
   */
  test("an account whose plugin is gone is reported by doctor", async () => {
    const root = await migrated();
    place(root, "poke-dex", PROVIDER, { "server.js": DECLARES });
    expect((await cli(["credentials", "add-key", "poke-dex"], { root, prompt: secret })).code).toBe(
      0,
    );

    // Healthy while the plugin is there — the positive control, without which
    // "reports something" would pass for the wrong reason.
    const healthy = await cli(["doctor"], { root, service: fakeService({ root }) });
    expect(healthy.out).toMatch(/stranded credentials\s+none/);

    rmSync(join(root, "plugins", "poke-dex"), { recursive: true });

    const stranded = await cli(["doctor"], { root, service: fakeService({ root }) });
    expect(stranded.out).toContain("poke-dex");
    expect(stranded.out).not.toMatch(/stranded credentials\s+none/);
  });

  test("still stores a key for a built-in with no plugins installed", async () => {
    const root = await migrated();

    const result = await cli(["credentials", "add-key", "anthropic"], { root, prompt: secret });
    expect(result.code).toBe(0);
  });
});

/**
 * The CLI answering a question the descriptor owns, for a provider only a plugin
 * supplies.
 *
 * Both commands below read the six compiled-in providers and nothing else before
 * this. `omni setup` therefore wrote an agent configuration with **no context
 * limit** for a plugin-supplied model — a file that outlives the command, where
 * the agent silently falls back to its own default while the gateway advertises
 * the real window — and `omni models dry-run` reported `provider:missing` in red
 * for a target the running gateway was serving, contradicting `omni doctor` on
 * the same installation.
 *
 * This is what `PluginDefinition.providers` exists for: a declared field can be
 * read by importing the module, where a `ctx.provider.register` capability could
 * only be read by running `setup` — which opens channels, applies migrations and
 * mounts routes, none of which a diagnostic may do.
 */
describe("the CLI reads a plugin's declared provider", () => {
  const PROVIDER = {
    ...MANIFEST,
    id: "acme-ai",
    capabilities: ["provider"],
    origins: ["https://upstream.test"],
    server: "server.js",
  } as const;

  /**
   * A server entry that declares a provider, and records what actually ran.
   *
   * **Two** sentinels, and the paths are interpolated as string literals rather
   * than read from `process.env`. The first version passed them through
   * `cli({env})`, which sets `RunOptions.env` — and `context.ts` reads that as
   * `options.env ?? process.env` and never writes it back, so inside the
   * imported module the variable was `undefined` and the sentinel could not be
   * written under *any* implementation. A mutant where `readPluginProviders`
   * called `setup` and swallowed its throw survived the whole suite.
   *
   * The top-level sentinel is the positive control the first version also
   * lacked: without it, "setup did not run" is equally satisfied by an import
   * that never happened, which is the other way this test could pass while
   * proving nothing.
   */
  const SERVER = (topLevel: string, inSetup: string) => `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(topLevel)}, "yes");
export default {
  providers: [
    {
      descriptor: {
        id: "acme-ai",
        capabilities: { tools: true, images: false, reasoning: false },
        writeOverInput: { fiveMinute: 1.25, oneHour: 2 },
        catalog: {
          defaultModel: "acme-1",
          authTypes: ["apiKey"],
          models: [
            {
              id: "acme-1",
              label: "Acme One",
              pricing: { input: 5, output: 25, cacheRead: 0.5, cacheWrite5m: 6.25, cacheWrite1h: 10 },
              limits: { contextWindow: 123000, maxOutputTokens: 4096 },
            },
          ],
        },
        modelPrefixes: ["acme-"],
        presentation: {
          label: "Acme",
          order: 90,
          tone: "cyan",
          colour: { light: "oklch(0.5 0.03 258)", dark: "oklch(0.72 0.03 258)" },
        },
      },
      codec: {
        buildRequest: () => ({
          request: { url: "https://acme.test/v1", method: "POST", headers: [], body: "{}" },
        }),
        decode: async function* () {},
      },
    },
  ],
  setup() {
    writeFileSync(${JSON.stringify(inSetup)}, "yes");
    return {};
  },
};`;

  async function installed(): Promise<string> {
    const root = makeRoot();
    expect((await cli(["db", "migrate"], { root })).code).toBe(0);
    place(root, "acme-ai", PROVIDER, {
      "server.js": SERVER(join(root, "imported"), join(root, "setup-ran")),
    });
    expect(
      (
        await cli(["credentials", "add-key", "acme-ai"], {
          root,
          prompt: { isTty: false, secret: async () => "pk-secret", confirm: async () => true },
        })
      ).code,
    ).toBe(0);
    // Seeded through the store rather than `models put --from-catalog`, which
    // reads `PROVIDER_MODEL_CATALOG` — a build-time table a plugin provider is
    // not in, and deliberately so: the CLI's catalog *listing* omits plugin
    // models by design. What these commands read is the stored target, and a
    // target naming any well-formed provider saves.
    const store = await openStore(root);
    await store.config.putModel({
      id: "fast",
      strategy: "priority",
      isAlias: false,
      targets: [
        {
          provider: "acme-ai",
          model: "acme-1",
          tier: 1,
          weight: 1,
          costPerMTok: { input: 5, output: 25 },
          capabilities: { tools: true, images: false, reasoning: false },
        },
      ],
    });
    store.close();
    return root;
  }

  /**
   * The same installation, but with a plugin whose module throws on import.
   *
   * A separate root rather than a rewrite of `installed()`'s, because a module
   * is cached per process: overwriting `server.js` after the first import leaves
   * the good one in the cache and the test passes against it. The manifest is
   * untouched, so the plugin is still `loadable` and still declares the
   * capability — the failure is in the module, which is where a real one is.
   *
   * The credential and the model are seeded through the store, since `add-key`
   * would (correctly) refuse a provider it cannot read.
   */
  async function broken(): Promise<string> {
    const root = makeRoot();
    expect((await cli(["db", "migrate"], { root })).code).toBe(0);
    place(root, "acme-ai", PROVIDER, {
      "server.js": 'throw new Error("upstream SDK missing");',
    });
    const store = await openStore(root);
    await store.config.putModel({
      id: "fast",
      strategy: "priority",
      isAlias: false,
      targets: [
        {
          provider: "acme-ai",
          model: "acme-1",
          tier: 1,
          weight: 1,
          costPerMTok: { input: 5, output: 25 },
          capabilities: { tools: true, images: false, reasoning: false },
        },
      ],
    });
    store.close();
    return root;
  }

  test("omni setup writes the window the plugin's descriptor states", async () => {
    const root = await installed();

    const result = await cli(["setup", "opencode", "--dir", root], {
      root,
      // opencode asks which pool serves each model class; answering the same
      // pool throughout is the smallest configuration that writes a file.
      prompt: {
        isTty: true,
        secret: async () => "",
        confirm: async () => true,
        input: async () => "fast",
      },
    });

    expect(result.code).toBe(0);

    // The descriptor's own figure, read from the file the command wrote. 123000
    // is a number no built-in states, so it cannot have arrived from the
    // compiled-in registry by coincidence — and before this it was absent
    // entirely, since `limit` is omitted rather than zeroed when unknown, which
    // is the silent half of the bug: the agent used its own default while the
    // gateway advertised the real window.
    const config = JSON.parse(readFileSync(join(root, "opencode.json"), "utf8")) as {
      provider: { omnigateway: { models: Record<string, { limit?: { context: number } }> } };
    };
    expect(config.provider.omnigateway.models.fast?.limit?.context).toBe(123_000);
  });

  test("omni models dry-run routes to the plugin's provider rather than calling it missing", async () => {
    const root = await installed();

    const result = await cli(["models", "dry-run", "fast"], { root });

    expect(result.code).toBe(0);
    expect(result.out).not.toContain("provider:missing");
    expect(result.out).toContain("acme-ai");
  });

  test("a plugin the host would refuse contributes no descriptor", async () => {
    // The registry has to describe the installation a *running gateway* would
    // have, not the one the manifests wish for. A plugin the loader will skip
    // supplies nothing, so reading its descriptor anyway would put a provider in
    // this registry that no gateway has — the same lie as omitting one, pointed
    // the other way, and it would make `dry-run` report a route that cannot
    // exist.
    const root = makeRoot();
    expect((await cli(["db", "migrate"], { root })).code).toBe(0);
    place(
      root,
      "acme-ai",
      { ...PROVIDER, api: 99 },
      {
        "server.js": SERVER(join(root, "imported"), join(root, "setup-ran")),
      },
    );
    const store = await openStore(root);
    await store.config.putModel({
      id: "fast",
      strategy: "priority",
      isAlias: false,
      targets: [
        {
          provider: "acme-ai",
          model: "acme-1",
          tier: 1,
          weight: 1,
          costPerMTok: { input: 5, output: 25 },
          capabilities: { tools: true, images: false, reasoning: false },
        },
      ],
    });
    store.close();

    // The premise: the host says it will not load this one.
    const listed = await cli(["plugin", "list", "--json"], { root });
    expect(JSON.parse(listed.out).plugins).toMatchObject([{ loadable: false }]);

    const result = await cli(["models", "dry-run", "fast"], { root });

    expect(result.code).toBe(0);
    // `provider:missing` is the honest answer here, and the same one the gateway
    // gives: the plugin does not load, so the provider does not exist.
    expect(result.out).toContain("provider:missing");
  });

  /**
   * A plugin that cannot be read is *named*, by both commands and in both
   * formats.
   *
   * This is the original bug wearing a different coat. When the read fails, the
   * provider is absent, so `omni setup` writes a config with no context limit
   * and `omni models dry-run` reports `provider:missing` — and if neither says
   * why, the operator is back to a silent omission and a red finding with no
   * cause. `setup` discarded the failures entirely, and `note()` is a no-op under
   * `--json`, so a script saw `provider:missing` with the explanation deleted.
   */
  test("a plugin that fails to import is named by dry-run, on stderr and in --json", async () => {
    // Built with the throwing entry from the start, not overwritten after
    // `installed()` — Bun caches a module per process, so a rewrite after the
    // first import has no effect and the test would pass against the good one.
    const root = await broken();

    const human = await cli(["models", "dry-run", "fast"], { root });
    expect(human.code).toBe(0);
    expect(human.err).toContain("acme-ai");
    expect(human.err).toContain("upstream SDK missing");

    const json = await cli(["models", "dry-run", "fast", "--json"], { root });
    const body = JSON.parse(json.out) as {
      pluginFailures: { id: string; reason: string }[];
      excluded: { reason: string }[];
    };
    // The cause travels with the consequence. A payload carrying
    // `provider:missing` and nothing else is what a support ticket is built on.
    expect(body.excluded.map((row) => row.reason)).toContain("provider:missing");
    expect(body.pluginFailures).toHaveLength(1);
    expect(body.pluginFailures[0]?.id).toBe("acme-ai");
    expect(body.pluginFailures[0]?.reason).toContain("upstream SDK missing");
  });

  test("a plugin that fails to import is named by setup too", async () => {
    // `setup` is the command whose output outlives it, so a silent omission
    // here is the more expensive one: the agent falls back to its own default
    // while the gateway advertises the real window.
    const root = await broken();

    const result = await cli(["setup", "opencode", "--dir", root], {
      root,
      prompt: {
        isTty: true,
        secret: async () => "",
        confirm: async () => true,
        input: async () => "fast",
      },
    });

    expect(result.code).toBe(0);
    expect(result.err).toContain("acme-ai");
    expect(result.err).toContain("upstream SDK missing");
    // And the limit really is gone, so the warning is not decorating a working
    // path — this is the state it exists to explain.
    const config = JSON.parse(readFileSync(join(root, "opencode.json"), "utf8")) as {
      provider: { omnigateway: { models: Record<string, { limit?: unknown }> } };
    };
    expect(config.provider.omnigateway.models.fast?.limit).toBeUndefined();
  });

  test("the merged registry keeps its null prototype", () => {
    // Asserted directly rather than through a command, and the reason is worth
    // recording: every reader that happens to exist today uses `Object.hasOwn`,
    // which is not fooled by a prototype key — so no behavioural test can see
    // this, and one written to try would pass under the spread that loses it.
    //
    // The invariant is the rule, not a consequence of one. CLAUDE.md states it
    // for *every* provider-keyed table, precisely because a reader that asks
    // `providers[id]?.catalog` — `resolveModelLimits` does — gets the `Object`
    // constructor for `"constructor"` and throws on the next property access.
    // A derived table that quietly drops it is a trap set for the next reader.
    const root = makeRoot();
    return pluginProviders(root).then(({ descriptors }) => {
      expect(Object.getPrototypeOf(descriptors)).toBeNull();
      expect((descriptors as Record<string, unknown>).constructor).toBeUndefined();
      // And it really is populated, so "no prototype" is not just "no object".
      expect(Object.keys(descriptors)).toContain("anthropic");
    });
  });

  test("a plugin the host will not load is named, not silently absent", async () => {
    // The end-to-end half. `loadable` is false for the three fatal manifest
    // problems — the *ordinary* way a plugin breaks — and that produced no
    // failure line in any command, so the operator got `provider:missing` with
    // no cause. `api: PLUGIN_API_VERSION - 1` is the realistic one: a plugin
    // published against the previous generation.
    const root = makeRoot();
    expect((await cli(["db", "migrate"], { root })).code).toBe(0);
    place(
      root,
      "acme-ai",
      { ...PROVIDER, api: PLUGIN_API_VERSION - 1 },
      { "server.js": SERVER(join(root, "imported"), join(root, "setup-ran")) },
    );
    const store = await openStore(root);
    await store.config.putModel({
      id: "fast",
      strategy: "priority",
      isAlias: false,
      targets: [
        {
          provider: "acme-ai",
          model: "acme-1",
          tier: 1,
          weight: 1,
          costPerMTok: { input: 5, output: 25 },
          capabilities: { tools: true, images: false, reasoning: false },
        },
      ],
    });
    store.close();

    const human = await cli(["models", "dry-run", "fast"], { root });
    expect(human.code).toBe(0);
    expect(human.err).toContain("acme-ai");
    expect(human.err).toContain("will not load");

    const json = await cli(["models", "dry-run", "fast", "--json"], { root });
    const body = JSON.parse(json.out) as {
      pluginFailures: { id: string; reason: string }[];
      excluded: { reason: string }[];
    };
    // The consequence and its cause travel together, which is the whole point.
    expect(body.excluded.map((row) => row.reason)).toContain("provider:missing");
    expect(body.pluginFailures).toHaveLength(1);
    expect(body.pluginFailures[0]?.reason).toContain("will not load");
  });

  test("a key for a built-in provider runs nobody's plugin", async () => {
    // The short-circuit's actual purpose, asserted rather than argued: minting a
    // credential for a compiled-in provider must not evaluate a stranger's
    // top-level code, which is a real side effect and not the CLI's to cause for
    // a question that cannot depend on the answer.
    //
    // The first version asked `PROVIDER_IDS.includes(...)`, and CLAUDE.md says
    // of that constant "it feed CLI usage messages and tests, never a gate".
    // Swapping it for the call-time registry read left every test green — the
    // mutant survived, because nothing pinned this. So does deleting the
    // short-circuit outright, which is the more interesting one: without this
    // test, the property the branch exists for was unowned.
    const root = makeRoot();
    expect((await cli(["db", "migrate"], { root })).code).toBe(0);
    place(root, "acme-ai", PROVIDER, {
      "server.js": SERVER(join(root, "imported"), join(root, "setup-ran")),
    });

    expect(
      (
        await cli(["credentials", "add-key", "anthropic"], {
          root,
          prompt: { isTty: false, secret: async () => "sk-secret", confirm: async () => true },
        })
      ).code,
    ).toBe(0);
    // Under this root nothing has imported that module yet, so absence is the
    // module never having been evaluated rather than a per-process cache hit —
    // which is why this cannot reuse `installed()`, whose own `add-key` names
    // the plugin's provider and therefore must import it.
    expect(existsSync(join(root, "imported"))).toBe(false);
  });

  test("a plugin whose manifest is corrupt is named, not silently absent", async () => {
    // The end-to-end half of the manifest:null gap. An interrupted install or a
    // truncated download leaves `omni-plugin.json` unparseable; the host then
    // knows nothing about the plugin at all, including whether it supplies the
    // provider a stored target names. Before this the operator got
    // `provider:missing` with an empty `pluginFailures` — consequence shown,
    // cause deleted, which is the bug this command was given the field for.
    const root = makeRoot();
    expect((await cli(["db", "migrate"], { root })).code).toBe(0);
    place(root, "acme-ai", PROVIDER, {
      "server.js": SERVER(join(root, "imported"), join(root, "setup-ran")),
    });
    // Truncated mid-object, which is what a half-written file actually looks
    // like — not a syntactically valid manifest with wrong contents.
    writeFileSync(join(root, "plugins", "acme-ai", "omni-plugin.json"), '{"id":"acme-ai","ca');

    const store = await openStore(root);
    await store.config.putModel({
      id: "fast",
      strategy: "priority",
      isAlias: false,
      targets: [
        {
          provider: "acme-ai",
          model: "acme-1",
          tier: 1,
          weight: 1,
          costPerMTok: { input: 5, output: 25 },
          capabilities: { tools: true, images: false, reasoning: false },
        },
      ],
    });
    store.close();

    const human = await cli(["models", "dry-run", "fast"], { root });
    expect(human.code).toBe(0);
    expect(human.err).toContain("acme-ai");

    const json = await cli(["models", "dry-run", "fast", "--json"], { root });
    const body = JSON.parse(json.out) as {
      pluginFailures: { id: string; reason: string }[];
      excluded: { reason: string }[];
    };
    // Both halves, in one payload: what went wrong for the request, and why.
    expect(body.excluded.map((row) => row.reason)).toContain("provider:missing");
    expect(body.pluginFailures).toHaveLength(1);
    expect(body.pluginFailures[0]?.id).toBe("acme-ai");
    expect(body.pluginFailures[0]?.reason).toContain("unknown");
  });

  test("a plugin provider's models are nameable from the CLI", async () => {
    // `--from-catalog` and `models catalog` were the last CLI paths answering
    // from the build. `credentials add-key acme-ai` succeeded, `models dry-run`
    // ranked its candidates, `doctor` reported it present and the gateway routed
    // and priced it — and this refused `unknown provider "acme-ai"`, so there was
    // no CLI route to the target at all. The operator had to hand-write the JSON,
    // including the pricing and capabilities the plugin already declares.
    const root = await installed();

    const listed = await cli(["models", "catalog", "--provider", "acme-ai", "--json"], { root });
    expect(listed.code).toBe(0);
    const rows = (JSON.parse(listed.out) as { models: { id: string; provider: string }[] }).models;
    expect(rows.map((row) => row.id)).toContain("acme-1");

    const put = await cli(["models", "put", "viacatalog", "--from-catalog", "acme-ai:acme-1"], {
      root,
    });
    expect(put.code).toBe(0);

    // The saved target carries what the descriptor declared, which is the half a
    // hand-written JSON file gets wrong: an exit code alone would pass if the
    // command saved a target with zero prices.
    const store = await openStore(root);
    const saved = (await store.config.listModels()).find((row) => row.id === "viacatalog");
    store.close();
    expect(saved?.targets[0]?.provider).toBe("acme-ai");
    expect(saved?.targets[0]?.model).toBe("acme-1");
    // The whole pricing block the descriptor declared, cache rates included —
    // which is more than the old `catalogPricing` path could have produced for
    // this provider, since it read a table `registerProvider` never writes to.
    expect(saved?.targets[0]?.costPerMTok).toEqual({
      input: 5,
      output: 25,
      cacheRead: 0.5,
      cacheWrite5m: 6.25,
      cacheWrite1h: 10,
    });
    // And the capabilities, which come off the descriptor rather than the
    // catalog entry.
    expect(saved?.targets[0]?.capabilities).toEqual({
      tools: true,
      images: false,
      reasoning: false,
    });
  });

  test("both commands import the module and neither calls its setup", async () => {
    // The property the declared field buys, asserted rather than argued — and
    // asserted from *both* ends, because each alone is satisfiable for the wrong
    // reason. `imported` proves the module really was evaluated, so
    // `setup-ran`'s absence means `setup` was skipped rather than that nothing
    // happened at all.
    const root = await installed();
    const imported = join(root, "imported");
    const ranSetup = join(root, "setup-ran");

    expect((await cli(["models", "dry-run", "fast"], { root })).code).toBe(0);
    // Written by the module's top level, so its presence proves a CLI command
    // really evaluated the module. Not deleted and re-checked between commands:
    // Bun caches a module per process, so the second import is a cache hit and
    // the top level does not run again. That is correct — re-running a
    // stranger's top-level code once per command would be worse — and it is why
    // this asserts "was imported at all" rather than "was imported by each".
    expect(existsSync(imported)).toBe(true);
    expect(existsSync(ranSetup)).toBe(false);

    await cli(["setup", "claude", "--dir", root], {
      root,
      prompt: {
        isTty: true,
        secret: async () => "",
        confirm: async () => true,
        input: async () => "fast",
      },
    });
    expect(existsSync(ranSetup)).toBe(false);
  });
});

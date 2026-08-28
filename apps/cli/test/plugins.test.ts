import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  const PROVIDER = { ...MANIFEST, id: "poke-dex", capabilities: ["provider"] } as const;
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
    place(root, "poke-dex", PROVIDER);

    const result = await cli(["credentials", "add-key", "poke-dex"], { root, prompt: secret });
    expect(result.code).toBe(0);

    const listed = await cli(["credentials", "list", "--json"], { root });
    const body = JSON.parse(listed.out) as { credentials: Array<Record<string, unknown>> };
    expect(body.credentials[0]).toMatchObject({ provider: "poke-dex", authType: "apiKey" });
    expect(listed.out).not.toContain("pk-secret");
  });

  test("refuses a plugin that supplies no provider", async () => {
    const root = await migrated();
    // Installed, loadable, and its id is well-formed — the capability is the
    // whole difference from the accepting case above, and without this the
    // guard would admit every plugin. Asserted on the *listing* rather than
    // trusting the fixture, because the distinction between this test and the
    // next one lives entirely in what is on disk.
    place(root, "poke-dex", MANIFEST);
    const before = await cli(["plugin", "list", "--json"], { root });
    expect(JSON.parse(before.out).plugins).toMatchObject([{ id: "poke-dex", loadable: true }]);

    const result = await cli(["credentials", "add-key", "poke-dex"], { root, prompt: secret });
    expect(result.code).not.toBe(0);
    expect(result.err).toContain('"provider" capability');
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
   * The fourth way, which no manifest read can close, and which `doctor` carries
   * instead.
   *
   * The `provider` capability is *permission* to call `ctx.provider.register`,
   * not proof that the plugin does — `manifest.ts` does not even require a
   * `server` entry beside it. So this credential is admitted, and the honest
   * thing is to say where an operator finds out.
   */
  test("a plugin that declares the capability and registers nothing is caught by doctor", async () => {
    const root = await migrated();
    place(root, "poke-dex", PROVIDER);
    expect((await cli(["credentials", "add-key", "poke-dex"], { root, prompt: secret })).code).toBe(
      0,
    );

    // Loadable and healthy on every other line, which is exactly why this one
    // has to exist: before it, `plugin list`, `doctor` and `add-key` all said ok.
    const healthy = await cli(["doctor"], { root, service: fakeService({ root }) });
    expect(healthy.out).toContain("stranded credentials");
    // A declared provider is not stranded — `doctor` reads the lenient question,
    // so a plugin that merely failed to load is reported on its own line and not
    // accused twice.
    expect(healthy.out).toMatch(/stranded credentials\s+none/);

    // Remove the plugin and the same credential becomes stranded, which is the
    // state a restore onto an installation without the plugin leaves behind.
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
    server: "server.js",
  } as const;

  /** A server entry that declares a provider and would notice if `setup` ran. */
  const SERVER = `import { writeFileSync } from "node:fs";
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
    writeFileSync(process.env.OMNI_TEST_SETUP_RAN, "yes");
    return {};
  },
};`;

  async function installed(): Promise<string> {
    const root = makeRoot();
    expect((await cli(["db", "migrate"], { root })).code).toBe(0);
    place(root, "acme-ai", PROVIDER, { "server.js": SERVER });
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
    place(root, "acme-ai", { ...PROVIDER, api: 99 }, { "server.js": SERVER });
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

  test("neither command runs the plugin's setup", async () => {
    // The property the declared field buys, asserted rather than argued. The
    // sentinel is written by `setup` and by nothing else, so its absence is the
    // whole claim: `import()` ran the module, and `setup` was never called.
    const root = await installed();
    const sentinel = join(root, "setup-ran");

    await cli(["models", "dry-run", "fast"], { root, env: { OMNI_TEST_SETUP_RAN: sentinel } });
    await cli(["setup", "claude", "--dry-run"], {
      root,
      prompt: silentPrompt,
      env: { OMNI_TEST_SETUP_RAN: sentinel },
    });

    expect(existsSync(sentinel)).toBe(false);
  });
});

import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { seedCredential, target, virtualModel } from "@omni/testkit";
import { cli, makeRoot, openStore } from "./helpers/harness.ts";

/** An installation with one wide pool, one narrow one, and one nobody knows. */
async function installation(): Promise<string> {
  const root = makeRoot();
  expect((await cli(["db", "migrate"], { root })).code).toBe(0);
  const store = await openStore(root);
  await seedCredential(store, { id: "c1", provider: "anthropic" });
  await store.config.putModel(
    virtualModel({
      id: "opus",
      targets: [target({ provider: "anthropic", model: "claude-opus-5" })],
    }),
  );
  await store.config.putModel(
    virtualModel({
      id: "haiku",
      targets: [target({ provider: "anthropic", model: "claude-haiku-4-5" })],
    }),
  );
  await store.config.putModel(
    virtualModel({
      id: "mystery",
      targets: [target({ provider: "anthropic", model: "some-private-build" })],
    }),
  );
  store.close();
  return root;
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

test("setup claude writes one profile per model, carrying that model's window", async () => {
  const root = await installation();
  const dir = join(root, "profiles");

  const result = await cli(["setup", "claude", "--dir", dir], { root });
  expect(result.code).toBe(0);

  expect(readdirSync(dir).sort()).toEqual(["haiku", "mystery", "opus"]);
  const opus = readJson(join(dir, "opus", "settings.json")).env as Record<string, string>;
  const haiku = readJson(join(dir, "haiku", "settings.json")).env as Record<string, string>;

  // One variable, one process: the whole reason these are separate profiles.
  expect(opus.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBe("1000000");
  expect(haiku.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBe("200000");
  expect(opus.ANTHROPIC_MODEL).toBe("opus");
  expect(opus.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY).toBe("1");
});

test("setup claude omits the window it does not know rather than guessing", async () => {
  const root = await installation();
  const dir = join(root, "profiles");
  await cli(["setup", "claude", "--dir", dir], { root });

  const env = readJson(join(dir, "mystery", "settings.json")).env as Record<string, string>;
  expect(env.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBeUndefined();
  expect(env.ANTHROPIC_BASE_URL).toBeDefined();
});

// The client consults the variable only for a model its built-in table does not
// know, and never for an id beginning `claude-`. Writing it there produces a
// file that looks like it configures something and does not.
test("setup claude omits the window for an id the client resolves itself", async () => {
  const root = await installation();
  const store = await openStore(root);
  await store.config.putModel(
    virtualModel({
      id: "claude-sonnet-5",
      targets: [target({ provider: "anthropic", model: "claude-sonnet-5" })],
    }),
  );
  store.close();

  const dir = join(root, "profiles");
  await cli(["setup", "claude", "--dir", dir], { root });

  const env = readJson(join(dir, "claude-sonnet-5", "settings.json")).env as Record<string, string>;
  expect(env.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBeUndefined();
});

test("setup writes a placeholder unless a key is given", async () => {
  const root = await installation();
  const dir = join(root, "profiles");

  const placeheld = await cli(["setup", "claude", "--dir", dir], { root });
  const env = readJson(join(dir, "opus", "settings.json")).env as Record<string, string>;
  expect(env.ANTHROPIC_AUTH_TOKEN).toBe("<your OmniGateway key>");
  expect(placeheld.err).toContain("placeholder");

  await cli(["setup", "claude", "--dir", dir, "--key", "omni_live_secret"], { root });
  const withKey = readJson(join(dir, "opus", "settings.json")).env as Record<string, string>;
  expect(withKey.ANTHROPIC_AUTH_TOKEN).toBe("omni_live_secret");
});

test("a dry run writes nothing and shows everything", async () => {
  const root = await installation();
  const dir = join(root, "profiles");

  const result = await cli(["setup", "claude", "--dir", dir, "--dry-run"], { root });
  expect(result.code).toBe(0);
  expect(existsSync(dir)).toBe(false);
  expect(result.out).toContain("CLAUDE_CODE_MAX_CONTEXT_TOKENS");
});

test("setup opencode describes the whole catalog in one file", async () => {
  const root = await installation();
  const result = await cli(["setup", "opencode", "--dir", root], { root });
  expect(result.code).toBe(0);

  const config = readJson(join(root, "opencode.json"));
  const provider = (config.provider as Record<string, Record<string, unknown>>).omnigateway;
  expect(provider?.npm).toBe("@ai-sdk/openai-compatible");
  expect((provider?.options as { baseURL: string } | undefined)?.baseURL).toEndWith("/v1");

  const models = provider?.models as Record<string, { name: string; limit?: { context: number } }>;
  expect(models.opus?.limit?.context).toBe(1_000_000);
  expect(models.haiku?.limit?.context).toBe(200_000);
});

// opencode reads `limit.context: 0` as "no limit" and disables its own
// compaction, so an unknown window must be absent rather than zero.
test("setup opencode omits a limit it does not know rather than writing zero", async () => {
  const root = await installation();
  await cli(["setup", "opencode", "--dir", root], { root });

  const config = readJson(join(root, "opencode.json"));
  const provider = (config.provider as Record<string, Record<string, unknown>>).omnigateway;
  const models = provider?.models as Record<string, { limit?: unknown }>;
  expect(models.mystery).toBeDefined();
  expect(models.mystery?.limit).toBeUndefined();
});

test("setup refuses an installation with no models rather than writing an empty file", async () => {
  const root = makeRoot();
  expect((await cli(["db", "migrate"], { root })).code).toBe(0);

  const result = await cli(["setup", "opencode", "--dir", root], { root });
  expect(result.code).toBe(1);
  expect(result.err).toContain("no virtual models configured");
  expect(existsSync(join(root, "opencode.json"))).toBe(false);
});

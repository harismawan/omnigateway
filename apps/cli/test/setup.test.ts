import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
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

function mappingPrompt(answers: string[], questions?: string[]) {
  return {
    isTty: true,
    secret: async () => "",
    confirm: async () => true,
    input: async (question: string) => {
      questions?.push(question);
      return answers.shift() ?? "";
    },
  };
}

test("setup claude prompts for explicit mappings and writes one merged settings file", async () => {
  const root = await installation();
  const dir = join(root, ".claude");
  const answers = ["opus", "mystery", "opus", "", "haiku"];
  const questions: string[] = [];

  const result = await cli(["setup", "claude", "--dir", dir], {
    root,
    prompt: {
      isTty: true,
      secret: async () => "",
      confirm: async () => true,
      input: async (question) => {
        questions.push(question);
        return answers.shift() ?? "";
      },
    },
  });
  expect(result.code).toBe(0);

  const config = readJson(join(dir, "settings.json"));
  const env = config.env as Record<string, string>;
  expect(env).toMatchObject({
    ANTHROPIC_MODEL: "opus",
    ANTHROPIC_DEFAULT_FABLE_MODEL: "mystery",
    ANTHROPIC_DEFAULT_OPUS_MODEL: "opus",
    ANTHROPIC_DEFAULT_HAIKU_MODEL: "haiku",
    ANTHROPIC_AUTH_TOKEN: "<your OmniGateway key>",
  });
  expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBeUndefined();
  expect(env.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBeUndefined();
  expect(questions).toHaveLength(5);
  expect(result.err).toContain("placeholder");
});

test("setup claude preserves unrelated existing settings and removes stale mappings", async () => {
  const root = await installation();
  const dir = join(root, ".claude");
  const path = join(dir, "settings.json");
  const writes: Array<{ path: string; contents: string }> = [];
  const existing = JSON.stringify({
    permissions: { allow: ["Read"] },
    env: { KEEP_ME: "yes", ANTHROPIC_DEFAULT_SONNET_MODEL: "stale" },
  });
  const answers = ["opus", "", "", "", ""];

  const result = await cli(["setup", "claude", "--dir", dir], {
    root,
    prompt: {
      isTty: true,
      secret: async () => "",
      confirm: async () => true,
      input: async () => answers.shift() ?? "",
    },
    setupFs: {
      homeDir: root,
      cwd: root,
      read: (candidate) => (candidate === path ? existing : null),
      write: (candidate, contents) => writes.push({ path: candidate, contents }),
    },
  });

  expect(result.code).toBe(0);
  expect(writes).toHaveLength(1);
  const merged = JSON.parse(writes[0]?.contents ?? "") as {
    permissions: { allow: string[] };
    env: Record<string, string>;
  };
  expect(merged.permissions.allow).toEqual(["Read"]);
  expect(merged.env.KEEP_ME).toBe("yes");
  expect(merged.env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBeUndefined();
});

test("setup claude refuses malformed existing settings without writing", async () => {
  const root = await installation();
  const writes: string[] = [];
  const answers = ["opus", "", "", "", ""];
  const result = await cli(["setup", "claude"], {
    root,
    prompt: {
      isTty: true,
      secret: async () => "",
      confirm: async () => true,
      input: async () => answers.shift() ?? "",
    },
    setupFs: {
      homeDir: root,
      cwd: root,
      read: () => "{",
      write: (path) => writes.push(path),
    },
  });

  expect(result.code).toBe(1);
  expect(result.err).toContain("cannot parse existing settings.json");
  expect(writes).toEqual([]);
});

test("a Claude dry run shows the real merge and writes nothing", async () => {
  const root = await installation();
  const answers = ["opus", "", "", "", ""];
  const result = await cli(["setup", "claude", "--dry-run"], {
    root,
    prompt: {
      isTty: true,
      secret: async () => "",
      confirm: async () => true,
      input: async () => answers.shift() ?? "",
    },
    setupFs: {
      homeDir: root,
      cwd: root,
      read: () => JSON.stringify({ theme: "dark" }),
      write: () => expect.unreachable(),
    },
  });

  expect(result.code).toBe(0);
  expect(result.out).toContain('"theme": "dark"');
  expect(result.out).toContain('"ANTHROPIC_MODEL": "opus"');
});

test("setup writes through the injected filesystem seam", async () => {
  const root = await installation();
  const writes: Array<{ path: string; contents: string }> = [];

  const result = await cli(["setup", "opencode"], {
    root,
    prompt: mappingPrompt(["opus", "", "", "", ""]),
    setupFs: {
      homeDir: "/virtual/home",
      cwd: "/virtual/project",
      read: () => null,
      write: (path, contents) => writes.push({ path, contents }),
    },
  });

  expect(result.code).toBe(0);
  expect(writes).toHaveLength(1);
  expect(writes[0]?.path).toBe("/virtual/project/opencode.json");
  expect(writes[0]?.contents).toContain('"OmniGateway"');
});

test("setup opencode prompts for mappings and writes only selected pools", async () => {
  const root = await installation();
  const questions: string[] = [];
  const result = await cli(["setup", "opencode", "--dir", root], {
    root,
    prompt: mappingPrompt(["opus", "opus", "", "", "haiku"], questions),
  });
  expect(result.code).toBe(0);
  expect(questions).toHaveLength(5);

  const config = readJson(join(root, "opencode.json"));
  expect(config.model).toBe("omnigateway/opus");
  const provider = (config.provider as Record<string, Record<string, unknown>>).omnigateway;
  expect(provider?.npm).toBe("@ai-sdk/openai-compatible");
  expect((provider?.options as { baseURL: string } | undefined)?.baseURL).toEndWith("/v1");

  const models = provider?.models as Record<string, { name: string; limit?: { context: number } }>;
  expect(Object.keys(models)).toEqual(["opus", "haiku"]);
  expect(models.opus?.limit?.context).toBe(1_000_000);
  expect(models.haiku?.limit?.context).toBe(200_000);
});

// opencode reads `limit.context: 0` as "no limit" and disables its own
// compaction, so an unknown window must be absent rather than zero.
test("setup opencode omits a limit it does not know rather than writing zero", async () => {
  const root = await installation();
  await cli(["setup", "opencode", "--dir", root], {
    root,
    prompt: mappingPrompt(["mystery", "", "", "", ""]),
  });

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

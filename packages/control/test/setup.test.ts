import { expect, test } from "bun:test";
import { virtualModel } from "@omni/testkit";
import { claudeSettings, opencodeConfig } from "../src/setup.ts";

const input = { baseUrl: "https://gateway.example" };

function described(id: string) {
  return [{ model: virtualModel({ id }), limits: {}, label: id }];
}

test("Claude setup writes one settings file with explicit class mappings", () => {
  const file = claudeSettings(
    ["default", "fable", "opus", "sonnet", "haiku"].flatMap((id) => described(id)),
    input,
    {
      defaultModel: "default",
      fableModel: "fable",
      opusModel: "opus",
      sonnetModel: "sonnet",
      haikuModel: "haiku",
    },
  );
  const config = JSON.parse(file.contents) as { env: Record<string, string> };

  expect(file.path).toBe("settings.json");
  expect(config.env).toMatchObject({
    ANTHROPIC_MODEL: "default",
    ANTHROPIC_DEFAULT_FABLE_MODEL: "fable",
    ANTHROPIC_DEFAULT_OPUS_MODEL: "opus",
    ANTHROPIC_DEFAULT_SONNET_MODEL: "sonnet",
    ANTHROPIC_DEFAULT_HAIKU_MODEL: "haiku",
  });
  expect(config.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBeUndefined();
});

test("Claude setup omits optional mappings and uses discovery mirrors", () => {
  const file = claudeSettings(
    described("model"),
    { ...input, discoveryMirrors: true },
    {
      defaultModel: "model",
    },
  );
  const config = JSON.parse(file.contents) as { env: Record<string, string> };

  expect(config.env.ANTHROPIC_MODEL).toBe("claude/model");
  expect(config.env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBeUndefined();
});

test("Claude setup rejects an empty default mapping", () => {
  expect(() => claudeSettings(described("model"), input, { defaultModel: "" })).toThrow(
    "default model is required",
  );
});

test("Claude setup rejects an unknown mapping and names its slot", () => {
  expect(() =>
    claudeSettings(described("model"), input, { defaultModel: "model", opusModel: "missing" }),
  ).toThrow('opusModel names unknown virtual model "missing"');
});

test("Claude setup preserves unrelated settings and removes stale optional mappings", () => {
  const existing = JSON.stringify({
    permissions: { allow: ["Read"] },
    env: {
      KEEP_ME: "yes",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "stale",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "stale",
    },
  });
  const file = claudeSettings(described("model"), input, { defaultModel: "model" }, existing);
  const config = JSON.parse(file.contents) as {
    permissions: { allow: string[] };
    env: Record<string, string>;
  };

  expect(config.permissions).toEqual({ allow: ["Read"] });
  expect(config.env.KEEP_ME).toBe("yes");
  expect(config.env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBeUndefined();
  expect(config.env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBeUndefined();
});

test("Claude setup refuses malformed existing JSON", () => {
  expect(() => claudeSettings(described("model"), input, { defaultModel: "model" }, "{")).toThrow(
    "cannot parse existing settings.json",
  );
});

test.each([
  "https://gateway.example",
  "https://gateway.example/",
  "https://gateway.example/v1",
  "https://gateway.example/v1/",
  "https://gateway.example/v1/v1",
  "https://gateway.example/v1/v1/",
])("OpenCode base URL has exactly one /v1 for %s", (baseUrl) => {
  const file = opencodeConfig(described("model"), { baseUrl });
  const config = JSON.parse(file.contents) as {
    provider: { omnigateway: { options: { baseURL: string } } };
  };
  expect(config.provider.omnigateway.options.baseURL).toBe("https://gateway.example/v1");
});

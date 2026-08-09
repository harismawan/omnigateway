import { expect, test } from "bun:test";
import { virtualModel } from "@omni/testkit";
import { claudeProfiles, opencodeConfig } from "../src/setup.ts";

const input = { baseUrl: "https://gateway.example" };

function described(id: string) {
  return [{ model: virtualModel({ id }), limits: {}, label: id }];
}

test("Claude profile paths cannot escape their output directory", () => {
  expect(claudeProfiles(described(".."), input)[0]?.path).toBe("%2E%2E/settings.json");
  expect(claudeProfiles(described("a\\b"), input)[0]?.path).toBe("a%5Cb/settings.json");
});

test("Claude profile paths stay distinct when readable slugs collide", () => {
  const profiles = claudeProfiles(
    ["a/b", "a\\b", "a-b", "..", "_.."].flatMap((id) => described(id)),
    input,
  );
  expect(new Set(profiles.map((file) => file.path)).size).toBe(profiles.length);
});

test("Claude profiles use discovery mirrors only when enabled", () => {
  const plain = JSON.parse(claudeProfiles(described("model"), input)[0]?.contents ?? "") as {
    env: Record<string, string>;
  };
  const mirrored = JSON.parse(
    claudeProfiles(described("model"), { ...input, discoveryMirrors: true })[0]?.contents ?? "",
  ) as { env: Record<string, string> };
  const visible = JSON.parse(
    claudeProfiles(described("claude-model"), { ...input, discoveryMirrors: true })[0]?.contents ??
      "",
  ) as { env: Record<string, string> };

  expect(plain.env.ANTHROPIC_MODEL).toBe("model");
  expect(mirrored.env.ANTHROPIC_MODEL).toBe("claude/model");
  expect(visible.env.ANTHROPIC_MODEL).toBe("claude-model");
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

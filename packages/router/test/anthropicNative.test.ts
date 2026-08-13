import { expect, test } from "bun:test";
import type { ChatRequest } from "@omni/ir";
import { credential, snapshot, target } from "@omni/testkit";
import { eligible, needsAnthropicNative } from "../src/filters.ts";

const NOW = 1_000_000;

const req: ChatRequest = {
  model: "fast",
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  stream: true,
};

const webSearch = {
  provider: "anthropic" as const,
  family: "webSearch" as const,
  type: "web_search_20250305",
  name: "web_search",
  wire: {},
};

const model = (targets: ReturnType<typeof target>[]) => ({
  id: "fast",
  strategy: "score" as const,
  isAlias: false,
  targets,
});

test("a portable custom tool needs nothing Anthropic-specific", () => {
  expect(
    needsAnthropicNative({
      ...req,
      tools: [{ provider: "custom", name: "f", inputSchema: {} }],
    }),
  ).toBe(false);
});

test("an Anthropic-defined tool makes the request Anthropic-native", () => {
  expect(needsAnthropicNative({ ...req, tools: [webSearch] })).toBe(true);
});

test("Anthropic-native history makes the request Anthropic-native", () => {
  expect(
    needsAnthropicNative({
      ...req,
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "anthropicNative",
              blockType: "web_search_tool_result",
              data: { tool_use_id: "srvtoolu_1", content: [] },
            },
          ],
        },
      ],
    }),
  ).toBe(true);
});

test("an Anthropic-native request excludes OpenAI and Kimi targets", () => {
  const { pairs, excluded } = eligible({
    request: { ...req, tools: [webSearch] },
    model: model([
      target({ provider: "openai", model: "gpt-5" }),
      target({ provider: "kimi", model: "k2" }),
      target({ provider: "anthropic", model: "claude-opus-4" }),
    ]),
    snapshot: snapshot({
      credentials: [
        credential({ id: "o", provider: "openai" }),
        credential({ id: "k", provider: "kimi" }),
        credential({ id: "a", provider: "anthropic" }),
      ],
    }),
    now: NOW,
    rand: 0,
    load: new Map(),
  });
  expect(pairs.map((p) => p.credential.id)).toEqual(["a"]);
  expect(excluded.map((e) => e.reason)).toEqual([
    "capability:anthropicTools",
    "capability:anthropicTools",
  ]);
});

test("a pool with no Anthropic target yields no candidates at all", () => {
  const { pairs } = eligible({
    request: { ...req, tools: [webSearch] },
    model: model([target({ provider: "openai", model: "gpt-5" })]),
    snapshot: snapshot({ credentials: [credential({ id: "o", provider: "openai" })] }),
    now: NOW,
    rand: 0,
    load: new Map(),
  });
  expect(pairs).toHaveLength(0);
});

test("a portable custom tool still routes to every provider", () => {
  const { pairs } = eligible({
    request: { ...req, tools: [{ provider: "custom", name: "f", inputSchema: {} }] },
    model: model([
      target({ provider: "openai", model: "gpt-5" }),
      target({ provider: "anthropic", model: "claude-opus-4" }),
    ]),
    snapshot: snapshot({
      credentials: [
        credential({ id: "o", provider: "openai" }),
        credential({ id: "a", provider: "anthropic" }),
      ],
    }),
    now: NOW,
    rand: 0,
    load: new Map(),
  });
  expect(pairs.map((p) => p.credential.id).sort()).toEqual(["a", "o"]);
});

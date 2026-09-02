import { expect, test } from "bun:test";
import type { AnthropicToolDef, ProviderToolDef, ToolDef } from "../src/request.ts";
import { estimateInputTokens } from "../src/tokens.ts";

/**
 * A hosted tool the Responses surface accepts: owned by a provider, carrying a
 * wire declaration this gateway never interprets, and with no Anthropic family
 * because Anthropic does not define it.
 */
const toolSearch: ProviderToolDef = {
  kind: "provider",
  provider: "openai",
  type: "tool_search",
  name: "tool_search",
  wire: { max_results: 5 },
};

const webSearch: AnthropicToolDef = {
  kind: "provider",
  provider: "anthropic",
  family: "webSearch",
  type: "web_search_20250305",
  name: "web_search",
  wire: { max_uses: 5 },
};

test("a provider tool needs no Anthropic family to be a ToolDef", () => {
  const tools: ToolDef[] = [toolSearch, webSearch];
  expect(tools.map((t) => (t.kind === "provider" ? t.provider : "portable"))).toEqual([
    "openai",
    "anthropic",
  ]);
  expect(toolSearch.family).toBeUndefined();
});

test("an Anthropic tool still narrows to one carrying a family", () => {
  // The alias is what keeps `ingress/anthropicTools.ts` and the Anthropic
  // encoder reading `family` without a check: omitting it is a type error, and
  // an unused directive here is a typecheck failure, so relaxing the alias
  // fails the build rather than going quiet.
  // @ts-expect-error - family is required on the Anthropic narrowing
  const missingFamily: AnthropicToolDef = {
    kind: "provider",
    provider: "anthropic",
    type: "web_search_20250305",
    name: "web_search",
    wire: {},
  };
  expect(missingFamily.provider).toBe("anthropic");
});

test("a hosted tool's wire declaration is charged for, like any other tool", () => {
  const request = {
    model: "gpt-5.6",
    messages: [{ role: "user" as const, content: [{ type: "text" as const, text: "hi" }] }],
    stream: false,
  };
  const withTool = estimateInputTokens({ ...request, tools: [toolSearch] });
  expect(withTool).toBeGreaterThan(estimateInputTokens(request));
});

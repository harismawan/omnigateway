import { describe, expect, test } from "bun:test";
import type { ChatRequest } from "@omni/ir";
import { toWire } from "../../../../packages/providers/src/anthropic/wire.ts";
import { toAntigravityWire } from "../../../../packages/providers/src/antigravity/wire.ts";
import { toKiloWire } from "../../../../packages/providers/src/kilo/wire.ts";
import { toChatWire } from "../../../../packages/providers/src/kimi/wire.ts";
import {
  toCustomChatWire,
  toCustomResponsesWire,
} from "../../../../packages/providers/src/custom/wire.ts";
import { toGrokWire } from "../../../../packages/providers/src/grok/wire.ts";
import { toMuseWire } from "../../../../packages/providers/src/muse/wire.ts";
import { toResponsesWire } from "../../../../packages/providers/src/openai/wire.ts";
import { parseAnthropicRequest } from "../../src/ingress/anthropic.ts";
import { parseResponsesRequest } from "../../src/ingress/responses.ts";

const encoders = [
  ["openai", toResponsesWire, "auto"],
  ["muse", toMuseWire, "auto"],
  ["grok", toGrokWire, "concise"],
  ["custom", toCustomResponsesWire, "auto"],
] as const;

for (const [provider, encode, summary] of encoders) {
  describe(`${provider} reasoning display`, () => {
    for (const stream of [false, true]) {
      for (const display of [undefined, "summarized", "omitted", "updates"] as const) {
        test(`${display ?? "default"}, stream=${stream}`, () => {
          const req: ChatRequest = {
            model: "m",
            messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
            stream,
            reasoning: { mode: "adaptive", effort: "high", ...(display ? { display } : {}) },
          };
          expect(encode(req, "m").body.reasoning).toEqual({
            effort: "high",
            ...(display === undefined || display === "summarized" ? { summary } : {}),
          });
        });
      }
      test(`Responses summary none, stream=${stream}`, () => {
        const req = parseResponsesRequest({
          model: "m",
          input: "hi",
          stream,
          reasoning: { effort: "high", summary: "none" },
        });
        expect(req.reasoning).toEqual({ mode: "adaptive", effort: "high", display: "omitted" });
        expect(encode(req, "m").body.reasoning).toEqual({ effort: "high" });
      });
    }
  });
}

const betweenToolsBody = {
  model: "claude-sonnet-5-5",
  max_tokens: 100,
  messages: [
    { role: "user", content: "hi" },
    {
      role: "assistant",
      content: [{ type: "thinking", thinking: "Progress", signature: "signed" }],
    },
    { role: "user", content: "continue" },
  ],
  thinking: { type: "between_tools" },
};

describe("between-tools reasoning", () => {
  test("accepts the known form, rejects unknown forms", () => {
    expect(parseAnthropicRequest(betweenToolsBody).reasoning).toEqual({ mode: "betweenTools" });
    expect(() =>
      parseAnthropicRequest({ ...betweenToolsBody, thinking: { type: "unknown" } }),
    ).toThrow();
  });
  for (const stream of [false, true]) {
    test(`Anthropic preserves thinking and signed progress, stream=${stream}`, () => {
      const req = parseAnthropicRequest({ ...betweenToolsBody, stream });
      const { body } = toWire(req, req.model, { oauth: false });
      expect(body.thinking).toEqual({ type: "between_tools" });
      expect(body.messages[1]).toEqual(betweenToolsBody.messages[1]);
    });
    for (const [provider, encode] of [
      ...encoders,
      ["custom", toCustomChatWire],
      ["kilo", toKiloWire],
      ["kimi", toChatWire],
      [
        "antigravity",
        (req: ChatRequest, model: string) =>
          toAntigravityWire(req, model, { project: "p", requestId: "test" }),
      ],
    ] as const) {
      test(`${provider} degrades to off, stream=${stream}`, () => {
        const req = parseAnthropicRequest({ ...betweenToolsBody, stream });
        const actual = encode(req, "m");
        expect(actual.body).toEqual(encode({ ...req, reasoning: { mode: "off" } }, "m").body);
        expect(actual.degradations).toContain(`${provider}:reasoning-between-tools-as-off`);
      });
    }
  }
});

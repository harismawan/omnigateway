import { describe, expect, test } from "bun:test";
import type { ChatRequest } from "@omni/ir";
import { toCustomResponsesWire } from "../../../../packages/providers/src/custom/wire.ts";
import { toGrokWire } from "../../../../packages/providers/src/grok/wire.ts";
import { toMuseWire } from "../../../../packages/providers/src/muse/wire.ts";
import { toResponsesWire } from "../../../../packages/providers/src/openai/wire.ts";
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

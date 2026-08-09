import { expect, test } from "bun:test";
import { modelSchema } from "../src/schemas.ts";

const model = (limits: Record<string, unknown>) => ({
  id: "m",
  strategy: "score" as const,
  isAlias: false,
  targets: [
    {
      provider: "anthropic" as const,
      model: "claude-opus-5",
      tier: 1,
      weight: 1,
      costPerMTok: { input: 5, output: 25 },
      ...limits,
      capabilities: { tools: true, images: true, reasoning: true },
    },
  ],
});

test("keeps the token limits a target was saved with", () => {
  const parsed = modelSchema.parse(model({ contextWindow: 1_000_000, maxOutputTokens: 128_000 }));
  expect(parsed.targets[0]?.contextWindow).toBe(1_000_000);
  expect(parsed.targets[0]?.maxOutputTokens).toBe(128_000);
});

test("a target that names no limits stays silent rather than claiming zero", () => {
  const parsed = modelSchema.parse(model({}));
  expect(parsed.targets[0]?.contextWindow).toBeUndefined();
  expect(parsed.targets[0]?.maxOutputTokens).toBeUndefined();
});

test("rejects a limit that is not a whole number of tokens", () => {
  expect(() => modelSchema.parse(model({ contextWindow: 0 }))).toThrow();
  expect(() => modelSchema.parse(model({ maxOutputTokens: 1.5 }))).toThrow();
});

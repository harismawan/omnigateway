import { expect, test } from "bun:test";
import type { ProviderId } from "@omni/ir";
import { isProviderId } from "../src/connect.ts";
import { modelSchema, providerIdSchema } from "../src/schemas.ts";

const target = (provider: string) => ({
  provider,
  model: "anthropic/claude-sonnet-5",
  tier: 1,
  weight: 1,
  costPerMTok: { input: 2, output: 10 },
  capabilities: { tools: true, images: true, reasoning: true },
});

const model = (provider: string) => ({
  id: "fast",
  strategy: "score" as const,
  isAlias: false,
  targets: [target(provider)],
});

/**
 * The three provider lists that TypeScript cannot check against `ProviderId`.
 *
 * `providerIdSchema` gates credential creation and the target union gates model
 * configuration, so a provider present in one and missing from the other
 * produces a build that connects an account it can never route to.
 */
test("a kilo credential can be created and a kilo target can be configured", () => {
  expect(providerIdSchema.parse("kilo")).toBe("kilo");
  expect(modelSchema.parse(model("kilo")).targets[0]?.provider).toBe("kilo");
  expect(isProviderId("kilo")).toBe(true);
});

test("every provider id but custom can back a plain target", () => {
  const ids: ProviderId[] = ["anthropic", "openai", "kimi", "kilo", "grok"];
  for (const id of ids) {
    expect(providerIdSchema.parse(id)).toBe(id);
    expect(isProviderId(id)).toBe(true);
    expect(modelSchema.parse(model(id)).targets[0]?.provider).toBe(id);
  }

  // `custom` is its own arm of the union: it carries an endpoint id and would
  // be rejected by the shape above.
  expect(providerIdSchema.parse("custom")).toBe("custom");
  expect(() => modelSchema.parse(model("custom"))).toThrow();
});

test("a provider that does not exist is refused everywhere", () => {
  expect(() => providerIdSchema.parse("kilocode")).toThrow();
  expect(isProviderId("kilocode")).toBe(false);
  expect(() => modelSchema.parse(model("kilocode"))).toThrow();
});

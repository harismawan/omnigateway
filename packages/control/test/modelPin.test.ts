import { expect, test } from "bun:test";
import { modelSchema } from "../src/schemas.ts";

const model = (pin: Record<string, unknown>) => ({
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
      ...pin,
      capabilities: { tools: true, images: true, reasoning: true },
    },
  ],
});

const customModel = (pin: Record<string, unknown>) => ({
  id: "m",
  strategy: "score" as const,
  isAlias: false,
  targets: [
    {
      provider: "custom" as const,
      endpointId: "local",
      model: "llama",
      tier: 1,
      weight: 1,
      costPerMTok: { input: 0, output: 0 },
      ...pin,
      capabilities: { tools: true, images: true, reasoning: true },
    },
  ],
});

test("keeps the account a target is pinned to", () => {
  const parsed = modelSchema.parse(model({ credentialId: "cred-1" }));
  expect(parsed.targets[0]?.credentialId).toBe("cred-1");
});

test("a target that names no account stays unpinned rather than pinned to nothing", () => {
  expect(modelSchema.parse(model({})).targets[0]?.credentialId).toBeUndefined();
});

test("rejects an empty pin", () => {
  // Not a third state between pinned and unpinned: it is an id no credential
  // can ever match, which would read as an unpinned target and route nowhere.
  expect(() => modelSchema.parse(model({ credentialId: "" }))).toThrow();
  expect(() => modelSchema.parse(model({ credentialId: "   " }))).toThrow();
});

test("custom targets can be pinned too", () => {
  // The field is on both arms of the union. A custom endpoint may hold several
  // accounts, so it is exactly a case where pinning has something to say.
  expect(modelSchema.parse(customModel({ credentialId: "cred-2" })).targets[0]?.credentialId).toBe(
    "cred-2",
  );
});

test("accepts a pin naming an account this installation does not hold", () => {
  // Deliberate: validating the id here would make removing an account block
  // every later edit of a model that mentioned it, and the router already
  // reports the dangling pin as `pin:missing`.
  expect(modelSchema.parse(model({ credentialId: "deleted" })).targets[0]?.credentialId).toBe(
    "deleted",
  );
});

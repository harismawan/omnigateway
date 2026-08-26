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

test("normalizes surrounding whitespace rather than storing it", () => {
  // A pasted id is the common way one arrives. Stored untrimmed it matches no
  // credential and reports `pin:missing`, which reads as a deleted account.
  expect(modelSchema.parse(model({ credentialId: "  cred-1  " })).targets[0]?.credentialId).toBe(
    "cred-1",
  );
});

test("bounds the pin in length and charset", () => {
  // Not cosmetic. A `pin:missing` row carries this string into
  // `LogFields.credentialId` and `request_logs.degradations`, and that
  // allowlist documents the field as a bounded identifier — `reason` is the
  // free-text one, and only `reason` is truncated.
  expect(() => modelSchema.parse(model({ credentialId: "x".repeat(65) }))).toThrow();
  expect(modelSchema.parse(model({ credentialId: "x".repeat(64) })).targets[0]?.credentialId).toBe(
    "x".repeat(64),
  );
  expect(() => modelSchema.parse(model({ credentialId: "cred 1" }))).toThrow();
  expect(() => modelSchema.parse(model({ credentialId: "cred:1\nreason=spoofed" }))).toThrow();
  // A real id: `crypto.randomUUID()`. The format is deliberately not enforced,
  // so this passes on charset alone, not because the schema knows about UUIDs.
  expect(
    modelSchema.parse(model({ credentialId: "3f2a1b4c-5d6e-4f70-8a91-b2c3d4e5f607" })).targets[0]
      ?.credentialId,
  ).toBe("3f2a1b4c-5d6e-4f70-8a91-b2c3d4e5f607");
});

test("custom targets can be pinned too", () => {
  // The field is on both arms of the union. A custom endpoint may hold several
  // accounts, so it is exactly a case where pinning has something to say.
  expect(modelSchema.parse(customModel({ credentialId: "cred-2" })).targets[0]?.credentialId).toBe(
    "cred-2",
  );
});

test("bounds a custom target's pin the same way, not by looking like it does", () => {
  // The two arms of the union carry their own copy of the field, so every rule
  // the anthropic arm is tested for is untested here — and a custom pin reaches
  // `LogFields.credentialId` and `request_logs.degradations` by exactly the same
  // route. The bound is what makes that field the bounded identifier its own
  // allowlist documents.
  expect(() => modelSchema.parse(customModel({ credentialId: "x".repeat(65) }))).toThrow();
  expect(
    modelSchema.parse(customModel({ credentialId: "x".repeat(64) })).targets[0]?.credentialId,
  ).toBe("x".repeat(64));
  expect(() => modelSchema.parse(customModel({ credentialId: "cred 2" }))).toThrow();
  expect(() =>
    modelSchema.parse(customModel({ credentialId: "cred:2\nreason=spoofed" })),
  ).toThrow();
  expect(() => modelSchema.parse(customModel({ credentialId: "" }))).toThrow();
  expect(() => modelSchema.parse(customModel({ credentialId: "   " }))).toThrow();
  expect(
    modelSchema.parse(customModel({ credentialId: "  cred-2  " })).targets[0]?.credentialId,
  ).toBe("cred-2");
});

test("accepts a pin naming an account this installation does not hold", () => {
  // Deliberate: validating the id here would make removing an account block
  // every later edit of a model that mentioned it, and the router already
  // reports the dangling pin as `pin:missing`.
  expect(modelSchema.parse(model({ credentialId: "deleted" })).targets[0]?.credentialId).toBe(
    "deleted",
  );
});

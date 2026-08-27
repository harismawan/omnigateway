import { expect, test } from "bun:test";
import { GatewayError } from "@omni/ir";
import { PROVIDER_DESCRIPTORS } from "@omni/providers/descriptors";
import { snapshot, target } from "@omni/testkit";
import { resolveModel } from "../src/resolve.ts";

test("resolves a configured virtual model by id", () => {
  const vm = {
    id: "fast",
    strategy: "score" as const,
    isAlias: false,
    targets: [target({ model: "claude-opus-4" })],
  };
  const resolved = resolveModel("fast", snapshot({ models: [vm] }));
  expect(resolved.id).toBe("fast");
  expect(resolved.targets).toHaveLength(1);
});

test("synthesises a single-target model from provider/model syntax", () => {
  const resolved = resolveModel("anthropic/claude-opus-4", snapshot({}));
  expect(resolved.isAlias).toBe(true);
  expect(resolved.strategy).toBe("score");
  expect(resolved.targets).toEqual([
    {
      provider: "anthropic",
      model: "claude-opus-4",
      tier: 1,
      weight: 1,
      costPerMTok: { input: 0, output: 0 },
      capabilities: { tools: true, images: true, reasoning: true },
    },
  ]);
});

test("accepts a colon separator as well as a slash", () => {
  expect(resolveModel("kimi:kimi-k2", snapshot({})).targets[0]?.model).toBe("kimi-k2");
});

test("does not synthesize custom targets without endpoint metadata", () => {
  for (const name of ["custom/model", "custom:model"]) {
    expect(() => resolveModel(name, snapshot({}))).toThrow(GatewayError);
  }
});

test("keeps slashes inside the model portion intact", () => {
  const resolved = resolveModel("openai/org/gpt-5", snapshot({}));
  expect(resolved.targets[0]?.provider).toBe("openai");
  expect(resolved.targets[0]?.model).toBe("org/gpt-5");
});

test("takes capabilities from the registry for a synthesised target", () => {
  const resolved = resolveModel("kimi/kimi-k2", snapshot({}));
  expect(resolved.targets[0]?.capabilities).toEqual({
    tools: true,
    images: false,
    reasoning: false,
  });
});

test("infers the provider for a bare well-known model name", () => {
  const resolved = resolveModel("claude-sonnet-4-5", snapshot({}));
  expect(resolved.targets[0]?.provider).toBe("anthropic");
  expect(resolved.targets[0]?.model).toBe("claude-sonnet-4-5");
});

test("a configured virtual model wins over prefix inference", () => {
  const vm = {
    id: "claude-opus-4",
    strategy: "priority" as const,
    isAlias: false,
    targets: [target({ provider: "kimi" as const, model: "kimi-k2" })],
  };
  expect(resolveModel("claude-opus-4", snapshot({ models: [vm] })).targets[0]?.provider).toBe(
    "kimi",
  );
});

test("throws NO_CANDIDATES for an unresolvable name", () => {
  try {
    resolveModel("does-not-exist", snapshot({}));
    throw new Error("expected throw");
  } catch (e) {
    expect(e).toBeInstanceOf(GatewayError);
    expect((e as GatewayError).code).toBe("NO_CANDIDATES");
  }
});

test("rejects an unknown provider prefix rather than guessing", () => {
  expect(() => resolveModel("bedrock/claude", snapshot({}))).toThrow(GatewayError);
});

test("a provider registered after import is reachable by both of its names", () => {
  // Both branches of `resolveModel`, because they disagreed. The explicit
  // `provider/model` branch reads the registry directly and was already correct;
  // the bare-name branch iterated `PREFIX_PROVIDER`, an `Object.entries(...)`
  // evaluated at import — long before `loadPlugins()` — so a provider registered
  // at boot could be reached one way and not the other, inside one function.
  //
  // Measured before the fix: `prefixed/x` resolved, `pfx-1` threw
  // NO_CANDIDATES. The asymmetry is the bug; a plugin provider declaring
  // `modelPrefixes` would have had them silently ignored.
  const registry = PROVIDER_DESCRIPTORS as unknown as Record<string, unknown>;
  const seed = PROVIDER_DESCRIPTORS.anthropic;

  // Absent first, so the assertions below cannot pass by the id having been
  // there all along.
  expect(() => resolveModel("pfx-1", snapshot({}))).toThrow(GatewayError);

  registry.prefixed = { ...seed, id: "prefixed", modelPrefixes: ["pfx-"] };
  try {
    expect(resolveModel("prefixed/x", snapshot({})).targets[0]?.provider).toBe("prefixed");
    expect(resolveModel("pfx-1", snapshot({})).targets[0]?.provider).toBe("prefixed");
  } finally {
    delete registry.prefixed;
  }

  // And gone again, so nothing leaks into another test in this file.
  expect(() => resolveModel("pfx-1", snapshot({}))).toThrow(GatewayError);
});

test("longest match still wins once prefixes are read per call", () => {
  // The property the sort exists for, re-asserted against the per-call build:
  // a shorter prefix registered later must not shadow a longer one.
  const registry = PROVIDER_DESCRIPTORS as unknown as Record<string, unknown>;
  const seed = PROVIDER_DESCRIPTORS.anthropic;
  registry.shortpfx = { ...seed, id: "shortpfx", modelPrefixes: ["dup-"] };
  registry.longpfx = { ...seed, id: "longpfx", modelPrefixes: ["dup-long-"] };
  try {
    expect(resolveModel("dup-long-1", snapshot({})).targets[0]?.provider).toBe("longpfx");
    expect(resolveModel("dup-1", snapshot({})).targets[0]?.provider).toBe("shortpfx");
  } finally {
    delete registry.shortpfx;
    delete registry.longpfx;
  }
});

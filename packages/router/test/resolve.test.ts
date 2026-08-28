import { expect, test } from "bun:test";
import { GatewayError } from "@omni/ir";
import { PROVIDER_DESCRIPTORS, type ProviderDescriptors } from "@omni/providers/descriptors";
import { entryOf, snapshot, target } from "@omni/testkit";
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

test("a provider the registry gains is reachable by both of its names", () => {
  // Both branches of `resolveModel`, because they disagreed. The explicit
  // `provider/model` branch read the registry directly and was already correct;
  // the bare-name branch iterated a module-scope `Object.entries(...)` built at
  // import — long before `loadPlugins()` — so a provider registered at boot
  // could be reached one way and not the other, inside one function. Measured
  // before the fix: `prefixed/x` resolved, `pfx-1` threw NO_CANDIDATES.
  //
  // Handed as a parameter rather than written into the global. An earlier
  // version of this test mutated `PROVIDER_DESCRIPTORS` and restored it in a
  // `finally`, which is a shared mutable global under a runner that interleaves
  // files — the same pattern that made a doctor test fail one run in six when a
  // second suite registered an id it asserted absent.
  const installed: ProviderDescriptors = {
    ...PROVIDER_DESCRIPTORS,
    prefixed: {
      ...entryOf(PROVIDER_DESCRIPTORS, "anthropic"),
      id: "prefixed",
      modelPrefixes: ["pfx-"],
    },
  };

  // Against the real registry, which has neither name.
  expect(() => resolveModel("pfx-1", snapshot({}))).toThrow(GatewayError);
  expect(() => resolveModel("prefixed/x", snapshot({}))).toThrow(GatewayError);

  // Against one that does. Both branches, or the asymmetry is back.
  expect(resolveModel("prefixed/x", snapshot({}), installed).targets[0]?.provider).toBe("prefixed");
  expect(resolveModel("pfx-1", snapshot({}), installed).targets[0]?.provider).toBe("prefixed");
});

test("longest match still wins once prefixes are read per call", () => {
  // The property the sort exists for, re-asserted against the per-call build: a
  // shorter prefix must not shadow a longer one that extends it.
  const seed = entryOf(PROVIDER_DESCRIPTORS, "anthropic");
  const installed: ProviderDescriptors = {
    ...PROVIDER_DESCRIPTORS,
    shortpfx: { ...seed, id: "shortpfx", modelPrefixes: ["dup-"] },
    longpfx: { ...seed, id: "longpfx", modelPrefixes: ["dup-long-"] },
  };

  expect(resolveModel("dup-long-1", snapshot({}), installed).targets[0]?.provider).toBe("longpfx");
  expect(resolveModel("dup-1", snapshot({}), installed).targets[0]?.provider).toBe("shortpfx");
});

test("an injected registry that is an ordinary object refuses inherited keys", () => {
  // A caller's registry may carry a prototype — a spread of the real one does —
  // so neither branch may rely on the table being null-prototype. Before this,
  // `constructor/x` passed the existence check and threw a `TypeError` out of
  // `synthesize`, which reached the client as a 500 carrying an internal
  // expression.
  const ordinary: ProviderDescriptors = { ...PROVIDER_DESCRIPTORS };
  expect(Object.getPrototypeOf(ordinary)).not.toBeNull();

  for (const name of ["constructor/x", "toString/x", "valueOf:x"]) {
    expect(() => resolveModel(name, snapshot({}), ordinary)).toThrow(GatewayError);
  }
  // The positive control: a real provider still resolves through the same table.
  expect(resolveModel("anthropic/claude-opus-5", snapshot({}), ordinary).targets[0]?.provider).toBe(
    "anthropic",
  );
});

test("a synthesized target is priced from the descriptor, not the id-keyed global", () => {
  // `registerProvider` mutates `PROVIDER_DESCRIPTORS` and deliberately not
  // `PROVIDER_MODEL_CATALOG`, so a provider from `<root>/plugins/` exists in the
  // first and never the second. Pricing through the second gave every such
  // model `{input: 0, output: 0}` — which the scorer reads as "unpriced" and
  // `priceOf` bills as free: `costUsd` of 0, spend limits that never
  // accumulate, `usage_daily` recording nothing. No throw, no degradation.
  //
  // The plugin host *requires* `catalog` and `modelPrefixes` to register, so the
  // plugin was forced to supply prices the router then ignored.
  const seed = entryOf(PROVIDER_DESCRIPTORS, "anthropic");
  const installed: ProviderDescriptors = {
    ...PROVIDER_DESCRIPTORS,
    sentinel: {
      ...seed,
      id: "sentinel",
      modelPrefixes: ["sent-"],
      catalog: {
        defaultModel: "sent-1",
        authTypes: ["apiKey"],
        models: [
          {
            id: "sent-1",
            label: "Sentinel One",
            pricing: {
              input: 5,
              output: 25,
              cacheRead: 0.5,
              cacheWrite5m: 6.25,
              cacheWrite1h: 10,
            },
            limits: { contextWindow: 200_000, maxOutputTokens: 8_192 },
          },
        ],
      },
    },
  };

  // Both branches: the bare name inferred from its prefix, and the explicit
  // `provider/model` form. Each reaches `synthesize` by a different route.
  for (const name of ["sent-1", "sentinel/sent-1"]) {
    const target = resolveModel(name, snapshot({}), installed).targets[0];
    expect(target?.provider).toBe("sentinel");
    expect(target?.costPerMTok).toEqual({
      input: 5,
      output: 25,
      cacheRead: 0.5,
      cacheWrite5m: 6.25,
      cacheWrite1h: 10,
    });
    // Limits travel with the price, or a target carrying one and not the other
    // is a trap for the next reader.
    expect(target?.contextWindow).toBe(200_000);
    expect(target?.maxOutputTokens).toBe(8_192);
  }
});

test("a model the descriptor does not list is still unpriced, not invented", () => {
  // The other half. Zero here is the documented "unpriced" case the scorer
  // drops from the cost term — the bug was that *every* plugin model looked
  // like this, not that this case exists.
  const seed = entryOf(PROVIDER_DESCRIPTORS, "anthropic");
  const installed: ProviderDescriptors = {
    ...PROVIDER_DESCRIPTORS,
    sentinel: { ...seed, id: "sentinel", modelPrefixes: ["sent-"] },
  };

  const target = resolveModel("sent-unlisted", snapshot({}), installed).targets[0];
  expect(target?.costPerMTok).toEqual({ input: 0, output: 0 });
  expect(target?.contextWindow).toBeUndefined();
});

test("a built-in still prices exactly as it did", () => {
  // The positive control, and the equivalence that matters for everything that
  // already worked: for a built-in the descriptor's catalog *is* the global's
  // entry, so this must be unchanged.
  const viaPrefix = resolveModel("claude-opus-5", snapshot({})).targets[0];
  expect(viaPrefix?.provider).toBe("anthropic");
  expect(viaPrefix?.costPerMTok.input).toBeGreaterThan(0);
  expect(viaPrefix?.costPerMTok.output).toBeGreaterThan(0);
});

import { expect, test } from "bun:test";
import type { ProviderId } from "@omni/ir";
import { catalogLimits, catalogPricing, PROVIDER_MODEL_CATALOG } from "../src/catalog.ts";
import type { HttpRequest, HttpResponse } from "../src/index.ts";
import { ADAPTERS } from "../src/registry.ts";
import { entry as tableEntry } from "./entry.ts";

const PROVIDERS = [
  "anthropic",
  "openai",
  "kimi",
  "kilo",
  "grok",
  "muse",
  "custom",
] as const satisfies readonly ProviderId[];

const EXPECTED = {
  anthropic: {
    defaultModel: "claude-opus-5",
    ids: [
      "claude-fable-5-1",
      "claude-fable-5",
      "claude-opus-5",
      "claude-sonnet-5",
      "claude-haiku-4-5",
    ],
  },
  openai: {
    defaultModel: "gpt-5.6",
    ids: ["gpt-6-astra", "gpt-5.6", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"],
  },
  kimi: {
    defaultModel: "k3-256k",
    ids: ["k3-256k", "k3", "kimi-for-coding", "kimi-for-coding-highspeed"],
  },
  kilo: {
    defaultModel: "anthropic/claude-sonnet-5",
    ids: [
      "anthropic/claude-fable-5",
      "anthropic/claude-opus-5",
      "anthropic/claude-sonnet-5",
      "anthropic/claude-haiku-4.5",
      "openai/gpt-5.6-sol",
      "openai/gpt-5.6-terra",
      "openai/gpt-5.6-luna",
      "google/gemini-3.1-pro-preview",
      "google/gemini-3.7-flash",
      "moonshotai/kimi-k3",
      "nvidia/nemotron-3-ultra-550b-a55b:free",
      "nvidia/nemotron-3.5-lightning:free",
      "dots-studio/dots-3-note-preview:free",
      "cohere/north-mini-code:free",
      "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
      "stepfun/step-3.7-flash:free",
      "nvidia/nemotron-3-super-120b-a12b:free",
      "tencent/hy3:free",
      "poolside/laguna-s-2.1:free",
      "poolside/laguna-xs-2.1:free",
      "liquid/lfm-2.5-2.6b:free",
      "nvidia/nemotron-3.5-content-safety:free",
      "kilo-auto/frontier",
      "kilo-auto/balanced",
      "kilo-auto/efficient",
      "kilo-auto/small",
      "kilo-auto/free",
    ],
  },
  grok: {
    defaultModel: "grok-4.6",
    ids: [
      "grok-4.6",
      "grok-4.5",
      "grok-4.3",
      "grok-4.20-0309-reasoning",
      "grok-4.20-0309-non-reasoning",
      "grok-4.20-multi-agent-0309",
    ],
  },
  muse: {
    defaultModel: "muse-spark-1.3",
    ids: [
      "muse-spark-1.3",
      "muse-spark-1.3-contributor",
      "muse-spark-1.2",
      "muse-spark-1.2-contributor",
    ],
  },
  custom: { defaultModel: "", ids: [] },
} as const;

test("catalog covers every provider with ordered curated IDs", () => {
  expect(Object.keys(PROVIDER_MODEL_CATALOG).sort()).toEqual([...PROVIDERS].sort());

  for (const provider of PROVIDERS) {
    const entry = tableEntry(PROVIDER_MODEL_CATALOG, provider, "PROVIDER_MODEL_CATALOG");
    expect(entry.defaultModel).toBe(EXPECTED[provider].defaultModel);
    expect(entry.models.map((model) => model.id)).toEqual([...EXPECTED[provider].ids]);
  }
});

test("catalog entries have non-empty unique values and exactly one default", () => {
  for (const provider of PROVIDERS) {
    const entry = tableEntry(PROVIDER_MODEL_CATALOG, provider, "PROVIDER_MODEL_CATALOG");
    const ids = entry.models.map((model) => model.id);

    if (provider === "custom") {
      expect(entry.defaultModel).toBe("");
      expect(ids).toEqual([]);
      continue;
    }
    expect(entry.defaultModel.length).toBeGreaterThan(0);
    expect(entry.models.every((model) => model.id.length > 0 && model.label.length > 0)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.filter((id) => id === entry.defaultModel)).toHaveLength(1);
  }
});

/**
 * The kilo entries the price invariant below cannot speak for, listed by id
 * rather than matched by shape so a new entry cannot join them by accident.
 *
 * `kilo-auto/free` and the `:free` tier really do cost nothing. The three
 * tiered routers report no price at all upstream because they choose a model
 * per request, which lands on the same stored 0 for the opposite reason. Both
 * kinds are checked on their own terms in the two tests that follow.
 * `kilo-auto/small` is deliberately absent: it states a full rate, cache read
 * included, so the invariant covers it like any other model.
 */
const KILO_UNPRICED: readonly string[] = [
  "nvidia/nemotron-3-ultra-550b-a55b:free",
  "nvidia/nemotron-3.5-lightning:free",
  "dots-studio/dots-3-note-preview:free",
  "cohere/north-mini-code:free",
  "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
  "stepfun/step-3.7-flash:free",
  "nvidia/nemotron-3-super-120b-a12b:free",
  "tencent/hy3:free",
  "poolside/laguna-s-2.1:free",
  "poolside/laguna-xs-2.1:free",
  "liquid/lfm-2.5-2.6b:free",
  "nvidia/nemotron-3.5-content-safety:free",
  "kilo-auto/frontier",
  "kilo-auto/balanced",
  "kilo-auto/efficient",
  "kilo-auto/free",
];

test("every model carries a usable price", () => {
  for (const provider of PROVIDERS) {
    for (const model of tableEntry(PROVIDER_MODEL_CATALOG, provider, "PROVIDER_MODEL_CATALOG")
      .models) {
      if (provider === "kilo" && KILO_UNPRICED.includes(model.id)) continue;
      const { input, output, cacheRead } = model.pricing;
      // A zero price is read by the router as "unpriced", which would silently
      // remove this model from cost ranking.
      expect(input).toBeGreaterThan(0);
      expect(output).toBeGreaterThan(0);
      expect(cacheRead).toBeGreaterThan(0);
      // Output is never cheaper than input, and a cache read never costs more
      // than reading the same tokens fresh.
      expect(output).toBeGreaterThanOrEqual(input);
      expect(cacheRead).toBeLessThanOrEqual(input);
    }
  }
});

test("kilo states a price for everything except its free tier and its routers", () => {
  const free = tableEntry(PROVIDER_MODEL_CATALOG, "kilo", "PROVIDER_MODEL_CATALOG")
    .models.filter((model) => model.pricing.input === 0 && model.pricing.output === 0)
    .map((model) => model.id);

  expect(free).toEqual([...KILO_UNPRICED]);
  // The one router that does state a price states it in full, cache read
  // included.
  expect(catalogPricing("kilo", "kilo-auto/small")).toEqual({
    input: 0.05,
    output: 0.4,
    cacheRead: 0.005,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
  });
  // And a vendor-namespaced row is priced like any other model.
  expect(catalogPricing("kilo", "anthropic/claude-sonnet-5")).toEqual({
    input: 2,
    output: 10,
    cacheRead: 0.2,
    cacheWrite5m: 2.5,
    cacheWrite1h: 2.5,
  });
});

test("kilo advertises the exact windows its upstreams report", () => {
  // `GET /v1/models` states these to the client, so a rounded figure is a
  // client-visible bug: a window advertised ~1,400 tokens wider than the model
  // holds produces a request sized to fit that the upstream rejects. The rows
  // are not uniform — each carries whatever its own vendor reports.
  expect(catalogLimits("kilo", "google/gemini-3.1-pro-preview")).toEqual({
    contextWindow: 1_048_576,
    maxOutputTokens: 65_536,
  });
  expect(catalogLimits("kilo", "moonshotai/kimi-k3")).toEqual({
    contextWindow: 1_048_576,
    maxOutputTokens: 131_072,
  });
  expect(catalogLimits("kilo", "poolside/laguna-s-2.1:free")).toEqual({
    contextWindow: 262_144,
    maxOutputTokens: 32_768,
  });
  expect(catalogLimits("kilo", "liquid/lfm-2.5-2.6b:free")).toEqual({
    contextWindow: 128_000,
    maxOutputTokens: 8_192,
  });
  expect(catalogLimits("kilo", "kilo-auto/small")).toEqual({
    contextWindow: 262_144,
    maxOutputTokens: 32_768,
  });
  // And the decimal rows really are decimal, so a blanket conversion to
  // powers of two would be just as wrong.
  expect(catalogLimits("kilo", "anthropic/claude-opus-5")).toEqual({
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
  });
});

test("the auth a credential uses selects which window is advertised", () => {
  // `oauthLimits` is the Codex backend, which an OAuth credential is routed to
  // and an API key never sees — a genuinely narrower surface for the same model
  // id. Two callers pass an explicit `auth`: `anthropic/index.ts` and
  // `resolveModelLimits`, whose number `setup.ts` writes into
  // `CLAUDE_CODE_MAX_CONTEXT_TOKENS`, where being wrong outlives the request
  // that would expose it.
  //
  // Both arms and the default, because the branch is one line and every mutant
  // of it — dropping `oauthLimits`, flipping the default — was surviving the
  // whole suite. `synthesize` is the only caller reaching the default, and it
  // has no credential to ask, so `"apiKey"` is the wider and honest answer.
  expect(catalogLimits("openai", "gpt-5.6", "oauth")).toEqual({
    contextWindow: 272_000,
    maxOutputTokens: 128_000,
  });
  expect(catalogLimits("openai", "gpt-5.6", "apiKey")).toEqual({
    contextWindow: 922_000,
    maxOutputTokens: 128_000,
  });
  expect(catalogLimits("openai", "gpt-5.6")).toEqual(catalogLimits("openai", "gpt-5.6", "apiKey"));

  // A model stating no `oauthLimits` answers the same either way: absence means
  // one set covers both ways in, never "no limits over OAuth".
  expect(catalogLimits("anthropic", "claude-opus-5", "oauth")).toEqual(
    catalogLimits("anthropic", "claude-opus-5", "apiKey"),
  );
  expect(catalogLimits("anthropic", "claude-opus-5", "oauth")).not.toBeNull();
});

test("kilo records the cache-write price its upstreams report", () => {
  // Every row that states a write price, exhaustively: a sampled assertion
  // leaves the unsampled rows free to be silently zeroed. A row missing here
  // reports no write price at all upstream — Moonshot's and the routers' — and
  // that zero is real rather than absent.
  const WRITE: Readonly<Record<string, number>> = {
    "anthropic/claude-fable-5": 12.5,
    "anthropic/claude-opus-5": 6.25,
    "anthropic/claude-sonnet-5": 2.5,
    "anthropic/claude-haiku-4.5": 1.25,
    "openai/gpt-5.6-sol": 6.25,
    "openai/gpt-5.6-terra": 2.5,
    "openai/gpt-5.6-luna": 0.25,
    "google/gemini-3.1-pro-preview": 0.375,
    // Recorded to the digit Kilo states it to; the one figure a rounding pass
    // would quietly change.
    "google/gemini-3.7-flash": 0.041667,
  };

  const priced = Object.fromEntries(
    tableEntry(PROVIDER_MODEL_CATALOG, "kilo", "PROVIDER_MODEL_CATALOG")
      .models.filter(
        (model) => model.pricing.cacheWrite5m !== 0 || model.pricing.cacheWrite1h !== 0,
      )
      .map((model) => [model.id, model.pricing.cacheWrite5m]),
  );
  expect(priced).toEqual(WRITE);

  // One figure repeated across both TTLs: Kilo reports a single
  // `input_cache_write` price, and this wire cannot express a TTL at all.
  for (const model of tableEntry(PROVIDER_MODEL_CATALOG, "kilo", "PROVIDER_MODEL_CATALOG").models) {
    expect({ id: model.id, oneHour: model.pricing.cacheWrite1h }).toEqual({
      id: model.id,
      oneHour: model.pricing.cacheWrite5m,
    });
  }
});

test("kilo's free tier and routers are gateway-only", () => {
  for (const model of tableEntry(PROVIDER_MODEL_CATALOG, "kilo", "PROVIDER_MODEL_CATALOG").models) {
    const gatewayOnly = model.id.endsWith(":free") || model.id.startsWith("kilo-auto/");
    // An absent `auth` means both ways in, which is what the vendor-namespaced
    // models are: only the gateway backend serves the free tier and the
    // routers, so an OAuth credential cannot reach them.
    expect({ id: model.id, auth: model.auth ?? null }).toEqual({
      id: model.id,
      auth: gatewayOnly ? ["apiKey"] : null,
    });
  }
});

test("Kimi labels describe coding endpoint aliases", () => {
  expect(
    tableEntry(PROVIDER_MODEL_CATALOG, "kimi", "PROVIDER_MODEL_CATALOG").models.map(
      (model) => model.label,
    ),
  ).toEqual([
    "Kimi K3 — 256K",
    "Kimi K3 — up to 1M",
    "Kimi K2.7 Code",
    "Kimi K2.7 Code — High Speed",
  ]);
});

test("the high-speed coding endpoint doubles output and leaves input alone", () => {
  const standard = catalogPricing("kimi", "kimi-for-coding");
  const highspeed = catalogPricing("kimi", "kimi-for-coding-highspeed");
  if (standard === null || highspeed === null) throw new Error("coding endpoints are not listed");

  expect(highspeed.input).toBe(standard.input);
  expect(highspeed.output).toBe(standard.output * 2);
});

test("the bare OpenAI alias is priced as the tier it routes to", () => {
  expect(catalogPricing("openai", "gpt-5.6")).toEqual(catalogPricing("openai", "gpt-5.6-sol"));
});

test("catalogPricing reports an unlisted model rather than guessing", () => {
  expect(catalogPricing("anthropic", "claude-opus-5")).toEqual({
    input: 5,
    output: 25,
    cacheRead: 0.5,
    // 1.25x and 2x of base input, which is what Anthropic charges to create a
    // cache entry at each TTL.
    cacheWrite5m: 6.25,
    cacheWrite1h: 10,
  });
  expect(catalogPricing("anthropic", "some-model-we-do-not-list")).toBeNull();
  // A model listed under one provider is not priced under another.
  expect(catalogPricing("openai", "claude-opus-5")).toBeNull();
});

// --- authTypes ---------------------------------------------------------------
// `authTypes` is not a description, it is a promise: the console reads it and
// puts a key field, an authorize button, or both in front of the operator. An
// `apiKey` claim against an adapter that cannot use a raw key would produce a
// credential that stores, lists, and fails on first dispatch.

test("every provider states which credentials it can hold", () => {
  expect(
    Object.fromEntries(
      PROVIDERS.map((id) => [
        id,
        [...tableEntry(PROVIDER_MODEL_CATALOG, id, "PROVIDER_MODEL_CATALOG").authTypes].sort(),
      ]),
    ),
  ).toEqual({
    anthropic: ["apiKey", "oauth"],
    openai: ["apiKey", "oauth"],
    kimi: ["apiKey", "oauth"],
    kilo: ["apiKey", "oauth"],
    grok: ["apiKey", "oauth"],
    // A subscription is spent minting a Model API key, and a key made at
    // dev.meta.ai reaches the same host, so both ways in are real here.
    muse: ["apiKey", "oauth"],
    // The one provider with no authorization flow behind it.
    custom: ["apiKey"],
  });
});

test("an apiKey claim means the adapter really authenticates with a raw key", async () => {
  for (const id of PROVIDERS) {
    if (
      !tableEntry(PROVIDER_MODEL_CATALOG, id, "PROVIDER_MODEL_CATALOG").authTypes.includes("apiKey")
    )
      continue;

    let sent: HttpRequest | null = null;
    const result = await tableEntry(ADAPTERS, id, "ADAPTERS").send({
      request: {
        model: "cheap",
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        stream: true,
      },
      model:
        tableEntry(PROVIDER_MODEL_CATALOG, id, "PROVIDER_MODEL_CATALOG").defaultModel ||
        "some-model",
      // No access token. An adapter that only understands OAuth raises AUTH
      // here, which fails this test rather than reaching the assertion.
      credentials: {
        accessToken: null,
        apiKey: `${id}-raw-key`,
        providerData: { origin: "https://endpoint.example", protocol: "chat_completions" },
      },
      http: async (value): Promise<HttpResponse> => {
        sent = value;
        return {
          status: 200,
          headers: new Headers({ "content-type": "text/event-stream" }),
          body: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
              controller.close();
            },
          }),
          text: async () => "",
        };
      },
      signal: new AbortController().signal,
    });
    for await (const _ of result.events) {
      // drained so the adapter finishes and releases the stub response
    }

    if (sent === null) throw new Error(`${id} sent no request`);
    const carried = (sent as HttpRequest).headers.some(([, value]) =>
      value.includes(`${id}-raw-key`),
    );
    expect({ id, carried }).toEqual({ id, carried: true });
  }
});

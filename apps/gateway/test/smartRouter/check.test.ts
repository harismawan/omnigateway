import { expect, test } from "bun:test";
import { memoryCoord } from "@omni/coord";
import { type ChatRequest, GatewayError, type StreamEvent } from "@omni/ir";
import type { AdapterRequest, AdapterResult, HttpClient, ProviderAdapter } from "@omni/providers";
import { buildSnapshot } from "@omni/router";
import type { RequestLog, Settings, Store } from "@omni/store";
import {
  type CaptureLogger,
  captureLogger,
  memoryStore,
  requestLog,
  seedCredential,
  target,
  virtualModel,
} from "@omni/testkit";
import { createLoadRegistry } from "../../src/dispatch/loadRegistry.ts";
import { VerdictCache } from "../../src/guardrail/cache.ts";
import {
  CLASSIFIER_NOTE,
  checkConfidentiality,
  checkRow,
  MAX_UNCACHED_SEGMENTS,
  SEGMENT_CONCURRENCY,
  type SmartRouteDecision,
  type SmartRouterDeps,
  UNAVAILABLE_MESSAGE,
  UNCONFIGURED_MESSAGE,
} from "../../src/smartRouter/check.ts";
import type { Confidentiality } from "../../src/smartRouter/classifier.ts";

const POLICY = "POLICY-TEXT-salaries-and-passwords";
const USAGE = { inputTokens: 40, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };

const transport: HttpClient = () => {
  throw new Error("a stub adapter reached the transport");
};

async function* replay(events: readonly StreamEvent[]): AsyncGenerator<StreamEvent, void> {
  for (const event of events) yield event;
}

function reply(text: string): StreamEvent[] {
  return [
    { type: "start", id: "upstream", model: "local-judge" },
    { type: "blockStart", index: 0, block: { type: "text" } },
    { type: "blockDelta", index: 0, delta: { type: "text", text } },
    { type: "blockEnd", index: 0 },
    { type: "end", stopReason: "endTurn", usage: USAGE },
  ];
}

function hang(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) reject(signal.reason);
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

/** Everything the classifier was sent, as one string. */
function sent(call: AdapterRequest): string {
  return call.request.messages
    .flatMap((m) => m.content)
    .map((b) => (b.type === "text" ? b.text : ""))
    .join("\n");
}

/** A cache that remembers which verdicts were written. */
class SpyCache extends VerdictCache<Confidentiality> {
  readonly writes: Confidentiality[] = [];
  override set(key: string, verdict: Confidentiality, now: number): void {
    this.writes.push(verdict);
    super.set(key, verdict, now);
  }
}

type Harness = {
  store: Store;
  deps: SmartRouterDeps;
  cache: SpyCache;
  logger: CaptureLogger;
  calls: AdapterRequest[];
  externalCalls: AdapterRequest[];
  debits: Array<{ keyId: string; model: string; tokens: number; costUsd: number }>;
  maxInFlight: () => number;
  check: (request: ChatRequest, signal?: AbortSignal) => Promise<SmartRouteDecision>;
  rows: () => Promise<RequestLog[]>;
};

/**
 * The stub local classifier answers per call by markers in the text it is sent:
 * `HANG` waits for its signal, `SLOW` answers after 10ms, `BOOM` throws,
 * `GARBLE` answers something unreadable, `SECRET` is confidential, anything
 * else public.
 */
async function harness(settings: Partial<Settings> = {}): Promise<Harness> {
  const store = await memoryStore();
  await seedCredential(store, {
    id: "c-local",
    provider: "custom",
    authType: "apiKey",
    accessToken: null,
    refreshToken: null,
    apiKey: "key-local",
    providerData: {
      endpointId: "local",
      endpointLabel: "local",
      origin: "https://local.example.com",
      protocol: "chat_completions",
    },
  });
  await seedCredential(store, { id: "c-ext", provider: "anthropic" });
  const local = (model: string) =>
    target({
      provider: "custom",
      endpointId: "local",
      model,
      costPerMTok: { input: 1, output: 1 },
    });
  await store.config.putModel(virtualModel({ id: "classifier", targets: [local("local-judge")] }));
  await store.config.putModel(virtualModel({ id: "local", targets: [local("local-llm")] }));
  await store.config.putModel(virtualModel({ id: "fast", targets: [target()] }));
  await store.config.putModel(
    virtualModel({ id: "mixed", targets: [local("local-llm"), target()] }),
  );
  await store.config.putSettings({
    smartRouterEnabled: true,
    smartRouterClassifierModel: "classifier",
    smartRouterLocalModel: "local",
    smartRouterPolicy: POLICY,
    smartRouterTimeoutMs: 40,
    ...settings,
  });

  const calls: AdapterRequest[] = [];
  const externalCalls: AdapterRequest[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const custom: ProviderAdapter = {
    id: "custom",
    capabilities: { tools: true, images: true, reasoning: true },
    async send(request): Promise<AdapterResult> {
      calls.push(request);
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        const text = sent(request);
        if (text.includes("HANG")) return await hang(request.signal);
        if (text.includes("SLOW")) await sleep(10, request.signal);
        if (text.includes("BOOM")) {
          throw new GatewayError("UPSTREAM", `upstream echoed ${text}`, { provider: "custom" });
        }
        const word = text.includes("GARBLE")
          ? "MAYBE"
          : text.includes("SECRET")
            ? "CONFIDENTIAL"
            : "PUBLIC";
        return { events: replay(reply(word)), degradations: [] };
      } finally {
        inFlight--;
      }
    },
  };
  const external: ProviderAdapter = {
    id: "anthropic",
    capabilities: { tools: true, images: true, reasoning: true },
    async send(request): Promise<AdapterResult> {
      externalCalls.push(request);
      return { events: replay(reply("hi")), degradations: [] };
    },
  };

  const logger = captureLogger();
  const cache = new SpyCache();
  let n = 0;
  const deps: SmartRouterDeps = {
    store,
    snapshots: { get: (now: number) => buildSnapshot(store, now) },
    adapters: { custom, anthropic: external },
    http: transport,
    now: () => 1_000_000,
    rand: () => 0,
    loadRegistry: createLoadRegistry(),
    coord: memoryCoord(),
    refresh: async (c) => await c.secrets(),
    requestId: () => `req_${++n}`,
    logger,
    smartRouterCache: cache,
  };
  const debits: Harness["debits"] = [];
  return {
    store,
    deps,
    cache,
    logger,
    calls,
    externalCalls,
    debits,
    maxInFlight: () => maxInFlight,
    check: (request, signal = new AbortController().signal) =>
      checkConfidentiality(deps, {
        apiKeyId: "key-1",
        request,
        signal,
        debit: (keyId, model, usage) => debits.push({ keyId, model, ...usage }),
        parentRequestId: "parent-1",
      }),
    rows: async () => await store.usage.recent(50),
  };
}

/** One segment per message: each is too long to pack with another. */
function request(markers: readonly string[], model = "fast"): ChatRequest {
  return {
    model,
    stream: false,
    messages: markers.map((marker, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: [{ type: "text", text: `segment-${i} ${marker} ${"x".repeat(5_000)}` }],
    })),
  };
}

test("unset, unresolved, or mixed-provider models are unconfigured and call nothing", async () => {
  for (const settings of [
    { smartRouterClassifierModel: null },
    { smartRouterLocalModel: null },
    { smartRouterClassifierModel: "nope" },
    { smartRouterLocalModel: "nope" },
    { smartRouterClassifierModel: "mixed" },
    { smartRouterLocalModel: "mixed" },
    { smartRouterLocalModel: "fast" },
  ] satisfies Partial<Settings>[]) {
    const h = await harness(settings);
    const decision = await h.check(request(["a"]));
    expect(decision).toMatchObject({ kind: "refused", notes: ["smart-router:unconfigured"] });
    if (decision.kind !== "refused") throw new Error("unreachable");
    expect(decision.error.code).toBe("INTERNAL");
    expect(decision.error.message).toBe(UNCONFIGURED_MESSAGE);
    expect(h.calls).toHaveLength(0);
    expect(await h.rows()).toHaveLength(0);
  }
});

test("a model already local-only is not judged", async () => {
  const h = await harness();
  const decision = await h.check(request(["SECRET"], "local"));
  expect(decision).toEqual({
    kind: "local",
    model: "local",
    classifier: "classifier",
    notes: ["smart-router:already-local"],
  });
  expect(h.calls).toHaveLength(0);
  expect(await h.rows()).toHaveLength(0);
});

test("all public goes external with one row summing every call", async () => {
  const h = await harness();
  const decision = await h.check(request(["a", "b", "c"]));
  expect(decision).toEqual({ kind: "external", notes: ["smart-router:public"] });
  expect(h.calls).toHaveLength(3);
  expect(h.calls.every((c) => c.request.stream === false)).toBe(true);
  expect(h.externalCalls).toHaveLength(0);
  const rows = await h.rows();
  expect(rows).toHaveLength(1);
  const [row] = rows;
  expect(row).toMatchObject({
    requestedModel: "classifier",
    resolvedProvider: "custom",
    resolvedModel: "local-judge",
    credentialId: "c-local",
    status: 200,
    attempts: 3,
    inputTokens: 120,
    outputTokens: 3,
    degradations: [CLASSIFIER_NOTE],
    apiKeyId: "key-1",
  });
  expect(row?.costUsd).toBeCloseTo((3 * 41) / 1_000_000, 12);
  // The row id is the check's own, never a call's.
  expect(h.calls.map((c) => c.requestId)).not.toContain(row?.id);
  expect(h.debits).toEqual([
    { keyId: "key-1", model: "classifier", tokens: 123, costUsd: row?.costUsd ?? -1 },
  ]);
  expect(h.cache.writes).toEqual(["public", "public", "public"]);
});

test("one confidential among many goes local and aborts the rest", async () => {
  const h = await harness();
  const decision = await h.check(request(["HANG", "SLOW SECRET", "HANG"]));
  expect(decision).toEqual({
    kind: "local",
    model: "local",
    classifier: "classifier",
    notes: ["smart-router:local"],
  });
  expect(h.calls).toHaveLength(3);
  // The hanging calls ended by the stop, long before their 40ms timeout.
  const hung = h.calls.filter((call) => sent(call).includes("HANG"));
  expect(hung).toHaveLength(2);
  for (const call of hung) {
    expect(call.signal.aborted).toBe(true);
    expect(call.signal.reason).not.toBeInstanceOf(GatewayError);
  }
  // Only the verdict obtained is cached; aborted calls are not.
  expect(h.cache.writes).toEqual(["confidential"]);
  const [row] = await h.rows();
  expect(row).toMatchObject({ status: 200, attempts: 3, inputTokens: 40, outputTokens: 1 });
  // Stopped calls are not failures.
  expect(h.logger.records.filter((r) => r.level === "warn")).toHaveLength(0);
});

test("at most SEGMENT_CONCURRENCY calls are in flight", async () => {
  const h = await harness();
  const markers = Array.from({ length: SEGMENT_CONCURRENCY + 3 }, () => "SLOW");
  const decision = await h.check(request(markers));
  expect(decision.kind).toBe("external");
  expect(h.calls).toHaveLength(SEGMENT_CONCURRENCY + 3);
  expect(h.maxInFlight()).toBe(SEGMENT_CONCURRENCY);
});

test("a timeout refuses, with a 504 row and a fixed warning", async () => {
  const h = await harness();
  const decision = await h.check(request(["HANG"]));
  expect(decision).toMatchObject({ kind: "refused", notes: ["smart-router:unavailable"] });
  if (decision.kind !== "refused") throw new Error("unreachable");
  expect(decision.error.code).toBe("UPSTREAM");
  expect(decision.error.message).toBe(UNAVAILABLE_MESSAGE);
  const [row] = await h.rows();
  expect(row).toMatchObject({ status: 504, errorCode: "TIMEOUT", attempts: 1 });
  expect(h.logger.records.filter((r) => r.level === "warn")).toEqual([
    {
      level: "warn",
      msg: "confidentiality check failed",
      fields: { requestId: "parent-1", model: "classifier", reason: "classifier timed out" },
    },
  ]);
  expect(h.cache.writes).toEqual([]);
});

test("an unreadable reply refuses, and failures are not cached", async () => {
  const h = await harness();
  const req = request(["GARBLE"]);
  expect((await h.check(req)).kind).toBe("refused");
  expect((await h.check(req)).kind).toBe("refused");
  expect(h.calls).toHaveLength(2);
  expect(h.cache.writes).toEqual([]);
  expect(h.logger.records.find((r) => r.msg === "confidentiality check failed")?.fields).toEqual({
    requestId: "parent-1",
    model: "classifier",
    reason: "classifier reply unreadable",
  });
  expect(await h.rows()).toHaveLength(2);
});

test("a failing classifier call refuses with that call's own status", async () => {
  const h = await harness();
  const decision = await h.check(request(["BOOM"]));
  expect(decision.kind).toBe("refused");
  const [row] = await h.rows();
  // Dispatch files the adapter's throw as its own exhausted-failover error.
  expect(row).toMatchObject({ status: 503, errorCode: "ALL_CANDIDATES_FAILED", attempts: 1 });
  expect(h.logger.records.find((r) => r.msg === "confidentiality check failed")?.fields).toEqual({
    requestId: "parent-1",
    model: "classifier",
    code: "ALL_CANDIDATES_FAILED",
    reason: "classifier ALL_CANDIDATES_FAILED",
  });
});

test("whichever settles first decides: a failure before a confidential refuses", async () => {
  const h = await harness();
  const decision = await h.check(request(["GARBLE", "SLOW SECRET"]));
  expect(decision.kind).toBe("refused");
  expect(h.cache.writes).toEqual([]);
});

test("whichever settles first decides: a confidential before a failure goes local", async () => {
  const h = await harness();
  const decision = await h.check(request(["SECRET", "SLOW GARBLE"]));
  expect(decision).toMatchObject({ kind: "local", model: "local" });
  expect(h.logger.records.filter((r) => r.level === "warn")).toHaveLength(0);
});

test("a client abort is a cancellation with a 499 row", async () => {
  const h = await harness({ smartRouterTimeoutMs: 60_000 });
  const client = new AbortController();
  const pending = h.check(request(["HANG", "HANG"]), client.signal);
  while (h.calls.length < 2) await Bun.sleep(1);
  client.abort(new Error("client went away"));
  expect(await pending).toEqual({ kind: "cancelled" });
  const [row] = await h.rows();
  expect(row).toMatchObject({ status: 499, errorCode: "interrupted", attempts: 2 });
  expect(h.cache.writes).toEqual([]);
  expect(h.logger.records.filter((r) => r.level === "warn")).toHaveLength(0);
});

test("a client gone before any call is a cancellation with no row", async () => {
  const h = await harness();
  const client = new AbortController();
  client.abort(new Error("client went away"));
  expect(await h.check(request(["a"]), client.signal)).toEqual({ kind: "cancelled" });
  expect(h.calls).toHaveLength(0);
  expect(await h.rows()).toHaveLength(0);
});

test("a second run of a judged request is served from cache with no row", async () => {
  const h = await harness();
  const pub = request(["a", "b"]);
  await h.check(pub);
  expect(await h.check(pub)).toEqual({ kind: "external", notes: ["smart-router:public"] });
  const secret = request(["c", "SECRET"]);
  await h.check(secret);
  const before = h.calls.length;
  expect(await h.check(secret)).toEqual({
    kind: "local",
    model: "local",
    classifier: "classifier",
    notes: ["smart-router:local"],
  });
  expect(h.calls).toHaveLength(before);
  expect(await h.rows()).toHaveLength(2);
});

test("a cached confidential segment goes local without calling for the rest", async () => {
  const h = await harness();
  await h.check(request(["SECRET"]));
  const before = h.calls.length;
  const decision = await h.check(request(["SECRET", "new", "newer"]));
  expect(decision).toMatchObject({ kind: "local", model: "local" });
  expect(h.calls).toHaveLength(before);
});

test("more than MAX_UNCACHED_SEGMENTS uncached goes local without calling", async () => {
  const h = await harness();
  const markers = Array.from({ length: MAX_UNCACHED_SEGMENTS + 1 }, (_, i) => `m${i}`);
  expect(markers).toHaveLength(65);
  const decision = await h.check(request(markers));
  expect(decision).toEqual({
    kind: "local",
    model: "local",
    classifier: "classifier",
    notes: ["smart-router:local", "smart-router:oversize"],
  });
  expect(h.calls).toHaveLength(0);
  expect(await h.rows()).toHaveLength(0);
});

test("the warning line carries no segment text and no policy", async () => {
  for (const marker of ["GARBLE", "HANG", "BOOM"]) {
    const h = await harness();
    const req = request([`${marker} the-judged-words`]);
    await h.check(req);
    expect(h.logger.records.some((r) => r.msg === "confidentiality check failed")).toBe(true);
    const warnings = h.logger.lines.filter((l) => l.includes("confidentiality check failed"));
    expect(warnings).toHaveLength(1);
    for (const line of warnings) {
      expect(line).not.toContain("the-judged-words");
      expect(line).not.toContain(POLICY);
    }
  }
});

/**
 * One row stands for every classifier call of a check. Its provider request id
 * is the first call's (in call order) that has one — the same call whose target
 * the row already names — so the choice is deterministic, not whichever settled
 * last.
 */
test("the check row names the first call's provider request id", () => {
  const call = (upstreamRequestId: string | null, routed = true): RequestLog =>
    requestLog({ id: "x", upstreamRequestId, resolvedProvider: routed ? "custom" : null });
  const status = { status: 200, errorCode: null };
  expect(
    checkRow("r", 0, 1, "local-judge", 3, [call(null, false), call("up-2"), call("up-3")], status)
      .upstreamRequestId,
  ).toBe("up-2");
  expect(checkRow("r", 0, 1, "local-judge", 1, [call(null)], status).upstreamRequestId).toBeNull();
});

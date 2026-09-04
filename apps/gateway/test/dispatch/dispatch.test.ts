import { expect, test } from "bun:test";
import { type ChatRequest, GatewayError, type StreamEvent } from "@omni/ir";
import {
  anthropicAdapter,
  codecAdapter,
  type HttpClient,
  type ProviderAdapter,
  type ProviderCodec,
} from "@omni/providers";
import { PROVIDER_DESCRIPTORS, type ProviderDescriptors } from "@omni/providers/descriptors";
import { buildSnapshot, healthKey } from "@omni/router";
import type { CredentialSecrets, Store } from "@omni/store";
import { createStore, deriveKey } from "@omni/store";
import { captureLogger, entryOf } from "@omni/testkit";
import { dispatch } from "../../src/dispatch/index.ts";
import { createLoadRegistry } from "../../src/dispatch/loadRegistry.ts";
import { createTelemetry } from "../../src/telemetry/index.ts";
import { createTrace } from "../../src/telemetry/spans.ts";

const req: ChatRequest = {
  model: "fast",
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  stream: true,
};

async function* textStream(text: string): AsyncGenerator<StreamEvent> {
  yield { type: "start", id: "m", model: "claude-opus-4" };
  yield { type: "blockStart", index: 0, block: { type: "text" } };
  yield { type: "blockDelta", index: 0, delta: { type: "text", text } };
  yield { type: "blockEnd", index: 0 };
  yield {
    type: "end",
    stopReason: "endTurn",
    usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
  };
}

/** A stream whose usage reports cache-creation tokens and nothing else. */
async function* cacheWriteStream(cacheWriteTokens: number): AsyncGenerator<StreamEvent> {
  yield { type: "start", id: "m", model: "m-1" };
  yield { type: "blockStart", index: 0, block: { type: "text" } };
  yield { type: "blockDelta", index: 0, delta: { type: "text", text: "ok" } };
  yield { type: "blockEnd", index: 0 };
  yield {
    type: "end",
    stopReason: "endTurn",
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens },
  };
}

/**
 * The sentinel provider as a *codec*, which is the shape a plugin supplies one in.
 *
 * The registry test below used a stub adapter, and the design that added the
 * `provider` capability asked for this instead: "a plugin provider is exactly the
 * synthetic provider it injects", so routing it through `codecAdapter` buys the
 * codec contract the same call-graph coverage the registry already had, for the
 * cost of a stub transport
 * (`docs/superpowers/specs/2026-08-28-plugin-provider-capability-design.md`).
 *
 * It reads its own response body rather than ignoring it. A decode that yielded a
 * fixed stream would pass whether or not the host performed the request the codec
 * described, which is half of what the contract is.
 */
const SENTINEL_URL = "https://sentinel.test/v1/send";

const sentinelCodec: ProviderCodec = {
  buildRequest(input) {
    return {
      request: {
        url: SENTINEL_URL,
        method: "POST",
        headers: [
          ["content-type", "application/json"],
          ["x-sentinel-key", input.credentials.apiKey ?? ""],
        ],
        body: JSON.stringify({ model: input.model }),
      },
    };
  },
  async *decode(input) {
    const payload: unknown = JSON.parse(await new Response(input.body).text());
    const written =
      typeof payload === "object" && payload !== null && "cacheWrite" in payload
        ? Number((payload as { cacheWrite: unknown }).cacheWrite)
        : 0;
    yield* cacheWriteStream(written);
  },
};

/** A transport that answers only what `sentinelCodec` knows how to read. */
function sentinelUpstream(): { http: HttpClient; urls: string[] } {
  const urls: string[] = [];
  const http: HttpClient = async (request) => {
    urls.push(request.url);
    const body = JSON.stringify({ cacheWrite: 1_000_000 });
    return {
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      body: new Response(body).body,
      text: async () => body,
    };
  };
  return { http, urls };
}

/** Records every call so a test can assert which credential was used. */
function stubAdapter(
  behaviour: (call: number) => AsyncGenerator<StreamEvent> | Error,
): ProviderAdapter & { calls: string[] } {
  const calls: string[] = [];
  return {
    id: "anthropic",
    capabilities: { tools: true, images: true, reasoning: true },
    calls,
    async send(r) {
      calls.push(r.credentials.accessToken ?? "none");
      const result = behaviour(calls.length);
      if (result instanceof Error) throw result;
      return { events: result, degradations: [] };
    },
  };
}

async function seeded(credentials: number): Promise<Store> {
  const store = await createStore({
    path: ":memory:",
    encryptionKey: await deriveKey("test-secret-value-for-unit-tests"),
  });
  for (let i = 1; i <= credentials; i++) {
    await store.credentials.create({
      id: `c${i}`,
      provider: "anthropic",
      label: `c${i}`,
      authType: "oauth",
      enabled: true,
      tier: 1,
      weight: 1,
      expiresAt: null,
      accountEmail: null,
      providerData: {},
      disabledReason: null,
      disabledAt: null,
      accessToken: `test-token-${i}`,
      refreshToken: `test-refresh-${i}`,
      apiKey: null,
      idToken: null,
    });
  }
  await store.config.putModel({
    id: "fast",
    strategy: "priority",
    isAlias: false,
    targets: [
      {
        provider: "anthropic",
        model: "claude-opus-4",
        tier: 1,
        weight: 1,
        costPerMTok: { input: 15, output: 75 },
        capabilities: { tools: true, images: true, reasoning: true },
      },
    ],
  });
  return store;
}

/** The stub adapters never reach the transport, so this throws if one does. */
const noHttp: HttpClient = () => {
  throw new Error("a stub adapter reached the transport");
};

function deps(store: Store, adapter: ProviderAdapter) {
  return {
    store,
    snapshots: { get: (now: number) => buildSnapshot(store, now) },
    adapters: { anthropic: adapter, openai: adapter, kimi: adapter },
    http: noHttp,
    now: () => 1_000_000,
    rand: () => 0,
    loadRegistry: createLoadRegistry(),
    refresh: async () => ({
      accessToken: "refreshed",
      refreshToken: "r",
      apiKey: null,
      idToken: null,
    }),
  };
}

async function drain(events: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

test("reads routing through the injected snapshot source", async () => {
  const store = await seeded(1);
  const adapter = stubAdapter(() => textStream("hello"));
  const snapshot = await buildSnapshot(store, 1_000_000);
  await store.config.removeModel("fast");
  let reads = 0;
  const configured = {
    ...deps(store, adapter),
    snapshots: {
      get: async () => {
        reads++;
        return snapshot;
      },
    },
  };

  const events = await drain(
    (await dispatch(req, configured, new AbortController().signal, "req_test")).events,
  );

  expect(events.at(-1)).toMatchObject({ type: "end" });
  expect(reads).toBe(1);
  store.close();
});

test("compresses once from the dispatch snapshot and sends identical content on failover", async () => {
  const store = await seeded(2);
  await store.config.putSettings({ rtkEnabled: true });
  const received: string[] = [];
  const adapter = stubAdapter((call) =>
    call === 1 ? new GatewayError("UPSTREAM", "retry") : textStream("ok"),
  );
  const originalSend = adapter.send.bind(adapter);
  adapter.send = async (input) => {
    const block = input.request.messages[1]?.content[0];
    received.push(block?.type === "toolResult" ? block.content : "");
    return originalSend(input);
  };
  const repeated = [
    "bun test v1.4.0",
    ...Array.from({ length: 600 }, () => "case passed"),
    "600 pass",
    "0 fail",
    "Ran 600 tests across 20 files",
  ].join("\n");
  const input: ChatRequest = {
    model: "fast",
    stream: false,
    messages: [
      {
        role: "assistant",
        content: [{ type: "toolUse", id: "t1", name: "bash", input: "bun test" }],
      },
      { role: "user", content: [{ type: "toolResult", toolUseId: "t1", content: repeated }] },
    ],
  };

  const outcome = await dispatch(
    input,
    deps(store, adapter),
    new AbortController().signal,
    "req_rtk",
  );
  await drain(outcome.events);

  expect(received).toHaveLength(2);
  expect(received[0]).toBe(received[1]);
  expect(received[0]?.length).toBeLessThan(repeated.length);
  expect(input.messages[1]?.content[0]).toMatchObject({ content: repeated });
  expect(outcome.log()).toMatchObject({
    rtkApplied: true,
    rtkFilterHits: 1,
    rtkFilters: ["test-output"],
  });
  store.close();
});

test("streams a successful response and logs it", async () => {
  const store = await seeded(1);
  const adapter = stubAdapter(() => textStream("hello"));
  const outcome = await dispatch(
    req,
    deps(store, adapter),
    new AbortController().signal,
    "req_route_owned",
  );
  const events = await drain(outcome.events);

  expect(events.at(-1)).toMatchObject({ type: "end" });
  const log = outcome.log();
  expect(log.id).toBe("req_route_owned");
  expect(log.status).toBe(200);
  expect(log.attempts).toBe(1);
  expect(log.inputTokens).toBe(10);
  expect(log.resolvedModel).toBe("claude-opus-4");
  store.close();
});

test("an AUTH failure refreshes and retries the same OAuth credential once", async () => {
  const store = await seeded(2);
  const adapter = stubAdapter((call) =>
    call === 1 ? new GatewayError("AUTH", "expired") : textStream("refreshed"),
  );
  let refreshes = 0;
  const configured = deps(store, adapter);
  configured.refresh = async () => {
    refreshes++;
    return {
      accessToken: "test-token-refreshed",
      refreshToken: "test-refresh-rotated",
      apiKey: null,
      idToken: null,
    };
  };

  const outcome = await dispatch(req, configured, new AbortController().signal, "req_test");
  const events = await drain(outcome.events);

  expect(events.at(-1)).toMatchObject({ type: "end" });
  expect(adapter.calls).toEqual(["test-token-1", "test-token-refreshed"]);
  expect(refreshes).toBe(1);
  expect(outcome.log().attempts).toBe(1);
  expect(outcome.log().credentialId).toBe("c1");
  store.close();
});

test("a pre-emptive refresh followed by AUTH does not refresh twice", async () => {
  const store = await seeded(2);
  await store.credentials.update("c1", { expiresAt: 1_120_000 });
  const adapter = stubAdapter((call) =>
    call === 1 ? new GatewayError("AUTH", "still unauthorized") : textStream("fallback"),
  );
  let refreshes = 0;
  const configured = deps(store, adapter);
  configured.refresh = async () => {
    refreshes++;
    return {
      accessToken: "test-token-refreshed",
      refreshToken: "test-refresh-rotated",
      apiKey: null,
      idToken: null,
    };
  };

  const outcome = await dispatch(req, configured, new AbortController().signal, "req_test");
  await drain(outcome.events);

  expect(refreshes).toBe(1);
  expect(adapter.calls.slice(0, 2)).toEqual(["test-token-refreshed", "test-token-2"]);
  store.close();
});

test("a second AUTH after refresh falls through to the next candidate", async () => {
  const store = await seeded(2);
  const adapter = stubAdapter((call) =>
    call < 3 ? new GatewayError("AUTH", "unauthorized") : textStream("fallback"),
  );
  let refreshes = 0;
  const configured = deps(store, adapter);
  configured.refresh = async () => {
    refreshes++;
    return {
      accessToken: "test-token-refreshed",
      refreshToken: "test-refresh-rotated",
      apiKey: null,
      idToken: null,
    };
  };

  const outcome = await dispatch(req, configured, new AbortController().signal, "req_test");
  await drain(outcome.events);

  expect(adapter.calls).toEqual(["test-token-1", "test-token-refreshed", "test-token-2"]);
  expect(refreshes).toBe(1);
  expect(outcome.log().attempts).toBe(2);
  store.close();
});

test("a refresh failure proceeds to the next candidate", async () => {
  const store = await seeded(2);
  const adapter = stubAdapter((call) =>
    call === 1 ? new GatewayError("AUTH", "expired") : textStream("fallback"),
  );
  const configured = deps(store, adapter);
  configured.refresh = async () => {
    throw new GatewayError("UPSTREAM", "refresh unavailable");
  };

  const outcome = await dispatch(req, configured, new AbortController().signal, "req_test");
  await drain(outcome.events);

  expect(adapter.calls).toEqual(["test-token-1", "test-token-2"]);
  expect(outcome.log().attempts).toBe(2);
  store.close();
});

test("fails over to the next credential before the commit point", async () => {
  const store = await seeded(2);
  const logger = captureLogger();
  const upstreamBody = "UPSTREAM_ERROR_BODY_SENTINEL";
  const adapter = stubAdapter((call) =>
    call === 1 ? new GatewayError("UPSTREAM", upstreamBody) : textStream("recovered"),
  );
  const outcome = await dispatch(
    req,
    { ...deps(store, adapter), logger },
    new AbortController().signal,
    "req_test",
  );
  const events = await drain(outcome.events);

  expect(adapter.calls).toHaveLength(2);
  expect(events.some((e) => e.type === "blockDelta")).toBe(true);
  expect(outcome.log().attempts).toBe(2);
  expect(outcome.log().status).toBe(200);
  expect(logger.records).toContainEqual(
    expect.objectContaining({
      level: "warn",
      msg: "attempt failed; retrying",
      fields: expect.objectContaining({
        requestId: "req_test",
        attempt: 1,
        code: "UPSTREAM",
        retryable: true,
      }),
    }),
  );
  expect(logger.lines.join("\n")).not.toContain(upstreamBody);
  store.close();
});

test("a failover trace has sibling attempts and the failed attempt's code", async () => {
  const store = await seeded(2);
  const trace = createTrace({ startedAt: 1_000_000, traceparent: null });
  const adapter = stubAdapter((call) =>
    call === 1
      ? new GatewayError("RATE_LIMIT", "slow down", { retryAfterMs: 1_000 })
      : textStream("recovered"),
  );
  const outcome = await dispatch(
    req,
    { ...deps(store, adapter), trace },
    new AbortController().signal,
    "req_trace",
  );
  await drain(outcome.events);

  const attempts = trace.spans.filter((span) => span.name === "dispatch.attempt");
  expect(attempts).toHaveLength(2);
  expect(attempts.map((span) => span.parent)).toEqual([0, 0]);
  expect(attempts[0]?.attrs.code).toBe("RATE_LIMIT");
  expect(trace.spans.filter((span) => span.name === "stream.commit")).toHaveLength(1);
  store.close();
});

test("each provider.http span is parented to the attempt that made the call", async () => {
  const store = await seeded(2);
  const telemetry = createTelemetry({
    metricsEnabled: false,
    maxSeries: 10,
    otlpEndpoint: "https://collector.example",
    otlpHeaders: {},
    traceSample: 1,
    now: () => 1_000_000,
    version: "test",
    exporter: { enqueue: () => {}, flush: async () => {}, queued: () => 0, stop: () => {} },
  });
  const trace = telemetry.startRequest("req_http", 1_000_000, null, "openai", 0);
  if (trace === null) throw new Error("tracing should be on");
  // Stands in for the transport's response-head callback: fired from inside
  // the adapter, while the attempt that owns the call is still active.
  const adapter = stubAdapter((call) => {
    telemetry.httpHead({
      provider: "anthropic",
      host: "api.example",
      path: "/v1/messages",
      status: call === 1 ? 429 : 200,
      durationMs: 5,
      requestId: "req_http",
    });
    return call === 1
      ? new GatewayError("RATE_LIMIT", "slow down", { retryAfterMs: 1_000 })
      : textStream("recovered");
  });
  const outcome = await dispatch(
    req,
    { ...deps(store, adapter), trace },
    new AbortController().signal,
    "req_http",
  );
  await drain(outcome.events);

  const attempts = trace.spans.flatMap((span, i) => (span.name === "dispatch.attempt" ? [i] : []));
  const http = trace.spans.filter((span) => span.name === "provider.http");
  expect(attempts).toHaveLength(2);
  expect(http.map((span) => span.parent)).toEqual(attempts);
  expect(http.map((span) => span.attrs.status)).toEqual([429, 200]);
  telemetry.stop();
  store.close();
});

test("custom failover stays within the target endpoint", async () => {
  const store = await createStore({
    path: ":memory:",
    encryptionKey: await deriveKey("test-secret-value-for-unit-tests"),
  });
  for (const [id, endpointId] of [
    ["local-1", "local"],
    ["remote-1", "remote"],
    ["local-2", "local"],
  ] as const) {
    await store.credentials.create({
      id,
      provider: "custom",
      label: id,
      authType: "apiKey",
      enabled: true,
      tier: 1,
      weight: endpointId === "remote" ? 100 : 1,
      expiresAt: null,
      accountEmail: null,
      providerData: {
        endpointId,
        endpointLabel: endpointId,
        origin: `https://${endpointId}.example.com`,
        protocol: "chat_completions",
      },
      disabledReason: null,
      disabledAt: null,
      accessToken: null,
      refreshToken: null,
      apiKey: `key-${id}`,
      idToken: null,
    });
  }
  await store.config.putModel({
    id: "fast",
    strategy: "priority",
    isAlias: false,
    targets: [
      {
        provider: "custom",
        endpointId: "local",
        model: "local-model",
        tier: 1,
        weight: 1,
        costPerMTok: { input: 1, output: 1 },
        capabilities: { tools: true, images: true, reasoning: true },
      },
    ],
  });
  const calls: string[] = [];
  const adapter: ProviderAdapter = {
    id: "custom",
    capabilities: { tools: true, images: true, reasoning: true },
    async send(input) {
      calls.push(input.credentials.apiKey ?? "none");
      if (calls.length === 1) throw new GatewayError("UPSTREAM", "retry");
      return { events: textStream("recovered"), degradations: [] };
    },
  };
  const configured = {
    ...deps(store, adapter),
    adapters: { custom: adapter },
  };

  const outcome = await dispatch(req, configured, new AbortController().signal, "req_custom");
  const events = await drain(outcome.events);

  expect(events.at(-1)).toMatchObject({ type: "end" });
  expect(calls).toEqual(["key-local-1", "key-local-2"]);
  expect(outcome.log()).toMatchObject({ attempts: 2, credentialId: "local-2", status: 200 });
  store.close();
});

test("a failure after the commit point surfaces as an error event, not a retry", async () => {
  const store = await seeded(2);
  const trace = createTrace({ startedAt: 1_000_000, traceparent: null });
  const adapter = stubAdapter((call) => {
    if (call > 1) return textStream("should not be reached");
    return (async function* () {
      yield { type: "start", id: "m", model: "claude-opus-4" } as StreamEvent;
      yield { type: "blockStart", index: 0, block: { type: "text" } } as StreamEvent;
      yield {
        type: "blockDelta",
        index: 0,
        delta: { type: "text", text: "partial" },
      } as StreamEvent;
      throw new GatewayError("UPSTREAM", "died mid-stream");
    })();
  });

  const outcome = await dispatch(
    req,
    { ...deps(store, adapter), trace },
    new AbortController().signal,
    "req_test",
  );
  const events = await drain(outcome.events);

  expect(adapter.calls).toHaveLength(1);
  expect(events.at(-1)).toMatchObject({ type: "error", code: "UPSTREAM" });
  expect(outcome.log().status).toBe(502);
  expect(trace.spans.filter((span) => span.name === "stream.commit")).toHaveLength(1);
  expect(trace.spans.filter((span) => span.name === "dispatch.attempt")).toHaveLength(1);
  store.close();
});

test("stops consuming an attempt after canonical end", async () => {
  const store = await seeded(2);
  const adapter = stubAdapter((call) => {
    if (call > 1) return textStream("should not be reached");
    return (async function* () {
      yield { type: "start", id: "m", model: "claude-opus-4" } as StreamEvent;
      yield {
        type: "end",
        stopReason: "endTurn",
        usage: { inputTokens: 1, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      } as StreamEvent;
      throw new GatewayError("UPSTREAM", "after terminal event");
    })();
  });

  const outcome = await dispatch(
    req,
    deps(store, adapter),
    new AbortController().signal,
    "req_test",
  );
  const events = await drain(outcome.events);

  expect(adapter.calls).toHaveLength(1);
  expect(events.filter((event) => event.type === "end")).toHaveLength(1);
  expect(events.some((event) => event.type === "error")).toBe(false);
  expect(outcome.log().status).toBe(200);
  store.close();
});

test("adapter exhaustion without end or error fails after stream commit", async () => {
  const store = await seeded(1);
  const adapter = stubAdapter(() =>
    (async function* () {
      yield { type: "start", id: "m", model: "claude-opus-4" } as StreamEvent;
      yield { type: "blockStart", index: 0, block: { type: "text" } } as StreamEvent;
      yield {
        type: "blockDelta",
        index: 0,
        delta: { type: "text", text: "partial" },
      } as StreamEvent;
    })(),
  );

  const outcome = await dispatch(
    req,
    deps(store, adapter),
    new AbortController().signal,
    "req_test",
  );
  const events = await drain(outcome.events);

  expect(events.at(-1)).toMatchObject({ type: "error", code: "UPSTREAM" });
  expect(outcome.log().status).toBe(502);
  expect(outcome.log().errorCode).toBe("UPSTREAM");
  const rows = await store.credentials.listHealth();
  expect(rows[0]?.consecutiveFailures).toBe(1);
  store.close();
});

test("adapter exhaustion without end or error fails over before stream commit", async () => {
  const store = await seeded(2);
  const adapter = stubAdapter((call) =>
    call === 1
      ? (async function* () {
          yield { type: "start", id: "failed", model: "claude-opus-4" } as StreamEvent;
          yield { type: "blockStart", index: 0, block: { type: "text" } } as StreamEvent;
        })()
      : textStream("recovered"),
  );

  const outcome = await dispatch(
    req,
    deps(store, adapter),
    new AbortController().signal,
    "req_test",
  );
  const events = await drain(outcome.events);

  expect(adapter.calls).toHaveLength(2);
  expect(events.filter((event) => event.type === "start")).toEqual([
    { type: "start", id: "m", model: "claude-opus-4" },
  ]);
  expect(events.at(-1)).toMatchObject({ type: "end" });
  expect(outcome.log().status).toBe(200);
  store.close();
});

test("an in-stream non-retryable error is not mistaken for success", async () => {
  // Real decoders (e.g. anthropic/decode.ts's "error" case) yield an error
  // StreamEvent rather than throwing. A non-retryable in-stream error must
  // still be recorded as a failed request, not fall through to the 200 path
  // once the generator ends.
  const store = await seeded(2);
  const adapter = stubAdapter((call) => {
    if (call > 1) return textStream("should not be reached");
    return (async function* () {
      yield { type: "start", id: "m", model: "claude-opus-4" } as StreamEvent;
      yield {
        type: "error",
        code: "BAD_REQUEST",
        message: "malformed",
        retryable: false,
      } as StreamEvent;
    })();
  });

  const outcome = await dispatch(
    req,
    deps(store, adapter),
    new AbortController().signal,
    "req_test",
  );
  const events = await drain(outcome.events);

  expect(adapter.calls).toHaveLength(1);
  expect(events.at(-1)).toMatchObject({ type: "error", code: "BAD_REQUEST" });
  expect(outcome.log().status).toBe(400);
  expect(outcome.log().errorCode).toBe("BAD_REQUEST");
  store.close();
});

test("a non-retryable error stops immediately without trying other credentials", async () => {
  const store = await seeded(3);
  const adapter = stubAdapter(() => new GatewayError("BAD_REQUEST", "malformed"));
  const outcome = await dispatch(
    req,
    deps(store, adapter),
    new AbortController().signal,
    "req_test",
  );
  const events = await drain(outcome.events);

  expect(adapter.calls).toHaveLength(1);
  expect(events[0]).toMatchObject({ type: "error", code: "BAD_REQUEST" });
  expect(outcome.log().status).toBe(400);
  store.close();
});

test("stops after maxAttempts even with candidates remaining", async () => {
  const store = await seeded(5);
  await store.config.putSettings({ maxAttempts: 2 });
  const adapter = stubAdapter(() => new GatewayError("UPSTREAM", "boom"));
  const outcome = await dispatch(
    req,
    deps(store, adapter),
    new AbortController().signal,
    "req_test",
  );
  await drain(outcome.events);

  expect(adapter.calls).toHaveLength(2);
  expect(outcome.log().errorCode).toBe("ALL_CANDIDATES_FAILED");
  store.close();
});

test("emits NO_CANDIDATES when the pool is empty", async () => {
  const store = await seeded(0);
  const adapter = stubAdapter(() => textStream("x"));
  const outcome = await dispatch(
    req,
    deps(store, adapter),
    new AbortController().signal,
    "req_test",
  );
  const events = await drain(outcome.events);

  expect(events[0]).toMatchObject({ type: "error", code: "NO_CANDIDATES" });
  expect(outcome.log().status).toBe(503);
  store.close();
});

test("a hard failure opens the breaker and persists it", async () => {
  const store = await seeded(1);
  await store.config.putSettings({ maxAttempts: 1, breakerThreshold: 1 });
  const adapter = stubAdapter(() => new GatewayError("UPSTREAM", "boom"));
  await drain(
    (await dispatch(req, deps(store, adapter), new AbortController().signal, "req_test")).events,
  );

  const rows = await store.credentials.listHealth();
  expect(rows[0]?.breakerState).toBe("open");
  expect(rows[0]?.consecutiveFailures).toBe(1);
  store.close();
});

test("a rate limit parks the credential without opening the breaker", async () => {
  const store = await seeded(1);
  await store.config.putSettings({ maxAttempts: 1 });
  const adapter = stubAdapter(
    () => new GatewayError("RATE_LIMIT", "slow down", { retryAfterMs: 30_000 }),
  );
  await drain(
    (await dispatch(req, deps(store, adapter), new AbortController().signal, "req_test")).events,
  );

  const rows = await store.credentials.listHealth();
  expect(rows[0]?.breakerState).toBe("closed");
  expect(rows[0]?.rateLimitedUntil).toBe(1_030_000);
  store.close();
});

// Both dispatches take their snapshot before either writes: `dispatch` builds it
// eagerly, while the generator body that writes health does not run until it is
// drained. That is the concurrent interleaving, reproduced without depending on
// how the scheduler orders two in-flight requests.
test("concurrent failures on one credential both count", async () => {
  const store = await seeded(1);
  await store.config.putSettings({ maxAttempts: 1 });
  const first = await dispatch(
    req,
    deps(
      store,
      stubAdapter(() => new GatewayError("UPSTREAM", "boom")),
    ),
    new AbortController().signal,
    "req_a",
  );
  const second = await dispatch(
    req,
    deps(
      store,
      stubAdapter(() => new GatewayError("UPSTREAM", "boom")),
    ),
    new AbortController().signal,
    "req_b",
  );

  await drain(first.events);
  await drain(second.events);

  const rows = await store.credentials.listHealth();
  expect(rows[0]?.consecutiveFailures).toBe(2);
  store.close();
});

// A soft failure carries the rest of the row forward from what it read. Reading
// a stale row therefore does not just lose an increment, it restores the count
// and breaker state from before the hard failure that landed in between.
test("a rate limit landing after a hard failure does not resurrect its count", async () => {
  const store = await seeded(1);
  await store.config.putSettings({ maxAttempts: 1 });
  const soft = await dispatch(
    req,
    deps(
      store,
      stubAdapter(() => new GatewayError("RATE_LIMIT", "slow down", { retryAfterMs: 30_000 })),
    ),
    new AbortController().signal,
    "req_soft",
  );
  const hard = await dispatch(
    req,
    deps(
      store,
      stubAdapter(() => new GatewayError("UPSTREAM", "boom")),
    ),
    new AbortController().signal,
    "req_hard",
  );

  await drain(hard.events);
  await drain(soft.events);

  const rows = await store.credentials.listHealth();
  expect(rows[0]?.consecutiveFailures).toBe(1);
  expect(rows[0]?.rateLimitedUntil).toBe(1_030_000);
  store.close();
});

test("a success records latency and marks the credential used", async () => {
  const store = await seeded(1);
  const adapter = stubAdapter(() => textStream("hi"));
  await drain(
    (await dispatch(req, deps(store, adapter), new AbortController().signal, "req_test")).events,
  );

  const rows = await store.credentials.listHealth();
  expect(rows[0]?.lastUsedAt).toBe(1_000_000);
  expect(rows[0]?.ewmaTtftMs).not.toBeNull();
  store.close();
});

test("refreshes an expired oauth credential before calling the adapter", async () => {
  const store = await seeded(1);
  await store.credentials.update("c1", { expiresAt: 500_000 });
  const adapter = stubAdapter(() => textStream("hi"));
  await drain(
    (await dispatch(req, deps(store, adapter), new AbortController().signal, "req_test")).events,
  );

  expect(adapter.calls[0]).toBe("refreshed");
  store.close();
});

test("collects the stream for a non-streaming request", async () => {
  const store = await seeded(1);
  const adapter = stubAdapter(() => textStream("hello"));
  const outcome = await dispatch(
    { ...req, stream: false },
    deps(store, adapter),
    new AbortController().signal,
    "req_test",
  );
  const events = await drain(outcome.events);
  // The caller still receives events; egress folds them with collect().
  expect(events.filter((e) => e.type === "blockDelta")).toHaveLength(1);
  store.close();
});

/**
 * `request_logs.degradations` is a **set**, asserted on the column rather than on
 * any one reason.
 *
 * `noteDegradations` says so in its own docstring and one writer did not use it:
 * the routing-exclusion loop pushed directly, and `eligible` emits
 * `capability:providerNative` from inside its *credential* loop. So a pool of N
 * targets across M accounts wrote N×M identical strings — on an ordinary
 * web-search request that succeeded. The column is unbounded `TEXT`, nothing
 * truncates on write or read, and the console renders one chip per entry keyed
 * on the string: 24 duplicates and a React duplicate-key warning on the happy
 * path.
 *
 * Written as an invariant over whatever the run produced, not as a count for
 * this fixture. A test asserting "3 entries" would pass while a fourth writer
 * started repeating itself; this one fails for any duplicate from any source,
 * which is the property the docstring already claimed.
 */
test("a request never records the same degradation twice, however many accounts it skipped", async () => {
  const store = await seeded(1);
  // Three Anthropic accounts and three OpenAI ones, so the exclusion loop runs
  // six times against two targets. Under a direct push this produced one row per
  // (target, credential) pair rather than one per distinct reason.
  for (const [id, provider] of [
    ["a2", "anthropic"],
    ["a3", "anthropic"],
    ["o1", "openai"],
    ["o2", "openai"],
    ["o3", "openai"],
  ] as const) {
    await store.credentials.create({
      id,
      provider,
      label: id,
      authType: "apiKey",
      enabled: true,
      tier: 1,
      weight: 1,
      expiresAt: null,
      accountEmail: null,
      providerData: {},
      disabledReason: null,
      disabledAt: null,
      accessToken: null,
      refreshToken: null,
      apiKey: "synthetic-key",
      idToken: null,
    });
  }
  await store.config.putModel({
    id: "native",
    strategy: "priority",
    isAlias: false,
    targets: [
      {
        provider: "openai",
        model: "gpt-5",
        tier: 1,
        weight: 1,
        costPerMTok: { input: 1, output: 1 },
        capabilities: { tools: true, images: true, reasoning: true },
      },
      {
        provider: "anthropic",
        model: "claude-opus-5",
        tier: 1,
        weight: 1,
        costPerMTok: { input: 1, output: 1 },
        capabilities: { tools: true, images: true, reasoning: true },
      },
    ],
  });

  const adapter = stubAdapter(() => textStream("ok"));
  const outcome = await dispatch(
    {
      ...req,
      model: "native",
      // An Anthropic-defined tool, which is the ordinary Claude-Code shape. It
      // excludes every OpenAI account — the `size === 1` arm, on a request that
      // then succeeds against Anthropic.
      tools: [
        {
          kind: "provider",
          provider: "anthropic",
          family: "webSearch",
          type: "web_search_20250305",
          name: "web_search",
          wire: {},
        },
      ],
    },
    { ...deps(store, adapter), adapters: { anthropic: adapter, openai: adapter } },
    new AbortController().signal,
    "req_dedupe",
  );
  await drain(outcome.events);
  const { degradations } = outcome.log();

  // The request succeeded, which is the point: this is not an error path.
  expect(outcome.log().status).toBe(200);
  // Three OpenAI accounts were skipped for one reason.
  expect(degradations).toContain("excluded:capability:providerNative");
  expect(new Set(degradations).size).toBe(degradations.length);
});

test("Anthropic-native capability exclusions omit credential IDs from degradations", async () => {
  const store = await seeded(1);
  await store.credentials.create({
    id: "sensitive-openai-id",
    provider: "openai",
    label: "openai",
    authType: "apiKey",
    enabled: true,
    tier: 1,
    weight: 1,
    expiresAt: null,
    accountEmail: null,
    providerData: {},
    disabledReason: null,
    disabledAt: null,
    accessToken: null,
    refreshToken: null,
    apiKey: "synthetic-key",
    idToken: null,
  });
  await store.config.putModel({
    id: "native",
    strategy: "priority",
    isAlias: false,
    targets: [
      {
        provider: "openai",
        model: "gpt-5",
        tier: 1,
        weight: 1,
        costPerMTok: { input: 1, output: 1 },
        capabilities: { tools: true, images: true, reasoning: true },
      },
      {
        provider: "anthropic",
        model: "claude-opus-4",
        tier: 1,
        weight: 1,
        costPerMTok: { input: 15, output: 75 },
        capabilities: { tools: true, images: true, reasoning: true },
      },
    ],
  });
  const outcome = await dispatch(
    {
      ...req,
      model: "native",
      tools: [
        {
          kind: "provider",
          provider: "anthropic",
          family: "webSearch",
          type: "web_search_20260318",
          name: "web_search",
          wire: {},
        },
      ],
    },
    deps(
      store,
      stubAdapter(() => textStream("hi")),
    ),
    new AbortController().signal,
    "req_test",
  );
  await drain(outcome.events);

  expect(outcome.log().degradations).toContain("excluded:capability:providerNative");
  expect(outcome.log().degradations.join(" ")).not.toContain("sensitive-openai-id");
  store.close();
});

test("the log records the excluded candidates and their reasons", async () => {
  const store = await seeded(2);
  await store.credentials.update("c1", { enabled: false });
  const adapter = stubAdapter(() => textStream("hi"));
  const outcome = await dispatch(
    req,
    deps(store, adapter),
    new AbortController().signal,
    "req_test",
  );
  await drain(outcome.events);

  expect(outcome.log().degradations).toContain("excluded:c1:disabled");
  store.close();
});

/** Repoints the seeded pool's only target at one account. */
async function pinFastTo(store: Store, credentialId: string): Promise<void> {
  await store.config.putModel({
    id: "fast",
    strategy: "priority",
    isAlias: false,
    targets: [
      {
        provider: "anthropic",
        model: "claude-opus-4",
        tier: 1,
        weight: 1,
        costPerMTok: { input: 15, output: 75 },
        credentialId,
        capabilities: { tools: true, images: true, reasoning: true },
      },
    ],
  });
}

test("a pinned target that cannot serve fails the request rather than reaching a sibling", async () => {
  const store = await seeded(2);
  await pinFastTo(store, "c1");
  await store.credentials.update("c1", { enabled: false });
  const adapter = stubAdapter(() => textStream("hi"));
  const outcome = await dispatch(
    req,
    deps(store, adapter),
    new AbortController().signal,
    "req_test",
  );
  const events = await drain(outcome.events);

  // The whole point of a pin, and the one thing no test above dispatch has ever
  // checked: c2 is enabled, healthy and of the right provider, and it must not
  // be called. An operator pins for billing separation or a per-account
  // agreement, and silent spillover defeats both.
  expect(adapter.calls).toEqual([]);
  expect(events[0]).toMatchObject({ type: "error", code: "NO_CANDIDATES" });
  // The pinned account's own reason, and nothing about the sibling it excluded.
  expect(outcome.log().degradations).toEqual(["excluded:c1:disabled"]);
  store.close();
});

test("a pin naming an account that is gone is written into the request log", async () => {
  const store = await seeded(1);
  await pinFastTo(store, "removed-account");
  const adapter = stubAdapter(() => textStream("hi"));
  const outcome = await dispatch(
    req,
    deps(store, adapter),
    new AbortController().signal,
    "req_test",
  );
  await drain(outcome.events);

  expect(adapter.calls).toEqual([]);
  // This row is the whole justification for bounding `credentialId` at 64
  // characters of `[A-Za-z0-9_-]` in the model schema: the id an operator typed
  // lands in `request_logs.degradations` and in `LogFields.credentialId`, which
  // is a closed allowlist documenting the field as a bounded identifier.
  expect(outcome.log().degradations).toEqual(["excluded:removed-account:pin:missing"]);
  expect(outcome.log().errorCode).toBe("NO_CANDIDATES");
  store.close();
});

test("failover hands the second provider the client's own tool names, not Anthropic's aliases", async () => {
  const store = await seeded(1);
  await store.credentials.create({
    id: "c-openai",
    provider: "openai",
    label: "openai",
    authType: "apiKey",
    enabled: true,
    tier: 2,
    weight: 1,
    expiresAt: null,
    accountEmail: null,
    providerData: {},
    disabledReason: null,
    disabledAt: null,
    accessToken: null,
    refreshToken: null,
    apiKey: "synthetic-key",
    idToken: null,
  });
  await store.config.putModel({
    id: "mixed",
    strategy: "priority",
    isAlias: false,
    targets: [
      {
        provider: "anthropic",
        model: "claude-opus-4",
        tier: 1,
        weight: 1,
        costPerMTok: { input: 15, output: 75 },
        capabilities: { tools: true, images: true, reasoning: true },
      },
      {
        provider: "openai",
        model: "gpt-5",
        tier: 2,
        weight: 1,
        costPerMTok: { input: 1, output: 1 },
        capabilities: { tools: true, images: true, reasoning: true },
      },
    ],
  });

  // The real Anthropic adapter, because a stub would not build a cloak and the
  // whole question here is what the cloak leaves behind. It fails on a 503 so
  // dispatch moves to the next candidate.
  let anthropicWire = "";
  const http: HttpClient = async (request) => {
    anthropicWire = request.body;
    return {
      status: 503,
      headers: new Headers(),
      body: null,
      text: async () => '{"type":"error","error":{"type":"overloaded_error","message":"busy"}}',
    };
  };

  const second: string[] = [];
  const openai: ProviderAdapter = {
    id: "openai",
    capabilities: { tools: true, images: true, reasoning: true },
    async send(r) {
      for (const t of r.request.tools ?? []) if (t.kind === "portable") second.push(t.name);
      for (const m of r.request.messages) {
        for (const b of m.content) if (b.type === "toolUse") second.push(b.name);
      }
      return { events: textStream("ok"), degradations: [] };
    },
  };

  const input: ChatRequest = {
    model: "mixed",
    stream: true,
    messages: [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      {
        role: "assistant",
        content: [{ type: "toolUse", id: "tu_1", name: "delegate_task", input: {} }],
      },
      { role: "user", content: [{ type: "toolResult", toolUseId: "tu_1", content: "done" }] },
    ],
    tools: [{ kind: "portable", name: "session_search", inputSchema: { type: "object" } }],
  };

  const outcome = await dispatch(
    input,
    {
      ...deps(store, openai),
      adapters: { anthropic: anthropicAdapter, openai, kimi: openai },
      http,
    },
    new AbortController().signal,
    "req_failover",
  );
  await drain(outcome.events);

  // The first leg really did rename, so the second leg seeing the originals is
  // a fact about the cloak's scope rather than about it never having run.
  expect(anthropicWire).toContain("SessionSearch");
  expect(anthropicWire).toContain("DelegateTask");
  expect(second).toEqual(["session_search", "delegate_task"]);
  // And the shared IR the two attempts share is untouched.
  expect(input.tools?.[0]).toMatchObject({ name: "session_search" });
  store.close();
});

/** A request carrying one custom tool the Anthropic OAuth leg will rename. */
const CLOAKED: ChatRequest = {
  model: "fast",
  stream: true,
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  tools: [{ kind: "portable", name: "session_search", inputSchema: { type: "object" } }],
};

/** Answers the Anthropic leg with one canned HTTP response. */
function anthropicHttp(status: number, body: string): HttpClient {
  return async () => ({
    status,
    headers: new Headers(),
    body: null,
    text: async () => body,
  });
}

test("a cloaked request reports how many names it renamed, once, on its own log line", async () => {
  const store = await seeded(1);
  const logger = captureLogger();
  const outcome = await dispatch(
    CLOAKED,
    {
      ...deps(
        store,
        stubAdapter(() => textStream("hi")),
      ),
      adapters: { anthropic: anthropicAdapter, openai: anthropicAdapter, kimi: anthropicAdapter },
      // A 200 with an empty SSE body: the adapter returns a result, which is
      // the path that carries the count.
      http: async () => ({
        status: 200,
        headers: new Headers({ "content-type": "text/event-stream" }),
        body: new Response("").body as ReadableStream<Uint8Array>,
        text: async () => "",
      }),
      logger,
    },
    new AbortController().signal,
    "req_count",
  );
  await drain(outcome.events);

  const cloaked = logger.records.filter((r) => r.fields.cloakedTools !== undefined);
  expect(cloaked).toHaveLength(1);
  expect(cloaked[0]?.fields.cloakedTools).toBe(1);
  // A count and never the names — the field is the redaction boundary.
  expect(JSON.stringify(cloaked[0]?.fields)).not.toContain("session_search");
});

test("a degradation both attempts report is recorded once, not once per attempt", async () => {
  // `request_logs.degradations` means a set: "images were dropped" is one fact
  // however many attempts dropped it. `note()` inside a single `toWire` cannot
  // see across attempts, so this is the only thing deduping a failover — and
  // both collection sites have to agree, or one of them reintroduces the
  // duplicate the other prevents.
  const store = await seeded(2);
  const adapter = stubAdapter((call) =>
    call === 1 ? new GatewayError("UPSTREAM", "retry") : textStream("ok"),
  );
  const originalSend = adapter.send.bind(adapter);
  adapter.send = async (input) => {
    if (adapter.calls.length === 0) {
      // The failing attempt reports through the error, the succeeding one
      // through its result: the two paths this dedupe spans.
      await originalSend(input).catch(() => undefined);
      throw new GatewayError("UPSTREAM", "retry", { degradations: ["kimi:images-dropped"] });
    }
    const result = await originalSend(input);
    return { ...result, degradations: ["kimi:images-dropped"] };
  };

  const outcome = await dispatch(
    req,
    deps(store, adapter),
    new AbortController().signal,
    "req_dup",
  );
  await drain(outcome.events);

  expect(outcome.log().degradations).toEqual(["kimi:images-dropped"]);
  store.close();
});

test("a fingerprint refusal still records that the cloak was running", async () => {
  const store = await seeded(1);
  const outcome = await dispatch(
    CLOAKED,
    {
      ...deps(
        store,
        stubAdapter(() => textStream("hi")),
      ),
      adapters: { anthropic: anthropicAdapter, openai: anthropicAdapter, kimi: anthropicAdapter },
      http: anthropicHttp(
        400,
        JSON.stringify({
          type: "error",
          error: {
            type: "invalid_request_error",
            message: "You're out of extra usage. Add more at claude.ai/settings/usage.",
          },
        }),
      ),
    },
    new AbortController().signal,
    "req_refused",
  );
  await drain(outcome.events).catch(() => undefined);

  // The whole point of the record: an operator looking at a refusal blamed on
  // tool names must be able to tell whether the rename actually happened. The
  // adapter throws here, so there is no result to carry it.
  expect(outcome.log().errorCode).toBe("FINGERPRINT_REFUSED");
  expect(outcome.log().degradations).toContain("anthropic:tool-names-cloaked");
});

test("injected clock enforces deadline without waiting for the timer", async () => {
  const store = await seeded(1);
  await store.config.putSettings({ requestDeadlineMs: 10 });
  const adapter = stubAdapter(() => textStream("unexpected"));
  const times = [1_000, 1_000, 1_011, 1_011];
  let index = 0;
  const configured = {
    ...deps(store, adapter),
    now: () => times[index++] ?? 1_011,
  };

  const outcome = await dispatch(req, configured, new AbortController().signal, "req_clock");
  const events = await drain(outcome.events);

  expect(events.at(-1)).toMatchObject({ type: "error", code: "TIMEOUT" });
  expect(adapter.calls).toHaveLength(0);
  expect(outcome.log().attempts).toBe(0);
  store.close();
});

test("request deadline is absolute across candidates", async () => {
  const store = await seeded(2);
  await store.config.putSettings({ requestDeadlineMs: 20 });
  let aborted = 0;
  const adapter: ProviderAdapter = {
    id: "anthropic",
    capabilities: { tools: true, images: true, reasoning: true },
    async send(request) {
      return {
        events: (async function* () {
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(resolve, 1_000);
            request.signal.addEventListener(
              "abort",
              () => {
                clearTimeout(timer);
                aborted++;
                reject(request.signal.reason);
              },
              { once: true },
            );
          });
          yield* textStream("late");
        })(),
        degradations: [],
      };
    },
  };
  const outcome = await dispatch(
    req,
    { ...deps(store, adapter), now: () => Date.now() },
    new AbortController().signal,
    "req_test",
  );
  const events = await drain(outcome.events);
  expect(events.at(-1)).toMatchObject({ type: "error", code: "TIMEOUT" });
  expect(outcome.log().attempts).toBe(1);
  expect(aborted).toBe(1);
  store.close();
});

test("request deadline covers credential refresh", async () => {
  const store = await seeded(1);
  await store.config.putSettings({ requestDeadlineMs: 20 });
  await store.credentials.update("c1", { expiresAt: 0 });
  let sends = 0;
  const adapter = stubAdapter(() => {
    sends++;
    return textStream("unexpected");
  });
  const configured = { ...deps(store, adapter), now: () => Date.now() };
  configured.refresh = async () => await new Promise(() => {});
  const outcome = await dispatch(req, configured, new AbortController().signal, "req_test");
  const events = await drain(outcome.events);
  expect(events.at(-1)).toMatchObject({ type: "error", code: "TIMEOUT" });
  expect(sends).toBe(0);
  store.close();
});

test("unlimited request has no dispatch deadline and ends on client cancellation", async () => {
  const store = await seeded(1);
  await store.config.putSettings({ requestDeadlineMs: 0 });
  const started = Promise.withResolvers<void>();
  const adapter: ProviderAdapter = {
    id: "anthropic",
    capabilities: { tools: true, images: true, reasoning: true },
    async send(request) {
      return {
        events: (async function* () {
          started.resolve();
          await new Promise<void>((_resolve, reject) =>
            request.signal.addEventListener("abort", () => reject(request.signal.reason), {
              once: true,
            }),
          );
        })(),
        degradations: [],
      };
    },
  };
  const controller = new AbortController();
  const outcome = await dispatch(
    req,
    { ...deps(store, adapter), now: () => Date.now() },
    controller.signal,
    "req_unlimited",
  );
  const reason = new DOMException("client disconnected", "AbortError");
  let settled = false;
  const draining = drain(outcome.events).finally(() => {
    settled = true;
  });
  await started.promise;
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(settled).toBe(false);

  controller.abort(reason);
  await expect(draining).rejects.toBe(reason);
  store.close();
});

test("unlimited request releases its upstream lifecycle after normal completion", async () => {
  const store = await seeded(1);
  await store.config.putSettings({ requestDeadlineMs: 0 });
  let lifecycleAborts = 0;
  const adapter: ProviderAdapter = {
    id: "anthropic",
    capabilities: { tools: true, images: true, reasoning: true },
    async send(request) {
      request.signal.addEventListener("abort", () => lifecycleAborts++, { once: true });
      return { events: textStream("done"), degradations: [] };
    },
  };
  const outcome = await dispatch(
    req,
    { ...deps(store, adapter), now: () => Date.now() },
    new AbortController().signal,
    "req_unlimited_complete",
  );
  const events = await drain(outcome.events);

  expect(events.at(-1)).toMatchObject({ type: "end" });
  expect(outcome.log()).toMatchObject({ status: 200, errorCode: null });
  expect(lifecycleAborts).toBe(1);
  store.close();
});

test("client abort remains distinct from request deadline", async () => {
  const store = await seeded(1);
  await store.config.putSettings({ requestDeadlineMs: 60_000 });
  const adapter: ProviderAdapter = {
    id: "anthropic",
    capabilities: { tools: true, images: true, reasoning: true },
    async send(request) {
      return {
        events: (async function* () {
          await new Promise<void>((_resolve, reject) =>
            request.signal.addEventListener("abort", () => reject(request.signal.reason), {
              once: true,
            }),
          );
        })(),
        degradations: [],
      };
    },
  };
  const controller = new AbortController();
  const outcome = await dispatch(
    req,
    { ...deps(store, adapter), now: () => Date.now() },
    controller.signal,
    "req_test",
  );
  const reason = new DOMException("client disconnected", "AbortError");
  const draining = drain(outcome.events);
  controller.abort(reason);
  await expect(draining).rejects.toBe(reason);
  store.close();
});

test("counts a request as in flight only while it is in flight", async () => {
  const store = await seeded(1);
  const registry = createLoadRegistry();
  const key = healthKey("c1", "claude-opus-4");
  let duringSend: number | undefined;

  const adapter = stubAdapter(() => textStream("hello"));
  const observing: ProviderAdapter = {
    ...adapter,
    async send(r) {
      duringSend = registry.counts().get(key);
      return adapter.send(r);
    },
  };

  const events = await drain(
    (
      await dispatch(
        req,
        { ...deps(store, observing), loadRegistry: registry },
        new AbortController().signal,
        "req_test",
      )
    ).events,
  );

  expect(events.at(-1)).toMatchObject({ type: "end" });
  expect(duringSend).toBe(1);
  expect(registry.counts().get(key) ?? 0).toBe(0);
  store.close();
});

test("releases the slot when every candidate fails", async () => {
  const store = await seeded(1);
  const registry = createLoadRegistry();
  const adapter = stubAdapter(() => new Error("upstream exploded"));

  await drain(
    (
      await dispatch(
        req,
        { ...deps(store, adapter), loadRegistry: registry },
        new AbortController().signal,
        "req_test",
      )
    ).events,
  );

  expect(registry.counts().get(healthKey("c1", "claude-opus-4")) ?? 0).toBe(0);
  store.close();
});

test("releases the slot when the client hangs up mid-stream", async () => {
  const store = await seeded(1);
  const registry = createLoadRegistry();
  const adapter = stubAdapter(() => textStream("hello"));

  const { events } = await dispatch(
    req,
    { ...deps(store, adapter), loadRegistry: registry },
    new AbortController().signal,
    "req_test",
  );
  // Read one event, then walk away without draining — the generator's finally
  // is the only thing that can free the slot.
  await events.next();
  await events.return(undefined);

  expect(registry.counts().get(healthKey("c1", "claude-opus-4")) ?? 0).toBe(0);
  store.close();
});

test("a burst arriving together fans out across credentials", async () => {
  const store = await seeded(3);
  await store.config.putModel({
    id: "fast",
    strategy: "roundRobin",
    isAlias: false,
    targets: [
      {
        provider: "anthropic",
        model: "claude-opus-4",
        tier: 1,
        weight: 1,
        costPerMTok: { input: 15, output: 75 },
        capabilities: { tools: true, images: true, reasoning: true },
      },
    ],
  });

  const registry = createLoadRegistry();
  const chosen: string[] = [];
  const adapter = stubAdapter(() => textStream("hello"));
  const configured = {
    ...deps(store, adapter),
    loadRegistry: registry,
    onRoute: async (t: { credentialId: string }) => {
      chosen.push(t.credentialId);
    },
  };

  // Every request is dispatched before any stream is drained. This is the case
  // lastUsedAt cannot see and the whole change exists for: nothing has
  // *finished*, so only in-flight accounting can tell these apart.
  const outcomes = await Promise.all(
    Array.from({ length: 9 }, () =>
      dispatch(req, configured, new AbortController().signal, "req_burst"),
    ),
  );
  await Promise.all(outcomes.map((o) => drain(o.events)));

  expect(new Set(chosen).size).toBe(3);
  expect(registry.counts().size).toBe(0);
  store.close();
});

test("abandoning the stream without reading it releases the slot", async () => {
  const store = await seeded(1);
  const registry = createLoadRegistry();
  const adapter = stubAdapter(() => textStream("hello"));

  const { events } = await dispatch(
    req,
    { ...deps(store, adapter), loadRegistry: registry },
    new AbortController().signal,
    "req_test",
  );
  // Closed without a single next(), so no generator body ever runs and no
  // finally inside one can fire. A slot claimed before the body starts has to
  // be freed by something else.
  await events.return(undefined);

  expect(registry.counts().size).toBe(0);
  store.close();
});

test("releases the slot when the client aborts mid-stream", async () => {
  const store = await seeded(1);
  await store.config.putSettings({ requestDeadlineMs: 0 });
  const registry = createLoadRegistry();
  const started = Promise.withResolvers<void>();
  const adapter: ProviderAdapter = {
    id: "anthropic",
    capabilities: { tools: true, images: true, reasoning: true },
    async send(request) {
      return {
        events: (async function* () {
          started.resolve();
          await new Promise<void>((_resolve, reject) =>
            request.signal.addEventListener("abort", () => reject(request.signal.reason), {
              once: true,
            }),
          );
        })(),
        degradations: [],
      };
    },
  };

  const controller = new AbortController();
  const outcome = await dispatch(
    req,
    { ...deps(store, adapter), loadRegistry: registry, now: () => Date.now() },
    controller.signal,
    "req_abort",
  );
  const reason = new DOMException("client disconnected", "AbortError");
  const draining = drain(outcome.events);
  await started.promise;
  expect(registry.counts().get(healthKey("c1", "claude-opus-4"))).toBe(1);

  controller.abort(reason);
  await expect(draining).rejects.toBe(reason);

  expect(registry.counts().size).toBe(0);
  store.close();
});

test("releases the slot when the request deadline expires", async () => {
  const store = await seeded(1);
  await store.config.putSettings({ requestDeadlineMs: 10 });
  const registry = createLoadRegistry();
  const adapter = stubAdapter(() => textStream("unexpected"));
  // The clock must stay inside the deadline until the slot has been claimed and
  // then pass it at the top of the attempt loop. Expiring earlier returns
  // before anything is claimed, which would make this assertion vacuous.
  const times = [1_000, 1_000, 1_000, 1_000, 1_011];
  let index = 0;

  const outcome = await dispatch(
    req,
    { ...deps(store, adapter), loadRegistry: registry, now: () => times[index++] ?? 1_011 },
    new AbortController().signal,
    "req_deadline",
  );
  const events = await drain(outcome.events);

  expect(events.at(-1)).toMatchObject({ type: "error", code: "TIMEOUT" });
  expect(adapter.calls).toHaveLength(0);
  // Nothing inside the attempt loop ran, so only the outer release can free the
  // slot claimed at rank time.
  expect(registry.counts().size).toBe(0);
  store.close();
});

test("releases the slot when an attempt fails after committing bytes", async () => {
  const store = await seeded(2);
  const registry = createLoadRegistry();
  const adapter: ProviderAdapter = {
    id: "anthropic",
    capabilities: { tools: true, images: true, reasoning: true },
    async send() {
      return {
        events: (async function* () {
          yield { type: "start", id: "m", model: "claude-opus-4" };
          yield { type: "blockStart", index: 0, block: { type: "text" } };
          // Past the commit point: failover is impossible from here.
          yield { type: "blockDelta", index: 0, delta: { type: "text", text: "partial" } };
          throw new GatewayError("UPSTREAM", "died mid-stream");
        })(),
        degradations: [],
      };
    },
  };

  const events = await drain(
    (
      await dispatch(
        req,
        { ...deps(store, adapter), loadRegistry: registry },
        new AbortController().signal,
        "req_postcommit",
      )
    ).events,
  );

  expect(events.at(-1)).toMatchObject({ type: "error", code: "UPSTREAM" });
  expect(registry.counts().size).toBe(0);
  store.close();
});

test("a wrapper closed before its first pull still frees the slot on disconnect", async () => {
  const store = await seeded(1);
  await store.config.putSettings({ requestDeadlineMs: 0 });
  const registry = createLoadRegistry();
  const adapter = stubAdapter(() => textStream("hello"));
  const controller = new AbortController();

  const outcome = await dispatch(
    req,
    { ...deps(store, adapter), loadRegistry: registry, now: () => Date.now() },
    controller.signal,
    "req_wrapped",
  );

  // The egress layer wraps this generator in another generator. Closing that
  // wrapper before anything pulls it skips its body, so its `for await` never
  // exists and the close never reaches the generator below — the same blind
  // spot one layer up. Nothing here has run, so nothing here can release.
  const wrapper = (async function* () {
    for await (const event of outcome.events) yield event;
  })();
  await wrapper.return(undefined);
  expect(registry.counts().get(healthKey("c1", "claude-opus-4"))).toBe(1);

  // A real disconnect aborts the request signal, and that does not depend on
  // which layer happened to be consuming.
  controller.abort(new DOMException("client disconnected", "AbortError"));

  expect(registry.counts().size).toBe(0);
  store.close();
});

test("failover counts the credential it moves to, and frees it after", async () => {
  const store = await seeded(2);
  const registry = createLoadRegistry();
  const seen: Array<[string, number]> = [];
  const adapter = stubAdapter((call) =>
    call === 1 ? new GatewayError("UPSTREAM", "retry") : textStream("ok"),
  );
  const observing: ProviderAdapter = {
    ...adapter,
    async send(r) {
      // Which credential the registry believes is busy while this attempt runs.
      for (const [key, n] of await registry.counts()) seen.push([key, n]);
      return adapter.send(r);
    },
  };

  const events = await drain(
    (
      await dispatch(
        req,
        { ...deps(store, observing), loadRegistry: registry },
        new AbortController().signal,
        "req_failover",
      )
    ).events,
  );

  expect(events.at(-1)).toMatchObject({ type: "end" });
  // Attempt 0 counted c1; attempt 1 counted c2 and not c1 — the eager slot is
  // handed back when its attempt ends, not held across the failover.
  expect(seen).toEqual([
    [healthKey("c1", "claude-opus-4"), 1],
    [healthKey("c2", "claude-opus-4"), 1],
  ]);
  expect(registry.counts().size).toBe(0);
  store.close();
});

test("a credential that cannot expire is served without reaching the refresher", async () => {
  // Kilo credentials carry `expiresAt: null` and no refresh token. Handing one
  // to the refresher would throw AUTH on the null refresh token before any
  // provider was consulted, disabling a perfectly good credential.
  const store = await createStore({
    path: ":memory:",
    encryptionKey: await deriveKey("test-secret-value-for-unit-tests"),
  });
  await store.credentials.create({
    id: "k1",
    provider: "kilo",
    label: "k1",
    authType: "oauth",
    enabled: true,
    tier: 1,
    weight: 1,
    expiresAt: null,
    accountEmail: null,
    providerData: {},
    disabledReason: null,
    disabledAt: null,
    accessToken: "test-token-kilo",
    refreshToken: null,
    apiKey: null,
    idToken: null,
  });
  await store.config.putModel({
    id: "fast",
    strategy: "priority",
    isAlias: false,
    targets: [
      {
        provider: "kilo",
        model: "anthropic/claude-sonnet-5",
        tier: 1,
        weight: 1,
        costPerMTok: { input: 2, output: 10 },
        capabilities: { tools: true, images: true, reasoning: true },
      },
    ],
  });

  const adapter = stubAdapter(() => textStream("hello"));
  const configured = {
    ...deps(store, adapter),
    adapters: { kilo: adapter },
    refresh: async (): Promise<CredentialSecrets> => {
      throw new Error("dispatch reached the refresher for a credential that cannot expire");
    },
  };

  const events = await drain(
    (await dispatch(req, configured, new AbortController().signal, "req_test")).events,
  );

  expect(events.at(-1)).toMatchObject({ type: "end" });
  expect(adapter.calls).toEqual(["test-token-kilo"]);
});

/** The line every terminal failure has to leave behind, and nothing else. */
const rejections = (logger: ReturnType<typeof captureLogger>) =>
  logger.records.filter((record) => record.msg === "request rejected");

test("prints why a non-retryable attempt failed, naming the target it failed on", async () => {
  const store = await seeded(1);
  const logger = captureLogger();
  const adapter = stubAdapter(() => new GatewayError("BAD_REQUEST", "max_tokens exceeds limit"));

  const outcome = await dispatch(
    req,
    { ...deps(store, adapter), logger },
    new AbortController().signal,
    "req_test",
  );
  const events = await drain(outcome.events);

  expect(events).toEqual([
    { type: "error", code: "BAD_REQUEST", message: "max_tokens exceeds limit", retryable: false },
  ]);
  expect(rejections(logger)).toHaveLength(1);
  expect(rejections(logger)[0]).toMatchObject({
    level: "warn",
    fields: {
      requestId: "req_test",
      status: 400,
      provider: "anthropic",
      model: "claude-opus-4",
      credentialId: "c1",
      code: "BAD_REQUEST",
      attempts: 1,
    },
  });
  store.close();
});

/**
 * The line an operator gets for the gateway's own defect, which used to be blank.
 *
 * `INTERNAL` prints at `error` precisely because it is this gateway's fault, and
 * an `AggregateError` carries its detail in `errors` with an empty message of its
 * own. Copying that message verbatim rendered `reason=` with nothing after it —
 * and `request_logs` holds no message, so the failure was recoverable nowhere.
 */
test("names an error that carries no message instead of logging a blank reason", async () => {
  const store = await seeded(1);
  const logger = captureLogger();
  const adapter = stubAdapter(() => new AggregateError([new Error("something odd")]));

  const outcome = await dispatch(
    req,
    { ...deps(store, adapter), logger },
    new AbortController().signal,
    "req_test",
  );
  await drain(outcome.events);

  expect(rejections(logger)).toHaveLength(1);
  expect(rejections(logger)[0]?.fields?.reason).toBe("AggregateError");
});

/** The same blank-reason defect on the path that explains a dead refresh token. */
test("names a refresh failure that carries no message", async () => {
  const store = await seeded(1);
  const logger = captureLogger();
  const adapter = stubAdapter(() => new GatewayError("AUTH", "token rejected"));

  const outcome = await dispatch(
    req,
    {
      ...deps(store, adapter),
      logger,
      refresh: (): Promise<CredentialSecrets> => {
        throw new AggregateError([]);
      },
    },
    new AbortController().signal,
    "req_test",
  );
  await drain(outcome.events);

  const failures = logger.records.filter((record) => record.msg === "credential refresh failed");
  expect(failures).toHaveLength(1);
  expect(failures[0]?.fields?.reason).toBe("AggregateError");
});

test("retries a transport failure that arrives as an aggregate of connect errors", async () => {
  const store = await seeded(2);
  const logger = captureLogger();
  const adapter = stubAdapter(
    () => new AggregateError([new Error("connect ECONNREFUSED 160.79.104.10:443")]),
  );

  const outcome = await dispatch(
    req,
    { ...deps(store, adapter), logger },
    new AbortController().signal,
    "req_test",
  );
  await drain(outcome.events);

  // NETWORK is retryable, so both seeded candidates are tried and the pool is
  // reported exhausted. INTERNAL stopped at the first and served a 500 instead.
  expect(adapter.calls).toEqual(["test-token-1", "test-token-2"]);
  expect(rejections(logger)[0]?.fields).toMatchObject({
    code: "ALL_CANDIDATES_FAILED",
    status: 503,
    attempts: 2,
  });
});

test("prints one rejection line when the candidate pool is exhausted", async () => {
  const store = await seeded(2);
  const logger = captureLogger();
  const adapter = stubAdapter(() => new GatewayError("UPSTREAM", "bad gateway"));

  const outcome = await dispatch(
    req,
    { ...deps(store, adapter), logger },
    new AbortController().signal,
    "req_test",
  );
  await drain(outcome.events);

  expect(rejections(logger)).toHaveLength(1);
  expect(rejections(logger)[0]?.fields).toMatchObject({
    requestId: "req_test",
    status: 503,
    code: "ALL_CANDIDATES_FAILED",
    attempts: 2,
  });
  store.close();
});

test("prints a rejection line for a request that never reached a candidate", async () => {
  const store = await seeded(0);
  // Info, not debug: this line has to earn its keep on a default install.
  const logger = captureLogger("info");
  const adapter = stubAdapter(() => textStream("x"));

  const outcome = await dispatch(
    req,
    { ...deps(store, adapter), logger },
    new AbortController().signal,
    "req_test",
  );
  await drain(outcome.events);

  expect(rejections(logger)).toHaveLength(1);
  const fields = rejections(logger)[0]?.fields;
  expect(fields).toMatchObject({ requestId: "req_test", status: 503, code: "NO_CANDIDATES" });
  // Nothing was routed, so there is no target to name — and a line that named
  // one would be inventing it.
  expect(fields?.provider).toBeUndefined();
  expect(fields?.model).toBeUndefined();
  expect(fields?.credentialId).toBeUndefined();
  // This gateway wrote the message, so no prompt can be hiding in it and it
  // prints without debug. Withholding it would leave an empty pool and an
  // unroutable model looking identical, which is the whole question a 503 asks.
  expect(fields?.reason).toBe('no eligible credential for model "fast"');
  store.close();
});

test("prints a codec's own failure at the default level, provider and all", async () => {
  // The other half of the same gate, and the regression that prompted it.
  //
  // `codecFailure` names the provider because that is what makes the line
  // actionable — and naming it is precisely what used to suppress the line,
  // since the gate inferred "came from upstream" from that field. A plugin codec
  // throwing on every request logged `code=UPSTREAM` with no reason, which reads
  // exactly like a provider outage, while the sentence naming the plugin and the
  // hook existed and was withheld.
  //
  // Asserted at `info`, not `debug`: the whole claim is that it does not wait.
  const store = await seeded(1);
  const logger = captureLogger("info");
  const adapter = stubAdapter(
    () =>
      new GatewayError("UPSTREAM", "acme-ai codec buildRequest threw", {
        provider: "anthropic",
        gatewayAuthored: true,
      }),
  );

  const outcome = await dispatch(
    req,
    { ...deps(store, adapter), logger },
    new AbortController().signal,
    "req_test",
  );
  await drain(outcome.events);

  expect(rejections(logger)).toHaveLength(1);
  const fields = rejections(logger)[0]?.fields;
  // Both, together: which provider, and what actually happened to it.
  expect(fields?.provider).toBe("anthropic");
  expect(fields?.reason).toBe("acme-ai codec buildRequest threw");
  store.close();
});

test("prints the upstream message only where debug output was asked for", async () => {
  const upstreamBody = "REJECTION_BODY_SENTINEL";
  for (const [level, expected] of [
    ["debug", upstreamBody],
    ["info", undefined],
  ] as const) {
    const store = await seeded(1);
    const logger = captureLogger(level);
    // `provider` with no `gatewayAuthored` is what an upstream body looks like:
    // `httpError` — the constructor that copies a response body into a message —
    // sets the first and not the second, and the flag defaults off so every
    // unaudited site reads this way too. An error built without a provider is a
    // different case, not a looser fixture.
    const adapter = stubAdapter(
      () => new GatewayError("BAD_REQUEST", upstreamBody, { provider: "anthropic" }),
    );

    const outcome = await dispatch(
      req,
      { ...deps(store, adapter), logger },
      new AbortController().signal,
      "req_test",
    );
    await drain(outcome.events);

    expect(rejections(logger)).toHaveLength(1);
    expect(rejections(logger)[0]?.fields.reason).toBe(expected);
    if (level === "info") expect(logger.lines.join("\n")).not.toContain(upstreamBody);
    store.close();
  }
});

/**
 * The resume after a terminal event is yielded is the one moment a bookkeeping
 * write can reach code that would decide the request a second time.
 *
 * Left to reach the attempt catch, a failed health write reassigned the status
 * the row keeps and yielded another error event — the client receiving two
 * terminal frames for one request, and stdout disagreeing with its own row
 * about the same `requestId`, which is the join those two are supposed to have.
 */
test("a failed health write cannot rewrite an outcome the client already has", async () => {
  const store = await seeded(1);
  const logger = captureLogger("info");
  const adapter = stubAdapter(() =>
    (async function* (): AsyncGenerator<StreamEvent> {
      yield { type: "start", id: "m", model: "claude-opus-4" };
      yield { type: "blockStart", index: 0, block: { type: "text" } };
      yield { type: "blockDelta", index: 0, delta: { type: "text", text: "partial" } };
      yield { type: "error", code: "UPSTREAM", message: "TERMINAL_FRAME", retryable: true };
    })(),
  );
  const configured = {
    ...deps(store, adapter),
    logger,
    store: {
      ...store,
      credentials: {
        ...store.credentials,
        updateHealth: () => Promise.reject(new Error("HEALTH_WRITE_SENTINEL")),
      },
    },
  };

  const outcome = await dispatch(req, configured, new AbortController().signal, "req_test");
  const events = await drain(outcome.events);

  // Told once, and told the truth: the upstream's own failure, not the store's.
  expect(events.filter((e) => e.type === "error")).toHaveLength(1);
  expect(events.at(-1)).toMatchObject({ type: "error", code: "UPSTREAM" });
  expect(outcome.log()).toMatchObject({ status: 502, errorCode: "UPSTREAM" });
  expect(rejections(logger)).toHaveLength(1);
  expect(rejections(logger)[0]?.fields).toMatchObject({ status: 502, code: "UPSTREAM" });

  // Swallowing it silently would trade one invisible failure for another, so
  // the write that died is still reported — at `error`, because it is ours.
  const health = logger.records.filter((r) => r.msg === "failed to persist credential health");
  expect(health).toHaveLength(1);
  expect(health[0]?.level).toBe("error");
  store.close();
});

test("prints no rejection line for a request that succeeded", async () => {
  const store = await seeded(1);
  const logger = captureLogger();
  const adapter = stubAdapter(() => textStream("hello"));

  const outcome = await dispatch(
    req,
    { ...deps(store, adapter), logger },
    new AbortController().signal,
    "req_test",
  );
  await drain(outcome.events);

  expect(outcome.log().status).toBe(200);
  expect(rejections(logger)).toEqual([]);
  store.close();
});

test("prints a rejection line for a decoder's own terminal error event", async () => {
  const store = await seeded(1);
  const logger = captureLogger("info");
  const adapter = stubAdapter(() =>
    (async function* (): AsyncGenerator<StreamEvent> {
      yield { type: "start", id: "m", model: "claude-opus-4" };
      yield { type: "blockStart", index: 0, block: { type: "text" } };
      yield { type: "blockDelta", index: 0, delta: { type: "text", text: "partial" } };
      yield { type: "error", code: "UPSTREAM", message: "DECODER_BODY_SENTINEL", retryable: true };
    })(),
  );

  const outcome = await dispatch(
    req,
    { ...deps(store, adapter), logger },
    new AbortController().signal,
    "req_test",
  );
  await drain(outcome.events);

  expect(rejections(logger)).toHaveLength(1);
  // Committed, so this is the status the client's stream ends on; a line that
  // read `status=0` would be reporting the log before dispatch filled it in.
  expect(rejections(logger)[0]?.fields).toMatchObject({
    requestId: "req_test",
    status: 502,
    provider: "anthropic",
    model: "claude-opus-4",
    credentialId: "c1",
    code: "UPSTREAM",
    attempts: 1,
  });
  expect(logger.lines.join("\n")).not.toContain("DECODER_BODY_SENTINEL");
  store.close();
});

test("prints why a credential refresh failed, gating the endpoint's message", async () => {
  const refreshBody = "REFRESH_BODY_SENTINEL";
  for (const [level, expected] of [
    ["debug", refreshBody],
    ["info", undefined],
  ] as const) {
    const store = await seeded(2);
    const logger = captureLogger(level);
    const adapter = stubAdapter((call) =>
      call === 1 ? new GatewayError("AUTH", "expired") : textStream("fallback"),
    );
    const configured = { ...deps(store, adapter), logger };
    configured.refresh = async () => {
      throw new GatewayError("UPSTREAM", refreshBody, { provider: "anthropic" });
    };

    const outcome = await dispatch(req, configured, new AbortController().signal, "req_test");
    await drain(outcome.events);

    // The refresh *attempt* is already announced, so without this the output
    // reads as a refresh that worked followed by an unexplained failover.
    const failed = logger.records.filter((record) => record.msg === "credential refresh failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]?.level).toBe("warn");
    expect(failed[0]?.fields).toMatchObject({
      requestId: "req_test",
      provider: "anthropic",
      model: "claude-opus-4",
      credentialId: "c1",
      attempt: 1,
      code: "UPSTREAM",
    });
    expect(failed[0]?.fields.reason).toBe(expected);
    if (level === "info") expect(logger.lines.join("\n")).not.toContain(refreshBody);
    store.close();
  }
});

/**
 * The other half of the rule, and the reason it is a rule rather than a debug
 * gate: most of what fails a refresh, this gateway wrote.
 *
 * A rejected OIDC discovery document, a provider with no refresh grant, a token
 * response carrying no `access_token` — none can hold a prompt, and each is the
 * single fact that explains the failover underneath it. Gating the whole line
 * on debug left an operator a bare `code=UPSTREAM` for exactly the faults it
 * was added to name.
 */
test("prints a refresh failure this gateway wrote, without waiting for debug", async () => {
  const ownMessage = "discovery document token_endpoint is not an accounts.example.com https url";
  const store = await seeded(2);
  const logger = captureLogger("info");
  const adapter = stubAdapter((call) =>
    call === 1 ? new GatewayError("AUTH", "expired") : textStream("fallback"),
  );
  const configured = { ...deps(store, adapter), logger };
  configured.refresh = async () => {
    // No `provider`: nothing upstream said this.
    throw new GatewayError("UPSTREAM", ownMessage);
  };

  const outcome = await dispatch(req, configured, new AbortController().signal, "req_test");
  await drain(outcome.events);

  const failed = logger.records.filter((record) => record.msg === "credential refresh failed");
  expect(failed).toHaveLength(1);
  expect(failed[0]?.fields.reason).toBe(ownMessage);
  store.close();
});

/** A request with a cacheable prefix and no breakpoint of its own. */
const UNMARKED_PREFIX: ChatRequest = {
  model: "fast",
  stream: true,
  system: [{ type: "text", text: "You are a careful assistant. ".repeat(400) }],
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  tools: [{ kind: "portable", name: "session_search", inputSchema: { type: "object" } }],
};

/** Runs the real Anthropic adapter and returns the bytes it put on the wire. */
async function wireFor(
  store: Store,
  request: ChatRequest = UNMARKED_PREFIX,
): Promise<{ body: string; degradations: string[] }> {
  let sent = "";
  const outcome = await dispatch(
    request,
    {
      ...deps(
        store,
        stubAdapter(() => textStream("hi")),
      ),
      adapters: { anthropic: anthropicAdapter, openai: anthropicAdapter, kimi: anthropicAdapter },
      http: async (request) => {
        sent = request.body;
        return {
          status: 200,
          headers: new Headers({ "content-type": "text/event-stream" }),
          body: new Response("").body as ReadableStream<Uint8Array>,
          text: async () => "",
        };
      },
    },
    new AbortController().signal,
    "req_autocache",
  );
  await drain(outcome.events);
  return { body: sent, degradations: outcome.log().degradations };
}

/** Just the bytes, for the tests that only ask what reached the wire. */
async function wireBodyFor(store: Store): Promise<string> {
  return (await wireFor(store)).body;
}

/** The same prefix, but with the caller's own breakpoint on its last block. */
const MARKED_PREFIX: ChatRequest = {
  ...UNMARKED_PREFIX,
  system: [
    {
      type: "text",
      text: "You are a careful assistant. ".repeat(400),
      cacheControl: { type: "ephemeral", ttl: "1h" },
    },
  ],
};

/**
 * The system blocks of an Anthropic wire body, as text plus breakpoint.
 *
 * Read by position from the end, never by a fixed length: the OAuth leg
 * prepends a billing header and two identity lines, so the caller's own first
 * block is not index 0 and the count is a property of the credential rather
 * than of anything these tests assert.
 */
function wireSystem(body: string): Array<{ text: string; marker: unknown }> {
  const parsed = JSON.parse(body) as { system?: Array<{ text?: string; cache_control?: unknown }> };
  return (parsed.system ?? []).map((block) => ({
    text: block.text ?? "",
    marker: block.cache_control,
  }));
}

// The one interaction this feature can get silently and expensively wrong. Both
// halves are asserted against the real `toWire`, because the claim is about what
// Anthropic is billed for, and every hop before the wire looked right while the
// bug that motivated `autoCacheEnabled`'s own test was live.
test("auto-cache marks the ponytail block when the client marked nothing", async () => {
  const store = await seeded(1);
  await store.config.putSettings({ ponytailMode: "full" });

  const { body, degradations } = await wireFor(store);

  // The ruleset is last, so the system-tier breakpoint lands on it and the
  // ruleset is inside the cached prefix rather than trailing it.
  const system = wireSystem(body);
  const last = system.at(-1);
  expect(last?.text).toContain("You are a lazy senior developer.");
  expect(last?.marker).toEqual({ type: "ephemeral" });
  // Nothing earlier in system is marked, so this is the tier's one breakpoint.
  expect(system.slice(0, -1).every((block) => block.marker === undefined)).toBe(true);
  expect(degradations).toContain("anthropic:cache-breakpoint-added");
  store.close();
});

test("auto-cache still declines when the client marked its own prompt", async () => {
  const store = await seeded(1);
  await store.config.putSettings({ ponytailMode: "full" });

  const { body, degradations } = await wireFor(store, MARKED_PREFIX);

  // The caller's own marker moved onto the ruleset, TTL intact, and the count
  // is unchanged — so `estimateCachedInputTokens` stays non-zero and auto-cache
  // adds nothing. Moving a marker must never become a way to switch it on.
  const system = wireSystem(body);
  const last = system.at(-1);
  expect(last?.text).toContain("You are a lazy senior developer.");
  expect(last?.marker).toEqual({ type: "ephemeral", ttl: "1h" });
  // One breakpoint in, one breakpoint out — the caller's, relocated.
  expect(system.filter((block) => block.marker !== undefined)).toHaveLength(1);
  expect(degradations).not.toContain("anthropic:cache-breakpoint-added");
  expect(degradations).toContain("ponytail:cache-marker-moved");
  store.close();
});

test("the auto-cache setting reaches the wire, on and off", async () => {
  // The setting travels store -> snapshot -> dispatch -> attempt -> adapter ->
  // toWire, and every hop but the last was assertable only by reading the code.
  // `attempt` forwards it through a spread that fails silently open, so a typo
  // there produces a feature that is simply never on.
  const on = await seeded(1);
  expect(await wireBodyFor(on)).toContain("cache_control");
  on.close();

  const off = await seeded(1);
  await off.config.putSettings({ autoCacheEnabled: false });
  expect(await wireBodyFor(off)).not.toContain("cache_control");
  off.close();
});

test("a candidate whose adapter is not injected fails INTERNAL, not silently", async () => {
  // Dead code until `ProviderId` widened: with a closed union of six and
  // `ADAPTERS` total over it, `deps.adapters[provider]` could not miss. It can
  // now, because `deps.adapters` is a separate injection point from
  // `PROVIDER_DESCRIPTORS` and the two can disagree — grok has a descriptor, so
  // the router admits the target, and the map handed to dispatch has no adapter
  // for it.
  //
  // `INTERNAL` and a throw, deliberately. Reaching here means the router
  // admitted a candidate it should have excluded, which is a gateway bug rather
  // than an operator one; a target naming a provider that is genuinely not
  // installed is excluded upstream as `provider:missing` and never arrives.
  const store = await seeded(1);
  await store.credentials.create({
    id: "g1",
    provider: "grok",
    label: "g1",
    authType: "apiKey",
    enabled: true,
    tier: 1,
    weight: 1,
    expiresAt: null,
    accountEmail: null,
    providerData: {},
    disabledReason: null,
    disabledAt: null,
    accessToken: null,
    refreshToken: null,
    apiKey: "grok-key",
    idToken: null,
  });
  await store.config.putModel({
    id: "fast",
    strategy: "priority",
    isAlias: false,
    targets: [
      {
        provider: "grok",
        model: "grok-4",
        tier: 1,
        weight: 1,
        costPerMTok: { input: 1, output: 1 },
        capabilities: { tools: true, images: true, reasoning: true },
      },
    ],
  });

  const configured = {
    ...deps(
      store,
      stubAdapter(() => textStream("unreachable")),
    ),
    adapters: { anthropic: stubAdapter(() => textStream("unreachable")) },
  };

  // Thrown while draining, not from `dispatch` itself: the attempt loop runs
  // inside the returned generator, so nothing fails until the first pull. That
  // is worth pinning — a caller awaiting `dispatch` and never draining would see
  // a clean resolve.
  const outcome = await dispatch(req, configured, new AbortController().signal, "req_no_adapter");
  // One drain, not two: a generator that has thrown is done, and a second pull
  // resolves empty rather than throwing again.
  const failure = await drain(outcome.events).then(
    () => null,
    (error: unknown) => error,
  );
  expect(failure).toMatchObject({
    code: "INTERNAL",
    // Not retryable, so it ends the request rather than burning every remaining
    // candidate on a bug none of them can fix.
    retryable: false,
  });
  expect((failure as Error).message).toMatch(/no adapter for provider grok/);
  store.close();
});

test("an adapter map built by a caller cannot answer for an Object member", async () => {
  // `DispatchDeps.adapters` is a public injection point — this file, the proxy
  // routes, and any embedder construct it as an ordinary object literal, so
  // `adapters["constructor"]` answers the `Object` constructor. Before the read
  // site asked `Object.hasOwn`, the lookup succeeded and dispatch called `.send`
  // on a function that has no `send`: a raw `TypeError` where `INTERNAL` was
  // intended, and `classify` turns that into a 500 blaming the gateway.
  //
  // Normalising the map inside `createApp` did not cover this, which is the
  // whole point — this test deliberately does not go through `createApp`, and
  // that is the path the earlier fix missed.
  //
  // Both injection points are supplied, because the router excludes an
  // unregistered provider before dispatch ever looks: `providers` says the
  // installation has `constructor`, `adapters` does not, and their disagreeing
  // is exactly what `INTERNAL` reports.
  const store = await seeded(1);
  await store.credentials.create({
    id: "p1",
    provider: "constructor",
    label: "p1",
    authType: "apiKey",
    enabled: true,
    tier: 1,
    weight: 1,
    expiresAt: null,
    accountEmail: null,
    providerData: {},
    disabledReason: null,
    disabledAt: null,
    accessToken: null,
    refreshToken: null,
    apiKey: "k",
    idToken: null,
  });
  await store.config.putModel({
    id: "fast",
    strategy: "priority",
    isAlias: false,
    targets: [
      {
        provider: "constructor",
        model: "m-1",
        tier: 1,
        weight: 1,
        costPerMTok: { input: 1, output: 1 },
        capabilities: { tools: true, images: true, reasoning: true },
      },
    ],
  });

  const anthropic = entryOf(PROVIDER_DESCRIPTORS, "anthropic", "PROVIDER_DESCRIPTORS");
  const providers: ProviderDescriptors = {
    ...PROVIDER_DESCRIPTORS,
    constructor: { ...anthropic, id: "constructor" },
  };
  const configured = {
    ...deps(
      store,
      stubAdapter(() => textStream("unreachable")),
    ),
    providers,
    // A plain literal with a prototype, exactly as every caller writes one.
    adapters: { anthropic: stubAdapter(() => textStream("unreachable")) },
  };

  const outcome = await dispatch(req, configured, new AbortController().signal, "req_proto");
  const failure = await drain(outcome.events).then(
    () => null,
    (error: unknown) => error,
  );

  expect(failure).toMatchObject({ code: "INTERNAL", retryable: false });
  expect((failure as Error).message).toMatch(/no adapter for provider constructor/);
  // Not a `TypeError` about `.send`, which is what the un-guarded lookup gave.
  expect((failure as Error).message).not.toMatch(/is not a function/);
  store.close();
});

test("a request routed on the injected registry is priced on it too", async () => {
  // The end-to-end shape of the disagreement. `dispatch` threads
  // `deps.providers` into `resolveModel` and `rank`, so a provider that exists
  // only in the injected registry routes and dispatches — and for one round
  // `priceOf` still read the module-global one, so its cache writes were priced
  // at zero. The request succeeded, the row was written, and the only evidence
  // was a `costUsd` that was too low. No throw, no log line, no degradation.
  //
  // The target is deliberately legacy-shaped: no explicit `cacheWrite5m`, so the
  // descriptor's multiplier is what decides the bill. A target carrying its own
  // write price never consults the descriptor and could not show this.
  const store = await seeded(1);
  await store.credentials.create({
    id: "la1",
    provider: "late-arrival",
    label: "la1",
    authType: "apiKey",
    enabled: true,
    tier: 1,
    weight: 1,
    expiresAt: null,
    accountEmail: null,
    providerData: {},
    disabledReason: null,
    disabledAt: null,
    accessToken: null,
    refreshToken: null,
    apiKey: "k",
    idToken: null,
  });
  await store.config.putModel({
    id: "fast",
    strategy: "priority",
    isAlias: false,
    targets: [
      {
        provider: "late-arrival",
        model: "m-1",
        tier: 1,
        weight: 1,
        costPerMTok: { input: 5, output: 25, cacheRead: 0.5 },
        capabilities: { tools: true, images: true, reasoning: true },
      },
    ],
  });

  const anthropic = entryOf(PROVIDER_DESCRIPTORS, "anthropic", "PROVIDER_DESCRIPTORS");
  const providers: ProviderDescriptors = {
    ...PROVIDER_DESCRIPTORS,
    "late-arrival": { ...anthropic, id: "late-arrival" },
  };
  const adapter = stubAdapter(() => cacheWriteStream(1_000_000));
  const outcome = await dispatch(
    req,
    { ...deps(store, adapter), providers, adapters: { "late-arrival": adapter } },
    new AbortController().signal,
    "req_priced",
  );
  await drain(outcome.events);

  const log = outcome.log();
  expect(log.status).toBe(200);
  expect(log.cacheWriteTokens).toBe(1_000_000);
  // 5 * 1.25 = 6.25 per million, Anthropic's write multiplier, which is what the
  // injected descriptor carries. Zero is what the bug produced.
  expect(log.costUsd).toBeCloseTo(6.25, 10);
  store.close();
});

test("a request routed on the default registry is priced on it too", async () => {
  // The production path, and the half the test above does not cover. That one
  // passes `providers`, so both it and the unit tests exercise only the injected
  // branch — `deps.providers ?? {}` at the call site breaks the default path and
  // survives the whole dispatch suite, caught only incidentally by unrelated
  // rate-limit assertions. Adding the new behaviour's test without its
  // counterpart is how the coverage came out one-sided.
  //
  // Same shape as its sibling: a legacy target with no explicit `cacheWrite5m`,
  // so the descriptor's multiplier is what decides the bill. `anthropic` is a
  // real provider, so the default registry is what has to supply it.
  const store = await seeded(1);
  await store.config.putModel({
    id: "fast",
    strategy: "priority",
    isAlias: false,
    targets: [
      {
        provider: "anthropic",
        model: "claude-opus-4",
        tier: 1,
        weight: 1,
        costPerMTok: { input: 5, output: 25, cacheRead: 0.5 },
        capabilities: { tools: true, images: true, reasoning: true },
      },
    ],
  });

  const adapter = stubAdapter(() => cacheWriteStream(1_000_000));
  // No `providers`, exactly as `createApp` builds these deps.
  const outcome = await dispatch(
    req,
    { ...deps(store, adapter), adapters: { anthropic: adapter } },
    new AbortController().signal,
    "req_default_priced",
  );
  await drain(outcome.events);

  const log = outcome.log();
  expect(log.status).toBe(200);
  expect(log.cacheWriteTokens).toBe(1_000_000);
  // Anthropic's real 1.25x write multiplier: 5 * 1.25 = 6.25 per million. Zero
  // is what an empty or bypassed registry produces.
  expect(log.costUsd).toBeCloseTo(6.25, 10);
  store.close();
});

test("a bare model name is inferred against the injected registry", async () => {
  // The third threading in this function, and the one no test reached. Every
  // other dispatch test asks for a *configured* virtual model, so
  // `resolveModel` returns from `snapshot.models.get(name)` before it ever
  // consults a registry — which means `deps.providers ?? {}` at that call site
  // survived the entire suite, not just this file.
  //
  // Found by extending the reviewer's own method to the sites they did not name
  // rather than stopping at the one they did. All three threadings now have a
  // test that fails if the registry stops reaching them.
  const store = await seeded(1);
  await store.credentials.create({
    id: "la1",
    provider: "late-arrival",
    label: "la1",
    authType: "apiKey",
    enabled: true,
    tier: 1,
    weight: 1,
    expiresAt: null,
    accountEmail: null,
    providerData: {},
    disabledReason: null,
    disabledAt: null,
    accessToken: null,
    refreshToken: null,
    apiKey: "k",
    idToken: null,
  });
  // Deliberately no `putModel`: the name has to be inferred from its prefix,
  // which is the only path that reads the registry.
  await store.config.removeModel("fast");

  const anthropic = entryOf(PROVIDER_DESCRIPTORS, "anthropic", "PROVIDER_DESCRIPTORS");
  const providers: ProviderDescriptors = {
    ...PROVIDER_DESCRIPTORS,
    "late-arrival": { ...anthropic, id: "late-arrival", modelPrefixes: ["latearr-"] },
  };
  const adapter = stubAdapter(() => textStream("ok"));
  const outcome = await dispatch(
    { ...req, model: "latearr-1" },
    { ...deps(store, adapter), providers, adapters: { "late-arrival": adapter } },
    new AbortController().signal,
    "req_inferred",
  );
  await drain(outcome.events);

  const log = outcome.log();
  expect(log.status).toBe(200);
  // Routed to the provider only the injected registry declares a prefix for.
  expect(log.resolvedProvider).toBe("late-arrival");
  expect(log.resolvedModel).toBe("latearr-1");
  store.close();
});

test("a bare model name is inferred against the default registry", async () => {
  // The production half of the test above, and the one that actually pins the
  // threading. `deps.providers ?? {}` at the `resolveModel` call site only
  // changes behaviour when `deps.providers` is *undefined*, so a test that
  // injects a registry cannot catch it — every other dispatch test uses a
  // configured virtual model, where `resolveModel` returns before consulting a
  // registry at all. Both gaps had to close for the mutant to die.
  //
  // No `putModel`, so `claude-opus-4` has to be inferred from the `claude-`
  // prefix the real registry declares for anthropic.
  const store = await seeded(1);
  await store.config.removeModel("fast");

  const adapter = stubAdapter(() => textStream("ok"));
  const outcome = await dispatch(
    { ...req, model: "claude-opus-4" },
    { ...deps(store, adapter), adapters: { anthropic: adapter } },
    new AbortController().signal,
    "req_inferred_default",
  );
  await drain(outcome.events);

  const log = outcome.log();
  expect(log.status).toBe(200);
  expect(log.resolvedProvider).toBe("anthropic");
  expect(log.resolvedModel).toBe("claude-opus-4");
  store.close();
});

test("a sentinel registry reaches every consumer dispatch has", async () => {
  // The pattern test, rather than one more instance of it.
  //
  // Three review rounds each found the same defect in the previous round's fix:
  // a registry threaded into some of the functions reachable from `dispatch` and
  // not all. The prototype sweep stopped at one package; the injection work
  // threaded `resolveModel` and `rank` but not `priceOf`; the tests pinning that
  // covered the injected path but not the default. Each was found by hand, one
  // at a time, by someone thinking to try that particular site.
  //
  // This asks the question of the whole call graph at once. `deps.providers`
  // holds one synthetic provider and none of the six real ones, so a consumer
  // reading the module-global instead sees a registry without `sentinel` and
  // fails loudly rather than differently:
  //
  //   - `resolveModel` cannot infer `sent-1` from its prefix -> NO_CANDIDATES
  //   - `eligible` excludes the target as `provider:missing` -> no candidates
  //   - `priceOf` finds no `writeOverInput` -> cache writes billed at zero
  //
  // Two dispatches because one request cannot reach all three: a *configured*
  // model short-circuits `resolveModel` before it consults any registry, while
  // an *inferred* one goes through `synthesize`. One sentinel registry, both
  // paths, and **both assert `costUsd`**.
  //
  // The adapter behind it is `codecAdapter` rather than a stub, so the same two
  // dispatches also cross the contract a plugin supplies its provider through.
  // That is not a second test wearing this one's clothes: a plugin provider *is*
  // the synthetic provider injected here, so the registry question and the codec
  // question have the same subject, and giving them separate fixtures would mean
  // the registry was proved against something no plugin can supply.
  //
  // The inferred leg did not, and the comment here explained why: an inferred
  // target was priced from `PROVIDER_MODEL_CATALOG`, a different global that is
  // not injected, so it carried zero prices and could show no multiplier. That
  // stopped being true when `synthesize` moved onto `descriptor.catalog` — and
  // this comment went on telling the next reader not to bother, one assertion
  // away from covering the fix. A stale reason not to test something is worse
  // than no comment: it is the previous round's defect wearing the previous
  // round's justification, which is exactly how three rounds in a row went.
  const sentinel: ProviderDescriptors = {
    sentinel: {
      ...entryOf(PROVIDER_DESCRIPTORS, "anthropic", "PROVIDER_DESCRIPTORS"),
      id: "sentinel",
      modelPrefixes: ["sent-"],
      // Its own catalog, listing only the inferred model, at prices no built-in
      // charges. A fallback to the global cannot produce these numbers by
      // coincidence — the global has no `sentinel` key at all.
      catalog: {
        defaultModel: "sent-1",
        authTypes: ["apiKey"],
        models: [
          {
            id: "sent-1",
            label: "Sentinel One",
            pricing: {
              input: 7,
              output: 33,
              cacheRead: 0.7,
              cacheWrite5m: 11,
              cacheWrite1h: 21,
            },
            limits: { contextWindow: 123_000, maxOutputTokens: 4_096 },
          },
        ],
      },
    },
  };

  const store = await seeded(1);
  await store.credentials.create({
    id: "s1",
    provider: "sentinel",
    label: "s1",
    authType: "apiKey",
    enabled: true,
    tier: 1,
    weight: 1,
    expiresAt: null,
    accountEmail: null,
    providerData: {},
    disabledReason: null,
    disabledAt: null,
    accessToken: null,
    refreshToken: null,
    apiKey: "k",
    idToken: null,
  });
  // A configured pool with legacy pricing: no explicit `cacheWrite5m`, so the
  // bill is decided by the descriptor's multiplier, which only the sentinel
  // registry supplies. This is the `eligible` + `priceOf` half.
  await store.config.putModel({
    id: "fast",
    strategy: "priority",
    isAlias: false,
    targets: [
      {
        provider: "sentinel",
        model: "s-model",
        tier: 1,
        weight: 1,
        costPerMTok: { input: 5, output: 25, cacheRead: 0.5 },
        capabilities: { tools: true, images: true, reasoning: true },
      },
    ],
  });

  // The adapter is `codecAdapter`, not a stub: this test injects exactly what a
  // plugin supplies, so the codec contract crosses the same call graph the
  // registry does and the host is the only thing performing a request.
  const sentinelAdapter = codecAdapter(
    "sentinel",
    { tools: true, images: true, reasoning: true },
    sentinelCodec,
  );
  const upstream = sentinelUpstream();
  const configured = {
    ...deps(store, sentinelAdapter),
    http: upstream.http,
    providers: sentinel,
    adapters: { sentinel: sentinelAdapter },
  };
  const priced = await dispatch(req, configured, new AbortController().signal, "req_sentinel_a");
  await drain(priced.events);
  const pricedLog = priced.log();

  expect(pricedLog.status).toBe(200);
  expect(pricedLog.resolvedProvider).toBe("sentinel");
  // 5 * 1.25 = 6.25 per million. Zero is what a fallback to the global gives.
  expect(pricedLog.costUsd).toBeCloseTo(6.25, 10);
  // The host sent the request the codec described. Without this the cost
  // assertions above would hold for a codec whose `buildRequest` was never read.
  expect(upstream.urls).toEqual([SENTINEL_URL]);

  // And the `resolveModel` half: the same registry has to be what infers a bare
  // name from its prefix, *and* what prices what it inferred.
  await store.config.removeModel("fast");
  const inferredUpstream = sentinelUpstream();
  const inferred = await dispatch(
    { ...req, model: "sent-1" },
    {
      ...deps(store, sentinelAdapter),
      http: inferredUpstream.http,
      providers: sentinel,
      adapters: { sentinel: sentinelAdapter },
    },
    new AbortController().signal,
    "req_sentinel_b",
  );
  await drain(inferred.events);
  const inferredLog = inferred.log();

  expect(inferredLog.status).toBe(200);
  expect(inferredLog.resolvedProvider).toBe("sentinel");
  expect(inferredLog.resolvedModel).toBe("sent-1");
  // One million cache-write tokens at the descriptor's own `cacheWrite5m` of 11.
  // Zero is what pricing from the un-injected global gives, and 6.25 is what the
  // configured leg above produces — so neither a fallback nor a copy of the
  // other half can pass this by accident.
  expect(inferredLog.costUsd).toBeCloseTo(11, 10);
});

/** Records the system prompt each attempt actually sent, flattened to compare. */
function systemSent(adapter: ProviderAdapter, seen: string[]): void {
  const original = adapter.send.bind(adapter);
  adapter.send = async (input) => {
    seen.push((input.request.system ?? []).map((b) => (b.type === "text" ? b.text : "")).join("|"));
    return original(input);
  };
}

test("appends the ponytail ruleset once and sends identical system content on failover", async () => {
  const store = await seeded(2);
  await store.config.putSettings({ ponytailMode: "full" });
  const adapter = stubAdapter((call) =>
    call === 1 ? new GatewayError("UPSTREAM", "retry") : textStream("ok"),
  );
  const seen: string[] = [];
  systemSent(adapter, seen);
  const input: ChatRequest = {
    model: "fast",
    stream: false,
    system: [{ type: "text", text: "you are helpful" }],
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  };

  const outcome = await dispatch(
    input,
    deps(store, adapter),
    new AbortController().signal,
    "req_p",
  );
  await drain(outcome.events);

  expect(seen).toHaveLength(2);
  expect(seen[0]).toBe(seen[1]);
  expect(seen[0]).toContain("You are a lazy senior developer.");
  expect(outcome.log().degradations).toContain("ponytail:full");
  store.close();
});

test("leaves the request alone and records nothing when ponytail is off", async () => {
  const store = await seeded(1);
  const adapter = stubAdapter(() => textStream("ok"));
  const seen: string[] = [];
  systemSent(adapter, seen);
  const input: ChatRequest = {
    model: "fast",
    stream: false,
    system: [{ type: "text", text: "you are helpful" }],
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  };

  const outcome = await dispatch(
    input,
    deps(store, adapter),
    new AbortController().signal,
    "req_o",
  );
  await drain(outcome.events);

  expect(seen[0]).toBe("you are helpful");
  expect(outcome.log().degradations.some((d) => d.startsWith("ponytail:"))).toBe(false);
  store.close();
});

test("records a moved cache breakpoint separately from the level", async () => {
  const store = await seeded(1);
  await store.config.putSettings({ ponytailMode: "lite" });
  const adapter = stubAdapter(() => textStream("ok"));
  const input: ChatRequest = {
    model: "fast",
    stream: false,
    system: [{ type: "text", text: "prefix", cacheControl: { type: "ephemeral" } }],
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  };

  const outcome = await dispatch(
    input,
    deps(store, adapter),
    new AbortController().signal,
    "req_m",
  );
  await drain(outcome.events);

  expect(outcome.log().degradations).toContain("ponytail:lite");
  expect(outcome.log().degradations).toContain("ponytail:cache-marker-moved");
  store.close();
});

test("an in-stream upstream message is withheld from stdout, like a thrown one", async () => {
  // The decoders build this message from the upstream's own body — a
  // context-length refusal quotes prompt text back into it — and this rethrow
  // reached `reasonField` with no provider, so it printed at default level.
  // `httpError` avoids exactly that on the non-streaming path by naming the
  // provider; the streaming path is the busiest client's default.
  //
  // `captureLogger("info")` and not the default: `captureLogger()` is `debug`,
  // where `reasonField` prints unconditionally, so a test written with the
  // default cannot tell withheld from printed.
  // One credential, so the in-stream error is terminal: the retry line carries
  // no `reason` at all, and the message only reaches stdout once the candidates
  // are exhausted and `reasonField` decides whether to print `lastError`.
  const store = await seeded(1);
  const logger = captureLogger("info");
  const upstreamBody = "IN_STREAM_UPSTREAM_SENTINEL";
  const adapter = stubAdapter(() => {
    return (async function* () {
      yield { type: "start", id: "m", model: "claude-opus-4" } as StreamEvent;
      yield {
        type: "error",
        code: "UPSTREAM",
        message: upstreamBody,
        retryable: true,
      } as StreamEvent;
    })();
  });

  const outcome = await dispatch(
    req,
    { ...deps(store, adapter), logger },
    new AbortController().signal,
    "req_test",
  );
  await drain(outcome.events);

  expect(logger.lines.join("\n")).not.toContain(upstreamBody);
  // The operator still learns which provider failed, and with what code.
  expect(logger.lines.join("\n")).toContain("provider=anthropic");
  store.close();
});

import { expect, test } from "bun:test";
import { type ChatRequest, GatewayError, type StreamEvent } from "@omni/ir";
import type { HttpClient, ProviderAdapter } from "@omni/providers";
import { buildSnapshot, healthKey } from "@omni/router";
import type { CredentialSecrets, Store } from "@omni/store";
import { createStore, deriveKey } from "@omni/store";
import { captureLogger } from "@omni/testkit";
import { dispatch } from "../../src/dispatch/index.ts";
import { createLoadRegistry } from "../../src/dispatch/loadRegistry.ts";

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
    deps(store, adapter),
    new AbortController().signal,
    "req_test",
  );
  const events = await drain(outcome.events);

  expect(adapter.calls).toHaveLength(1);
  expect(events.at(-1)).toMatchObject({ type: "error", code: "UPSTREAM" });
  expect(outcome.log().status).toBe(502);
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

  expect(outcome.log().degradations).toContain("excluded:capability:anthropicTools");
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
      for (const [key, n] of registry.counts()) seen.push([key, n]);
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

test("prints the upstream message only where debug output was asked for", async () => {
  const upstreamBody = "REJECTION_BODY_SENTINEL";
  for (const [level, expected] of [
    ["debug", upstreamBody],
    ["info", undefined],
  ] as const) {
    const store = await seeded(1);
    const logger = captureLogger(level);
    // `provider` is what marks a message as the upstream's own, and `httpError`
    // — the only constructor that copies a response body into one — always sets
    // it. An error built without it is a different case, not a looser fixture.
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

import { expect, test } from "bun:test";
import { type ChatRequest, GatewayError, type StreamEvent } from "@omni/ir";
import type { HttpClient, ProviderAdapter } from "@omni/providers";
import type { Store } from "@omni/store";
import { createStore, deriveKey } from "@omni/store";
import { dispatch } from "../../src/dispatch/index.ts";

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
    adapters: { anthropic: adapter, openai: adapter, kimi: adapter },
    http: noHttp,
    now: () => 1_000_000,
    rand: () => 0,
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

test("streams a successful response and logs it", async () => {
  const store = await seeded(1);
  const adapter = stubAdapter(() => textStream("hello"));
  const outcome = await dispatch(req, deps(store, adapter), new AbortController().signal);
  const events = await drain(outcome.events);

  expect(events.at(-1)).toMatchObject({ type: "end" });
  const log = outcome.log();
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

  const outcome = await dispatch(req, configured, new AbortController().signal);
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

  const outcome = await dispatch(req, configured, new AbortController().signal);
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

  const outcome = await dispatch(req, configured, new AbortController().signal);
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

  const outcome = await dispatch(req, configured, new AbortController().signal);
  await drain(outcome.events);

  expect(adapter.calls).toEqual(["test-token-1", "test-token-2"]);
  expect(outcome.log().attempts).toBe(2);
  store.close();
});

test("fails over to the next credential before the commit point", async () => {
  const store = await seeded(2);
  const adapter = stubAdapter((call) =>
    call === 1 ? new GatewayError("UPSTREAM", "boom") : textStream("recovered"),
  );
  const outcome = await dispatch(req, deps(store, adapter), new AbortController().signal);
  const events = await drain(outcome.events);

  expect(adapter.calls).toHaveLength(2);
  expect(events.some((e) => e.type === "blockDelta")).toBe(true);
  expect(outcome.log().attempts).toBe(2);
  expect(outcome.log().status).toBe(200);
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

  const outcome = await dispatch(req, deps(store, adapter), new AbortController().signal);
  const events = await drain(outcome.events);

  expect(adapter.calls).toHaveLength(1);
  expect(events.at(-1)).toMatchObject({ type: "error", code: "UPSTREAM" });
  expect(outcome.log().status).toBe(502);
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

  const outcome = await dispatch(req, deps(store, adapter), new AbortController().signal);
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
  const outcome = await dispatch(req, deps(store, adapter), new AbortController().signal);
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
  const outcome = await dispatch(req, deps(store, adapter), new AbortController().signal);
  await drain(outcome.events);

  expect(adapter.calls).toHaveLength(2);
  expect(outcome.log().errorCode).toBe("ALL_CANDIDATES_FAILED");
  store.close();
});

test("emits NO_CANDIDATES when the pool is empty", async () => {
  const store = await seeded(0);
  const adapter = stubAdapter(() => textStream("x"));
  const outcome = await dispatch(req, deps(store, adapter), new AbortController().signal);
  const events = await drain(outcome.events);

  expect(events[0]).toMatchObject({ type: "error", code: "NO_CANDIDATES" });
  expect(outcome.log().status).toBe(503);
  store.close();
});

test("a hard failure opens the breaker and persists it", async () => {
  const store = await seeded(1);
  await store.config.putSettings({ maxAttempts: 1, breakerThreshold: 1 });
  const adapter = stubAdapter(() => new GatewayError("UPSTREAM", "boom"));
  await drain((await dispatch(req, deps(store, adapter), new AbortController().signal)).events);

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
  await drain((await dispatch(req, deps(store, adapter), new AbortController().signal)).events);

  const rows = await store.credentials.listHealth();
  expect(rows[0]?.breakerState).toBe("closed");
  expect(rows[0]?.rateLimitedUntil).toBe(1_030_000);
  store.close();
});

test("a success records latency and marks the credential used", async () => {
  const store = await seeded(1);
  const adapter = stubAdapter(() => textStream("hi"));
  await drain((await dispatch(req, deps(store, adapter), new AbortController().signal)).events);

  const rows = await store.credentials.listHealth();
  expect(rows[0]?.lastUsedAt).toBe(1_000_000);
  expect(rows[0]?.ewmaTtftMs).not.toBeNull();
  store.close();
});

test("refreshes an expired oauth credential before calling the adapter", async () => {
  const store = await seeded(1);
  await store.credentials.update("c1", { expiresAt: 500_000 });
  const adapter = stubAdapter(() => textStream("hi"));
  await drain((await dispatch(req, deps(store, adapter), new AbortController().signal)).events);

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
  );
  const events = await drain(outcome.events);
  // The caller still receives events; egress folds them with collect().
  expect(events.filter((e) => e.type === "blockDelta")).toHaveLength(1);
  store.close();
});

test("the log records the excluded candidates and their reasons", async () => {
  const store = await seeded(2);
  await store.credentials.update("c1", { enabled: false });
  const adapter = stubAdapter(() => textStream("hi"));
  const outcome = await dispatch(req, deps(store, adapter), new AbortController().signal);
  await drain(outcome.events);

  expect(outcome.log().degradations).toContain("excluded:c1:disabled");
  store.close();
});

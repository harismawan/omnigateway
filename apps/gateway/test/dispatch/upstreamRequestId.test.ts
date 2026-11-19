import { expect, test } from "bun:test";
import { memoryCoord } from "@omni/coord";
import type { ChatRequest, StreamEvent } from "@omni/ir";
import type { HttpClient, ProviderAdapter } from "@omni/providers";
import { buildSnapshot } from "@omni/router";
import { createStore, deriveKey, type Store } from "@omni/store";
import { dispatch } from "../../src/dispatch/index.ts";
import { createLoadRegistry } from "../../src/dispatch/loadRegistry.ts";

/**
 * The provider's own request id, from the response head of the attempt that
 * produced the row's outcome. Captured by dispatch around the transport, so an
 * adapter is free to never look at response headers.
 */

const req: ChatRequest = {
  model: "fast",
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  stream: true,
};

async function* ok(): AsyncGenerator<StreamEvent> {
  yield { type: "start", id: "m", model: "claude-opus-4" };
  yield { type: "blockStart", index: 0, block: { type: "text" } };
  yield { type: "blockDelta", index: 0, delta: { type: "text", text: "hi" } };
  yield { type: "blockEnd", index: 0 };
  yield {
    type: "end",
    stopReason: "endTurn",
    usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
  };
}

/** An adapter that performs one real transport call, then answers by its status. */
function transportAdapter(): ProviderAdapter {
  return {
    id: "anthropic",
    capabilities: { tools: true, images: true, reasoning: true },
    async send(r) {
      const response = await r.http({
        provider: "anthropic",
        url: "https://upstream.test/v1",
        method: "POST",
        headers: [],
        body: "{}",
        signal: r.signal,
      });
      await response.text();
      if (response.status >= 500) {
        const { GatewayError } = await import("@omni/ir");
        throw new GatewayError("UPSTREAM", "busy", { provider: "anthropic" });
      }
      return { events: ok(), degradations: [] };
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
      apiKey: `key-${i}`,
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
        costPerMTok: { input: 1, output: 1 },
        capabilities: { tools: true, images: true, reasoning: true },
      },
    ],
  });
  return store;
}

function respond(status: number, headers: Record<string, string>) {
  return {
    status,
    headers: new Headers(headers),
    body: null,
    text: async () => "{}",
  };
}

async function run(store: Store, http: HttpClient) {
  const adapter = transportAdapter();
  const outcome = await dispatch(
    req,
    {
      store,
      snapshots: { get: (now: number) => buildSnapshot(store, now) },
      adapters: { anthropic: adapter },
      http,
      now: () => 1_000_000,
      rand: () => 0,
      loadRegistry: createLoadRegistry(),
      coord: memoryCoord(),
      refresh: async (c) => await c.secrets(),
    },
    new AbortController().signal,
    "req_up",
  );
  for await (const _ of outcome.events) {
    // drain
  }
  return outcome.log();
}

test("Anthropic's request-id is recorded", async () => {
  const store = await seeded(1);
  const log = await run(store, async () => respond(200, { "request-id": "req_011abc" }));
  expect(log.upstreamRequestId).toBe("req_011abc");
  store.close();
});

test("OpenAI-style x-request-id is recorded", async () => {
  const store = await seeded(1);
  const log = await run(store, async () => respond(200, { "x-request-id": "chatcmpl-req-9" }));
  expect(log.upstreamRequestId).toBe("chatcmpl-req-9");
  store.close();
});

test("an absent header records null", async () => {
  const store = await seeded(1);
  const log = await run(store, async () => respond(200, {}));
  expect(log.upstreamRequestId).toBeNull();
  store.close();
});

test("failover records the serving attempt's id, not the failed one's", async () => {
  const store = await seeded(2);
  let n = 0;
  const log = await run(store, async () => {
    n += 1;
    return n === 1
      ? respond(503, { "request-id": "first-failed" })
      : respond(200, { "request-id": "second-served" });
  });
  expect(log.attempts).toBe(2);
  expect(log.upstreamRequestId).toBe("second-served");
  store.close();
});

test("an all-failed request records the last attempt's id", async () => {
  const store = await seeded(2);
  let n = 0;
  const log = await run(store, async () => {
    n += 1;
    return respond(503, { "request-id": `fail-${n}` });
  });
  expect(log.status).toBeGreaterThanOrEqual(500);
  expect(log.upstreamRequestId).toBe("fail-2");
  store.close();
});

test("an oversized or unprintable id is not recorded", async () => {
  const store = await seeded(1);
  const long = await run(store, async () => respond(200, { "request-id": "x".repeat(300) }));
  expect(long.upstreamRequestId).toBeNull();
  store.close();
});

test("a final attempt that never got a response head does not keep an earlier attempt's id", async () => {
  const store = await seeded(2);
  let n = 0;
  const log = await run(store, async () => {
    n += 1;
    if (n === 1) return respond(503, { "request-id": "first-failed" });
    throw new Error("connect ECONNREFUSED");
  });
  expect(log.attempts).toBe(2);
  expect(log.upstreamRequestId).toBeNull();
  store.close();
});

test("a late response from an abandoned attempt cannot overwrite the current one's id", async () => {
  const { createUpstreamRequestIdRecorder } = await import(
    "../../src/dispatch/upstreamRequestId.ts"
  );
  let current: string | null = "unset";
  const recorder = createUpstreamRequestIdRecorder((id) => {
    current = id;
  });
  let release: (() => void) | undefined;
  const slow: HttpClient = () =>
    new Promise((resolve) => {
      release = () => resolve(respond(200, { "request-id": "late" }));
    });
  const call = {
    provider: "anthropic" as const,
    url: "x",
    method: "POST",
    headers: [],
    body: "",
    signal: new AbortController().signal,
  };
  const pending = recorder.forAttempt(slow)(call);
  // The next attempt starts: it clears the id and supersedes the first.
  const second = recorder.forAttempt(async () => respond(200, { "request-id": "second" }));
  await second(call);
  expect(current).toBe("second");
  release?.();
  await pending;
  expect(current).toBe("second");
});

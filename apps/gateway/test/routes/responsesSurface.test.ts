import { expect, test } from "bun:test";
import type { ProviderId, StreamEvent } from "@omni/ir";
import type { HttpClient, ProviderAdapter } from "@omni/providers";
import {
  memoryStore,
  seedApiKey,
  seedCredential,
  stubAdapters,
  target,
  virtualModel,
} from "@omni/testkit";
import { type ProxyDeps, proxyRoutes } from "../../src/routes/proxy.ts";

const EVENTS: StreamEvent[] = [
  { type: "start", id: "upstream_1", model: "gpt-5-codex" },
  { type: "blockStart", index: 0, block: { type: "text" } },
  { type: "blockDelta", index: 0, delta: { type: "text", text: "Hi" } },
  { type: "blockEnd", index: 0 },
  {
    type: "end",
    stopReason: "endTurn",
    usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 5, cacheWriteTokens: 0 },
  },
];

async function harness(events: StreamEvent[] = EVENTS, overrides: Partial<ProxyDeps> = {}) {
  const store = await memoryStore();
  await seedCredential(store, { id: "c1", provider: "openai" });
  await store.config.putModel(
    virtualModel({
      id: "gpt-5-codex",
      targets: [target({ provider: "openai", model: "gpt-5-codex" })],
    }),
  );
  const { raw } = await seedApiKey(store, { label: "test" });

  let n = 0;
  const app = proxyRoutes({
    store,
    adapters: stubAdapters(events),
    http: (() => {
      throw new Error("a stub adapter reached the transport");
    }) as HttpClient,
    now: () => 1_000_000,
    rand: () => 0.5,
    refresh: async (c) => await c.secrets(),
    requestId: () => `req_${++n}`,
    ...overrides,
  });

  const call = (body: unknown, headers: Record<string, string> = {}) =>
    app.handle(
      new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${raw}`, ...headers },
        body: JSON.stringify(body),
      }),
    );

  return { store, app, raw, call };
}

test("serves a non-streaming Responses request in its own dialect", async () => {
  const { call } = await harness();
  const response = await call({ model: "gpt-5-codex", input: "hi", store: false });

  expect(response.status).toBe(200);
  const body = (await response.json()) as Record<string, unknown>;
  expect(body.object).toBe("response");
  expect(body.status).toBe("completed");
  expect(body.output).toEqual([
    {
      id: "msg_req_1_0",
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text: "Hi", annotations: [] }],
    },
  ]);
  // The prompt is the whole prompt: 10 uncached plus 5 read from cache.
  expect(body.usage).toMatchObject({
    input_tokens: 15,
    input_tokens_details: { cached_tokens: 5 },
  });
});

test("streams a Responses request as its own event sequence", async () => {
  const { call } = await harness();
  const response = await call({ model: "gpt-5-codex", input: "hi", stream: true });

  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  const text = await response.text();
  expect(text).toContain("event: response.created");
  expect(text).toContain("event: response.output_text.delta");
  expect(text).toContain("event: response.completed");
  expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true);
});

test("refuses an unauthenticated request before reading its body", async () => {
  const { app } = await harness();
  const response = await app.handle(
    new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-5-codex", input: "hi" }),
    }),
  );
  expect(response.status).toBe(401);
  const body = (await response.json()) as { error: { type: string } };
  // The Responses dialect, not the Anthropic one this route would otherwise
  // inherit from the shared error handler.
  expect(body.error.type).toBe("invalid_request_error");
});

test("a model the key may not use is refused in the Responses dialect", async () => {
  const store = await memoryStore();
  await seedCredential(store, { id: "c1", provider: "openai" });
  await store.config.putModel(
    virtualModel({
      id: "gpt-5-codex",
      targets: [target({ provider: "openai", model: "gpt-5-codex" })],
    }),
  );
  const { raw } = await seedApiKey(store, { label: "narrow", modelAllowlist: ["other"] });
  const app = proxyRoutes({
    store,
    adapters: stubAdapters(EVENTS),
    http: (() => {
      throw new Error("unreachable");
    }) as HttpClient,
    now: () => 1_000_000,
    rand: () => 0.5,
    refresh: async (c) => await c.secrets(),
    requestId: () => "req_1",
  });

  const response = await app.handle(
    new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${raw}` },
      body: JSON.stringify({ model: "gpt-5-codex", input: "hi" }),
    }),
  );
  expect(response.status).toBe(401);
  const body = (await response.json()) as { error: { param: unknown } };
  expect(body.error.param).toBeNull();
});

test("a stateful field is refused with the field named", async () => {
  const { call } = await harness();
  const response = await call({
    model: "gpt-5-codex",
    input: "hi",
    previous_response_id: "resp_earlier",
  });
  expect(response.status).toBe(400);
  const body = (await response.json()) as { error: { message: string } };
  expect(body.error.message).toContain("previous_response_id");
});

test("Codex's session-id header names the conversation for cache affinity", async () => {
  // The one header Codex sends and the reason this surface reads it: the
  // backend partitions its prompt cache by conversation, so a request arriving
  // without one is a cache miss the operator pays for on every turn.
  const seen: (string | undefined)[] = [];
  const watching: Readonly<Record<ProviderId, ProviderAdapter>> = {
    openai: {
      id: "openai",
      capabilities: { tools: true, images: true, reasoning: true },
      async send(req) {
        seen.push(req.request.conversationId);
        return {
          events: (async function* () {
            for (const e of EVENTS) yield e;
          })(),
          degradations: [],
        };
      },
    },
  };

  const { call } = await harness(EVENTS, { adapters: watching });
  await call({ model: "gpt-5-codex", input: "hi" }, { "session-id": "codex-thread-9" });
  expect(seen).toEqual(["codex-thread-9"]);
});

test("rate-limit headers reach this surface in the dialect its clients read", async () => {
  const store = await memoryStore();
  await seedCredential(store, { id: "c1", provider: "openai" });
  await store.config.putModel(
    virtualModel({
      id: "gpt-5-codex",
      targets: [target({ provider: "openai", model: "gpt-5-codex" })],
    }),
  );
  const { raw } = await seedApiKey(store, {
    label: "limited",
    limits: { requests: { "1m": 10 } },
  });

  const app = proxyRoutes({
    store,
    adapters: stubAdapters(EVENTS),
    http: (() => {
      throw new Error("unreachable");
    }) as HttpClient,
    now: () => 1_000_000,
    rand: () => 0.5,
    refresh: async (c) => await c.secrets(),
    requestId: () => "req_1",
  });

  const response = await app.handle(
    new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${raw}` },
      body: JSON.stringify({ model: "gpt-5-codex", input: "hi" }),
    }),
  );

  // The OpenAI spelling, not Anthropic's: an SDK parses one dialect and reads
  // no headers at all from the other, so it backs off from nothing.
  expect(response.headers.get("x-ratelimit-limit-requests")).toBe("10");
  expect(response.headers.get("anthropic-ratelimit-requests-limit")).toBeNull();
});

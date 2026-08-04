import { expect, test } from "bun:test";
import type { ProviderId, StreamEvent } from "@omni/ir";
import type { HttpClient, ProviderAdapter } from "@omni/providers";
import { authenticateApiKey } from "../../src/auth/apiKey.ts";
import { proxyRoutes } from "../../src/routes/proxy.ts";
import {
  memoryStore,
  seedApiKey,
  seedCredential,
  stubAdapters,
  target,
  virtualModel,
} from "../helpers/fixtures.ts";

const EVENTS: StreamEvent[] = [
  { type: "start", id: "upstream_1", model: "claude-opus-4" },
  { type: "blockStart", index: 0, block: { type: "text" } },
  { type: "blockDelta", index: 0, delta: { type: "text", text: "Hi" } },
  { type: "blockEnd", index: 0 },
  {
    type: "end",
    stopReason: "endTurn",
    usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
  },
];

async function harness(events: StreamEvent[] = EVENTS) {
  const store = await memoryStore();
  await seedCredential(store, { id: "c1", provider: "anthropic" });
  await store.config.putModel(
    virtualModel({
      id: "fast",
      targets: [target({ provider: "anthropic", model: "claude-opus-4" })],
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
  });

  const call = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    app.handle(
      new Request(`http://localhost${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${raw}`, ...headers },
        body: JSON.stringify(body),
      }),
    );

  return { store, app, raw, call };
}

test("proxies a non-streaming anthropic request", async () => {
  const { call } = await harness();
  const res = await call("/v1/messages", {
    model: "fast",
    max_tokens: 100,
    messages: [{ role: "user", content: "hi" }],
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { content: unknown; id: string };
  expect(body.content).toEqual([{ type: "text", text: "Hi" }]);
  expect(body.id).toBe("req_1");
});

test("proxies a streaming anthropic request as sse", async () => {
  const { call } = await harness();
  const res = await call("/v1/messages", {
    model: "fast",
    max_tokens: 100,
    stream: true,
    messages: [{ role: "user", content: "hi" }],
  });
  expect(res.headers.get("content-type")).toContain("text/event-stream");
  const text = await res.text();
  expect(text).toContain("event: message_start");
  expect(text).toContain("event: message_stop");
  expect(text).toContain('"text":"Hi"');
});

test("proxies a non-streaming openai request", async () => {
  const { call } = await harness();
  const res = await call("/v1/chat/completions", {
    model: "fast",
    messages: [{ role: "user", content: "hi" }],
  });
  const body = (await res.json()) as {
    object: string;
    choices: { message: { content: string } }[];
  };
  expect(body.object).toBe("chat.completion");
  expect(body.choices[0]?.message.content).toBe("Hi");
});

test("proxies a streaming openai request and terminates with [DONE]", async () => {
  const { call } = await harness();
  const res = await call("/v1/chat/completions", {
    model: "fast",
    stream: true,
    messages: [{ role: "user", content: "hi" }],
  });
  expect(await res.text()).toContain("data: [DONE]");
});

test("rejects a request with no api key", async () => {
  const { app } = await harness();
  const res = await app.handle(
    new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "fast",
        max_tokens: 1,
        messages: [{ role: "user", content: "hi" }],
      }),
    }),
  );
  expect(res.status).toBe(401);
  const body = (await res.json()) as { error: { type: string } };
  expect(body.error.type).toBe("authentication_error");
});

test("returns a 400 with the anthropic error shape for a malformed body", async () => {
  const { call } = await harness();
  const res = await call("/v1/messages", { max_tokens: 1, messages: [] });
  expect(res.status).toBe(400);
  const body = (await res.json()) as { error: { type: string } };
  expect(body.error.type).toBe("invalid_request_error");
});

test("returns a 400 with the openai error shape on the openai surface", async () => {
  const { call } = await harness();
  const res = await call("/v1/chat/completions", { model: "fast", messages: [] });
  expect(res.status).toBe(400);
  const body = (await res.json()) as { error: { type: string } };
  expect(body.error.type).toBe("invalid_request_error");
});

test("writes a request log with usage and the resolved credential", async () => {
  const { call, store } = await harness();
  await call("/v1/messages", {
    model: "fast",
    max_tokens: 100,
    messages: [{ role: "user", content: "hi" }],
  });
  const logs = await store.usage.recent(10);
  expect(logs).toHaveLength(1);
  expect(logs[0]?.credentialId).toBe("c1");
  expect(logs[0]?.outputTokens).toBe(2);
  expect(logs[0]?.status).toBe(200);
});

test("logs a streaming request after the stream drains", async () => {
  const { call, store } = await harness();
  const res = await call("/v1/messages", {
    model: "fast",
    max_tokens: 100,
    stream: true,
    messages: [{ role: "user", content: "hi" }],
  });
  await res.text();
  const logs = await store.usage.recent(10);
  expect(logs[0]?.status).toBe(200);
  expect(logs[0]?.outputTokens).toBe(2);
});

test("lists the configured virtual models", async () => {
  const { app, raw } = await harness();
  const res = await app.handle(
    new Request("http://localhost/v1/models", { headers: { authorization: `Bearer ${raw}` } }),
  );
  const body = (await res.json()) as { data: { id: string }[] };
  expect(body.data.map((m) => m.id)).toContain("fast");
});

test("never echoes the request body into the log", async () => {
  const { call, store } = await harness();
  await call("/v1/messages", {
    model: "fast",
    max_tokens: 100,
    messages: [{ role: "user", content: "sensitive-prompt-text" }],
  });
  const logs = await store.usage.recent(10);
  expect(JSON.stringify(logs)).not.toContain("sensitive-prompt-text");
});

test("writes exactly one log row when the client disconnects mid-stream after the commit point", async () => {
  // `app.handle()` never runs a real ReadableStream lifecycle, so it cannot
  // trigger `cancel()`. This regression needs a real socket: a genuine
  // client abort races an in-flight upstream read against the stream's
  // cancel callback, which is exactly the path that previously double-wrote
  // the request log (see the sseResponse `runOnce` latch).
  //
  // The row count alone cannot tell the two paths apart -- a second write
  // with the same id fails on the UNIQUE constraint and is silently
  // swallowed by `finishLog`, so this counts the actual `append` calls.
  const store = await memoryStore();
  let appendCalls = 0;
  const originalAppend = store.usage.append.bind(store.usage);
  store.usage.append = async (log) => {
    appendCalls++;
    await originalAppend(log);
  };
  await seedCredential(store, { id: "c1", provider: "anthropic" });
  await store.config.putModel(
    virtualModel({
      id: "fast",
      targets: [target({ provider: "anthropic", model: "claude-opus-4" })],
    }),
  );
  const { raw } = await seedApiKey(store, { label: "test" });

  // Yields one block, then hangs on the next `next()` call until the shared
  // AbortSignal fires -- reproducing the upstream-read-rejects-on-abort race.
  const hangingAdapter = (id: ProviderId): ProviderAdapter => ({
    id,
    capabilities: { tools: true, images: true, reasoning: true },
    async send(req) {
      const { signal } = req;
      async function* gen(): AsyncGenerator<StreamEvent, void, undefined> {
        yield { type: "start", id: "upstream_1", model: "claude-opus-4" };
        yield { type: "blockStart", index: 0, block: { type: "text" } };
        yield { type: "blockDelta", index: 0, delta: { type: "text", text: "Hi" } };
        await new Promise<never>((_, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          );
        });
      }
      return { events: gen(), degradations: [] };
    },
  });
  const adapters: Readonly<Record<ProviderId, ProviderAdapter>> = {
    anthropic: hangingAdapter("anthropic"),
    openai: hangingAdapter("openai"),
    kimi: hangingAdapter("kimi"),
  };

  let n = 0;
  const app = proxyRoutes({
    store,
    adapters,
    http: (() => {
      throw new Error("a stub adapter reached the transport");
    }) as HttpClient,
    now: () => 1_000_000,
    rand: () => 0.5,
    refresh: async (c) => await c.secrets(),
    requestId: () => `req_${++n}`,
  });

  const server = Bun.serve({ port: 0, fetch: app.fetch });
  try {
    const controller = new AbortController();
    const res = await fetch(`http://localhost:${server.port}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${raw}` },
      body: JSON.stringify({
        model: "fast",
        max_tokens: 100,
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      }),
      signal: controller.signal,
    });
    const reader = res.body?.getReader();
    if (reader === undefined) throw new Error("expected a streamed body");
    // Wait for the first content past the commit point, then hang up.
    let sawContent = false;
    while (!sawContent) {
      const { value, done } = await reader.read();
      if (done) break;
      if (new TextDecoder().decode(value).includes("Hi")) sawContent = true;
    }
    controller.abort();

    // Give the server's cancel()/pull()-catch race a beat to settle.
    await new Promise((resolve) => setTimeout(resolve, 100));

    const logs = await store.usage.recent(10);
    expect(logs).toHaveLength(1);
    expect(logs[0]?.id).toBe("req_1");
    expect(appendCalls).toBe(1);
  } finally {
    server.stop(true);
  }
});

test("accepts x-api-key on proxy and models routes", async () => {
  const { app, raw } = await harness();
  const proxy = await app.handle(
    new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": raw },
      body: JSON.stringify({
        model: "fast",
        max_tokens: 100,
        messages: [{ role: "user", content: "hi" }],
      }),
    }),
  );
  expect(proxy.status).toBe(200);

  const models = await app.handle(
    new Request("http://localhost/v1/models", { headers: { "x-api-key": raw } }),
  );
  expect(models.status).toBe(200);
});

test("rejects conflicting API key headers on proxy and models routes", async () => {
  const { app, raw } = await harness();
  const headers = { authorization: `Bearer ${raw}`, "x-api-key": "sk-omni-conflict" };
  const proxy = await app.handle(
    new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({
        model: "fast",
        max_tokens: 100,
        messages: [{ role: "user", content: "hi" }],
      }),
    }),
  );
  expect(proxy.status).toBe(401);
  const models = await app.handle(new Request("http://localhost/v1/models", { headers }));
  expect(models.status).toBe(401);
});

test("enforces exact model allowlists before dispatch", async () => {
  const store = await memoryStore();
  await seedCredential(store, { id: "c1", provider: "anthropic" });
  await store.config.putModel(
    virtualModel({
      id: "fast",
      targets: [target({ provider: "anthropic", model: "claude-opus-4" })],
    }),
  );
  let sends = 0;
  const adapters = stubAdapters(EVENTS);
  const anthropic = adapters.anthropic;
  const counting: ProviderAdapter = {
    ...anthropic,
    async send(request) {
      sends++;
      return anthropic.send(request);
    },
  };
  const { raw } = await seedApiKey(store, { label: "limited", modelAllowlist: [] });
  const app = proxyRoutes({
    store,
    adapters: { ...adapters, anthropic: counting },
    http: (() => {
      throw new Error("transport should not run");
    }) as HttpClient,
    now: () => 1_000_000,
    rand: () => 0,
    refresh: async (credential) => await credential.secrets(),
    requestId: () => crypto.randomUUID(),
  });
  const denied = await app.handle(
    new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${raw}` },
      body: JSON.stringify({
        model: "fast",
        max_tokens: 100,
        messages: [{ role: "user", content: "hi" }],
      }),
    }),
  );
  expect(denied.status).toBe(401);
  expect(sends).toBe(0);

  const key = await authenticateApiKey(store, raw);
  await store.keys.revoke(key.id);
  const allowedKey = await seedApiKey(store, { modelAllowlist: ["fast"] });
  const allowed = await app.handle(
    new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${allowedKey.raw}`,
      },
      body: JSON.stringify({
        model: "fast",
        max_tokens: 100,
        messages: [{ role: "user", content: "hi" }],
      }),
    }),
  );
  expect(allowed.status).toBe(200);
  expect(sends).toBe(1);
});

test("fixed-window rate limits are atomic, per-key, and roll over at the boundary", async () => {
  let now = 59_999;
  const store = await memoryStore();
  await seedCredential(store, { id: "c1", provider: "anthropic" });
  await store.config.putModel(
    virtualModel({
      id: "fast",
      targets: [target({ provider: "anthropic", model: "claude-opus-4" })],
    }),
  );
  const first = await seedApiKey(store, { rateLimitPerMin: 2 });
  const second = await seedApiKey(store, { rateLimitPerMin: 1 });
  let sends = 0;
  const adapters = stubAdapters(EVENTS);
  const anthropic = adapters.anthropic;
  const app = proxyRoutes({
    store,
    adapters: {
      ...adapters,
      anthropic: {
        ...anthropic,
        async send(request) {
          sends++;
          return anthropic.send(request);
        },
      },
    },
    http: (() => {
      throw new Error("transport should not run");
    }) as HttpClient,
    now: () => now,
    rand: () => 0,
    refresh: async (credential) => await credential.secrets(),
    requestId: () => crypto.randomUUID(),
  });
  const request = (raw: string) =>
    app.handle(
      new Request("http://localhost/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${raw}` },
        body: JSON.stringify({
          model: "fast",
          max_tokens: 100,
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
    );

  const concurrent = await Promise.all([
    request(first.raw),
    request(first.raw),
    request(first.raw),
  ]);
  expect(concurrent.map((response) => response.status).sort()).toEqual([200, 200, 429]);
  expect((await request(second.raw)).status).toBe(200);
  expect((await request(second.raw)).status).toBe(429);
  expect(sends).toBe(3);

  now = 60_000;
  expect((await request(first.raw)).status).toBe(200);
  expect((await request(second.raw)).status).toBe(200);
});

test("models route returns only models in the calling key allowlist", async () => {
  const { app, store } = await harness();
  await store.config.putModel(virtualModel({ id: "other" }));
  const { raw } = await seedApiKey(store, { modelAllowlist: ["fast"] });
  const response = await app.handle(
    new Request("http://localhost/v1/models", {
      headers: { authorization: `Bearer ${raw}` },
    }),
  );
  const body = (await response.json()) as { data: Array<{ id: string }> };
  expect(response.status).toBe(200);
  expect(body.data.map((model) => model.id)).toEqual(["fast"]);
});

test("models route returns all models for a null allowlist", async () => {
  const { app, store } = await harness();
  await store.config.putModel(virtualModel({ id: "other" }));
  const { raw } = await seedApiKey(store, { modelAllowlist: null });
  const response = await app.handle(
    new Request("http://localhost/v1/models", {
      headers: { authorization: `Bearer ${raw}` },
    }),
  );
  const body = (await response.json()) as { data: Array<{ id: string }> };
  expect(response.status).toBe(200);
  expect(body.data.map((model) => model.id).sort()).toEqual(["fast", "other"]);
});

test("models route returns no models for an empty allowlist", async () => {
  const { app, store } = await harness();
  const { raw } = await seedApiKey(store, { modelAllowlist: [] });
  const response = await app.handle(
    new Request("http://localhost/v1/models", {
      headers: { authorization: `Bearer ${raw}` },
    }),
  );
  const body = (await response.json()) as { data: Array<{ id: string }> };
  expect(response.status).toBe(200);
  expect(body.data).toEqual([]);
});

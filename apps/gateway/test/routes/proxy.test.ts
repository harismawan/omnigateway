import { expect, test } from "bun:test";
import type { ProviderId, StreamEvent } from "@omni/ir";
import type { HttpClient, ProviderAdapter } from "@omni/providers";
import {
  captureLogger,
  memoryStore,
  seedApiKey,
  seedCredential,
  stubAdapters,
  target,
  virtualModel,
} from "@omni/testkit";
import { authenticateApiKey } from "../../src/auth/apiKey.ts";
import { type ProxyDeps, proxyRoutes } from "../../src/routes/proxy.ts";

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

async function harness(events: StreamEvent[] = EVENTS, overrides: Partial<ProxyDeps> = {}) {
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
    ...overrides,
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

/** The lines that used to restate a `request_logs` row on stdout. */
const TERMINAL = ["request done", "request failed", "request cancelled"];

const terminalLines = (logger: ReturnType<typeof captureLogger>) =>
  logger.records.filter((record) => TERMINAL.includes(record.msg));

test("records a finished request as a row, and prints nothing", async () => {
  const logger = captureLogger();
  const { call, store } = await harness(EVENTS, { logger });
  const res = await call("/v1/messages", {
    model: "fast",
    max_tokens: 100,
    messages: [{ role: "user", content: "hi" }],
  });
  expect(res.status).toBe(200);

  expect(terminalLines(logger)).toEqual([]);

  const [row] = await store.usage.recent(10);
  expect(row).toEqual(
    expect.objectContaining({
      id: "req_1",
      state: "done",
      status: 200,
      resolvedProvider: "anthropic",
      resolvedModel: "claude-opus-4",
      inputTokens: 10,
      outputTokens: 2,
    }),
  );
});

test("records a streaming request as one row once it drains, and prints nothing", async () => {
  const logger = captureLogger();
  const { call, store } = await harness(EVENTS, { logger });
  const res = await call("/v1/messages", {
    model: "fast",
    max_tokens: 100,
    stream: true,
    messages: [{ role: "user", content: "hi" }],
  });
  await res.text();

  expect(terminalLines(logger)).toEqual([]);

  const rows = await store.usage.recent(10);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toEqual(expect.objectContaining({ id: "req_1", state: "done", status: 200 }));
});

test("never writes request bodies or keys into stdout", async () => {
  const logger = captureLogger();
  const { call, raw } = await harness(EVENTS, { logger });
  const sentinel = "PROMPT_SENTINEL_MUST_NOT_REACH_STDOUT";
  const res = await call("/v1/messages", {
    model: "fast",
    max_tokens: 100,
    messages: [{ role: "user", content: sentinel }],
  });
  expect(res.status).toBe(200);

  const output = logger.lines.join("\n");
  expect(output).not.toContain(sentinel);
  expect(output).not.toContain(raw);
  expect(output).not.toContain("test-token-c1");
  expect(output).not.toContain("test-refresh-c1");
});

test("records a malformed request as a row, and prints neither a line nor the body", async () => {
  const logger = captureLogger();
  const { call, store } = await harness(EVENTS, { logger });
  const sentinel = "MALFORMED_BODY_SENTINEL";
  const res = await call("/v1/messages", { model: "fast", messages: [sentinel] });
  expect(res.status).toBe(400);

  expect(terminalLines(logger)).toEqual([]);
  expect(logger.lines.join("\n")).not.toContain(sentinel);

  const [row] = await store.usage.recent(10);
  expect(row).toEqual(
    expect.objectContaining({ state: "done", status: 400, errorCode: "BAD_REQUEST" }),
  );
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

test("holds a stalled stream open with keepalive comments", async () => {
  // Upstream can go quiet for a long time — a slow first token, a long
  // thinking block — and the provider's own pings are decoded away rather
  // than forwarded. Without a keepalive the socket carries no bytes at all
  // and Bun's idle timeout (Elysia defaults it to 30s) resets it, which the
  // client reports as a connection closed mid-response.
  const gate = Promise.withResolvers<void>();
  const stalling = (id: ProviderId): ProviderAdapter => ({
    id,
    capabilities: { tools: true, images: true, reasoning: true },
    async send() {
      return {
        events: (async function* () {
          for (const event of EVENTS.slice(0, 3)) yield event;
          await gate.promise;
          for (const event of EVENTS.slice(3)) yield event;
        })(),
        degradations: [],
      };
    },
  });

  const { call, store } = await harness(EVENTS, {
    adapters: {
      anthropic: stalling("anthropic"),
      openai: stalling("openai"),
      kimi: stalling("kimi"),
    },
    keepaliveMs: 5,
  });

  const res = await call("/v1/messages", {
    model: "fast",
    max_tokens: 100,
    stream: true,
    messages: [{ role: "user", content: "hi" }],
  });

  setTimeout(() => gate.resolve(), 60);
  const text = await res.text();

  expect(text).toContain(": keepalive");
  expect(text).toContain("event: message_stop");
  expect((await store.usage.recent(10))[0]?.status).toBe(200);
  store.close();
});

test("writes no keepalive into a stream that never stalls", async () => {
  const { call, store } = await harness(EVENTS, { keepaliveMs: 5 });
  const res = await call("/v1/messages", {
    model: "fast",
    max_tokens: 100,
    stream: true,
    messages: [{ role: "user", content: "hi" }],
  });

  expect(await res.text()).not.toContain(": keepalive");
  store.close();
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

test("returns client-compatible errors for truncated non-streaming responses", async () => {
  const partial = EVENTS.slice(0, 3);

  for (const [path, body] of [
    [
      "/v1/messages",
      { model: "fast", max_tokens: 100, messages: [{ role: "user", content: "hi" }] },
    ],
    ["/v1/chat/completions", { model: "fast", messages: [{ role: "user", content: "hi" }] }],
  ] as const) {
    const { call, store } = await harness(partial);
    const res = await call(path, body);
    expect(res.status).toBe(502);
    const response = (await res.json()) as { error: { type: string } };
    expect(response.error.type).toBe(path === "/v1/messages" ? "api_error" : "server_error");
    expect((await store.usage.recent(10))[0]?.status).toBe(502);
    store.close();
  }
});

test("streams client-compatible errors without successful terminal markers after truncation", async () => {
  const partial = EVENTS.slice(0, 3);

  for (const [path, body, forbidden] of [
    [
      "/v1/messages",
      {
        model: "fast",
        max_tokens: 100,
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      },
      "event: message_stop",
    ],
    [
      "/v1/chat/completions",
      { model: "fast", stream: true, messages: [{ role: "user", content: "hi" }] },
      "data: [DONE]",
    ],
  ] as const) {
    const { call, store } = await harness(partial);
    const res = await call(path, body);
    const text = await res.text();
    expect(text).toContain('"error"');
    expect(text).not.toContain(forbidden);
    expect((await store.usage.recent(10))[0]?.status).toBe(502);
    store.close();
  }
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

test("the first selected route inserts the pending row without a separate route update", async () => {
  const { call, store } = await harness();
  let beginCalls = 0;
  let routeCalls = 0;
  const originalBegin = store.usage.begin.bind(store.usage);
  const originalRoute = store.usage.route.bind(store.usage);
  store.usage.begin = async (log) => {
    beginCalls++;
    await originalBegin(log);
  };
  store.usage.route = async (id, target) => {
    routeCalls++;
    await originalRoute(id, target);
  };

  const response = await call("/v1/messages", {
    model: "fast",
    max_tokens: 100,
    messages: [{ role: "user", content: "hi" }],
  });

  expect(response.status).toBe(200);
  expect(beginCalls).toBe(1);
  expect(routeCalls).toBe(0);
  store.close();
});

test("a request in flight is in the log before its stream drains", async () => {
  const gate = Promise.withResolvers<void>();
  const stalling = (id: ProviderId): ProviderAdapter => ({
    id,
    capabilities: { tools: true, images: true, reasoning: true },
    async send() {
      return {
        events: (async function* () {
          for (const event of EVENTS.slice(0, 3)) yield event;
          await gate.promise;
          for (const event of EVENTS.slice(3)) yield event;
        })(),
        degradations: [],
      };
    },
  });

  const { call, store } = await harness(EVENTS, {
    adapters: {
      anthropic: stalling("anthropic"),
      openai: stalling("openai"),
      kimi: stalling("kimi"),
    },
  });

  const res = await call("/v1/messages", {
    model: "fast",
    max_tokens: 100,
    stream: true,
    messages: [{ role: "user", content: "hi" }],
  });

  const live = (await store.usage.recent(10))[0];
  expect(live?.state).toBe("pending");
  expect(live?.requestedModel).toBe("fast");
  expect(live?.resolvedProvider).toBe("anthropic");
  expect(live?.resolvedModel).toBe("claude-opus-4");
  expect(live?.credentialId).toBe("c1");

  gate.resolve();
  await res.text();

  const finished = await store.usage.recent(10);
  // Completed in place: still one row, and still filed under its start time.
  expect(finished).toHaveLength(1);
  expect(finished[0]?.state).toBe("done");
  expect(finished[0]?.status).toBe(200);
  expect(finished[0]?.at).toBe(live?.at);
  store.close();
});

test("a request rejected before dispatch never appears as in flight", async () => {
  const { app, store } = await harness();
  const res = await app.handle(
    new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer nope" },
      body: JSON.stringify({
        model: "fast",
        max_tokens: 100,
        messages: [{ role: "user", content: "hi" }],
      }),
    }),
  );
  expect(res.status).toBe(401);

  const logs = await store.usage.recent(10);
  expect(logs).toHaveLength(1);
  expect(logs[0]?.state).toBe("done");
  store.close();
});

test("a throw from dispatch completes the pending row without erasing it", async () => {
  const exploding = (id: ProviderId): ProviderAdapter => ({
    id,
    capabilities: { tools: true, images: true, reasoning: true },
    send() {
      throw new Error("adapter exploded");
    },
  });
  const { call, store } = await harness(EVENTS, {
    adapters: {
      anthropic: exploding("anthropic"),
      openai: exploding("openai"),
      kimi: exploding("kimi"),
    },
  });

  await call("/v1/messages", {
    model: "fast",
    max_tokens: 100,
    messages: [{ role: "user", content: "hi" }],
  });

  const logs = await store.usage.recent(10);
  expect(logs).toHaveLength(1);
  expect(logs[0]?.state).toBe("done");
  // The terminal catch carries no model; what beginning the request recorded stands.
  expect(logs[0]?.requestedModel).toBe("fast");
  store.close();
});

test("a store that cannot record the start still serves the request", async () => {
  const { call, store } = await harness();
  store.usage.begin = async () => {
    throw new Error("disk is full");
  };

  const res = await call("/v1/messages", {
    model: "fast",
    max_tokens: 100,
    messages: [{ role: "user", content: "hi" }],
  });

  expect(res.status).toBe(200);
  expect((await store.usage.recent(10))[0]?.status).toBe(200);
  store.close();
});

test("lists the configured virtual models", async () => {
  const { app, raw } = await harness();
  const res = await app.handle(
    new Request("http://localhost/v1/models", { headers: { authorization: `Bearer ${raw}` } }),
  );
  const body = (await res.json()) as { data: { id: string }[] };
  expect(body.data.map((m) => m.id)).toContain("fast");
});

test("tells the client how much context each model holds", async () => {
  const { app, store, raw } = await harness();
  await store.config.putModel(
    virtualModel({
      id: "opus",
      targets: [target({ provider: "anthropic", model: "claude-opus-5" })],
    }),
  );

  const res = await app.handle(
    new Request("http://localhost/v1/models", { headers: { authorization: `Bearer ${raw}` } }),
  );

  // Without this a client falls back to its own default window, which is 200K
  // for every model however much the target actually holds.
  const body = (await res.json()) as { data: Array<{ id: string; max_input_tokens?: number }> };
  expect(body.data.find((m) => m.id === "opus")?.max_input_tokens).toBe(1_000_000);
});

test("reports the Codex window for an OpenAI model an OAuth credential serves", async () => {
  const { app, store, raw } = await harness();
  await seedCredential(store, { id: "c-openai", provider: "openai", authType: "oauth" });
  await store.config.putModel(
    virtualModel({ id: "gpt", targets: [target({ provider: "openai", model: "gpt-5.6" })] }),
  );

  const res = await app.handle(
    new Request("http://localhost/v1/models", { headers: { authorization: `Bearer ${raw}` } }),
  );

  // The API takes 922K, but an OAuth credential reaches the model through
  // Codex, which caps a prompt at 272K.
  const body = (await res.json()) as { data: Array<{ id: string; max_input_tokens?: number }> };
  expect(body.data.find((m) => m.id === "gpt")?.max_input_tokens).toBe(272_000);
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
  // The row count alone cannot tell the two paths apart: completion upserts,
  // so a second write with the same id leaves one row while counting the
  // request into the daily rollup twice. This counts the `append` calls.
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
  const logger = captureLogger("debug");
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
    logger,
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
    expect(logs[0]?.status).toBe(499);
    expect(logs[0]?.errorCode).toBe("interrupted");
    expect(appendCalls).toBe(1);
    expect(terminalLines(logger)).toEqual([]);
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
  const logger = captureLogger();
  const { app, raw } = await harness(EVENTS, { logger });
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
  expect(logger.records).toContainEqual(
    expect.objectContaining({
      level: "warn",
      msg: "authentication rejected",
      fields: expect.objectContaining({ reason: "invalid credentials" }),
    }),
  );
  expect(logger.lines.join("\n")).not.toContain(raw);
  expect(logger.lines.join("\n")).not.toContain("sk-omni-conflict");
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
  const logger = captureLogger();
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
    logger,
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
  expect(logger.records.filter((record) => record.msg === "rate limit rejected")).toHaveLength(2);
  expect(logger.records).toContainEqual(
    expect.objectContaining({
      level: "warn",
      msg: "rate limit rejected",
      fields: expect.objectContaining({ apiKeyId: first.key.id, code: "RATE_LIMIT" }),
    }),
  );
  expect(logger.lines.join("\n")).not.toContain(first.raw);
  expect(logger.lines.join("\n")).not.toContain(second.raw);

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

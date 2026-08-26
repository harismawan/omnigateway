import { expect, test } from "bun:test";
import { GatewayError, type ProviderId, type StreamEvent } from "@omni/ir";
import {
  customAdapter,
  type HttpClient,
  type HttpRequest,
  type ProviderAdapter,
} from "@omni/providers";
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
import { createLoadRegistry } from "../../src/dispatch/loadRegistry.ts";
import { type ProxyDeps, proxyRoutes } from "../../src/routes/proxy.ts";
import type { Invalidator } from "../../src/stream/broadcaster.ts";

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

test("disables Bun's request timeout for both inference routes before authentication", async () => {
  const { app } = await harness();
  app.listen(0);
  const server = app.server;
  if (server === null) throw new Error("expected Elysia to start a Bun server");
  const calls: Array<{ path: string; seconds: number }> = [];
  const originalTimeout = server.timeout.bind(server);
  server.timeout = (request, seconds) => {
    calls.push({ path: new URL(request.url).pathname, seconds });
    originalTimeout(request, seconds);
  };

  try {
    for (const path of ["/v1/messages", "/v1/chat/completions"] as const) {
      const response = await fetch(`http://localhost:${server.port}${path}`, { method: "POST" });
      expect(response.status).toBe(401);
    }
    expect(calls).toEqual([
      { path: "/v1/messages", seconds: 0 },
      { path: "/v1/chat/completions", seconds: 0 },
    ]);
  } finally {
    await app.stop(true);
  }
});

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

test("preserves OpenAI passthrough fields through a custom chat target", async () => {
  const store = await memoryStore();
  await seedCredential(store, {
    id: "custom-1",
    provider: "custom",
    authType: "apiKey",
    accessToken: null,
    refreshToken: null,
    apiKey: "custom-key",
    providerData: {
      endpointId: "local",
      endpointLabel: "Local",
      origin: "http://localhost:8000",
      protocol: "chat_completions",
    },
  });
  await store.config.putModel(
    virtualModel({
      id: "local",
      targets: [target({ provider: "custom", endpointId: "local", model: "upstream-model" })],
    }),
  );
  const { raw } = await seedApiKey(store);
  const sent: HttpRequest[] = [];
  const http: HttpClient = async (request) => {
    sent.push(request);
    const frames = [
      `data: ${JSON.stringify({
        id: "chat_1",
        model: "upstream-model",
        choices: [{ index: 0, delta: { role: "assistant", content: "Hi" } }],
      })}\n\n`,
      `data: ${JSON.stringify({
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      })}\n\n`,
      "data: [DONE]\n\n",
    ].join("");
    return {
      status: 200,
      headers: new Headers({ "content-type": "text/event-stream" }),
      body: new Response(frames).body,
      text: async () => frames,
    };
  };
  const adapters: Readonly<Record<ProviderId, ProviderAdapter>> = {
    ...stubAdapters(EVENTS),
    custom: customAdapter,
  };
  const app = proxyRoutes({
    store,
    adapters,
    http,
    now: () => 1_000_000,
    rand: () => 0.5,
    refresh: async (credential) => await credential.secrets(),
    requestId: () => "req_custom",
  });

  const response = await app.handle(
    new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${raw}` },
      body: JSON.stringify({
        model: "local",
        messages: [{ role: "user", content: "hi" }],
        top_p: 0.25,
      }),
    }),
  );

  expect(response.status).toBe(200);
  await response.text();
  const upstream = sent[0];
  if (upstream === undefined) throw new Error("custom adapter did not send request");
  expect(JSON.parse(upstream.body)).toMatchObject({ top_p: 0.25 });
});

/** The lines that used to restate a `request_logs` row on stdout. */
const TERMINAL = ["request done", "request failed", "request cancelled"];

const terminalLines = (logger: ReturnType<typeof captureLogger>) =>
  logger.records.filter((record) => TERMINAL.includes(record.msg));

/**
 * Waits for something the route finishes after the response is handed back,
 * and gives up with a name.
 *
 * Bounded on purpose. Polling `usage.recent` in a bare `while` turns any
 * regression that stops the row being written into a job that hangs until the
 * whole run is killed — no failing test, no assertion, nothing to read. A
 * deadline makes the same regression a one-line failure that says what never
 * arrived.
 */
async function until(what: string, ready: () => Promise<boolean>): Promise<void> {
  for (let waited = 0; waited < 2_000; waited += 5) {
    if (await ready()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

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

test("prints why a request was rejected, since the row has nowhere to keep it", async () => {
  const logger = captureLogger();
  const { call } = await harness(EVENTS, { logger });
  const res = await call("/v1/messages", { model: "fast", messages: ["MALFORMED"] });
  expect(res.status).toBe(400);

  const rejected = logger.records.filter((record) => record.msg === "request rejected");
  expect(rejected).toHaveLength(1);
  expect(rejected[0]?.level).toBe("warn");
  expect(rejected[0]?.fields).toMatchObject({ surface: "anthropic", status: 400 });
  // The reason is the whole point of the line: `request_logs` keeps
  // `BAD_REQUEST` and not what about the request was bad.
  expect(rejected[0]?.fields.reason).toBeTruthy();
});

test("prints nothing for a request that succeeded", async () => {
  const logger = captureLogger();
  const { call } = await harness(EVENTS, { logger });
  const res = await call("/v1/messages", {
    model: "fast",
    max_tokens: 100,
    messages: [{ role: "user", content: "hi" }],
  });
  expect(res.status).toBe(200);

  // A rejection line on the happy path is an access line by another name, which
  // is what this change removed.
  expect(logger.records.map((record) => record.msg)).not.toContain("request rejected");
});

/**
 * An upstream that refuses. A rejecting `send` is how a non-2xx becomes an
 * attempt failure, and `BAD_REQUEST` is not retryable, so dispatch gives up on
 * the first candidate and hands the route an error event rather than throwing.
 *
 * The error must carry `provider`, because that is what a real one carries:
 * `httpError` is the only constructor that fills a message from a response
 * body, and it always sets the field. It is also what the redaction gate reads,
 * so an upstream error built without it is not a weaker fixture but a different
 * case — a gateway-authored message, which is allowed to print.
 */
function refusingAdapters(
  error: GatewayError,
): Readonly<Partial<Record<ProviderId, ProviderAdapter>>> {
  const make = (id: ProviderId): ProviderAdapter => ({
    id,
    capabilities: { tools: true, images: true, reasoning: true },
    send: () => Promise.reject(error),
  });
  return { anthropic: make("anthropic") };
}

const UPSTREAM_SENTINEL = "UPSTREAM_REFUSAL_BODY_SENTINEL";

test("prints why an upstream refused a non-streaming request", async () => {
  const logger = captureLogger("info");
  const { call, store } = await harness(EVENTS, {
    logger,
    adapters: refusingAdapters(
      new GatewayError("BAD_REQUEST", UPSTREAM_SENTINEL, { provider: "anthropic" }),
    ),
  });
  const res = await call("/v1/messages", {
    model: "fast",
    max_tokens: 100,
    messages: [{ role: "user", content: "hi" }],
  });
  expect(res.status).toBe(400);

  // The failure leaves dispatch as an error event, so the route's own catch
  // never sees it. Before this line the request was invisible on stdout and
  // the row kept only `400/BAD_REQUEST`.
  const rejected = logger.records.filter((record) => record.msg === "request rejected");
  expect(rejected).toHaveLength(1);
  expect(rejected[0]?.level).toBe("warn");
  expect(rejected[0]?.fields).toMatchObject({
    requestId: "req_1",
    status: 400,
    provider: "anthropic",
    model: "claude-opus-4",
    credentialId: "c1",
    code: "BAD_REQUEST",
    attempts: 1,
  });
  expect(logger.lines.join("\n")).not.toContain(UPSTREAM_SENTINEL);

  const [row] = await store.usage.recent(10);
  expect(row).toEqual(
    expect.objectContaining({ state: "done", status: 400, errorCode: "BAD_REQUEST" }),
  );
});

test("prints why an upstream refused a streaming request, exactly once", async () => {
  const logger = captureLogger("info");
  const { call } = await harness(EVENTS, {
    logger,
    adapters: refusingAdapters(
      new GatewayError("BAD_REQUEST", UPSTREAM_SENTINEL, { provider: "anthropic" }),
    ),
  });
  const res = await call("/v1/messages", {
    model: "fast",
    max_tokens: 100,
    stream: true,
    messages: [{ role: "user", content: "hi" }],
  });
  await res.text();

  const rejected = logger.records.filter((record) => record.msg === "request rejected");
  expect(rejected).toHaveLength(1);
  expect(rejected[0]?.fields).toMatchObject({ requestId: "req_1", code: "BAD_REQUEST" });
  expect(logger.lines.join("\n")).not.toContain(UPSTREAM_SENTINEL);
});

/** An upstream that never answers, so only the client's hang-up ends the attempt. */
function stallingAdapters(): Readonly<Partial<Record<ProviderId, ProviderAdapter>>> {
  return {
    anthropic: {
      id: "anthropic",
      capabilities: { tools: true, images: true, reasoning: true },
      send: (request) =>
        new Promise<never>((_, reject) => {
          request.signal.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          );
        }),
    },
  };
}

test("records a cancelled non-streaming request as 499, keeping what routing resolved", async () => {
  const logger = captureLogger("info");
  const { app, raw, store } = await harness(EVENTS, { logger, adapters: stallingAdapters() });

  const controller = new AbortController();
  const response = app.handle(
    new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${raw}` },
      body: JSON.stringify({
        model: "fast",
        max_tokens: 100,
        messages: [{ role: "user", content: "hi" }],
      }),
      signal: controller.signal,
    }),
  );
  // Hang up mid-attempt: the pending row proves routing already picked a target.
  await until(
    "the pending row routing writes",
    async () => (await store.usage.recent(1))[0] !== undefined,
  );
  controller.abort();
  await response.catch(() => undefined);

  const [row] = await store.usage.recent(10);
  // A disconnect is what streaming already records as 499/interrupted. The
  // non-streaming drain throws instead of returning, so it used to land as
  // 500/INTERNAL with the pending row's attribution overwritten by nulls.
  expect(row).toEqual(
    expect.objectContaining({
      id: "req_1",
      state: "done",
      status: 499,
      errorCode: "interrupted",
      requestedModel: "fast",
      resolvedProvider: "anthropic",
      resolvedModel: "claude-opus-4",
      credentialId: "c1",
      attempts: 1,
    }),
  );
  // A hang-up is not a gateway failure, and they are far too common to print.
  expect(logger.records.filter((record) => record.msg === "request rejected")).toEqual([]);
});

test("gives a stream that broke on the gateway's own error a terminal status", async () => {
  const logger = captureLogger("info");
  const { call, store } = await harness(EVENTS, { logger });
  // A health write is the one piece of dispatch that runs outside its own error
  // handling, so a store failure there escapes the generator as a throw instead
  // of an error event.
  store.credentials.updateHealth = async () => {
    throw new Error("HEALTH_WRITE_SENTINEL");
  };

  const res = await call("/v1/messages", {
    model: "fast",
    max_tokens: 100,
    stream: true,
    messages: [{ role: "user", content: "hi" }],
  });
  await res.text().catch(() => undefined);
  await until(
    "the row to be completed",
    async () => (await store.usage.recent(1))[0]?.state === "done",
  );

  // Not a client hang-up, so nothing remapped it: the row used to be written
  // `state='done', status=0`, reading as neither success nor failure.
  const [row] = await store.usage.recent(10);
  expect(row).toEqual(
    expect.objectContaining({ id: "req_1", state: "done", status: 500, errorCode: "INTERNAL" }),
  );

  const rejected = logger.records.filter((record) => record.msg === "request rejected");
  expect(rejected).toHaveLength(1);
  // The gateway broke, not the upstream, so this is not a warning about someone
  // else's behaviour.
  expect(rejected[0]?.level).toBe("error");
  expect(rejected[0]?.fields).toMatchObject({ requestId: "req_1", status: 500, code: "INTERNAL" });
  // The store wrote this message, not an upstream, so it cannot quote the
  // request back and it prints without waiting for debug — a defect nobody can
  // read is a defect twice. `logger` here is at info.
  expect(rejected[0]?.fields.reason).toBe("HEALTH_WRITE_SENTINEL");
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

/**
 * `usage.append` must run at most once per request id.
 *
 * `rollupLog` adds into `usage_daily` rather than replacing, so a second append
 * bills the same tokens and the same spend twice. The non-streaming path used to
 * complete the row and then keep working — collecting, rendering, serialising —
 * and anything thrown after that landed in the terminal catch, which completed
 * it again. The `logged` flag is what stopped that being billable.
 *
 * Body capture closed the window instead of guarding it: the artifact records
 * the response the client is handed, the artifact is written at `finishLog`, so
 * the body has to be rendered before the row is completed. The clock stamp the
 * OpenAI surface takes for `created` moved with it, and nothing that can throw
 * now runs after the append.
 *
 * The sentinel is left armed rather than deleted. It fires on the first clock
 * read after the row is written, so it stays false only while that ordering
 * holds — put rendering back after the completion and this test fails on
 * `thrown` rather than silently going back to relying on the flag. The flag
 * itself stays: it still guards the streaming path's `log`, and it is what makes
 * a future post-completion step safe to add.
 */
test("renders a non-streaming response before completing its row, and completes it once", async () => {
  const store = await memoryStore();
  await seedCredential(store, { id: "c1", provider: "anthropic" });
  await store.config.putModel(
    virtualModel({
      id: "fast",
      targets: [target({ provider: "anthropic", model: "claude-opus-4" })],
    }),
  );
  const { raw } = await seedApiKey(store);

  let appends = 0;
  const realAppend = store.usage.append.bind(store.usage);
  // Armed by the completion itself, so the throw lands strictly after the row
  // is written rather than at a call count that shifts whenever the path does.
  let completed = false;
  store.usage.append = async (log) => {
    appends++;
    completed = true;
    return realAppend(log);
  };
  let thrown = false;
  const logger = captureLogger("info");
  const app = proxyRoutes({
    store,
    adapters: stubAdapters(EVENTS),
    http: (() => {
      throw new Error("a stub adapter reached the transport");
    }) as HttpClient,
    now: () => {
      if (completed && !thrown) {
        thrown = true;
        throw new Error("AFTER_COMPLETION_SENTINEL");
      }
      return 1_000_000;
    },
    rand: () => 0.5,
    refresh: async (c) => await c.secrets(),
    requestId: () => "req_1",
    logger,
  });

  // The OpenAI surface stamps `created` from the clock while it renders, which
  // is the last clock read of the request and now happens before the append.
  const res = await app.handle(
    new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${raw}` },
      body: JSON.stringify({ model: "fast", messages: [{ role: "user", content: "hi" }] }),
    }),
  );
  await res.text().catch(() => undefined);

  expect(thrown).toBe(false);
  expect(res.status).toBe(200);
  expect(appends).toBe(1);
  const rows = await store.usage.recent(10);
  expect(rows).toHaveLength(1);
  expect(rows[0]?.state).toBe("done");
  expect(rows[0]?.status).toBe(200);
  store.close();
});

/**
 * The window the ordering above narrowed but did not close, and the billing
 * invariant that depends on the flag rather than on the order.
 *
 * Rendering now happens before the append, so the ordinary path has nothing left
 * that can throw afterwards — but `jsonResponse` still serialises the rendered
 * body after the row is written, and a body it cannot serialise lands in the
 * terminal catch with `logged` already true. An Anthropic-native block is the
 * cheapest way to arrange that honestly: its payload is carried verbatim by
 * contract, so a value `JSON.stringify` refuses reaches the response untouched.
 *
 * Without the guard the catch completes the row a second time, `rollupLog` adds
 * the same tokens and the same spend into `usage_daily` again, and every usage
 * figure the operator bills against is wrong. The client's 500 is correct and is
 * not what this is about.
 */
test("completes the row once when serialising the response throws after it is written", async () => {
  const unserializable: StreamEvent[] = [
    { type: "start", id: "upstream_1", model: "claude-opus-4" },
    {
      type: "blockStart",
      index: 0,
      block: {
        type: "anthropicNative",
        blockType: "web_search_tool_result",
        // A BigInt is the one JSON type there is no encoding for, so this throws
        // in `JSON.stringify` and nowhere earlier.
        data: { queriedAt: 1n },
      },
    },
    { type: "blockEnd", index: 0 },
    {
      type: "end",
      stopReason: "endTurn",
      usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
    },
  ];
  const logger = captureLogger("info");
  const { store, call } = await harness(unserializable, { logger });
  let appends = 0;
  const realAppend = store.usage.append.bind(store.usage);
  store.usage.append = async (log) => {
    appends++;
    return realAppend(log);
  };

  const res = await call("/v1/messages", {
    model: "fast",
    max_tokens: 100,
    messages: [{ role: "user", content: "hi" }],
  });
  await res.text().catch(() => undefined);

  expect(res.status).toBe(500);
  expect(appends).toBe(1);
  const rows = await store.usage.recent(10);
  expect(rows).toHaveLength(1);
  expect(rows[0]?.state).toBe("done");
  store.close();
});

/**
 * A stream can break after dispatch has already decided the request.
 *
 * The slot release runs in the generator's `finally`, after the success path
 * has recorded 200 and the upstream's tokens, so a throw there escapes with a
 * status already assigned. Gating the whole branch on `status === 0` meant a
 * client that received a truncated stream was filed as a clean 200 and printed
 * nowhere. Reporting and status-assignment are separate for this reason: the
 * row keeps what the upstream actually did, and the break still gets a line.
 */
test("reports a stream that broke after dispatch recorded its outcome", async () => {
  const logger = captureLogger("info");
  const inner = createLoadRegistry();
  const { call, store } = await harness(EVENTS, {
    logger,
    loadRegistry: {
      counts: () => inner.counts(),
      acquire: (credentialId, model) => {
        const release = inner.acquire(credentialId, model);
        return () => {
          release();
          throw new Error("RELEASE_SENTINEL");
        };
      },
    },
  });

  const res = await call("/v1/messages", {
    model: "fast",
    max_tokens: 100,
    stream: true,
    messages: [{ role: "user", content: "hi" }],
  });
  await res.text().catch(() => undefined);
  await until(
    "the row to be completed",
    async () => (await store.usage.recent(1))[0] !== undefined,
  );

  // The upstream did finish and did bill for it, so the row says so rather than
  // inventing a 500 the upstream never returned.
  const [row] = await store.usage.recent(10);
  expect(row).toEqual(expect.objectContaining({ state: "done", status: 200, outputTokens: 2 }));
  // But the break is the gateway's own defect, and it is not silent.
  const rejected = logger.records.filter((record) => record.msg === "request rejected");
  expect(rejected).toHaveLength(1);
  expect(rejected[0]?.level).toBe("error");
  expect(rejected[0]?.fields).toMatchObject({ status: 200, code: "INTERNAL" });
  store.close();
});

/**
 * A failure that merely coincided with a hang-up is not a hang-up.
 *
 * The health write inside dispatch's own error handling runs after the point
 * where an abort is turned back into `signal.reason`, so a store failing there
 * escapes as itself while the client's own timeout may already have fired.
 * Keyed off `signal.aborted`, that was filed 499/interrupted and printed
 * nowhere — a store outage across the fleet reading as clients giving up.
 */
test("records a failure that coincided with a hang-up as the failure it was", async () => {
  const logger = captureLogger("info");
  const refusing = (id: ProviderId): ProviderAdapter => ({
    id,
    capabilities: { tools: true, images: true, reasoning: true },
    send: () =>
      Promise.reject(new GatewayError("BAD_REQUEST", "refused", { provider: "anthropic" })),
  });
  const { app, raw, store } = await harness(EVENTS, {
    logger,
    adapters: { anthropic: refusing("anthropic") },
  });
  const controller = new AbortController();
  // Dispatch records the failure, then writes health — and the client gives up
  // in that window. The write is what escapes; the abort is a bystander.
  store.credentials.updateHealth = async () => {
    controller.abort();
    throw new Error("HEALTH_WRITE_SENTINEL");
  };

  const res = await app.handle(
    new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${raw}` },
      body: JSON.stringify({
        model: "fast",
        max_tokens: 100,
        messages: [{ role: "user", content: "hi" }],
      }),
      signal: controller.signal,
    }),
  );
  await res.text().catch(() => undefined);
  await until(
    "the row to be completed",
    async () => (await store.usage.recent(1))[0] !== undefined,
  );

  const [row] = await store.usage.recent(10);
  expect(row).toEqual(
    expect.objectContaining({ state: "done", status: 500, errorCode: "INTERNAL" }),
  );
  const rejected = logger.records.filter((record) => record.msg === "request rejected");
  expect(rejected).toHaveLength(1);
  // The gateway's own defect, so it pages rather than merely warns — and it
  // reads the same on both surfaces, which is why the level lives in one place.
  expect(rejected[0]?.level).toBe("error");
  store.close();
});

/**
 * A hang-up before routing is still a hang-up.
 *
 * It classifies as `TIMEOUT` on the way out of model resolution, so it used to
 * print a 504 rejection line and record one — the very event every other
 * disconnect path suppresses, at whatever rate the client retried.
 */
test("records a hang-up before routing as a disconnect, and prints nothing", async () => {
  const logger = captureLogger("info");
  const { app, raw, store } = await harness(EVENTS, { logger });
  const controller = new AbortController();
  controller.abort();

  const res = await app.handle(
    new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${raw}` },
      body: JSON.stringify({
        model: "fast",
        max_tokens: 100,
        messages: [{ role: "user", content: "hi" }],
      }),
      signal: controller.signal,
    }),
  );
  await res.text().catch(() => undefined);

  expect(logger.records.filter((record) => record.msg === "request rejected")).toEqual([]);
  const [row] = await store.usage.recent(10);
  expect(row).toEqual(expect.objectContaining({ status: 499, errorCode: "interrupted" }));
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
    kilo: hangingAdapter("kilo"),
    grok: hangingAdapter("grok"),
    custom: hangingAdapter("custom"),
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

/**
 * The regression the sliding window exists to close.
 *
 * `Math.floor(now / WINDOW_MS) * WINDOW_MS` reset the count on a clock edge, so
 * a key limited to N could send N at T+59s and N more at T+61s — twice its
 * ceiling with no rule broken. Written against that behaviour, so a revert to a
 * fixed window fails here rather than passing quietly.
 */
test("rate limits are atomic, per-key, and refuse a burst across the minute boundary", async () => {
  let now = 59_999;
  const store = await memoryStore();
  await seedCredential(store, { id: "c1", provider: "anthropic" });
  await store.config.putModel(
    virtualModel({
      id: "fast",
      targets: [target({ provider: "anthropic", model: "claude-opus-4" })],
    }),
  );
  const first = await seedApiKey(store, { limits: { requests: { "1m": 2 } } });
  const second = await seedApiKey(store, { limits: { requests: { "1m": 1 } } });
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

  // One millisecond past the old fixed window's edge. The bucket that used to
  // reset here still holds every request from 59_999, so the key is still at its
  // ceiling and a second full allowance is refused.
  now = 60_000;
  expect((await request(first.raw)).status).toBe(429);
  expect((await request(second.raw)).status).toBe(429);
  expect(sends).toBe(3);

  // The window frees up exactly one minute after the burst that filled it —
  // 59_999 + 60_000 — rather than on the next clock edge. Asserted at the tick,
  // because a window off by one is a window that is not sliding.
  now = 119_998;
  expect((await request(first.raw)).status).toBe(429);
  now = 119_999;
  expect((await request(first.raw)).status).toBe(200);
  expect((await request(second.raw)).status).toBe(200);
  expect(sends).toBe(5);
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

test("counts tokens without dispatching or logging the request", async () => {
  const { call, store } = await harness();
  const res = await call("/v1/messages/count_tokens", {
    model: "fast",
    messages: [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "read", input: { path: "/etc/hosts" } }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t1", content: "a".repeat(40_000) }],
      },
    ],
  });

  expect(res.status).toBe(200);
  const body = (await res.json()) as { input_tokens: number };
  // Tool output is where an agentic session keeps its tokens; a count that
  // ignored it would let the client run past its window without compacting.
  expect(body.input_tokens).toBeGreaterThan(9_000);

  // Nothing was dispatched and nothing was spent, so nothing may reach usage.
  const logs = await store.usage.recent(10);
  expect(logs).toEqual([]);
});

test("token counting requires a key", async () => {
  const { app } = await harness();
  const res = await app.handle(
    new Request("http://localhost/v1/messages/count_tokens", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "fast", messages: [{ role: "user", content: "hi" }] }),
    }),
  );
  expect(res.status).toBe(401);
});

test("token counting honours the key's model allowlist", async () => {
  const { store, app } = await harness();
  const { raw } = await seedApiKey(store, { label: "limited", modelAllowlist: [] });
  const res = await app.handle(
    new Request("http://localhost/v1/messages/count_tokens", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${raw}` },
      body: JSON.stringify({ model: "fast", messages: [{ role: "user", content: "hi" }] }),
    }),
  );
  expect(res.status).toBe(401);
});

test("token counting rejects a malformed body in the anthropic error shape", async () => {
  const { call } = await harness();
  const res = await call("/v1/messages/count_tokens", { messages: [] });
  expect(res.status).toBe(400);
  const body = (await res.json()) as { type: string; error: { type: string } };
  expect(body.type).toBe("error");
  expect(body.error.type).toBe("invalid_request_error");
});

// The mirror exists so Claude Code can see the pool. It must not also be a way
// around the policy that governs the pool.
test("a key denied a model is denied its discovery mirror too", async () => {
  const { store, app } = await harness();
  const { raw } = await seedApiKey(store, { label: "limited", modelAllowlist: ["slow"] });
  const res = await app.handle(
    new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${raw}` },
      body: JSON.stringify({
        model: "claude/fast",
        max_tokens: 16,
        messages: [{ role: "user", content: "hi" }],
      }),
    }),
  );
  expect(res.status).toBe(401);
});

test("a mirrored id routes to the pool it stands for", async () => {
  const { call } = await harness();
  const res = await call("/v1/messages", {
    model: "claude/fast",
    max_tokens: 16,
    messages: [{ role: "user", content: "hi" }],
  });
  expect(res.status).toBe(200);
});

test("a plugin sees exactly one event per request id, streaming and not", async () => {
  // The spec names this property and nothing tested it. `finishLog` is called
  // from two places in this file, gated by a `logged` flag, and the streaming
  // path reaches the second one — so the guarantee lives in the interaction
  // between them rather than in `finishLog` itself, where the existing tests
  // call it directly.
  //
  // A double event is not cosmetic for the consumer this exists for: a growth
  // counter would credit the same tokens twice, and there is no later
  // reconciliation to catch it, because the event stream is the only ledger a
  // plugin gets.
  const seen: string[] = [];
  const { call } = await harness(EVENTS, { emit: (event) => seen.push(event.requestId) });

  await call("/v1/messages", {
    model: "fast",
    max_tokens: 100,
    messages: [{ role: "user", content: "hi" }],
  });

  const streamed = await call("/v1/messages", {
    model: "fast",
    max_tokens: 100,
    stream: true,
    messages: [{ role: "user", content: "hi" }],
  });
  await streamed.text();

  expect(seen).toEqual(["req_1", "req_2"]);
  expect(new Set(seen).size).toBe(seen.length);
});

/** Records the topics a broadcaster is asked to invalidate, in order. */
function invalidations(): Invalidator & { topics: string[] } {
  const topics: string[] = [];
  return { topics, invalidate: (topic) => void topics.push(topic) };
}

test("a completed request invalidates usage and logs once, streaming and not", async () => {
  // The success path's `finishLog`, reached from the `log()` closure. Both
  // shapes of request end there, and a streaming one ends there from
  // `sseResponse`'s run-once completion rather than from the handler body.
  const stream = invalidations();
  const { call } = await harness(EVENTS, { broadcaster: stream });

  await call("/v1/messages", {
    model: "fast",
    max_tokens: 100,
    messages: [{ role: "user", content: "hi" }],
  });
  expect(stream.topics).toEqual(["res:usage", "res:logs"]);

  const streamed = await call("/v1/messages", {
    model: "fast",
    max_tokens: 100,
    stream: true,
    messages: [{ role: "user", content: "hi" }],
  });
  await streamed.text();

  expect(stream.topics).toEqual(["res:usage", "res:logs", "res:usage", "res:logs"]);
});

test("a request that failed before dispatch invalidates from the terminal catch", async () => {
  // The other of the two `finishLog` call sites, and the one an emitter placed
  // in the handler body would miss entirely. The two are mutually exclusive per
  // request — the `logged` flag is what makes them so — which is why one
  // finished request is one pair of invalidations whichever way it ended.
  const stream = invalidations();
  const { call, store } = await harness(EVENTS, { broadcaster: stream });

  const res = await call("/v1/messages", {
    model: "no-such-pool",
    max_tokens: 100,
    messages: [{ role: "user", content: "hi" }],
  });
  // 503 rather than 404: an unknown pool has no target that could serve it,
  // which is the same refusal as a pool whose every target is cooling down.
  expect(res.status).toBe(503);

  // Proof this is the terminal catch rather than the success path: no attempt
  // was made and no target was resolved, so nothing reached the `log()` closure.
  const [row] = await store.usage.recent(10);
  expect(row).toEqual(
    expect.objectContaining({ state: "done", attempts: 0, resolvedProvider: null }),
  );
  expect(stream.topics).toEqual(["res:usage", "res:logs"]);
});

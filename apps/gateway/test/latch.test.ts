import { expect, test } from "bun:test";
import type { ProviderId, StreamEvent } from "@omni/ir";
import type { HttpClient, ProviderAdapter } from "@omni/providers";
import { memoryStore, seedApiKey, seedCredential, target, virtualModel } from "@omni/testkit";
import { createApp } from "../src/app.ts";
import { createQuiesceLatch } from "../src/quiesce.ts";

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

/**
 * Adapters that do not answer until the test says so.
 *
 * The latch's whole subject is a request that is already inside the gateway,
 * so a test of it needs one that stays there — held at the provider call,
 * which is where a real request spends nearly all of its life.
 */
function gatedAdapters(gate: Promise<void>): Readonly<Record<ProviderId, ProviderAdapter>> {
  const make = (id: ProviderId): ProviderAdapter => ({
    id,
    capabilities: { tools: true, images: true, reasoning: true },
    async send() {
      await gate;
      return {
        events: (async function* () {
          for (const event of EVENTS) yield event;
        })(),
        degradations: [],
      };
    },
  });
  return {
    anthropic: make("anthropic"),
    openai: make("openai"),
    kimi: make("kimi"),
    kilo: make("kilo"),
    grok: make("grok"),
    custom: make("custom"),
  };
}

async function harness() {
  const store = await memoryStore();
  await seedCredential(store, { id: "c1", provider: "anthropic" });
  await store.config.putModel(
    virtualModel({
      id: "fast",
      targets: [target({ provider: "anthropic", model: "claude-opus-4" })],
    }),
  );
  const { raw } = await seedApiKey(store, { label: "latch" });

  const open = Promise.withResolvers<void>();
  const latch = createQuiesceLatch();
  const app = createApp({
    store,
    baseUrl: "http://localhost:9000",
    latch,
    adapters: gatedAdapters(open.promise),
    http: (() => {
      throw new Error("a stub adapter reached the transport");
    }) as HttpClient,
    now: () => 1_000_000,
    rand: () => 0.5,
    refresh: async (credential) => await credential.secrets(),
  });

  const proxy = (path = "/v1/messages") =>
    app.handle(
      new Request(`http://localhost${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${raw}` },
        body: JSON.stringify({
          model: "fast",
          max_tokens: 16,
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
    );

  const get = (path: string, cookie?: string) =>
    app.handle(
      new Request(`http://localhost${path}`, {
        ...(cookie === undefined ? {} : { headers: { cookie } }),
      }),
    );

  /** Sets the admin password through the setup route and returns its session cookie. */
  const login = async (): Promise<string> => {
    const response = await app.handle(
      new Request("http://localhost/api/setup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "hunter2hunter2" }),
      }),
    );
    const setCookie = response.headers.get("set-cookie");
    if (setCookie === null) throw new Error("test admin setup returned no session");
    return setCookie.split(";")[0] ?? "";
  };

  return { store, latch, app, proxy, get, login, release: open.resolve };
}

test("a closed latch refuses new client work, waits for what is in flight, and leaves the console up", async () => {
  const { store, latch, proxy, get, release } = await harness();

  // In flight: admitted, and parked inside the provider call.
  const inFlight = proxy();
  await Bun.sleep(5);

  const drain = latch.close(2_000);
  let drained = false;
  void drain.then(() => {
    drained = true;
  });
  await Bun.sleep(5);
  expect(drained).toBe(false);

  const refused = await proxy();
  expect(refused.status).toBe(503);

  // The asymmetry this latch exists for: the operator watching a restore keeps
  // the console, and keeps the route that will tell them how it ended.
  expect((await get("/api/status")).status).toBe(200);
  expect((await get("/health")).status).toBe(200);

  release();
  expect((await inFlight).status).toBe(200);
  expect(await drain).toEqual({ drained: true, inFlight: 0 });

  store.close();
});

test("a reopened latch admits client work again", async () => {
  const { store, latch, proxy, release } = await harness();
  release();

  await latch.close(2_000);
  expect((await proxy()).status).toBe(503);

  latch.open();
  expect((await proxy()).status).toBe(200);

  store.close();
});

test("a refusal is retryable and rendered in the surface the caller asked for", async () => {
  const { store, latch, proxy, release } = await harness();
  release();
  await latch.close(2_000);

  const anthropic = await proxy("/v1/messages");
  expect(anthropic.headers.get("retry-after")).toBe("5");
  expect(await anthropic.json()).toEqual({
    type: "error",
    error: { type: "overloaded_error", message: expect.stringContaining("maintenance") },
  });

  const openai = await proxy("/v1/chat/completions");
  expect(openai.status).toBe(503);
  const body = (await openai.json()) as { error: { type: string } };
  expect(body.error.type).toBe("server_error");

  // The Responses surface has its own error shape, and this function is keyed
  // on the path rather than on the surface — so a route added without a line
  // here is served the Anthropic dialect by default, which its client cannot
  // read. `param` is the field that tells the two OpenAI dialects apart.
  const responses = await proxy("/v1/responses");
  expect(responses.status).toBe(503);
  expect(await responses.json()).toEqual({
    error: {
      type: "server_error",
      code: "server_error",
      message: expect.stringContaining("maintenance"),
      param: null,
    },
  });

  store.close();
});

/**
 * The asymmetry the latch exists for, asserted rather than gestured at.
 *
 * `.not.toBe(503)` passes on a 401, a 404, and a route that was never mounted,
 * so it says nothing about whether the panel an operator watches a restore on
 * actually answers. These are the statuses each route really returns while the
 * gate is shut: the console is signed in and serving, and `/health` is the
 * liveness probe a supervisor keeps calling throughout.
 */
test("the latch is not consulted for the routes an operator recovers through", async () => {
  const { store, latch, get, login, release } = await harness();
  release();
  const cookie = await login();
  await latch.close(2_000);

  expect((await get("/health")).status).toBe(200);
  expect((await get("/api/status")).status).toBe(200);
  expect((await get("/api/database", cookie)).status).toBe(200);
  expect((await get("/api/lifecycle", cookie)).status).toBe(200);

  // And unauthenticated is still unauthenticated: the gate did not become the
  // reason a request was refused.
  expect((await get("/api/database")).status).toBe(401);

  store.close();
});

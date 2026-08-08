import { expect, test } from "bun:test";
import { computeCch } from "@omni/providers";
import type { Store } from "@omni/store";
import {
  memoryStore,
  seedApiKey,
  seedCredential as seedCredentialRow,
  target,
  virtualModel,
} from "@omni/testkit";
import { createApp } from "../../src/app.ts";
import {
  ANTHROPIC_STREAM,
  createStubUpstream,
  header,
  headerNames,
  type StubUpstream,
} from "./upstream.ts";

const NOW = 1_000_000;

/** Positional wrapper so each test reads as one line. */
async function seedCredential(store: Store, id: string, tier: number, token: string) {
  await seedCredentialRow(store, {
    id,
    tier,
    expiresAt: NOW + 3_600_000,
    accessToken: token,
    refreshToken: "test-token-refresh",
  });
}

async function harness(): Promise<{
  store: Store;
  upstream: StubUpstream;
  call: (body: unknown, headers?: Record<string, string>) => Promise<Response>;
}> {
  const store = await memoryStore();
  await store.config.putModel(
    virtualModel({
      id: "fast",
      strategy: "priority",
      targets: [target({ provider: "anthropic", model: "claude-opus-4" })],
    }),
  );

  const { raw } = await seedApiKey(store, { label: "e2e" });

  const upstream = createStubUpstream();
  let n = 0;
  const app = createApp({
    store,
    baseUrl: "http://localhost:8787",
    now: () => NOW,
    rand: () => 0.5,
    http: upstream.http,
    requestId: () => `req_${++n}`,
  });

  const call = (body: unknown, headers: Record<string, string> = {}) =>
    app.handle(
      new Request("http://localhost/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${raw}`,
          ...headers,
        },
        body: JSON.stringify(body),
      }),
    );

  return { store, upstream, call };
}

const REQUEST = {
  model: "fast",
  max_tokens: 100,
  messages: [{ role: "user", content: "hi" }],
};

test("a request travels through the real adapter to the stub upstream and back", async () => {
  const { call, upstream, store } = await harness();
  await seedCredential(store, "c1", 1, "test-token-a");
  upstream.queue(ANTHROPIC_STREAM);

  const res = await call(REQUEST);

  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    content: { type: string; text: string }[];
    usage: { input_tokens: number; output_tokens: number };
  };
  expect(body.content).toEqual([{ type: "text", text: "Hello" }]);
  expect(body.usage).toEqual({ input_tokens: 12, output_tokens: 3 });
});

test("the upstream request carries the claude-cli client identity", async () => {
  const { call, upstream, store } = await harness();
  await seedCredential(store, "c1", 1, "test-token-a");
  upstream.queue(ANTHROPIC_STREAM);
  await call(REQUEST);

  const sent = upstream.calls[0] as NonNullable<(typeof upstream.calls)[0]>;
  expect(header(sent, "user-agent")).toMatch(/^claude-cli\/[\d.]+ \(external, cli\)$/);
  expect(header(sent, "x-app")).toBe("cli");
  expect(header(sent, "X-Stainless-Lang")).toBe("js");
  expect(header(sent, "X-Stainless-Runtime")).toBe("node");
  expect(header(sent, "anthropic-version")).toBe("2023-06-01");
  // No header names the gateway. That is the point of the profile.
  for (const name of headerNames(sent)) {
    expect(name.toLowerCase()).not.toBe("x-omni-gateway");
  }
  expect(JSON.stringify(sent.headers)).not.toContain("omnigateway");
});

test("the upstream headers arrive in the profile order with the profile casing", async () => {
  const { call, upstream, store } = await harness();
  await seedCredential(store, "c1", 1, "test-token-a");
  upstream.queue(ANTHROPIC_STREAM);
  await call(REQUEST);

  const sent = upstream.calls[0] as NonNullable<(typeof upstream.calls)[0]>;
  const names = headerNames(sent);
  // Exact casing, not a lowercase match — Bun's fetch would have destroyed both.
  expect(names).toContain("X-Stainless-Lang");
  const at = (name: string) => names.indexOf(name);
  expect(at("Accept")).toBeLessThan(at("X-Stainless-Lang"));
  expect(at("X-Stainless-Lang")).toBeLessThan(at("anthropic-version"));
  expect(at("anthropic-version")).toBeLessThan(at("x-app"));
});

test("the body carries the billing block with a cch token valid over the sent bytes", async () => {
  const { call, upstream, store } = await harness();
  await seedCredential(store, "c1", 1, "test-token-a");
  upstream.queue(ANTHROPIC_STREAM);
  await call(REQUEST);

  const sent = upstream.calls[0] as NonNullable<(typeof upstream.calls)[0]>;
  const system = (sent.body as { system: { text: string }[] }).system;
  expect(system[0]?.text).toContain("x-anthropic-billing-header:");
  const token = /cch=([0-9a-f]{5});/.exec(system[0]?.text ?? "")?.[1];
  expect(token).toBeDefined();
  if (token === undefined) throw new Error("billing cch token missing");
  // Recompute over the bytes with the token reset to the placeholder. The
  // substitution is length-preserving, so these are the bytes that were hashed.
  expect(computeCch(sent.rawBody.replace(`cch=${token};`, "cch=00000;"))).toBe(token);
  // The pinned body order survived serialization.
  expect(Object.keys(sent.body as object).slice(0, 3)).toEqual(["model", "messages", "system"]);
});

test("a streaming request produces client-facing sse", async () => {
  const { call, upstream, store } = await harness();
  await seedCredential(store, "c1", 1, "test-token-a");
  upstream.queue(ANTHROPIC_STREAM);
  const res = await call({ ...REQUEST, stream: true });

  const text = await res.text();
  expect(text).toContain("event: message_start");
  expect(text).toContain('"text":"Hello"');
  expect(text).toContain("event: message_stop");
});

test("a 429 on the first credential fails over to the second", async () => {
  const { call, upstream, store } = await harness();
  await seedCredential(store, "c1", 1, "test-token-a");
  await seedCredential(store, "c2", 2, "test-token-b");

  upstream.queue({ kind: "error", status: 429, body: { error: { message: "rate limited" } } });
  upstream.queue(ANTHROPIC_STREAM);

  const res = await call(REQUEST);
  expect(res.status).toBe(200);
  expect(upstream.calls).toHaveLength(2);
  expect(upstream.calls[0]?.authorization).toContain("test-token-a");
  expect(upstream.calls[1]?.authorization).toContain("test-token-b");

  const logs = await store.usage.recent(1);
  expect(logs[0]?.attempts).toBe(2);
  expect(logs[0]?.credentialId).toBe("c2");
});

test("all credentials failing produces one error response and one log", async () => {
  const { call, upstream, store } = await harness();
  await seedCredential(store, "c1", 1, "test-token-a");
  await seedCredential(store, "c2", 2, "test-token-b");

  upstream.queue({ kind: "error", status: 429, body: { error: { message: "rate limited" } } });

  const res = await call(REQUEST);
  // Not 429. Every credential was rate limited, but the client did nothing
  // wrong and has nothing to slow down — the pool is what ran out, so dispatch
  // reports ALL_CANDIDATES_FAILED and the client sees a 503.
  expect(res.status).toBe(503);
  const body = (await res.json()) as { error: { type: string } };
  expect(body.error.type).toBe("api_error");

  const logs = await store.usage.recent(10);
  expect(logs).toHaveLength(1);
  expect(logs[0]?.status).toBe(503);
  expect(logs[0]?.errorCode).toBe("ALL_CANDIDATES_FAILED");
});

test("a failure after the commit point is forwarded in-stream, not failed over", async () => {
  const { call, upstream, store } = await harness();
  await seedCredential(store, "c1", 1, "test-token-a");
  await seedCredential(store, "c2", 2, "test-token-b");

  // 200, real content, then an in-stream error — the classic mid-stream failure.
  upstream.queue({
    kind: "sse",
    events: [
      {
        event: "message_start",
        data: {
          type: "message_start",
          message: {
            id: "m",
            model: "claude-opus-4",
            usage: { input_tokens: 1, output_tokens: 0 },
          },
        },
      },
      {
        event: "content_block_start",
        data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      },
      {
        event: "content_block_delta",
        data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Par" } },
      },
      {
        event: "error",
        data: { type: "error", error: { type: "overloaded_error", message: "boom" } },
      },
    ],
  });
  upstream.queue(ANTHROPIC_STREAM);

  const res = await call({ ...REQUEST, stream: true });
  const text = await res.text();

  expect(text).toContain('"text":"Par"');
  expect(text).toContain("event: error");
  // The second credential was never tried: bytes had already been sent.
  expect(upstream.calls).toHaveLength(1);
});

test("a 401 refreshes the credential and retries it", async () => {
  const { call, upstream, store } = await harness();
  await seedCredential(store, "c1", 1, "test-token-a");

  upstream.queue({ kind: "error", status: 401, body: { error: { message: "expired" } } });
  upstream.queue({
    kind: "json",
    status: 200,
    body: { access_token: "test-token-new", expires_in: 3600 },
  });
  upstream.queue(ANTHROPIC_STREAM);

  const res = await call(REQUEST);
  expect(res.status).toBe(200);

  const reloaded = await store.credentials.get("c1");
  expect((await reloaded?.secrets())?.accessToken).toBe("test-token-new");
});

test("a request for an unconfigured model is a clean 404-class error", async () => {
  const { call } = await harness();
  const res = await call({ ...REQUEST, model: "no-such-model-anywhere" });
  expect(res.status).toBe(503);
  const body = (await res.json()) as { error: { message: unknown } };
  expect(body.error.message).toBeTruthy();
});

test("the health endpoint needs no credentials", async () => {
  const store = await memoryStore();
  const app = createApp({
    store,
    baseUrl: "http://localhost:8787",
    http: createStubUpstream().http,
  });
  const res = await app.handle(new Request("http://localhost/health"));
  expect(res.status).toBe(200);
  const body = (await res.json()) as { ok: boolean };
  expect(body.ok).toBe(true);
});

test("no request or response text ever reaches the log table", async () => {
  const { call, upstream, store } = await harness();
  await seedCredential(store, "c1", 1, "test-token-a");
  upstream.queue(ANTHROPIC_STREAM);

  await call({
    ...REQUEST,
    messages: [{ role: "user", content: "sensitive-prompt-text" }],
  });

  const serialized = JSON.stringify(await store.usage.recent(10));
  expect(serialized).not.toContain("sensitive-prompt-text");
  expect(serialized).not.toContain("Hello");
  expect(serialized).not.toContain("test-token-a");
});

test("the client's betas reach the upstream alongside the oauth beta", async () => {
  const { call, upstream, store } = await harness();
  await seedCredential(store, "c1", 1, "test-token-a");
  upstream.queue(ANTHROPIC_STREAM);

  await call(
    { ...REQUEST, context_management: { edits: [{ type: "clear_tool_uses_20250919" }] } },
    { "anthropic-beta": "context-management-2025-06-27,interleaved-thinking-2025-05-14" },
  );

  const sent = upstream.calls[0] as NonNullable<(typeof upstream.calls)[0]>;
  const betas = (header(sent, "anthropic-beta") ?? "").split(",");
  expect(betas).toContain("context-management-2025-06-27");
  expect(betas).toContain("interleaved-thinking-2025-05-14");
  // Dropping this one would break the OAuth path itself.
  expect(betas).toContain("oauth-2025-04-20");
  // The body field the beta authorises travels with it, not without it.
  expect((sent.body as { context_management?: unknown }).context_management).toEqual({
    edits: [{ type: "clear_tool_uses_20250919" }],
  });
});

test("the api-key path names the client's betas and no others", async () => {
  const { call, upstream, store } = await harness();
  await seedCredentialRow(store, {
    id: "c1",
    authType: "apiKey",
    accessToken: null,
    refreshToken: null,
    apiKey: "sk-ant-test",
  });
  upstream.queue(ANTHROPIC_STREAM);

  await call(REQUEST, { "anthropic-beta": "context-management-2025-06-27" });

  const sent = upstream.calls[0] as NonNullable<(typeof upstream.calls)[0]>;
  expect(header(sent, "anthropic-beta")).toBe("context-management-2025-06-27");
});

test("a request naming no beta sends no beta header on the api-key path", async () => {
  const { call, upstream, store } = await harness();
  await seedCredentialRow(store, {
    id: "c1",
    authType: "apiKey",
    accessToken: null,
    refreshToken: null,
    apiKey: "sk-ant-test",
  });
  upstream.queue(ANTHROPIC_STREAM);

  await call(REQUEST);

  const sent = upstream.calls[0] as NonNullable<(typeof upstream.calls)[0]>;
  expect(header(sent, "anthropic-beta")).toBeNull();
});

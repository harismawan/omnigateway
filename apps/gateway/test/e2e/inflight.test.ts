import { expect, test } from "bun:test";
import { healthKey } from "@omni/router";
import { memoryStore, seedApiKey, seedCredential, target, virtualModel } from "@omni/testkit";
import { createApp } from "../../src/app.ts";
import { createLoadRegistry } from "../../src/dispatch/loadRegistry.ts";
import { ANTHROPIC_STREAM, createStubUpstream } from "./upstream.ts";

const NOW = 1_000_000;

async function harness() {
  const store = await memoryStore();
  await store.config.putModel(
    virtualModel({
      id: "fast",
      strategy: "priority",
      targets: [target({ provider: "anthropic", model: "claude-opus-4" })],
    }),
  );
  await seedCredential(store, {
    id: "c1",
    tier: 1,
    expiresAt: NOW + 3_600_000,
    accessToken: "test-token-1",
    refreshToken: "test-token-refresh",
  });
  const { raw } = await seedApiKey(store, { label: "e2e" });

  const upstream = createStubUpstream();
  const loadRegistry = createLoadRegistry();
  const app = createApp({
    store,
    baseUrl: "http://localhost:8787",
    now: () => NOW,
    rand: () => 0.5,
    http: upstream.http,
    loadRegistry,
    requestId: () => "req_inflight",
  });

  const call = () =>
    app.handle(
      new Request("http://localhost/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${raw}` },
        body: JSON.stringify({
          model: "fast",
          stream: true,
          max_tokens: 16,
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
    );

  return { store, upstream, loadRegistry, call };
}

const KEY = healthKey("c1", "claude-opus-4");

test("a cancelled response leaves nothing in flight", async () => {
  const { store, upstream, loadRegistry, call } = await harness();
  upstream.queue(ANTHROPIC_STREAM);

  const response = await call();
  expect(response.status).toBe(200);
  await response.body?.cancel();

  expect(loadRegistry.counts().get(KEY) ?? 0).toBe(0);
  store.close();
});

// Note on coverage: this file exercises the real route, but it cannot reach the
// case where a client disconnects *before the first pull*. By the time
// `app.handle` resolves here, the stream has already been pulled, so the
// generator has started and its own `finally` does the work — these two pass
// even with the pre-pull defences removed. The test that actually pins that
// window is "a wrapper closed before its first pull still frees the slot on
// disconnect" in `test/dispatch/dispatch.test.ts`.

test("a fully read stream leaves nothing in flight", async () => {
  const { store, upstream, loadRegistry, call } = await harness();
  upstream.queue(ANTHROPIC_STREAM);

  const response = await call();
  await response.text();

  expect(loadRegistry.counts().get(KEY) ?? 0).toBe(0);
  store.close();
});

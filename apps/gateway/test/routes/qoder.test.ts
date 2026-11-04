import { expect, test } from "bun:test";
import { memoryStore, seedApiKey, seedCredential, target, virtualModel } from "@omni/testkit";
import { qoderAdapter } from "../../../../packages/providers/src/qoder/index.ts";
import { proxyRoutes } from "../../src/routes/proxy.ts";

const bundle = JSON.stringify({
  version: 1,
  deviceToken: "dummy",
  uid: "u1",
  machineId: "synthetic",
  encryptUserInfo: "dummy-envelope",
  key: "wrapped",
  issuedAt: 1700000000000,
  origin: "https://api2.qoder.sh",
  models: [],
});
async function call(stream: boolean, tail = "data: [DONE]\n\n", path = "/v1/chat/completions") {
  const store = await memoryStore();
  await seedCredential(store, {
    id: "q1",
    provider: "qoder",
    authType: "oauth",
    accessToken: bundle,
    expiresAt: null,
  });
  await store.config.putModel(
    virtualModel({ id: "q-pool", targets: [target({ provider: "qoder", model: "synthetic" })] }),
  );
  const { raw } = await seedApiKey(store, { label: "test" });
  const app = proxyRoutes({
    store,
    adapters: { qoder: qoderAdapter },
    http: async () => ({
      status: 200,
      headers: new Headers({ "content-type": "text/event-stream" }),
      text: async () => "",
      body: new ReadableStream({
        start(c) {
          c.enqueue(
            new TextEncoder().encode(
              'data: {"id":"upstream-q","model":"synthetic","choices":[{"delta":{"content":"hello"}}]}\n\n' +
                'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":4,"completion_tokens":1}}\n\n' +
                tail,
            ),
          );
          c.close();
        },
      }),
    }),
    now: () => 1700000000000,
    rand: () => 0.5,
    refresh: async (c) => c.secrets(),
    requestId: () => "q-request",
  });
  return app.handle(
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${raw}` },
      body: JSON.stringify({
        model: "q-pool",
        max_tokens: 100,
        stream,
        messages: [{ role: "user", content: "hi" }],
      }),
    }),
  );
}

test("Qoder real adapter serves collected chat and Anthropic response surfaces", async () => {
  const chat = await call(false);
  expect(chat.status).toBe(200);
  expect(await chat.json()).toMatchObject({
    choices: [{ message: { content: "hello" } }],
    usage: { prompt_tokens: 4, completion_tokens: 1 },
  });
  const anthropic = await call(false, "data: [DONE]\n\n", "/v1/messages");
  expect(anthropic.status).toBe(200);
  expect(await anthropic.json()).toMatchObject({ content: [{ type: "text", text: "hello" }] });
});

test("Qoder stream after-output quota failure is surfaced, not a successful finish", async () => {
  const response = await call(true, "data: [EXCEED_QUOTA]\n\n");
  expect(response.status).toBe(200);
  const text = await response.text();
  expect(text).toContain("hello");
  expect(text).toContain("error");
  expect(text).toContain("rate_limit_exceeded");
});

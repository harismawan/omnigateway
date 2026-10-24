import { describe, expect, test } from "bun:test";
import type { StreamEvent } from "@omni/ir";
import type { HttpClient } from "@omni/providers";
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

async function harness(overrides: Partial<ProxyDeps> = {}) {
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
    adapters: stubAdapters(EVENTS),
    http: (() => {
      throw new Error("a stub adapter reached the transport");
    }) as HttpClient,
    now: () => 1_000_000,
    rand: () => 0.5,
    refresh: async (c) => await c.secrets(),
    requestId: () => `req_${++n}`,
    ...overrides,
  });
  const call = (
    path: string,
    body: unknown,
    headers: Record<string, string> = {},
    auth: string | null = `Bearer ${raw}`,
  ) =>
    app.handle(
      new Request(`http://localhost${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(auth === null ? {} : { authorization: auth }),
          ...headers,
        },
        body: JSON.stringify(body),
      }),
    );
  return { store, call };
}

const SURFACES = [
  {
    name: "anthropic",
    path: "/v1/messages",
    body: (stream: boolean) => ({
      model: "fast",
      max_tokens: 10,
      stream,
      messages: [{ role: "user", content: "hi" }],
    }),
  },
  {
    name: "openai",
    path: "/v1/chat/completions",
    body: (stream: boolean) => ({
      model: "fast",
      stream,
      messages: [{ role: "user", content: "hi" }],
    }),
  },
  {
    name: "responses",
    path: "/v1/responses",
    body: (stream: boolean) => ({ model: "fast", stream, input: "hi" }),
  },
] as const;

describe("trace fields reach the request-log row", () => {
  test("explicit caller headers are stored on the row", async () => {
    const { store, call } = await harness();
    const res = await call("/v1/messages", SURFACES[0].body(false), {
      "x-omni-session-id": "job-1",
      "x-omni-turn-id": "step-2",
      "x-omni-tags": "team-a,exp",
      "x-omni-metadata": "owner:ops",
      "x-request-id": "client-77",
    });
    expect(res.status).toBe(200);
    const [row] = await store.usage.recent(1);
    expect(row).toMatchObject({
      sessionId: "job-1",
      turnId: "step-2",
      agent: null,
      tags: ["team-a", "exp"],
      traceMetadata: { owner: "ops" },
      clientRequestId: "client-77",
    });
    expect(row?.degradations).not.toContain("trace:invalid");
  });

  for (const surface of SURFACES) {
    test(`an agent session is inferred on ${surface.name}, streaming`, async () => {
      const { store, call } = await harness();
      const res = await call(surface.path, surface.body(true), {
        "x-claude-code-session-id": "cc-9",
      });
      expect(res.status).toBe(200);
      await res.text();
      const [row] = await store.usage.recent(1);
      expect(row).toMatchObject({ agent: "claude-code", sessionId: "claude-code:cc-9" });
    });
  }

  test("a Codex turn snapshot in the Responses body is read", async () => {
    const { store, call } = await harness();
    const snapshot = JSON.stringify({ thread_id: "th-1", turn_id: "tu-1" });
    const res = await call("/v1/responses", {
      ...SURFACES[2].body(false),
      client_metadata: { "x-codex-turn-metadata": snapshot },
    });
    expect(res.status).toBe(200);
    const [row] = await store.usage.recent(1);
    expect(row).toMatchObject({
      agent: "codex",
      sessionId: "codex:th-1",
      turnId: "codex:tu-1",
    });
  });

  test("an invalid header is dropped and flagged, and the request still succeeds", async () => {
    const { store, call } = await harness();
    const res = await call("/v1/messages", SURFACES[0].body(false), {
      "x-omni-session-id": "x".repeat(300),
      "x-omni-tags": "ok",
    });
    expect(res.status).toBe(200);
    const [row] = await store.usage.recent(1);
    expect(row?.sessionId).toBeNull();
    expect(row?.tags).toEqual(["ok"]);
    expect(row?.degradations).toContain("trace:invalid");
  });

  test("a request refused after admission still carries its trace on the row", async () => {
    const { store, call } = await harness();
    const res = await call(
      "/v1/messages",
      { ...SURFACES[0].body(false), model: "no-such-model" },
      { "x-omni-session-id": "s-refused" },
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
    const [row] = await store.usage.recent(1);
    expect(row).toMatchObject({ sessionId: "s-refused", state: "done" });
  });
});

describe("x-omni-request-id", () => {
  for (const surface of SURFACES) {
    test(`is on a non-streaming success on ${surface.name} and equals the row id`, async () => {
      const { store, call } = await harness();
      const res = await call(surface.path, surface.body(false));
      expect(res.status).toBe(200);
      const [row] = await store.usage.recent(1);
      expect(res.headers.get("x-omni-request-id")).toBe(row?.id ?? "missing");
    });

    test(`is in the stream head on ${surface.name}`, async () => {
      const { call } = await harness();
      const res = await call(surface.path, surface.body(true));
      expect(res.headers.get("x-omni-request-id")).toBe("req_1");
      await res.text();
    });

    test(`is on a 401 on ${surface.name}`, async () => {
      const { call } = await harness();
      const res = await call(surface.path, surface.body(false), {}, "Bearer nope");
      expect(res.status).toBe(401);
      expect(res.headers.get("x-omni-request-id")).toBe("req_1");
    });

    test(`is on an error after admission on ${surface.name}`, async () => {
      const { call } = await harness();
      const res = await call(surface.path, { ...surface.body(false), model: "no-such-model" });
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.headers.get("x-omni-request-id")).toBe("req_1");
    });
  }

  test("is on count_tokens, including its 401, and writes no row", async () => {
    const { store, call } = await harness();
    const body = { model: "fast", messages: [{ role: "user", content: "hi" }] };
    const ok = await call("/v1/messages/count_tokens", body);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("x-omni-request-id")).toBe("req_1");
    const denied = await call("/v1/messages/count_tokens", body, {}, "Bearer nope");
    expect(denied.status).toBe(401);
    expect(denied.headers.get("x-omni-request-id")).toBe("req_2");
    expect(await store.usage.recent(10)).toEqual([]);
  });
});

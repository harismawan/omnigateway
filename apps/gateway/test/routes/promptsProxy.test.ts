import { expect, test } from "bun:test";
import { type ChatRequest, estimateInputTokens, type StreamEvent } from "@omni/ir";
import { builtinPrompts, injectPrompts } from "@omni/prompts";
import type { ProviderAdapter } from "@omni/providers";
import {
  memoryStore,
  seedApiKey,
  seedCredential,
  stubAdapters,
  target,
  virtualModel,
} from "@omni/testkit";
import { createLoadRegistry } from "../../src/dispatch/loadRegistry.ts";
import type { ProxyDeps } from "../../src/routes/proxy.ts";
import { proxyRoutes } from "../../src/routes/proxy.ts";

const EVENTS: StreamEvent[] = [
  { type: "start", id: "upstream", model: "claude-opus-4" },
  {
    type: "end",
    stopReason: "endTurn",
    usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
  },
];

async function harness(overrides: Partial<ProxyDeps> = {}) {
  const store = await memoryStore();
  await seedCredential(store, { id: "c1" });
  await store.config.putModel(virtualModel({ id: "fast", targets: [target()] }));
  await store.prompts.create({
    id: "team",
    name: "Team",
    description: null,
    text: "operator sentinel",
    note: null,
    activate: true,
  });
  await store.prompts.saveVersion("team", {
    text: "operator sentinel v2",
    note: null,
    activate: true,
  });
  await store.prompts.saveVersion("team", {
    text: "operator sentinel v3",
    note: null,
    activate: true,
  });
  await store.prompts.create({
    id: "key",
    name: "Key",
    description: null,
    text: "key sentinel",
    note: null,
    activate: true,
  });
  await store.config.putSettings({ prompts: ["team", "ponytail-lite"] });
  const { raw, key } = await seedApiKey(store, {
    prompts: { ids: ["key", "ponytail-full"], inheritGlobal: true },
  });
  const received: ChatRequest[] = [];
  const adapters = stubAdapters(EVENTS);
  const base = adapters.anthropic;
  if (!base) throw new Error("missing stub");
  const adapter: ProviderAdapter = {
    ...base,
    async send(input) {
      received.push(input.request);
      return base.send(input);
    },
  };
  let n = 0;
  const app = proxyRoutes({
    store,
    adapters: { ...adapters, anthropic: adapter },
    http: async () => {
      throw new Error("unexpected HTTP");
    },
    now: () => 1_000_000,
    rand: () => 0.5,
    refresh: (c) => c.secrets(),
    requestId: () => `prompt-${++n}`,
    ...overrides,
  });
  const call = (
    path: string,
    body: unknown,
    authorization = `Bearer ${raw}`,
    signal?: AbortSignal,
  ) =>
    app.handle(
      new Request(`http://localhost${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization },
        body: JSON.stringify(body),
        ...(signal === undefined ? {} : { signal }),
      }),
    );
  return { store, key, raw, adapter, received, call };
}

for (const surface of ["messages", "chat/completions", "responses"]) {
  for (const stream of [false, true]) {
    test(`${surface} stream=${stream} applies global then key prompts with key builtin precedence`, async () => {
      const h = await harness();
      const body =
        surface === "responses"
          ? { model: "fast", stream, input: "hello", instructions: "client" }
          : {
              model: "fast",
              stream,
              max_tokens: 10,
              ...(surface === "messages" ? { system: "client" } : {}),
              messages: [
                ...(surface === "chat/completions" ? [{ role: "system", content: "client" }] : []),
                { role: "user", content: "hello" },
              ],
            };
      const response = await h.call(`/v1/${surface}`, body);
      expect(response.status).toBe(200);
      await response.text();
      const last = h.received[0]?.system?.at(-1);
      expect(last?.type === "text" ? last.text : null).toBe(
        `operator sentinel v3\n\nkey sentinel\n\n${builtinPrompts().find((p) => p.id === "ponytail-full")?.text}`,
      );
      expect((await h.store.usage.recent(10))[0]?.prompts).toEqual([
        "team@3",
        "key@1",
        "ponytail-full@v4.9.0",
      ]);
      h.store.close();
    });
  }
}

test("count_tokens uses the identical effective injected IR and key opt-out", async () => {
  const h = await harness();
  await h.store.keys.setPrompts(h.key.id, { ids: ["key"], inheritGlobal: false });
  const body = { model: "fast", system: "client", messages: [{ role: "user", content: "hello" }] };
  const response = await h.call("/v1/messages/count_tokens", body);
  const expected = injectPrompts(
    {
      model: "fast",
      stream: false,
      system: [{ type: "text", text: "client" }],
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    },
    [{ id: "key", version: 1, text: "key sentinel" }],
  ).request;
  expect(await response.json()).toEqual({ input_tokens: estimateInputTokens(expected) });
  expect(await h.store.usage.recent(10)).toEqual([]);
  h.store.close();
});

test("inference reads active snapshot rows only, not prompt history", async () => {
  const h = await harness();
  h.store.prompts.get = async () => {
    throw new Error("history read on request path");
  };
  h.store.prompts.list = async () => {
    throw new Error("library read on request path");
  };
  const response = await h.call("/v1/messages", {
    model: "fast",
    max_tokens: 10,
    messages: [{ role: "user", content: "hello" }],
  });
  expect(response.status).toBe(200);
  expect(JSON.stringify(h.received[0]?.system)).toContain("operator sentinel v3");
  h.store.close();
});

test("unknown model retains applied IDs, while authentication failure retains none", async () => {
  const h = await harness();
  await h.call("/v1/messages", {
    model: "missing",
    max_tokens: 10,
    messages: [{ role: "user", content: "hello" }],
  });
  expect((await h.store.usage.recent(10))[0]?.prompts).toEqual([
    "team@3",
    "key@1",
    "ponytail-full@v4.9.0",
  ]);
  await h.call("/v1/messages", {}, "Bearer invalid");
  expect((await h.store.usage.recent(10)).find((row) => row.id === "prompt-2")?.prompts).toEqual(
    [],
  );
  h.store.close();
});

test("adapter setup throw retains applied IDs in terminal fallback and writes once", async () => {
  const h = await harness();
  Object.defineProperty(h.adapter, "send", {
    get() {
      throw new Error("adapter setup failed");
    },
  });
  const response = await h.call("/v1/messages", {
    model: "fast",
    max_tokens: 10,
    messages: [{ role: "user", content: "hello" }],
  });
  const rows = await h.store.usage.recent(10);
  expect(response.status).toBe(500);
  expect(rows).toHaveLength(1);
  expect(rows[0]?.prompts).toEqual(["team@3", "key@1", "ponytail-full@v4.9.0"]);
  h.store.close();
});

test("throw before dispatch returns an outcome retains applied IDs and notes", async () => {
  const loadRegistry = createLoadRegistry();
  loadRegistry.refresh = async () => {
    throw new Error("routing setup failed");
  };
  const h = await harness({ loadRegistry });
  await h.store.keys.setPrompts(h.key.id, { ids: [], inheritGlobal: true });
  await h.store.prompts.create({
    id: "draft",
    name: "Draft",
    description: null,
    text: "not active",
    note: null,
    activate: false,
  });
  await h.store.config.putSettings({ prompts: ["team", "draft"] });
  const response = await h.call("/v1/messages", {
    model: "fast",
    max_tokens: 10,
    messages: [{ role: "user", content: "hello" }],
  });
  const [completed] = await h.store.usage.recent(10);
  expect(completed?.prompts).toEqual(["team@3"]);
  expect(completed?.degradations).toContain("prompt:missing");
  expect(completed?.status).toBe(500);
  expect(response.status).toBe(500);
  h.store.close();
});

test("first pending row already holds applied IDs and only one completion is written", async () => {
  const h = await harness();
  const begin = h.store.usage.begin.bind(h.store.usage);
  const append = h.store.usage.append.bind(h.store.usage);
  const pending: string[][] = [];
  let completions = 0;
  h.store.usage.begin = async (row) => {
    pending.push([...row.prompts]);
    await begin(row);
  };
  h.store.usage.append = async (row) => {
    completions++;
    await append(row);
  };
  const response = await h.call("/v1/messages", {
    model: "fast",
    stream: true,
    max_tokens: 10,
    messages: [{ role: "user", content: "hello" }],
  });
  await response.text();
  expect(pending).toEqual([["team@3", "key@1", "ponytail-full@v4.9.0"]]);
  expect(completions).toBe(1);
  h.store.close();
});

test("failover keeps resolved bytes after activation and the next request sees the edit", async () => {
  const h = await harness();
  await seedCredential(h.store, { id: "c2" });
  const send = h.adapter.send.bind(h.adapter);
  let attempts = 0;
  h.adapter.send = async (input) => {
    const result = await send(input);
    if (++attempts === 1) {
      await h.store.prompts.saveVersion("team", {
        text: "new activation",
        note: null,
        activate: true,
      });
      return {
        events: (async function* (): AsyncGenerator<StreamEvent> {
          yield { type: "error", code: "UPSTREAM", message: "retry", retryable: true };
        })(),
        degradations: [],
      };
    }
    return result;
  };
  const body = { model: "fast", max_tokens: 10, messages: [{ role: "user", content: "hello" }] };
  expect((await h.call("/v1/messages", body)).status).toBe(200);
  expect(h.received).toHaveLength(2);
  expect(h.received[0]?.system).toEqual(h.received[1]?.system);
  expect(JSON.stringify(h.received[1]?.system)).toContain("operator sentinel v3");
  expect((await h.call("/v1/messages", body)).status).toBe(200);
  expect(JSON.stringify(h.received[2]?.system)).toContain("new activation");
  h.store.close();
});

test("dedupe and budget audit only the actually appended survivors", async () => {
  const h = await harness();
  await h.store.keys.setPrompts(h.key.id, { ids: [], inheritGlobal: true });
  for (const [id, text] of [
    ["a", "a".repeat(16_000)],
    ["b", "b".repeat(16_000)],
    ["c", "small"],
  ]) {
    if (id === undefined || text === undefined) throw new Error("missing fixture");
    await h.store.prompts.create({
      id,
      name: id,
      description: null,
      text,
      note: null,
      activate: true,
    });
  }
  await h.store.config.putSettings({ prompts: ["team", "a", "b", "c"] });
  expect(
    (
      await h.call("/v1/messages", {
        model: "fast",
        system: "operator sentinel v3",
        max_tokens: 10,
        messages: [{ role: "user", content: "hello" }],
      })
    ).status,
  ).toBe(200);
  const [row] = await h.store.usage.recent(10);
  expect(row?.prompts).toEqual(["a@1"]);
  expect(row?.degradations).toContain("prompt:already-present");
  expect(row?.degradations).toContain("prompt:over-budget");
  h.store.close();
});

test("no candidates still records the injected prompt IDs", async () => {
  const h = await harness();
  await h.store.credentials.update("c1", { enabled: false });
  await h.call("/v1/messages", {
    model: "fast",
    max_tokens: 10,
    messages: [{ role: "user", content: "hello" }],
  });
  const [row] = await h.store.usage.recent(10);
  expect(row?.errorCode).toBe("NO_CANDIDATES");
  expect(row?.prompts).toEqual(["team@3", "key@1", "ponytail-full@v4.9.0"]);
  h.store.close();
});

for (const stream of [false, true]) {
  test(`cancellation after injection preserves applied IDs stream=${stream}`, async () => {
    const h = await harness();
    let started: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    h.adapter.send = async (input) => {
      started?.();
      return {
        events: (async function* (): AsyncGenerator<StreamEvent> {
          await new Promise<void>((_, reject) => {
            if (input.signal.aborted) reject(input.signal.reason);
            else
              input.signal.addEventListener("abort", () => reject(input.signal.reason), {
                once: true,
              });
          });
        })(),
        degradations: [],
      };
    };
    const controller = new AbortController();
    const pending = h.call(
      "/v1/messages",
      { model: "fast", stream, max_tokens: 10, messages: [{ role: "user", content: "hello" }] },
      `Bearer ${h.raw}`,
      controller.signal,
    );
    if (stream) {
      const response = await pending;
      const drained = response.text().catch(() => undefined);
      await ready;
      controller.abort();
      await drained;
    } else {
      await ready;
      controller.abort();
      await pending;
    }
    const rows = await h.store.usage.recent(10);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe(499);
    expect(rows[0]?.prompts).toEqual(["team@3", "key@1", "ponytail-full@v4.9.0"]);
    h.store.close();
  });

  test(`screened dispatch setup throw retains applied IDs stream=${stream}`, async () => {
    const loadRegistry = createLoadRegistry();
    let refreshes = 0;
    const refresh = loadRegistry.refresh.bind(loadRegistry);
    loadRegistry.refresh = async () => {
      if (++refreshes === 2) throw new Error("main dispatch setup failed");
      await refresh();
    };
    const h = await harness({ loadRegistry });
    // The first dispatch is the guardrail judge; the second is the actual request.
    await h.store.keys.setGuardrailPolicy(h.key.id, "only engineering");
    await h.store.config.putSettings({ guardrailModel: "fast" });
    const send = h.adapter.send.bind(h.adapter);
    h.adapter.send = async (input) => {
      const result = await send(input);
      return {
        ...result,
        events: (async function* (): AsyncGenerator<StreamEvent> {
          yield { type: "start", id: "judge", model: "claude-opus-4" };
          yield { type: "blockStart", index: 0, block: { type: "text" } };
          yield { type: "blockDelta", index: 0, delta: { type: "text", text: "ALLOW" } };
          yield { type: "blockEnd", index: 0 };
          yield EVENTS[1] as StreamEvent;
        })(),
      };
    };
    const response = await h.call("/v1/messages", {
      model: "fast",
      stream,
      max_tokens: 10,
      messages: [{ role: "user", content: "hello" }],
    });
    await response.text().catch(() => undefined);
    const row = (await h.store.usage.recent(10)).find((entry) => entry.id === "prompt-1");
    expect(row?.prompts).toEqual(["team@3", "key@1", "ponytail-full@v4.9.0"]);
    expect(row?.status).toBe(500);
    h.store.close();
  });

  test(`post-commit failure preserves applied IDs stream=${stream}`, async () => {
    const h = await harness();
    h.adapter.send = async () => ({
      events: (async function* (): AsyncGenerator<StreamEvent> {
        yield { type: "start", id: "upstream", model: "claude-opus-4" };
        yield { type: "blockStart", index: 0, block: { type: "text" } };
        yield { type: "blockDelta", index: 0, delta: { type: "text", text: "partial" } };
        throw new Error("broken upstream");
      })(),
      degradations: [],
    });
    const response = await h.call("/v1/messages", {
      model: "fast",
      stream,
      max_tokens: 10,
      messages: [{ role: "user", content: "hello" }],
    });
    await response.text();
    const rows = await h.store.usage.recent(10);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.prompts).toEqual(["team@3", "key@1", "ponytail-full@v4.9.0"]);
    expect(rows[0]?.errorCode).not.toBeNull();
    h.store.close();
  });
}

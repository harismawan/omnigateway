import { expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ErrorCode } from "@omni/ir";
import { buildSnapshot } from "@omni/router";
import { createStore, deriveKey, type RequestLog } from "@omni/store";
import { unwatched } from "../../src/dispatch/upstreamRequestId.ts";
import { anthropicErrorBody } from "../../src/egress/anthropic.ts";
import { openaiErrorBody } from "../../src/egress/openai.ts";
import { responsesErrorBody } from "../../src/egress/responses.ts";
import { CLASSIFIER_INSTRUCTION } from "../../src/guardrail/classifier.ts";
import { UNAVAILABLE_MESSAGE, UNCONFIGURED_MESSAGE } from "../../src/smartRouter/check.ts";
import { CONFIDENTIALITY_INSTRUCTION } from "../../src/smartRouter/classifier.ts";
import {
  bodyWith,
  frames,
  type Harness,
  type LocalClassifier,
  SURFACES,
  type Surface,
  sentText,
  smartRouterHarness,
  transport,
} from "./harness.ts";

/**
 * Smart routing at the route boundary, on every surface, both response kinds.
 *
 * **A confidential request never reaches an external provider** is the rule
 * this file pins: confidential goes to the local model; a failed check, an
 * unconfigured feature, a failing local model and a local model that cannot
 * serve the request all refuse — none of them falls back to the model the
 * client asked for.
 */

const errorBody = (surface: Surface, code: ErrorCode, message: string): unknown =>
  surface === "anthropic"
    ? anthropicErrorBody(code, message)
    : surface === "responses"
      ? responsesErrorBody(code, message)
      : openaiErrorBody(code, message);

test("confidentiality and guardrail screen client text only; local reroute receives captured prompts", async () => {
  let reads = 0;
  const h: Harness = await smartRouterHarness({
    classifier: "secret",
    policy: "Only software engineering work.",
    deps: {
      snapshots: {
        async get(now) {
          if (++reads === 2) {
            await h.store.prompts.saveVersion("operator", {
              text: "LATER-OPERATOR-VERSION",
              note: null,
              activate: true,
            });
          }
          return buildSnapshot(h.store, now);
        },
      },
    },
  });
  await h.store.prompts.create({
    id: "operator",
    name: "Operator",
    description: null,
    text: "UNIQUE-OPERATOR-SENTINEL",
    note: null,
    activate: true,
  });
  await h.store.config.putSettings({ prompts: ["operator"] });
  const response = await h.call("anthropic", {
    body: { messages: [{ role: "user", content: "SECRET client text" }] },
  });
  expect(response.status).toBe(200);
  expect(h.externalCalls).toHaveLength(0);
  expect(h.localCalls).toHaveLength(1);
  expect(JSON.stringify(h.localCalls[0]?.request.system)).toContain("UNIQUE-OPERATOR-SENTINEL");
  expect(JSON.stringify(h.localCalls[0]?.request.system)).not.toContain("LATER-OPERATOR-VERSION");
  expect(h.classifierCalls.length).toBeGreaterThan(0);
  expect(h.localGuardrailCalls.length).toBeGreaterThan(0);
  for (const call of [...h.classifierCalls, ...h.localGuardrailCalls]) {
    expect(JSON.stringify(call.request)).not.toContain("UNIQUE-OPERATOR-SENTINEL");
  }
  const parent = await rowOf(h, "req_1");
  expect(parent?.prompts).toEqual(["operator@1"]);
  h.store.close();
});

/** The error a stream carried, as its surface renders it. */
function streamError(surface: Surface, text: string): unknown {
  const all = frames(text);
  if (surface === "anthropic") {
    const frame = all.find((f) => f.event === "error");
    return frame === undefined ? undefined : JSON.parse(frame.data);
  }
  if (surface === "responses") {
    const frame = all.find((f) => f.event === "response.failed");
    if (frame === undefined) return undefined;
    return (JSON.parse(frame.data) as { response: { error: unknown } }).response.error;
  }
  const frame = all.find((f) => f.data.includes('"error"'));
  return frame === undefined ? undefined : JSON.parse(frame.data);
}

function expectedStreamError(surface: Surface, code: ErrorCode, message: string): unknown {
  const body = errorBody(surface, code, message) as { error: Record<string, unknown> };
  if (surface === "responses") return { code: body.error.code, message };
  return body;
}

/** The model a response names: the non-streaming body's, or the stream's start. */
function responseModel(surface: Surface, stream: boolean, text: string): unknown {
  if (!stream) return (JSON.parse(text) as { model: unknown }).model;
  const all = frames(text);
  if (surface === "anthropic") {
    const start = all.find((f) => f.event === "message_start");
    return (JSON.parse(start?.data ?? "{}") as { message?: { model?: unknown } }).message?.model;
  }
  if (surface === "responses") {
    const created = all.find((f) => f.event === "response.created");
    return (JSON.parse(created?.data ?? "{}") as { response?: { model?: unknown } }).response
      ?.model;
  }
  // OpenAI chat chunks: every chunk carries `model`; frames() keeps only
  // `event:` frames, so read the data lines directly.
  const chunk = text
    .split("\n")
    .find((line) => line.startsWith("data: {") && line.includes('"model"'));
  return (JSON.parse(chunk?.slice("data: ".length) ?? "{}") as { model?: unknown }).model;
}

async function rowOf(h: Harness, id: string): Promise<RequestLog | undefined> {
  return (await h.store.usage.recent(50)).find((row) => row.id === id);
}

const SECRET = "the db password is SECRET-hunter2";

for (const surface of SURFACES) {
  for (const stream of [false, true]) {
    const kind = `${surface}, ${stream ? "streaming" : "non-streaming"}`;

    test(`public goes external with its own model (${kind})`, async () => {
      const h = await smartRouterHarness();
      const res = await h.call(surface, { stream });
      const text = await res.text();
      expect(res.status).toBe(200);
      expect(text).toContain("Hi");
      expect(h.externalCalls).toHaveLength(1);
      expect(h.externalCalls[0]?.request.model).toBe("fast");
      expect(h.localCalls).toHaveLength(0);
      expect(h.classifierCalls).toHaveLength(1);
      expect(res.headers.get("x-omni-route")).toBe(stream ? null : "external");
      const parent = await rowOf(h, "req_1");
      expect(parent?.degradations).toContain("smart-router:public");
      expect(parent?.requestedModel).toBe("fast");
      h.store.close();
    });

    test(`confidential goes to the local model and never external (${kind})`, async () => {
      const h = await smartRouterHarness();
      const res = await h.call(surface, { stream, body: bodyWith(surface, SECRET) });
      const text = await res.text();
      expect(res.status).toBe(200);
      expect(text).toContain("Local hi");
      expect(h.localCalls).toHaveLength(1);
      expect(h.localCalls[0]?.request.model).toBe("local-llm");
      expect(h.externalCalls).toHaveLength(0);
      expect(res.headers.get("x-omni-route")).toBe(stream ? null : "local");
      // The configured id, not what the upstream called itself.
      expect(responseModel(surface, stream, text)).toBe("local-llm");
      const parent = await rowOf(h, "req_1");
      expect(parent?.degradations).toContain("smart-router:local");
      h.store.close();
    });

    for (const [name, classifier] of [
      ["hang", "hang"],
      ["error", "error"],
      ["unreadable", "unreadable"],
    ] as const satisfies ReadonlyArray<readonly [string, LocalClassifier]>) {
      test(`a classifier ${name} refuses and dispatches nothing (${kind})`, async () => {
        const h = await smartRouterHarness({ classifier });
        const res = await h.call(surface, { stream });
        const text = await res.text();
        if (stream) {
          expect(res.status).toBe(200);
          expect(streamError(surface, text)).toEqual(
            expectedStreamError(surface, "UPSTREAM", UNAVAILABLE_MESSAGE),
          );
        } else {
          expect(res.status).toBe(502);
          expect(JSON.parse(text)).toEqual(errorBody(surface, "UPSTREAM", UNAVAILABLE_MESSAGE));
          expect(res.headers.get("x-omni-route")).toBeNull();
        }
        expect(text).not.toContain("the policy text was");
        expect(h.externalCalls).toHaveLength(0);
        expect(h.localCalls).toHaveLength(0);
        const parent = await rowOf(h, "req_1");
        expect(parent?.status).toBe(502);
        expect(parent?.errorCode).toBe("UPSTREAM");
        expect(parent?.degradations).toEqual(["smart-router:unavailable"]);
        h.store.close();
      });
    }
  }
}

test("the rerouted row keeps the client's model and the debit lands on it", async () => {
  const h = await smartRouterHarness();
  expect((await h.call("openai", { body: bodyWith("openai", SECRET) })).status).toBe(200);
  const parent = await rowOf(h, "req_1");
  expect(parent?.requestedModel).toBe("fast");
  expect(parent?.resolvedProvider).toBe("custom");
  expect(parent?.resolvedModel).toBe("llama3:8b");
  const parentDebits = h.debits.filter((d) => d.model !== "local-judge");
  expect(parentDebits).toHaveLength(1);
  expect(parentDebits[0]?.model).toBe("fast");
  expect(h.debits.some((d) => d.model === "local-llm")).toBe(false);
  h.store.close();
});

test("the rerouted streaming row keeps the client's model too", async () => {
  const h = await smartRouterHarness();
  const res = await h.call("anthropic", { stream: true, body: bodyWith("anthropic", SECRET) });
  await res.text();
  for (let i = 0; i < 50 && h.emitted.length < 2; i++) await Bun.sleep(5);
  const parent = await rowOf(h, "req_1");
  expect(parent?.requestedModel).toBe("fast");
  expect(parent?.resolvedProvider).toBe("custom");
  expect(h.debits.filter((d) => d.model !== "local-judge").map((d) => d.model)).toEqual(["fast"]);
  h.store.close();
});

for (const [name, settings] of [
  ["classifier model unset", { smartRouterClassifierModel: null }],
  ["local model unset", { smartRouterLocalModel: null }],
  ["local model not local-only", { smartRouterLocalModel: "mixed" }],
] as const) {
  for (const stream of [false, true]) {
    test(`${name} refuses as unconfigured (${stream ? "streaming" : "non-streaming"})`, async () => {
      const h = await smartRouterHarness({ settings });
      const res = await h.call("anthropic", { stream, body: bodyWith("anthropic", SECRET) });
      const text = await res.text();
      if (stream) {
        expect(res.status).toBe(200);
        expect(streamError("anthropic", text)).toEqual(
          expectedStreamError("anthropic", "INTERNAL", UNCONFIGURED_MESSAGE),
        );
      } else {
        expect(res.status).toBe(500);
        expect(JSON.parse(text)).toEqual(errorBody("anthropic", "INTERNAL", UNCONFIGURED_MESSAGE));
      }
      expect(h.classifierCalls).toHaveLength(0);
      expect(h.externalCalls).toHaveLength(0);
      expect(h.localCalls).toHaveLength(0);
      expect((await rowOf(h, "req_1"))?.degradations).toEqual(["smart-router:unconfigured"]);
      h.store.close();
    });
  }
}

for (const stream of [false, true]) {
  test(`a failing local model is an error, never a fallback external (${stream ? "streaming" : "non-streaming"})`, async () => {
    const h = await smartRouterHarness({ local: "error" });
    const res = await h.call("openai", { stream, body: bodyWith("openai", SECRET) });
    const text = await res.text();
    if (stream) {
      expect(res.status).toBe(200);
      expect(streamError("openai", text)).toBeDefined();
    } else {
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.headers.get("x-omni-route")).toBeNull();
    }
    expect(h.localCalls.length).toBeGreaterThan(0);
    expect(h.externalCalls).toHaveLength(0);
    for (let i = 0; i < 50 && h.emitted.length < 2; i++) await Bun.sleep(5);
    const parent = await rowOf(h, "req_1");
    expect(parent?.degradations).toContain("smart-router:local");
    expect(parent?.requestedModel).toBe("fast");
    h.store.close();
  });
}

test("a rerouted request with tools the local model lacks is NO_CANDIDATES, never external", async () => {
  const h = await smartRouterHarness({
    localCapabilities: { tools: false, images: true, reasoning: true },
  });
  const res = await h.call("openai", {
    body: {
      messages: [{ role: "user", content: SECRET }],
      tools: [
        {
          type: "function",
          function: { name: "lookup", parameters: { type: "object", properties: {} } },
        },
      ],
    },
  });
  expect(res.status).toBe(503);
  expect(
    (JSON.parse(await res.text()) as { error: { code?: unknown; type?: unknown } }).error,
  ).toBeDefined();
  expect((await rowOf(h, "req_1"))?.errorCode).toBe("NO_CANDIDATES");
  expect(h.externalCalls).toHaveLength(0);
  expect(h.localCalls).toHaveLength(0);
  h.store.close();
});

for (const [name, opts] of [
  ["the global switch off, key flag on", { settings: { smartRouterEnabled: false } }],
  ["the key flag off, global switch on", { smartRouting: false }],
] as const) {
  test(`${name}: no classifier call, no tag, no header`, async () => {
    const h = await smartRouterHarness({ ...opts, classifier: "hang" });
    for (const surface of SURFACES) {
      const res = await h.call(surface, { body: bodyWith(surface, SECRET) });
      expect(res.status).toBe(200);
      expect(res.headers.get("x-omni-route")).toBeNull();
      const streamed = await h.call(surface, { stream: true, body: bodyWith(surface, SECRET) });
      expect(await streamed.text()).toContain("Hi");
    }
    expect(h.classifierCalls).toHaveLength(0);
    expect(h.externalCalls).toHaveLength(6);
    for (const row of await h.store.usage.recent(50))
      expect(row.degradations.some((d) => d.startsWith("smart-router:"))).toBe(false);
    h.store.close();
  });
}

test("a request for the local model itself is not judged, even with the classifier hanging", async () => {
  const h = await smartRouterHarness({ classifier: "hang" });
  const res = await h.call("anthropic", {
    body: { model: "local-llm", ...bodyWith("anthropic", SECRET) },
  });
  const text = await res.text();
  expect(res.status).toBe(200);
  expect(res.headers.get("x-omni-route")).toBe("local");
  expect(JSON.parse(text).model).toBe("llama3:8b");
  expect(h.classifierCalls).toHaveLength(0);
  expect(h.localCalls).toHaveLength(1);
  expect(h.externalCalls).toHaveLength(0);
  const parent = await rowOf(h, "req_1");
  expect(parent?.degradations).toContain("smart-router:already-local");
  expect(parent?.requestedModel).toBe("local-llm");
  h.store.close();
});

for (const [where, body] of [
  [
    "an earlier user message",
    {
      messages: [
        { role: "user", content: SECRET },
        { role: "assistant", content: "noted" },
        { role: "user", content: "now summarise the weather" },
      ],
    },
  ],
  [
    "an assistant message",
    {
      messages: [
        { role: "user", content: "what is it?" },
        { role: "assistant", content: SECRET },
        { role: "user", content: "thanks" },
      ],
    },
  ],
  [
    "a tool result",
    {
      messages: [
        { role: "user", content: "read the env file" },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "t1", name: "read", input: { path: ".env" } }],
        },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: SECRET }] },
      ],
    },
  ],
  [
    "a tool-call input",
    {
      messages: [
        { role: "user", content: "save it" },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "t1", name: "write", input: { text: SECRET } }],
        },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
      ],
    },
  ],
] as const) {
  test(`a secret in ${where} goes local`, async () => {
    const h = await smartRouterHarness();
    const res = await h.call("anthropic", { body });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-omni-route")).toBe("local");
    expect(h.externalCalls).toHaveLength(0);
    expect(h.localCalls).toHaveLength(1);
    h.store.close();
  });
}

/**
 * Text inside Anthropic-native blocks is judged too. Such a block pins routing
 * to Anthropic, which the local model is not, so the local leg has no candidate
 * and the request is refused — never sent external.
 */
for (const [where, body] of [
  [
    "a tool result's search_result block",
    {
      messages: [
        { role: "user", content: "search the wiki" },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "t1", name: "search", input: { q: "db" } }],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "t1",
              content: [
                {
                  type: "search_result",
                  source: "https://wiki.example.com/db",
                  title: "Database",
                  content: [{ type: "text", text: SECRET }],
                },
              ],
            },
          ],
        },
      ],
    },
  ],
  [
    "a text document block",
    {
      messages: [
        {
          role: "user",
          content: [
            {
              type: "document",
              source: { type: "text", media_type: "text/plain", data: SECRET },
              citations: { enabled: true },
            },
            { type: "text", text: "summarise this" },
          ],
        },
      ],
    },
  ],
] as const) {
  test(`a secret only in ${where} is judged local and never sent external`, async () => {
    const h = await smartRouterHarness();
    const res = await h.call("anthropic", { body });
    expect(res.status).toBe(503);
    expect(h.classifierCalls.length).toBeGreaterThan(0);
    expect(h.externalCalls).toHaveLength(0);
    const parent = await rowOf(h, "req_1");
    expect(parent?.degradations).toContain("smart-router:local");
    expect(parent?.errorCode).toBe("NO_CANDIDATES");
    h.store.close();
  });
}

test("an identical second request is answered from the cache", async () => {
  const h = await smartRouterHarness();
  expect((await h.call("openai", { body: bodyWith("openai", SECRET) })).status).toBe(200);
  const first = h.classifierCalls.length;
  expect(first).toBeGreaterThan(0);
  expect((await h.call("openai", { body: bodyWith("openai", SECRET) })).status).toBe(200);
  expect(h.classifierCalls).toHaveLength(first);
  expect(h.localCalls).toHaveLength(2);
  expect(h.externalCalls).toHaveLength(0);
  h.store.close();
});

test("confidential with a guardrail policy is judged by the local classifier, never `judge`", async () => {
  const h = await smartRouterHarness({ policy: "Only software engineering work." });
  const res = await h.call("anthropic", { body: bodyWith("anthropic", SECRET) });
  expect(res.status).toBe(200);
  expect(res.headers.get("x-omni-route")).toBe("local");
  expect(h.judgeCalls).toHaveLength(0);
  expect(h.localGuardrailCalls).toHaveLength(1);
  expect(h.localGuardrailCalls[0]?.request.system).toEqual([
    { type: "text", text: CLASSIFIER_INSTRUCTION },
  ]);
  expect(h.externalCalls).toHaveLength(0);
  const parent = await rowOf(h, "req_1");
  expect(parent?.degradations).toEqual(["smart-router:local", "guardrail:allowed"]);
  h.store.close();
});

test("public with a guardrail policy is judged by `judge` as today", async () => {
  const h = await smartRouterHarness({ policy: "Only software engineering work." });
  const res = await h.call("anthropic");
  expect(res.status).toBe(200);
  expect(res.headers.get("x-omni-route")).toBe("external");
  expect(h.judgeCalls).toHaveLength(1);
  expect(h.localGuardrailCalls).toHaveLength(0);
  expect(h.externalCalls).toHaveLength(1);
  const parent = await rowOf(h, "req_1");
  expect(parent?.degradations).toEqual(["smart-router:public", "guardrail:allowed"]);
  h.store.close();
});

test("a public request with a policy and no guardrail model refuses as guardrail-unconfigured", async () => {
  const h = await smartRouterHarness({
    policy: "Only software engineering work.",
    settings: { guardrailModel: null },
  });
  const res = await h.call("anthropic");
  expect(res.status).toBe(500);
  expect(h.externalCalls).toHaveLength(0);
  expect((await rowOf(h, "req_1"))?.degradations).toEqual([
    "smart-router:public",
    "guardrail:unconfigured",
  ]);
  h.store.close();
});

test("classifier requests carry no ponytail or RTK and go through the bare transport", async () => {
  // A file-backed store, so body capture writes beside it and not into the
  // working directory.
  const root = join(tmpdir(), `omni-smart-router-bodies-${crypto.randomUUID()}`);
  await mkdir(root, { recursive: true });
  const store = await createStore({
    path: join(root, "omnigateway.db"),
    encryptionKey: await deriveKey("test-encryption-key-0123456789"),
  });
  const h = await smartRouterHarness({
    store,
    settings: { ponytailMode: "full", rtkEnabled: true, bodyLoggingEnabled: true },
    deps: { bodyLoggingAllowed: true },
  });
  const repeated = [
    "bun test v1.4.0",
    ...Array.from({ length: 600 }, () => "case passed"),
    "600 pass",
    "0 fail",
  ].join("\n");
  const res = await h.call("anthropic", {
    body: {
      messages: [
        { role: "user", content: "run the tests" },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "t1", name: "bash", input: { cmd: "bun test" } }],
        },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: repeated }] },
      ],
    },
  });
  expect(res.status).toBe(200);
  // Both transforms really are on: the real target's request carries them.
  expect(JSON.stringify(h.externalCalls[0]?.request.system)).toContain(
    "You are a lazy senior developer.",
  );
  expect(unwatched(h.externalCalls[0]?.http ?? transport)).not.toBe(transport);
  expect(h.classifierCalls.length).toBeGreaterThan(0);
  for (const call of h.classifierCalls) {
    expect(call.request.system).toEqual([{ type: "text", text: CONFIDENTIALITY_INSTRUCTION }]);
    expect(JSON.stringify(call.request)).not.toContain("lazy senior developer");
    expect(unwatched(call.http)).toBe(transport);
  }
  // RTK would have collapsed the repeated lines before the classifier saw them.
  expect(h.classifierCalls.map(sentText).join("\n")).toContain("case passed\ncase passed");
  h.store.close();
  await rm(root, { recursive: true, force: true });
});

for (const stream of [false, true]) {
  test(`client cancellation during the check is a 499 (${stream ? "streaming" : "non-streaming"})`, async () => {
    const h = await smartRouterHarness({
      classifier: "hang",
      settings: { smartRouterTimeoutMs: 60_000 },
    });
    const controller = new AbortController();
    const called = h.classifierCalled();
    const pending = h.call("anthropic", { stream, signal: controller.signal });
    if (stream) {
      const res = await pending;
      const reader = res.body?.getReader();
      const read = reader?.read().catch(() => undefined);
      await called;
      controller.abort();
      await read;
      await reader?.cancel().catch(() => undefined);
    } else {
      await called;
      controller.abort();
      await pending;
    }
    for (let i = 0; i < 50 && h.emitted.length < 2; i++) await Bun.sleep(5);
    const parent = await rowOf(h, "req_1");
    expect(parent?.status).toBe(499);
    expect(parent?.errorCode).toBe("interrupted");
    expect(h.externalCalls).toHaveLength(0);
    expect(h.localCalls).toHaveLength(0);
    expect(h.logger.records.some((e) => e.msg === "request rejected")).toBe(false);
    h.store.close();
  });
}

for (const stream of [false, true]) {
  test(`a screen that throws refuses as smart-router unavailable (${stream ? "streaming" : "non-streaming"})`, async () => {
    let reads = 0;
    const h = await smartRouterHarness({
      deps: {
        snapshots: {
          get: async () => {
            reads++;
            // The route's own read decides the request is screened; the
            // check's read throws.
            if (reads === 2) throw new Error("LEAKED-STORE-TEXT");
            return buildSnapshot(h.store, 1_000_000);
          },
        },
      },
    });
    const res = await h.call("anthropic", { stream });
    const text = await res.text();
    if (stream) {
      expect(streamError("anthropic", text)).toEqual(
        expectedStreamError("anthropic", "UPSTREAM", UNAVAILABLE_MESSAGE),
      );
    } else {
      expect(res.status).toBe(502);
      expect(JSON.parse(text)).toEqual(errorBody("anthropic", "UPSTREAM", UNAVAILABLE_MESSAGE));
    }
    expect(h.externalCalls).toHaveLength(0);
    expect(h.localCalls).toHaveLength(0);
    expect((await rowOf(h, "req_1"))?.degradations).toEqual(["smart-router:unavailable"]);
    const warned = h.logger.records.find((e) => e.msg === "confidentiality check failed");
    expect(warned?.fields).toEqual({ requestId: "req_1", reason: "confidentiality check threw" });
    for (const line of h.logger.lines) expect(line).not.toContain("LEAKED-STORE-TEXT");
    h.store.close();
  });
}

/**
 * The guardrail on a request going local uses the classifier the check
 * validated, not a value read from an earlier snapshot. Here the route's own
 * read (the first) names the external `judge` as the smart-router classifier;
 * every later read, the check's included, names the local one.
 */
test("the guardrail on a confidential request uses the classifier the check validated", async () => {
  let reads = 0;
  const h = await smartRouterHarness({
    policy: "Only software engineering work.",
    deps: {
      snapshots: {
        get: async () => {
          reads++;
          const snapshot = await buildSnapshot(h.store, 1_000_000);
          if (reads !== 1) return snapshot;
          return {
            ...snapshot,
            settings: { ...snapshot.settings, smartRouterClassifierModel: "judge" },
          };
        },
      },
    },
  });
  const res = await h.call("anthropic", { body: bodyWith("anthropic", SECRET) });
  expect(res.status).toBe(200);
  expect(h.judgeCalls).toHaveLength(0);
  expect(h.localGuardrailCalls).toHaveLength(1);
  expect(h.externalCalls).toHaveLength(0);
  expect(h.localCalls).toHaveLength(1);
  h.store.close();
});

/**
 * The local model is re-checked at send time. The check sees an all-`custom`
 * `local-llm`; by the time the rerouted request is dispatched it has gained an
 * external target. Dispatch refuses it rather than routing it.
 */
for (const stream of [false, true]) {
  test(`a local model that gained an external target after the check is refused (${stream ? "streaming" : "non-streaming"})`, async () => {
    const h = await smartRouterHarness({
      deps: {
        snapshots: {
          get: async () => {
            const snapshot = await buildSnapshot(h.store, 1_000_000);
            // Once classification has happened, `local-llm` is the mixed pool.
            const mixed = snapshot.models.get("mixed");
            if (h.classifierCalls.length === 0 || mixed === undefined) return snapshot;
            const models = new Map(snapshot.models);
            models.set("local-llm", { ...mixed, id: "local-llm" });
            return { ...snapshot, models };
          },
        },
      },
    });
    const res = await h.call("anthropic", { stream, body: bodyWith("anthropic", SECRET) });
    const text = await res.text();
    if (stream) {
      expect(res.status).toBe(200);
      expect(streamError("anthropic", text)).toEqual(
        expectedStreamError("anthropic", "INTERNAL", UNCONFIGURED_MESSAGE),
      );
    } else {
      expect(res.status).toBe(500);
      expect(JSON.parse(text)).toEqual(errorBody("anthropic", "INTERNAL", UNCONFIGURED_MESSAGE));
      expect(res.headers.get("x-omni-route")).toBeNull();
    }
    expect(h.classifierCalls.length).toBeGreaterThan(0);
    expect(h.externalCalls).toHaveLength(0);
    expect(h.localCalls).toHaveLength(0);
    for (let i = 0; i < 50 && h.emitted.length < 2; i++) await Bun.sleep(5);
    const parent = await rowOf(h, "req_1");
    expect(parent?.errorCode).toBe("INTERNAL");
    expect(parent?.requestedModel).toBe("fast");
    expect(parent?.degradations).toContain("smart-router:local");
    h.store.close();
  });
}

test("an unknown model is still checked: public fails NO_CANDIDATES, confidential goes local", async () => {
  const h = await smartRouterHarness();
  const pub = await h.call("openai", { body: { model: "nope" } });
  expect(pub.status).toBe(503);
  expect((await rowOf(h, "req_1"))?.errorCode).toBe("NO_CANDIDATES");
  expect(h.classifierCalls.length).toBeGreaterThan(0);
  expect(h.externalCalls).toHaveLength(0);
  expect(h.localCalls).toHaveLength(0);

  const secret = await h.call("openai", { body: { model: "nope", ...bodyWith("openai", SECRET) } });
  expect(secret.status).toBe(200);
  expect(secret.headers.get("x-omni-route")).toBe("local");
  expect(h.localCalls).toHaveLength(1);
  expect(h.externalCalls).toHaveLength(0);
  h.store.close();
});

/** More than `MAX_UNCACHED_SEGMENTS` messages, each too long to share a segment. */
function oversize(): Record<string, unknown> {
  return {
    messages: Array.from({ length: 65 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `message-${i} ${"x".repeat(5_000)}`,
    })),
  };
}

test("an oversize request goes local unasked, tagged oversize", async () => {
  const h = await smartRouterHarness({ classifier: "hang" });
  const res = await h.call("anthropic", { body: oversize() });
  expect(res.status).toBe(200);
  expect(res.headers.get("x-omni-route")).toBe("local");
  expect(h.classifierCalls).toHaveLength(0);
  expect(h.localCalls).toHaveLength(1);
  expect(h.externalCalls).toHaveLength(0);
  expect((await rowOf(h, "req_1"))?.degradations).toEqual([
    "smart-router:local",
    "smart-router:oversize",
  ]);
  h.store.close();
});

test("an oversize request with a guardrail policy is judged by the local classifier", async () => {
  const h = await smartRouterHarness({ classifier: "hang", policy: "Only software engineering." });
  const res = await h.call("anthropic", { body: oversize() });
  expect(res.status).toBe(200);
  expect(h.judgeCalls).toHaveLength(0);
  expect(h.localGuardrailCalls).toHaveLength(1);
  expect(h.externalCalls).toHaveLength(0);
  expect(h.localCalls).toHaveLength(1);
  const degradations = (await rowOf(h, "req_1"))?.degradations ?? [];
  expect(degradations).toContain("smart-router:oversize");
  expect(degradations).toContain("guardrail:allowed");
  h.store.close();
});

/**
 * A snapshot source where `local-judge` turns into the mixed pool once `turn`
 * says so: the check validated it as local-only, and it gains an external
 * target before a later classifier dispatch reads its own snapshot.
 */
function judgeTurnsMixed(h: () => Harness, turn: () => boolean) {
  return {
    get: async () => {
      const snapshot = await buildSnapshot(h().store, 1_000_000);
      const mixed = snapshot.models.get("mixed");
      if (!turn() || mixed === undefined) return snapshot;
      const models = new Map(snapshot.models);
      models.set("local-judge", { ...mixed, id: "local-judge" });
      return { ...snapshot, models };
    },
  };
}

test("a classifier call re-checks its model at send time and refuses rather than leak", async () => {
  let reads = 0;
  const h: Harness = await smartRouterHarness({
    deps: {
      // Reads 1 and 2 are the route's and the check's; from the third — the
      // classifier call's own dispatch — `local-judge` is mixed.
      snapshots: judgeTurnsMixed(
        () => h,
        () => ++reads > 2,
      ),
    },
  });
  const res = await h.call("anthropic", { body: bodyWith("anthropic", SECRET) });
  expect(res.status).toBe(502);
  expect(JSON.parse(await res.text())).toEqual(
    errorBody("anthropic", "UPSTREAM", UNAVAILABLE_MESSAGE),
  );
  expect(h.classifierCalls).toHaveLength(0);
  expect(h.localCalls).toHaveLength(0);
  expect(h.externalCalls).toHaveLength(0);
  h.store.close();
});

test("the guardrail's local classifier call re-checks its model at send time", async () => {
  const h: Harness = await smartRouterHarness({
    policy: "Only software engineering work.",
    deps: {
      // After classification, `local-judge` is mixed for the guardrail call.
      snapshots: judgeTurnsMixed(
        () => h,
        () => h.classifierCalls.length > 0,
      ),
    },
  });
  const res = await h.call("anthropic", { body: bodyWith("anthropic", SECRET) });
  expect(res.status).toBe(502);
  expect(h.classifierCalls.length).toBeGreaterThan(0);
  expect(h.localGuardrailCalls).toHaveLength(0);
  expect(h.judgeCalls).toHaveLength(0);
  expect(h.localCalls).toHaveLength(0);
  expect(h.externalCalls).toHaveLength(0);
  expect((await rowOf(h, "req_1"))?.degradations).toEqual([
    "smart-router:local",
    "guardrail:unavailable",
  ]);
  h.store.close();
});

/**
 * An already-local request is dispatched unclassified, so it too is re-checked
 * at send time: the check sees an all-`custom` `local-llm`, dispatch sees it
 * with an external target, and refuses rather than send unjudged text out.
 */
for (const stream of [false, true]) {
  test(`an already-local model that gained an external target after the check is refused (${stream ? "streaming" : "non-streaming"})`, async () => {
    let reads = 0;
    const h: Harness = await smartRouterHarness({
      classifier: "hang",
      deps: {
        snapshots: {
          get: async () => {
            const snapshot = await buildSnapshot(h.store, 1_000_000);
            // Reads 1 and 2 are the route's and the check's; dispatch's is third.
            const mixed = snapshot.models.get("mixed");
            if (++reads <= 2 || mixed === undefined) return snapshot;
            const models = new Map(snapshot.models);
            models.set("local-llm", { ...mixed, id: "local-llm" });
            return { ...snapshot, models };
          },
        },
      },
    });
    const res = await h.call("anthropic", {
      stream,
      body: { model: "local-llm", ...bodyWith("anthropic", SECRET) },
    });
    const text = await res.text();
    if (stream) {
      expect(res.status).toBe(200);
      expect(streamError("anthropic", text)).toEqual(
        expectedStreamError("anthropic", "INTERNAL", UNCONFIGURED_MESSAGE),
      );
    } else {
      expect(res.status).toBe(500);
      expect(JSON.parse(text)).toEqual(errorBody("anthropic", "INTERNAL", UNCONFIGURED_MESSAGE));
      expect(res.headers.get("x-omni-route")).toBeNull();
    }
    expect(h.classifierCalls).toHaveLength(0);
    expect(h.externalCalls).toHaveLength(0);
    expect(h.localCalls).toHaveLength(0);
    for (let i = 0; i < 50 && h.emitted.length < 1; i++) await Bun.sleep(5);
    const parent = await rowOf(h, "req_1");
    expect(parent?.errorCode).toBe("INTERNAL");
    expect(parent?.degradations).toContain("smart-router:already-local");
    h.store.close();
  });
}

/** Guardrail only (no smart routing): a screen that throws keeps the guardrail's own warning. */
test("a guardrail-only screen that throws warns with the usage policy reason", async () => {
  let reads = 0;
  const h: Harness = await smartRouterHarness({
    smartRouting: false,
    policy: "Only software engineering work.",
    deps: {
      snapshots: {
        get: async () => {
          // Prompt capture precedes the guardrail's own settings read.
          if (++reads === 2) throw new Error("LEAKED-STORE-TEXT");
          return buildSnapshot(h.store, 1_000_000);
        },
      },
    },
  });
  const res = await h.call("anthropic");
  expect(res.status).toBe(502);
  expect(h.externalCalls).toHaveLength(0);
  expect((await rowOf(h, "req_1"))?.degradations).toEqual(["guardrail:unavailable"]);
  const warned = h.logger.records.filter((e) => e.msg === "usage policy check failed");
  expect(warned.map((e) => e.fields)).toEqual([
    { requestId: "req_1", reason: "usage policy check threw" },
  ]);
  for (const line of h.logger.lines) expect(line).not.toContain("LEAKED-STORE-TEXT");
  h.store.close();
});

test("the smart-router check row carries the parent's trace", async () => {
  const h = await smartRouterHarness();
  const res = await h.call("openai", {
    body: bodyWith("openai", SECRET),
    headers: { "x-omni-session-id": "job-7", "x-omni-metadata": "owner:ops" },
  });
  expect(res.status).toBe(200);
  const rows = await h.store.usage.recent(50);
  const check = rows.find((r) => r.degradations.includes("smart-router:classifier"));
  expect(check).toMatchObject({ sessionId: "job-7", traceMetadata: { owner: "ops" } });
  expect(await rowOf(h, "req_1")).toMatchObject({ sessionId: "job-7" });
  h.store.close();
});

import { expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryCoord } from "@omni/coord";
import { type ErrorCode, GatewayError, type StreamEvent } from "@omni/ir";
import type { LimitConfig } from "@omni/ratelimit/catalog";
import type { RequestLog } from "@omni/store";
import { createStore, deriveKey } from "@omni/store";
import { health, memoryStore, seedCredential, target, virtualModel } from "@omni/testkit";
import { ApiKeyRateLimiter, modelSubjectId, RateLimitExceeded } from "../../src/auth/rateLimit.ts";
import { createRoutingSnapshotCache } from "../../src/dispatch/snapshotCache.ts";
import { unwatched } from "../../src/dispatch/upstreamRequestId.ts";
import { anthropicErrorBody } from "../../src/egress/anthropic.ts";
import { openaiErrorBody } from "../../src/egress/openai.ts";
import { responsesErrorBody } from "../../src/egress/responses.ts";
import { CLASSIFIER_INSTRUCTION } from "../../src/guardrail/classifier.ts";
import {
  REFUSED_MESSAGE,
  UNAVAILABLE_MESSAGE,
  UNCONFIGURED_MESSAGE,
} from "../../src/guardrail/judge.ts";
import {
  ALLOW,
  type Classifier,
  classifierText,
  DENY,
  frames,
  guardrailHarness,
  type Harness,
  SURFACES,
  type Surface,
  textEvents,
  transport,
} from "./harness.ts";

/**
 * The guardrail at the route boundary, on every surface, both response kinds.
 *
 * **Fail closed** is the rule this file pins: only an unambiguous allow from
 * the classifier reaches the real target. A deny, a timeout, an adapter error,
 * an unreadable reply and an unset classifier model each refuse — with fixed,
 * gateway-authored messages and three codes an operator can tell apart — and
 * the real target is never dispatched.
 */

const errorBody = (surface: Surface, code: ErrorCode, message: string): unknown =>
  surface === "anthropic"
    ? anthropicErrorBody(code, message)
    : surface === "responses"
      ? responsesErrorBody(code, message)
      : openaiErrorBody(code, message);

/** The error a stream carried, in the shape its surface renders it. */
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

/** The streamed rendering of a refusal, derived from the same error body as non-streaming. */
function expectedStreamError(surface: Surface, code: ErrorCode, message: string): unknown {
  const body = errorBody(surface, code, message) as { error: Record<string, unknown> };
  if (surface === "responses") return { code: body.error.code, message };
  return body;
}

async function rowOf(h: Harness, id: string): Promise<RequestLog | undefined> {
  return (await h.store.usage.recent(50)).find((row) => row.id === id);
}

type Case = {
  name: string;
  classifier: Classifier;
  unconfigured?: boolean;
  status: number;
  code: ErrorCode | null;
  message: string | null;
  note: string;
  /** Whether a classifier call was made, and so a classifier row written. */
  classified: boolean;
};

const CASES: Case[] = [
  {
    name: "allow",
    classifier: ALLOW,
    status: 200,
    code: null,
    message: null,
    note: "guardrail:allowed",
    classified: true,
  },
  {
    name: "deny",
    classifier: DENY,
    status: 400,
    code: "CONTENT_FILTER",
    message: REFUSED_MESSAGE,
    note: "guardrail:denied",
    classified: true,
  },
  {
    name: "timeout",
    classifier: { kind: "hang" },
    status: 502,
    code: "UPSTREAM",
    message: UNAVAILABLE_MESSAGE,
    note: "guardrail:unavailable",
    classified: true,
  },
  {
    name: "adapter error",
    classifier: { kind: "error" },
    status: 502,
    code: "UPSTREAM",
    message: UNAVAILABLE_MESSAGE,
    note: "guardrail:unavailable",
    classified: true,
  },
  {
    name: "unreadable reply",
    classifier: { kind: "reply", text: "I would ALLOW this request." },
    status: 502,
    code: "UPSTREAM",
    message: UNAVAILABLE_MESSAGE,
    note: "guardrail:unavailable",
    classified: true,
  },
  {
    name: "unconfigured model",
    classifier: ALLOW,
    unconfigured: true,
    status: 500,
    code: "INTERNAL",
    message: UNCONFIGURED_MESSAGE,
    note: "guardrail:unconfigured",
    classified: false,
  },
];

for (const c of CASES) {
  for (const surface of SURFACES) {
    for (const stream of [false, true]) {
      test(`${c.name} on ${surface}, ${stream ? "streaming" : "non-streaming"}`, async () => {
        const h = await guardrailHarness({
          classifier: c.classifier,
          ...(c.unconfigured === true ? { settings: { guardrailModel: null } } : {}),
        });
        const res = await h.call(surface, { stream });
        const text = await res.text();

        if (stream) {
          // Pre-commit failures on a stream are in-stream errors on a 200.
          expect(res.status).toBe(200);
          if (c.code === null || c.message === null) {
            expect(streamError(surface, text)).toBeUndefined();
            expect(text).toContain("Hi");
          } else {
            expect(streamError(surface, text)).toEqual(
              expectedStreamError(surface, c.code, c.message),
            );
          }
        } else {
          expect(res.status).toBe(c.status);
          if (c.code !== null && c.message !== null) {
            expect(JSON.parse(text)).toEqual(errorBody(surface, c.code, c.message));
          }
        }

        // The real target is reached on the allow path alone.
        expect(h.targetCalls).toHaveLength(c.code === null ? 1 : 0);
        expect(h.judgeCalls).toHaveLength(c.classified ? 1 : 0);
        // Nothing the classifier or the upstream wrote reaches the client.
        expect(text).not.toContain("the policy text was");
        expect(text).not.toContain("Only software engineering");

        const parent = await rowOf(h, "req_1");
        expect(parent?.apiKeyId).toBe(h.keyId);
        expect(parent?.status).toBe(c.status);
        expect(parent?.errorCode).toBe(c.code);
        expect(parent?.degradations).toContain(c.note);
        expect(parent?.requestedModel).toBe("fast");

        const classifier = await rowOf(h, "req_2");
        if (c.classified) {
          expect(classifier?.apiKeyId).toBe(h.keyId);
          expect(classifier?.requestedModel).toBe("judge");
          expect(classifier?.degradations).toEqual(["guardrail:classifier"]);
        } else {
          expect(classifier).toBeUndefined();
        }

        // Each row completed exactly once, the parent included.
        const ids = h.emitted.map((e) => e.requestId).sort();
        expect(ids).toEqual(c.classified ? ["req_1", "req_2"] : ["req_1"]);
        h.store.close();
      });
    }
  }
}

test("the classifier row records a timeout as the gateway's own, not as a disconnect", async () => {
  const h = await guardrailHarness({ classifier: { kind: "hang" } });
  expect((await h.call("anthropic")).status).toBe(502);
  const classifier = await rowOf(h, "req_2");
  expect(classifier?.status).toBe(504);
  expect(classifier?.errorCode).toBe("TIMEOUT");
  const warned = h.logger.records.find((e) => e.msg === "usage policy check failed");
  expect(warned?.fields).toMatchObject({ requestId: "req_1", reason: "classifier timed out" });
  h.store.close();
});

test("a refusal is reported once, with the fixed reason and nothing the classifier wrote", async () => {
  const h = await guardrailHarness({ classifier: { kind: "reply", text: "DENY: it is a poem" } });
  expect((await h.call("openai")).status).toBe(502);
  const rejected = h.logger.records.filter(
    (e) => e.msg === "request rejected" && e.fields.requestId === "req_1",
  );
  expect(rejected).toHaveLength(1);
  expect(rejected[0]?.fields).toMatchObject({ code: "UPSTREAM", reason: UNAVAILABLE_MESSAGE });
  for (const line of h.logger.lines) {
    expect(line).not.toContain("poem");
    expect(line).not.toContain("Only software engineering");
    expect(line).not.toContain("review this function");
  }
  h.store.close();
});

test("a key without a policy makes no classifier call and records no guardrail note", async () => {
  const h = await guardrailHarness({ policy: null, classifier: DENY });
  for (const surface of SURFACES) {
    expect((await h.call(surface)).status).toBe(200);
    const streamed = await h.call(surface, { stream: true });
    expect(streamed.status).toBe(200);
    expect(await streamed.text()).toContain("Hi");
  }
  expect(h.judgeCalls).toHaveLength(0);
  expect(h.targetCalls).toHaveLength(6);
  const rows = await h.store.usage.recent(50);
  expect(rows).toHaveLength(6);
  for (const row of rows)
    expect(row.degradations.some((d) => d.startsWith("guardrail:"))).toBe(false);
  h.store.close();
});

test("a key without a policy is served even with no classifier configured", async () => {
  const h = await guardrailHarness({ policy: null, settings: { guardrailModel: null } });
  expect((await h.call("anthropic")).status).toBe(200);
  expect(h.judgeCalls).toHaveLength(0);
  h.store.close();
});

/**
 * With a one-turn window, the request-level system prompt, the last message a
 * human wrote and the text of the tool results after it are judged. A user turn
 * carrying any tool result is a tool turn — even with text an agent client
 * injected beside it: it is not a human message, so that text is never sent —
 * but the result's own text is. Images never reach the classifier.
 */
test("a tool-result final turn judges the human text and the tool text, never images", async () => {
  const h = await guardrailHarness({ settings: { guardrailHistoryTurns: 1 } });
  const png =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
  const res = await h.call("anthropic", {
    body: {
      system: "AGENT-SYSTEM-PROMPT",
      messages: [
        { role: "user", content: "an older human message" },
        { role: "assistant", content: "ok" },
        {
          role: "user",
          content: [
            { type: "text", text: "please review my parser" },
            { type: "image", source: { type: "base64", media_type: "image/png", data: png } },
          ],
        },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "t1", name: "bash", input: { cmd: "cat x" } }],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "t1", content: "SECRET-TOOL-OUTPUT" },
            { type: "text", text: "INJECTED-REMINDER" },
          ],
        },
      ],
    },
  });
  expect(res.status).toBe(200);

  const sent = h.judgeCalls[0];
  if (sent === undefined) throw new Error("the classifier was not called");
  const text = classifierText(sent);
  expect(text).toContain("please review my parser");
  expect(text).toContain("AGENT-SYSTEM-PROMPT");
  expect(text).not.toContain("an older human message");
  expect(text).toContain('<tool_results>\n<result n="1">\nSECRET-TOOL-OUTPUT\n</result>');
  expect(text).not.toContain("INJECTED-REMINDER");
  expect(JSON.stringify(sent.request)).not.toContain(png);
  // Exactly the gateway's instruction and one text turn: no image, no tool block.
  expect(sent.request.system).toEqual([{ type: "text", text: CLASSIFIER_INSTRUCTION }]);
  expect(sent.request.messages).toHaveLength(1);
  expect(sent.request.messages[0]?.content.map((b) => b.type)).toEqual(["text"]);
  expect(sent.request.tools).toBeUndefined();
  h.store.close();
});

test("a tool result in the window reaches the classifier", async () => {
  const h = await guardrailHarness();
  const res = await h.call("anthropic", {
    body: {
      messages: [
        { role: "user", content: "summarise that page" },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "t1", name: "fetch", input: { url: "u" } }],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "t1", content: "SECRET-OUTPUT" }],
        },
      ],
    },
  });
  expect(res.status).toBe(200);
  const sent = h.judgeCalls[0];
  if (sent === undefined) throw new Error("the classifier was not called");
  expect(classifierText(sent)).toContain("SECRET-OUTPUT");
  h.store.close();
});

/** The accepted cost of judging tool output: an agent pays a classifier call per tool turn. */
test("a new tool turn under the same human message is a new classifier call", async () => {
  const h = await guardrailHarness();
  const first = [
    { role: "user", content: "run the build" },
    {
      role: "assistant",
      content: [{ type: "tool_use", id: "t1", name: "bash", input: { cmd: "make" } }],
    },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "built" }] },
  ];
  expect((await h.call("anthropic", { body: { messages: first } })).status).toBe(200);
  expect(h.judgeCalls).toHaveLength(1);
  // The very same request is still a hit.
  expect((await h.call("anthropic", { body: { messages: first } })).status).toBe(200);
  expect(h.judgeCalls).toHaveLength(1);
  const next = [
    ...first,
    {
      role: "assistant",
      content: [{ type: "tool_use", id: "t2", name: "bash", input: { cmd: "test" } }],
    },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t2", content: "passed" }] },
  ];
  expect((await h.call("anthropic", { body: { messages: next } })).status).toBe(200);
  expect(h.judgeCalls).toHaveLength(2);
  h.store.close();
});

/**
 * Codex's shell turn: `local_shell_call_output` becomes a user turn holding a
 * single native block, no text and no tool result. The walk goes past it to
 * what the human wrote; stopping there judged "" — and cached the verdict.
 */
test("a Responses local shell output turn judges the human's message, not an empty string", async () => {
  const h = await guardrailHarness();
  await h.call("responses", {
    body: {
      input: [
        { type: "message", role: "user", content: "review my parser please" },
        {
          type: "local_shell_call",
          id: "ls_1",
          call_id: "c1",
          status: "completed",
          action: { type: "exec", command: ["cat", "parser.ts"] },
        },
        { type: "local_shell_call_output", id: "lso_1", call_id: "c1", output: "SHELL-OUTPUT" },
      ],
    },
  });
  const sent = h.judgeCalls[0];
  if (sent === undefined) throw new Error("the classifier was not called");
  const text = classifierText(sent);
  expect(text).toContain("<request>\nreview my parser please\n</request>");
  expect(text).not.toContain("SHELL-OUTPUT");
  h.store.close();
});

/**
 * The Anthropic surface's own native tool output, `mcp_tool_result`, is legal
 * in a user turn and arrives there alone the same way.
 */
test("an Anthropic mcp_tool_result-only turn judges the human's message", async () => {
  const h = await guardrailHarness();
  await h.call("anthropic", {
    body: {
      messages: [
        { role: "user", content: "review my parser please" },
        {
          role: "assistant",
          content: [{ type: "mcp_tool_use", id: "m1", name: "read", server_name: "fs", input: {} }],
        },
        {
          role: "user",
          content: [{ type: "mcp_tool_result", tool_use_id: "m1", content: "MCP-OUTPUT" }],
        },
      ],
    },
  });
  const sent = h.judgeCalls[0];
  if (sent === undefined) throw new Error("the classifier was not called");
  const text = classifierText(sent);
  expect(text).toContain("<request>\nreview my parser please\n</request>");
  expect(text).not.toContain("MCP-OUTPUT");
  h.store.close();
});

/** An agent conversation: four human messages, tool turns between them. */
const agentConversation = [
  { role: "user", content: "HUMAN-ONE" },
  { role: "assistant", content: "ok" },
  { role: "user", content: "HUMAN-TWO" },
  {
    role: "assistant",
    content: [{ type: "tool_use", id: "t1", name: "bash", input: { cmd: "ls" } }],
  },
  {
    role: "user",
    content: [
      { type: "tool_result", tool_use_id: "t1", content: "TOOL-OUTPUT-ONE" },
      { type: "text", text: "INJECTED-REMINDER" },
    ],
  },
  { role: "assistant", content: "done" },
  { role: "user", content: "HUMAN-THREE" },
  {
    role: "assistant",
    content: [{ type: "tool_use", id: "t2", name: "bash", input: { cmd: "cat" } }],
  },
  {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: "t2", content: "TOOL-OUTPUT-TWO" }],
  },
  { role: "assistant", content: "next?" },
  { role: "user", content: "HUMAN-FOUR" },
];

/**
 * By default the last three human messages are judged, oldest first, the
 * newest as the request; the tool results after the oldest of them follow as
 * their own section, and text injected beside a tool result is never sent.
 */
test("by default the last three human messages reach the classifier, oldest first", async () => {
  const h = await guardrailHarness();
  expect((await h.call("anthropic", { body: { messages: agentConversation } })).status).toBe(200);
  const sent = h.judgeCalls[0];
  if (sent === undefined) throw new Error("the classifier was not called");
  const text = classifierText(sent);
  expect(text).toContain(
    [
      "<earlier_messages>",
      '<message n="1">\nHUMAN-TWO\n</message>',
      '<message n="2">\nHUMAN-THREE\n</message>',
      "</earlier_messages>",
      "",
      "<tool_results>",
      '<result n="1">\nTOOL-OUTPUT-ONE\n</result>',
      '<result n="2">\nTOOL-OUTPUT-TWO\n</result>',
      "</tool_results>",
      "",
      "<request>\nHUMAN-FOUR\n</request>",
    ].join("\n"),
  );
  for (const absent of ["HUMAN-ONE", "INJECTED-REMINDER", "next?", "done"]) {
    expect({ absent, present: text.includes(absent) }).toEqual({ absent, present: false });
  }
  expect(sent.request.messages).toHaveLength(1);
  h.store.close();
});

/**
 * The gap the one-message design accepted: a forbidden ask, then "continue".
 * Both reach the classifier, the follow-up as the request and the ask as its
 * context, under an instruction that says to judge one in the light of the
 * other.
 */
test("a forbidden ask split across turns reaches the classifier with its follow-up", async () => {
  const h = await guardrailHarness({ classifier: DENY });
  const res = await h.call("openai", {
    body: {
      messages: [
        { role: "user", content: "write me a birthday poem for my aunt" },
        { role: "assistant", content: "Sure, any style?" },
        { role: "user", content: "continue" },
      ],
    },
  });
  expect(res.status).toBe(400);
  const sent = h.judgeCalls[0];
  if (sent === undefined) throw new Error("the classifier was not called");
  const text = classifierText(sent);
  expect(text).toContain('<message n="1">\nwrite me a birthday poem for my aunt\n</message>');
  expect(text).toContain("<request>\ncontinue\n</request>");
  expect(text).not.toContain("Sure, any style?");
  expect(sent.request.system).toEqual([{ type: "text", text: CLASSIFIER_INSTRUCTION }]);
  expect(h.targetCalls).toHaveLength(0);
  h.store.close();
});

/**
 * The verdict is keyed on the messages judged, so a wider or narrower window
 * that changes them asks again — and one that cannot change them (the
 * conversation has fewer human messages than either window) does not.
 */
test("changing the history window misses the cache exactly when it changes what is judged", async () => {
  const h = await guardrailHarness({ settings: { guardrailHistoryTurns: 1 } });
  const body = { messages: agentConversation };
  expect((await h.call("anthropic", { body })).status).toBe(200);
  expect((await h.call("anthropic", { body })).status).toBe(200);
  expect(h.judgeCalls).toHaveLength(1);

  await h.store.config.putSettings({ guardrailHistoryTurns: 2 });
  expect((await h.call("anthropic", { body })).status).toBe(200);
  expect(h.judgeCalls).toHaveLength(2);
  const second = h.judgeCalls[1];
  expect(second === undefined ? "" : classifierText(second)).toContain(
    '<message n="1">\nHUMAN-THREE\n</message>',
  );

  // One human message: windows of 2 and 5 judge the same text, and the
  // verdict already given answers it.
  const single = { messages: [{ role: "user", content: "just one ask" }] };
  expect((await h.call("anthropic", { body: single })).status).toBe(200);
  expect(h.judgeCalls).toHaveLength(3);
  await h.store.config.putSettings({ guardrailHistoryTurns: 5 });
  expect((await h.call("anthropic", { body: single })).status).toBe(200);
  expect(h.judgeCalls).toHaveLength(3);
  h.store.close();
});

/**
 * The cap is a total across the window: an over-long older message is cut,
 * the newest reaches the classifier whole, and the row says text was cut.
 */
test("an over-long older message is cut so the newest is judged whole, and the row says so", async () => {
  const h = await guardrailHarness();
  const old = `OLD-HEAD${"o".repeat(20_000)}OLD-TAIL`;
  const res = await h.call("openai", {
    body: {
      messages: [
        { role: "user", content: old },
        { role: "assistant", content: "ok" },
        { role: "user", content: "NEWEST-ASK" },
      ],
    },
  });
  expect(res.status).toBe(200);
  const sent = h.judgeCalls[0];
  if (sent === undefined) throw new Error("the classifier was not called");
  const text = classifierText(sent);
  expect(text).toContain("<request>\nNEWEST-ASK\n</request>");
  expect(text).toContain("OLD-HEAD");
  expect(text).toContain("OLD-TAIL");
  expect(text).toContain("[… truncated …]");
  expect((await rowOf(h, "req_1"))?.degradations).toEqual([
    "guardrail:allowed",
    "guardrail:truncated",
  ]);
  h.store.close();
});

test("the same human message under a different system prompt misses the cache", async () => {
  const h = await guardrailHarness();
  for (const system of ["SYSTEM-A", "SYSTEM-B"])
    expect((await h.call("anthropic", { body: { system } })).status).toBe(200);
  expect(h.judgeCalls).toHaveLength(2);
  const second = h.judgeCalls[1];
  expect(second === undefined ? "" : classifierText(second)).toContain("SYSTEM-B");
  h.store.close();
});

/**
 * The timeout is the gateway's own timer, and a check that finished must clear
 * it: left armed, every judged request holds a timer for the whole timeout and
 * aborts a signal nothing reads any more. Watched through the timer functions
 * themselves, keyed on a timeout value nothing else in the path uses, so the
 * assertion does not depend on how long anything takes.
 */
test("a classifier call that finishes leaves no timeout timer armed", async () => {
  const TIMEOUT_MS = 43_219;
  const h = await guardrailHarness({ settings: { guardrailTimeoutMs: TIMEOUT_MS } });
  const realSet = globalThis.setTimeout;
  const realClear = globalThis.clearTimeout;
  const armed = new Set<unknown>();
  const created: unknown[] = [];
  globalThis.setTimeout = ((handler: () => void, ms?: number) => {
    const timer = realSet(handler, ms);
    if (ms === TIMEOUT_MS) {
      armed.add(timer);
      created.push(timer);
    }
    return timer;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((timer?: Parameters<typeof clearTimeout>[0]) => {
    armed.delete(timer);
    realClear(timer);
  }) as typeof clearTimeout;
  try {
    expect((await h.call("anthropic")).status).toBe(200);
  } finally {
    globalThis.setTimeout = realSet;
    globalThis.clearTimeout = realClear;
  }
  expect(h.judgeCalls).toHaveLength(1);
  // The judge armed exactly one, and cleared it.
  expect(created).toHaveLength(1);
  expect(armed.size).toBe(0);
  h.store.close();
});

/**
 * A classifier model whose provider has no adapter makes dispatch throw
 * `INTERNAL` before anything assigns the row a status. The classifier row still
 * completes with that failure, never as a status-0 row.
 */
test("a classifier dispatch that throws before a status is set records 500 INTERNAL", async () => {
  const h = await guardrailHarness();
  await seedCredential(h.store, { id: "c-orphan", provider: "grok" });
  await h.store.config.putModel(
    virtualModel({ id: "judge-orphan", targets: [target({ provider: "grok", model: "grok-4" })] }),
  );
  await h.store.config.putSettings({ guardrailModel: "judge-orphan" });
  expect((await h.call("anthropic")).status).toBe(502);
  expect(h.targetCalls).toHaveLength(0);
  const classifier = await rowOf(h, "req_2");
  expect(classifier?.status).toBe(500);
  expect(classifier?.errorCode).toBe("INTERNAL");
  expect(classifier?.degradations).toEqual(["guardrail:classifier"]);
  h.store.close();
});

/**
 * A failure thrown out of the classifier's dispatch can carry text the gateway
 * did not write — an upstream's error body, a store's row. The warning names
 * the failure by code and a fixed reason, never by the thrown message.
 */
for (const [name, thrown] of [
  [
    "a provider-bearing error",
    new GatewayError("UPSTREAM", "upstream said: LEAKED-UPSTREAM-TEXT", { provider: "openai" }),
  ],
  ["a plain error", new Error("LEAKED-UPSTREAM-TEXT")],
] as const) {
  test(`the check-failed warning carries no upstream text from ${name}`, async () => {
    // At the default level: debug prints provider-bearing reasons by design.
    const h = await guardrailHarness({ logLevel: "info" });
    await h.store.credentials.updateHealth("c-judge", "gpt-judge", () =>
      health({ credentialId: "c-judge", model: "gpt-judge", consecutiveFailures: 1 }),
    );
    h.store.credentials.updateHealth = async () => {
      throw thrown;
    };
    expect((await h.call("anthropic")).status).toBe(502);
    const warned = h.logger.records.find((e) => e.msg === "usage policy check failed");
    expect(warned?.fields).toMatchObject({ requestId: "req_1", model: "judge" });
    expect(typeof warned?.fields.reason).toBe("string");
    for (const line of h.logger.lines) expect(line).not.toContain("LEAKED-UPSTREAM-TEXT");
    h.store.close();
  });
}

/**
 * A `GatewayError` naming no provider passes `reasonField` at every level, and
 * nothing promises its message is this gateway's own words — a store or a
 * dependency may have written it. The guardrail's warning names a thrown
 * failure by its code and a fixed reason alone, at info and at debug.
 */
for (const level of ["info", "debug"] as const) {
  test(`a provider-less thrown error's message never reaches the check-failed warning (${level})`, async () => {
    const h = await guardrailHarness({ logLevel: level });
    await h.store.credentials.updateHealth("c-judge", "gpt-judge", () =>
      health({ credentialId: "c-judge", model: "gpt-judge", consecutiveFailures: 1 }),
    );
    h.store.credentials.updateHealth = async () => {
      throw new GatewayError("INTERNAL", "row said: SECRET-MARKER");
    };
    expect((await h.call("anthropic")).status).toBe(502);
    const warned = h.logger.records.filter((e) => e.msg === "usage policy check failed");
    expect(warned).toHaveLength(1);
    expect(warned[0]?.fields).toEqual({
      requestId: "req_1",
      model: "judge",
      code: "INTERNAL",
      reason: "classifier call failed",
    });
    for (const line of h.logger.lines) expect(line).not.toContain("SECRET-MARKER");
    h.store.close();
  });
}

/**
 * The judge itself failing — here the settings read it starts with — refuses
 * the request the way a failed check does, and the row says which guardrail
 * outcome it was rather than carrying no guardrail note at all.
 */
for (const stream of [false, true]) {
  test(`a judge that throws refuses as unavailable (${stream ? "streaming" : "non-streaming"})`, async () => {
    const store = await memoryStore();
    const real = createRoutingSnapshotCache(store);
    let reads = 0;
    const h = await guardrailHarness({
      store,
      deps: {
        snapshots: {
          get: async (now) => {
            reads++;
            if (reads === 1) throw new Error("LEAKED-STORE-TEXT");
            return real.get(now);
          },
        },
      },
    });
    const res = await h.call("anthropic", { stream });
    const text = await res.text();
    if (stream) {
      expect(res.status).toBe(200);
      expect(streamError("anthropic", text)).toEqual(
        expectedStreamError("anthropic", "UPSTREAM", UNAVAILABLE_MESSAGE),
      );
    } else {
      expect(res.status).toBe(502);
      expect(JSON.parse(text)).toEqual(errorBody("anthropic", "UPSTREAM", UNAVAILABLE_MESSAGE));
    }
    expect(h.judgeCalls).toHaveLength(0);
    expect(h.targetCalls).toHaveLength(0);
    const parent = await rowOf(h, "req_1");
    expect(parent?.status).toBe(502);
    expect(parent?.errorCode).toBe("UPSTREAM");
    expect(parent?.degradations).toEqual(["guardrail:unavailable"]);
    for (const line of h.logger.lines) expect(line).not.toContain("LEAKED-STORE-TEXT");
    h.store.close();
  });
}

test("an over-long human message is truncated head and tail, and the row says so", async () => {
  const h = await guardrailHarness();
  const long = `HEAD-MARK${"x".repeat(30_000)}TAIL-MARK`;
  const res = await h.call("openai", {
    body: { messages: [{ role: "user", content: long }] },
  });
  expect(res.status).toBe(200);
  const sent = h.judgeCalls[0];
  if (sent === undefined) throw new Error("the classifier was not called");
  const text = classifierText(sent);
  expect(text).toContain("HEAD-MARK");
  expect(text).toContain("TAIL-MARK");
  expect(text).toContain("[… truncated …]");
  expect(text.length).toBeLessThan(long.length);
  expect((await rowOf(h, "req_1"))?.degradations).toEqual([
    "guardrail:allowed",
    "guardrail:truncated",
  ]);
  h.store.close();
});

test("the classifier request carries no ponytail ruleset and no RTK rewrite with both enabled", async () => {
  const h = await guardrailHarness({ settings: { ponytailMode: "full", rtkEnabled: true } });
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
  const real = h.targetCalls[0];
  expect(JSON.stringify(real?.request.system)).toContain("You are a lazy senior developer.");
  expect((await rowOf(h, "req_1"))?.rtkApplied).toBe(true);

  const sent = h.judgeCalls[0];
  expect(sent?.request.system).toEqual([{ type: "text", text: CLASSIFIER_INSTRUCTION }]);
  expect(JSON.stringify(sent?.request)).not.toContain("lazy senior developer");
  const classifier = await rowOf(h, "req_2");
  expect(classifier?.rtkApplied).toBe(false);
  expect(classifier?.degradations).toEqual(["guardrail:classifier"]);
  h.store.close();
});

test("the classifier row is charged to the key and debits tokens and spend", async () => {
  const h = await guardrailHarness();
  expect((await h.call("anthropic")).status).toBe(200);

  const classifier = await rowOf(h, "req_2");
  expect(classifier?.apiKeyId).toBe(h.keyId);
  expect(classifier?.inputTokens).toBe(40);
  expect(classifier?.costUsd ?? 0).toBeGreaterThan(0);
  // Debited against the classifier model, never the parent's.
  const charged = h.debits.filter((d) => d.model === "judge");
  expect(charged).toHaveLength(1);
  expect(charged[0]).toMatchObject({ keyId: h.keyId, tokens: 41 });
  expect(charged[0]?.costUsd ?? 0).toBeGreaterThan(0);
  expect(h.debits.filter((d) => d.model === "fast")).toHaveLength(1);
  // The usage totals see it as its own request.
  const usage = await h.store.usage.recent(50, h.keyId);
  expect(usage.map((row) => row.id).sort()).toEqual(["req_1", "req_2"]);
  h.store.close();
});

/**
 * The classifier call is never admitted, so this replica never recorded the
 * classifier model's override at admission — yet another replica may have
 * seeded that subject's shared buckets and will not re-read the store while
 * they live. The classifier's tokens must land there, or that replica
 * under-counts the override for as long as its buckets last.
 */
test("the classifier's tokens reach its model override's buckets on a replica that seeded them", async () => {
  const store = await memoryStore();
  const coord = memoryCoord();
  const now = () => 1_000_000;
  const replicaA = new ApiKeyRateLimiter({ store, now, coord });
  const h = await guardrailHarness({ store, deps: { rateLimiter: replicaA } });
  const limits: LimitConfig = { models: { judge: { tokens: { "5h": 40 } } } };
  await h.store.keys.setLimits(h.keyId, limits);

  const replicaB = new ApiKeyRateLimiter({ store, now, coord });
  (await replicaB.admit(h.keyId, limits, "judge", "req_b")).release();

  expect((await h.call("anthropic")).status).toBe(200);
  expect((await rowOf(h, "req_2"))?.requestedModel).toBe("judge");
  // 41 classifier tokens against a ceiling of 40, seen without a store read.
  let refused: unknown = null;
  try {
    await replicaB.admit(h.keyId, limits, "judge", "req_b");
  } catch (error) {
    refused = error;
  }
  expect(refused instanceof RateLimitExceeded && refused.headroom.tokens?.used).toBe(41);
  expect(await replicaA.inFlight(modelSubjectId(h.keyId, "judge"))).toBe(0);
  h.store.close();
});

test("a cache hit makes no classifier call, writes no classifier row, and still notes the verdict", async () => {
  const h = await guardrailHarness();
  for (const surface of SURFACES) expect((await h.call(surface)).status).toBe(200);
  // One human message, judged once, across three surfaces' worth of turns.
  expect(h.judgeCalls).toHaveLength(1);
  const rows = await h.store.usage.recent(50);
  expect(rows.filter((r) => r.degradations.includes("guardrail:classifier"))).toHaveLength(1);
  expect(rows.filter((r) => r.degradations.includes("guardrail:allowed"))).toHaveLength(3);
  expect(h.debits.filter((d) => d.model === "judge")).toHaveLength(1);
  h.store.close();
});

test("a cached deny refuses without a call", async () => {
  const h = await guardrailHarness({ classifier: DENY });
  expect((await h.call("anthropic")).status).toBe(400);
  h.setClassifier(ALLOW);
  expect((await h.call("anthropic")).status).toBe(400);
  expect(h.judgeCalls).toHaveLength(1);
  expect(h.targetCalls).toHaveLength(0);
  h.store.close();
});

test("editing the policy or the classifier model misses the cache", async () => {
  const h = await guardrailHarness({ classifier: DENY });
  expect((await h.call("anthropic")).status).toBe(400);

  h.setClassifier(ALLOW);
  await h.store.keys.setGuardrailPolicy(h.keyId, "Anything goes.");
  expect((await h.call("anthropic")).status).toBe(200);
  expect(h.judgeCalls).toHaveLength(2);

  h.setClassifier(DENY);
  await h.store.config.putSettings({ guardrailModel: "judge-2" });
  expect((await h.call("anthropic")).status).toBe(400);
  expect(h.judgeCalls).toHaveLength(3);
  expect(h.judgeCalls[2]?.request.model).toBe("judge-2");
  h.store.close();
});

test("a different human message misses the cache", async () => {
  const h = await guardrailHarness();
  expect((await h.call("anthropic")).status).toBe(200);
  expect(
    (await h.call("anthropic", { body: { messages: [{ role: "user", content: "other" }] } }))
      .status,
  ).toBe(200);
  expect(h.judgeCalls).toHaveLength(2);
  h.store.close();
});

/**
 * A reply that said ALLOW and then failed is a failed check, not an allow: the
 * stream's own error outranks whatever text arrived before it.
 */
test("an ALLOW followed by an upstream error mid-stream refuses", async () => {
  const h = await guardrailHarness({
    classifier: {
      kind: "events",
      events: [
        { type: "start", id: "u", model: "gpt-judge" },
        { type: "blockStart", index: 0, block: { type: "text" } },
        { type: "blockDelta", index: 0, delta: { type: "text", text: "ALLOW" } },
        { type: "error", code: "UPSTREAM", message: "stream reset", retryable: true },
      ],
    },
  });
  expect((await h.call("anthropic")).status).toBe(502);
  expect(h.targetCalls).toHaveLength(0);
  expect((await rowOf(h, "req_1"))?.degradations).toContain("guardrail:unavailable");
  h.store.close();
});

/**
 * Dispatch can also fail by throwing rather than by yielding an error — here a
 * health write that dies after the classifier has already streamed its ALLOW.
 * The thrown failure outranks the text, exactly as an error event does.
 */
test("an ALLOW followed by a thrown dispatch failure refuses", async () => {
  const h = await guardrailHarness();
  // A recorded failure, so the classifier's success has a health row to reset…
  await h.store.credentials.updateHealth("c-judge", "gpt-judge", () =>
    health({ credentialId: "c-judge", model: "gpt-judge", consecutiveFailures: 1 }),
  );
  // …and the write that would reset it fails.
  h.store.credentials.updateHealth = async () => {
    throw new Error("disk full");
  };
  expect((await h.call("anthropic")).status).toBe(502);
  expect(h.judgeCalls).toHaveLength(1);
  expect(h.targetCalls).toHaveLength(0);
  h.store.close();
});

/**
 * A timeout that fires before the classifier is even routed reaches dispatch as
 * an already-aborted signal, which dispatch files as a disconnect. The row says
 * what happened instead: the gateway's own deadline.
 */
test("a timeout that fires before the classifier is routed is still recorded as TIMEOUT", async () => {
  const store = await memoryStore();
  const real = createRoutingSnapshotCache(store);
  let reads = 0;
  const h = await guardrailHarness({
    store,
    settings: { guardrailTimeoutMs: 5 },
    deps: {
      snapshots: {
        // The judge's own read is first; the classifier dispatch's is second,
        // and is held past the timeout.
        get: async (now) => {
          reads++;
          if (reads === 2) await Bun.sleep(40);
          return real.get(now);
        },
      },
    },
  });
  expect((await h.call("anthropic")).status).toBe(502);
  expect(h.judgeCalls).toHaveLength(0);
  const classifier = await rowOf(h, "req_2");
  expect(classifier?.status).toBe(504);
  expect(classifier?.errorCode).toBe("TIMEOUT");
  h.store.close();
});

/**
 * An `ALLOW` the model did not finish is not an allow. A reply cut off at its
 * token ceiling or stopped by the backend's own filter may have been on its way
 * to something else, so it refuses as unreadable, and is never cached: the
 * identical request that follows asks the classifier again.
 */
for (const stopReason of ["maxTokens", "contentFilter"] as const) {
  for (const stream of [false, true]) {
    test(`an ALLOW ending in ${stopReason} refuses, uncached (${stream ? "streaming" : "non-streaming"})`, async () => {
      const truncated = textEvents("ALLOW", "gpt-judge").map(
        (event): StreamEvent => (event.type === "end" ? { ...event, stopReason } : event),
      );
      const h = await guardrailHarness({ classifier: { kind: "events", events: truncated } });
      const res = await h.call("anthropic", { stream });
      const text = await res.text();
      if (stream) {
        expect(res.status).toBe(200);
        expect(streamError("anthropic", text)).toEqual(
          expectedStreamError("anthropic", "UPSTREAM", UNAVAILABLE_MESSAGE),
        );
      } else {
        expect(res.status).toBe(502);
        expect(JSON.parse(text)).toEqual(errorBody("anthropic", "UPSTREAM", UNAVAILABLE_MESSAGE));
      }
      expect(h.targetCalls).toHaveLength(0);
      expect((await rowOf(h, "req_1"))?.degradations).toContain("guardrail:unavailable");

      // Not cached: the same request asks again, and a finished ALLOW serves it.
      h.setClassifier(ALLOW);
      await (await h.call("anthropic", { stream })).text();
      expect(h.judgeCalls).toHaveLength(2);
      expect(h.targetCalls).toHaveLength(1);
      h.store.close();
    });
  }
}

test("failures are never cached: the next turn asks again and may succeed", async () => {
  for (const failure of [
    { kind: "error" },
    { kind: "hang" },
    { kind: "reply", text: "maybe" },
  ] satisfies Classifier[]) {
    const h = await guardrailHarness({ classifier: failure });
    expect((await h.call("anthropic")).status).toBe(502);
    h.setClassifier(ALLOW);
    expect((await h.call("anthropic")).status).toBe(200);
    expect(h.judgeCalls).toHaveLength(2);
    h.store.close();
  }
});

/**
 * A client that hangs up while the check runs is a disconnect, not a failed
 * check: nothing is filed as `UPSTREAM`, nothing is cached, nothing is printed
 * as a refusal, and the real target is never reached.
 */
for (const stream of [false, true]) {
  test(`client cancellation during judging is not logged as UPSTREAM (${stream ? "streaming" : "non-streaming"})`, async () => {
    const h = await guardrailHarness({
      classifier: { kind: "hang" },
      settings: { guardrailTimeoutMs: 60_000 },
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
    // The row is completed after the abort settles; give the write its turn.
    for (let i = 0; i < 50 && h.emitted.length < 2; i++) await Bun.sleep(5);

    const parent = await rowOf(h, "req_1");
    expect(parent?.status).toBe(499);
    expect(parent?.errorCode).toBe("interrupted");
    const classifier = await rowOf(h, "req_2");
    expect(classifier?.status).toBe(499);
    expect(classifier?.errorCode).toBe("interrupted");
    expect(h.targetCalls).toHaveLength(0);
    expect(h.logger.records.some((e) => e.msg === "usage policy check failed")).toBe(false);
    expect(h.logger.records.some((e) => e.msg === "request rejected")).toBe(false);
    h.store.close();
  });
}

test("a refused request still counts against the key: judging runs after admission", async () => {
  const h = await guardrailHarness({ classifier: DENY });
  await h.store.keys.setLimits(h.keyId, { requests: { "1m": 1 } });
  expect((await h.call("anthropic")).status).toBe(400);
  // The refusal consumed the minute's only request, so the next one is a 429
  // and the classifier is not asked again.
  expect(
    (await h.call("anthropic", { body: { messages: [{ role: "user", content: "b" }] } })).status,
  ).toBe(429);
  expect(h.judgeCalls).toHaveLength(1);
  h.store.close();
});

/**
 * Judging is the first step of the stream, not a step before its head: the
 * head goes out at once and keepalives cover the classifier's latency, so a
 * client that abandons a silent connection never sees one.
 */
test("a streaming request sends its head first and keeps alive while the classifier runs", async () => {
  const h = await guardrailHarness({
    classifier: { kind: "hang" },
    settings: { guardrailTimeoutMs: 80 },
    deps: { keepaliveMs: 10 },
  });
  const res = await h.call("responses", { stream: true });
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/event-stream");
  const text = await res.text();
  const keepalive = text.indexOf(": keepalive");
  expect(keepalive).toBeGreaterThanOrEqual(0);
  expect(keepalive).toBeLessThan(text.indexOf("response.failed"));
  expect(streamError("responses", text)).toEqual(
    expectedStreamError("responses", "UPSTREAM", UNAVAILABLE_MESSAGE),
  );
  h.store.close();
});

/**
 * Body capture applies to the request the client sent and never to the
 * classifier's: the classifier is handed the bare transport, not the parent's
 * capturing decorator, whatever the settings say.
 */
test("the classifier call is never captured, with body logging fully on", async () => {
  const root = join(tmpdir(), `omni-guardrail-bodies-${crypto.randomUUID()}`);
  await mkdir(root, { recursive: true });
  const store = await createStore({
    path: join(root, "omnigateway.db"),
    encryptionKey: await deriveKey("test-encryption-key-0123456789"),
  });
  try {
    const captured: import("../../src/bodyCapture.ts").CapturedParts[] = [];
    const h = await guardrailHarness({
      store,
      settings: { bodyLoggingEnabled: true, bodyLoggingCaptureStreamChunks: true },
      deps: {
        bodyLoggingAllowed: true,
        bodyWriter: {
          enqueue: (parts) => {
            captured.push(parts);
          },
        },
      },
    });
    expect((await h.call("anthropic")).status).toBe(200);
    expect(unwatched(h.targetCalls[0]?.http ?? transport)).not.toBe(transport);
    expect(unwatched(h.judgeCalls[0]?.http ?? (() => Promise.reject()))).toBe(transport);
    expect(captured.map((parts) => parts.requestId)).toEqual(["req_1"]);
    expect(captured[0]?.client.request).toContain("messages");
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

/**
 * The classifier row inherits the parent's trace, so a session's cost includes
 * what judging it cost. Its upstream request id is its own.
 */
test("the classifier row carries the parent's trace", async () => {
  const h = await guardrailHarness();
  const res = await h.call("anthropic", {
    headers: {
      "x-claude-code-session-id": "cc-1",
      "x-omni-tags": "team-a",
      "x-request-id": "client-1",
    },
  });
  expect(res.status).toBe(200);
  const rows = await h.store.usage.recent(50);
  const classifier = rows.find((r) => r.degradations.includes("guardrail:classifier"));
  const parent = rows.find((r) => !r.degradations.includes("guardrail:classifier"));
  const trace = {
    sessionId: "claude-code:cc-1",
    agent: "claude-code",
    tags: ["team-a"],
    clientRequestId: "client-1",
  };
  expect(parent).toMatchObject(trace);
  expect(classifier).toMatchObject(trace);
  h.store.close();
});

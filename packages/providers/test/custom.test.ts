import { describe, expect, test } from "bun:test";
import type { ChatRequest, StreamEvent } from "@omni/ir";
import { customAdapter } from "../src/custom/index.ts";
import type { HttpRequest } from "../src/index.ts";
import { ADAPTERS } from "../src/registry.ts";

const request: ChatRequest = {
  model: "local",
  system: [{ type: "text", text: "be terse" }],
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  stream: false,
};

const response = () => ({
  status: 200,
  headers: new Headers({ "content-type": "text/event-stream" }),
  body: new ReadableStream<Uint8Array>({ start: (controller) => controller.close() }),
  text: async () => "",
});

/**
 * A 200 whose SSE body streams the given payloads, then `[DONE]`.
 *
 * A frame may name its SSE event — the Responses wire routes on the `event:`
 * line, while Chat Completions streams typeless `data:` chunks.
 */
function sseResponse(payloads: (string | { event: string; payload: string })[]) {
  const text = `${payloads
    .map((frame) => {
      const [event, payload] =
        typeof frame === "string" ? [undefined, frame] : [frame.event, frame.payload];
      return `${event === undefined ? "" : `event: ${event}\n`}data: ${payload}\n\n`;
    })
    .join("")}data: [DONE]\n\n`;
  const bytes = new TextEncoder().encode(text);
  return {
    status: 200,
    headers: new Headers({ "content-type": "text/event-stream" }),
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
    text: async () => "",
  };
}

/** Sends one request through the adapter and folds its events. */
async function decodedEvents(
  payloads: (string | { event: string; payload: string })[],
  protocol: "chat_completions" | "responses" = "chat_completions",
): Promise<StreamEvent[]> {
  const result = await customAdapter.send({
    request,
    model: "upstream-model",
    credentials: {
      accessToken: null,
      apiKey: "test-provider-key",
      providerData: {
        endpointId: "local",
        endpointLabel: "Local",
        origin: "http://localhost:8000",
        protocol,
      },
    },
    http: async () => sseResponse(payloads),
    signal: new AbortController().signal,
  });
  const events: StreamEvent[] = [];
  for await (const event of result.events) events.push(event);
  return events;
}

async function sentFor(
  protocol: "chat_completions" | "responses",
  extraData: Record<string, unknown> = {},
): Promise<HttpRequest> {
  let sent: HttpRequest | null = null;
  await customAdapter.send({
    request,
    model: "upstream-model",
    credentials: {
      accessToken: null,
      apiKey: "test-provider-key",
      providerData: {
        endpointId: "local",
        endpointLabel: "Local",
        origin: "http://localhost:8000",
        protocol,
        ...extraData,
      },
    },
    http: async (value) => {
      sent = value;
      return response();
    },
    signal: new AbortController().signal,
  });
  if (sent === null) throw new Error("adapter did not send request");
  return sent;
}

test("custom chat completions uses endpoint origin without Kimi headers", async () => {
  const sent = await sentFor("chat_completions");

  expect(sent.url).toBe("http://localhost:8000/v1/chat/completions");
  expect(sent.headers).toContainEqual(["Authorization", "Bearer test-provider-key"]);
  expect(sent.headers.map(([name]) => name.toLowerCase())).not.toContain("x-msh-device-id");
  expect(JSON.parse(sent.body)).toMatchObject({ model: "upstream-model", stream: true });
});

// The thinking level crosses verbatim on both protocols: the effort string is
// forwarded unclamped (a custom server answers for its own vocabulary), an
// explicit opt-out stays off the body, and a token budget — inexpressible on
// either surface — is recorded rather than mapped onto an invented effort.
describe("custom adapter forwards the thinking level as asked", () => {
  async function sendReasoning(
    protocol: "chat_completions" | "responses",
    reasoning?: ChatRequest["reasoning"],
    vendorOpenai?: Record<string, unknown>,
  ): Promise<{ body: Record<string, unknown>; degradations: string[] }> {
    let sent: HttpRequest | null = null;
    const result = await customAdapter.send({
      request: {
        ...request,
        ...(reasoning !== undefined ? { reasoning } : {}),
        ...(vendorOpenai !== undefined ? { vendor: { openai: vendorOpenai } } : {}),
      },
      model: "upstream-model",
      credentials: {
        accessToken: null,
        apiKey: "test-provider-key",
        providerData: {
          endpointId: "local",
          endpointLabel: "Local",
          origin: "http://localhost:8000",
          protocol,
        },
      },
      http: async (value) => {
        sent = value;
        return response();
      },
      signal: new AbortController().signal,
    });
    if (sent === null) throw new Error("adapter did not send request");
    return {
      body: JSON.parse((sent as HttpRequest).body) as Record<string, unknown>,
      degradations: result.degradations,
    };
  }

  test("chat_completions forwards an explicit effort verbatim", async () => {
    const { body, degradations } = await sendReasoning("chat_completions", {
      mode: "adaptive",
      effort: "high",
    });
    expect(body.reasoning_effort).toBe("high");
    expect(degradations.some((value) => value.startsWith("kimi:"))).toBe(false);
    expect(degradations.some((value) => value.includes("reasoning"))).toBe(false);
  });

  test("chat_completions does not clamp deep levels", async () => {
    const { body, degradations } = await sendReasoning("chat_completions", {
      mode: "adaptive",
      effort: "xhigh",
    });
    expect(body.reasoning_effort).toBe("xhigh");
    expect(degradations).toEqual([]);
  });

  test("responses forwards deep levels without clamping", async () => {
    const { body, degradations } = await sendReasoning("responses", {
      mode: "adaptive",
      effort: "max",
    });
    expect(body.reasoning).toEqual({ effort: "max", summary: "auto" });
    expect(degradations).toEqual([]);
  });

  test("an adaptive request without an effort still asks for medium", async () => {
    for (const protocol of ["chat_completions", "responses"] as const) {
      const { body } = await sendReasoning(protocol, { mode: "adaptive" });
      expect(
        protocol === "chat_completions"
          ? body.reasoning_effort
          : (body.reasoning as { effort: string }).effort,
      ).toBe("medium");
    }
  });

  test("an explicit opt-out sends no reasoning field on either protocol", async () => {
    for (const protocol of ["chat_completions", "responses"] as const) {
      const { body, degradations } = await sendReasoning(protocol, { mode: "off" });
      expect(body.reasoning_effort).toBeUndefined();
      expect(body.reasoning).toBeUndefined();
      expect(degradations).toEqual([]);
    }
  });

  test("no reasoning config at all sends no reasoning field", async () => {
    for (const protocol of ["chat_completions", "responses"] as const) {
      const { body } = await sendReasoning(protocol);
      expect(body.reasoning_effort).toBeUndefined();
      expect(body.reasoning).toBeUndefined();
    }
  });

  test("a token budget is recorded, never mapped to an invented effort", async () => {
    for (const protocol of ["chat_completions", "responses"] as const) {
      const { body, degradations } = await sendReasoning(protocol, {
        mode: "budget",
        budgetTokens: 4096,
      });
      expect(body.reasoning_effort).toBeUndefined();
      expect(body.reasoning).toBeUndefined();
      expect(degradations).toContain("custom:reasoning-budget-dropped");
    }
  });

  test("a raw vendor field keeps precedence over the derived one, on both legs", async () => {
    // The responses bag replaces the whole `reasoning` object — summary
    // included — which is what Object.assign-last means.
    const { body, degradations } = await sendReasoning(
      "responses",
      { mode: "adaptive", effort: "high" },
      { reasoning: { effort: "low" } },
    );
    expect(body.reasoning).toEqual({ effort: "low" });
    expect(degradations).toEqual([]);

    const chat = await sendReasoning(
      "chat_completions",
      { mode: "adaptive", effort: "high" },
      { reasoning_effort: "low" },
    );
    expect(chat.body.reasoning_effort).toBe("low");
    expect(chat.degradations).toEqual([]);
  });
});

test("custom responses uses endpoint origin without Codex behavior", async () => {
  const sent = await sentFor("responses");

  expect(sent.url).toBe("http://localhost:8000/v1/responses");
  expect(sent.headers).toEqual([
    ["Content-Type", "application/json"],
    ["Authorization", "Bearer test-provider-key"],
  ]);
  expect(sent.body).not.toContain("chatgpt");
});

// The chat_completions leg must report upstream reasoning back to the client,
// mirroring what the responses leg already does with summaries. All three
// spellings the OpenRouter family ships are read; the thinking is always
// unsigned, because a signature minted over this server's request would
// poison an Anthropic-shaped client that replays it.
describe("custom chat decodes upstream reasoning as unsigned thinking", () => {
  test("reasoning_content deltas become a thinking block ahead of the text", async () => {
    const events = await decodedEvents([
      '{"id":"chatcmpl-1","choices":[{"delta":{"role":"assistant"}}]}',
      '{"choices":[{"delta":{"reasoning_content":"think "}}]}',
      '{"choices":[{"delta":{"reasoning_content":"hard"}}]}',
      '{"choices":[{"delta":{"content":"answer"}}]}',
      '{"choices":[{"delta":{},"finish_reason":"stop"}]}',
    ]);

    expect(events).toEqual([
      { type: "start", id: "chatcmpl-1", model: "" },
      { type: "blockStart", index: 0, block: { type: "thinking" } },
      { type: "blockDelta", index: 0, delta: { type: "thinking", text: "think " } },
      { type: "blockDelta", index: 0, delta: { type: "thinking", text: "hard" } },
      { type: "blockEnd", index: 0 },
      { type: "blockStart", index: 1, block: { type: "text" } },
      { type: "blockDelta", index: 1, delta: { type: "text", text: "answer" } },
      { type: "blockEnd", index: 1 },
      {
        type: "end",
        stopReason: "endTurn",
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      },
    ]);
    expect(
      events.some((e) => e.type === "blockDelta" && e.delta.type === "thinkingSignature"),
    ).toBe(false);
  });

  test("OpenRouter's normalized reasoning spelling decodes too", async () => {
    const events = await decodedEvents([
      '{"id":"c1","choices":[{"delta":{"reasoning":"why"}}]}',
      '{"choices":[{"delta":{"content":"so"}}]}',
    ]);

    expect(events.filter((e) => e.type === "blockDelta")).toEqual([
      { type: "blockDelta", index: 0, delta: { type: "thinking", text: "why" } },
      { type: "blockDelta", index: 1, delta: { type: "text", text: "so" } },
    ]);
  });

  test("unreadable reasoning_details entries are display-loss only, not errors", async () => {
    const events = await decodedEvents([
      '{"id":"c1","choices":[{"delta":{"reasoning_details":[{"type":"reasoning.encrypted","data":"blob"}]}}]}',
      '{"choices":[{"delta":{"content":"answer"}}]}',
    ]);

    expect(events.some((e) => e.type === "blockStart" && e.block.type === "thinking")).toBe(false);
    expect(events.at(-1)?.type).toBe("end");
  });

  test("readable reasoning_details entries contribute their text in order", async () => {
    const events = await decodedEvents([
      '{"id":"c1","choices":[{"delta":{"reasoning_details":[{"text":"de"},{"summary":"tailed"}]}}]}',
      '{"choices":[{"delta":{"content":"x"}}]}',
    ]);

    expect(events.filter((e) => e.type === "blockDelta")).toEqual([
      { type: "blockDelta", index: 0, delta: { type: "thinking", text: "detailed" } },
      { type: "blockDelta", index: 1, delta: { type: "text", text: "x" } },
    ]);
  });

  // The responses fork is wired through the adapter too, not just the chat
  // one: a summary delta must reach the client as thinking on this protocol.
  test("responses reasoning summaries stream through as unsigned thinking", async () => {
    const events = await decodedEvents(
      [
        { event: "response.created", payload: '{"response":{"id":"resp-1","model":"m"}}' },
        {
          event: "response.output_item.added",
          payload: '{"output_index":0,"item":{"type":"reasoning"}}',
        },
        {
          event: "response.reasoning_summary_text.delta",
          payload: '{"output_index":0,"delta":"why"}',
        },
        { event: "response.output_item.done", payload: '{"output_index":0}' },
        {
          event: "response.output_item.added",
          payload: '{"output_index":1,"item":{"type":"message"}}',
        },
        {
          event: "response.content_part.added",
          payload: '{"output_index":1,"part":{"type":"output_text"}}',
        },
        { event: "response.output_text.delta", payload: '{"output_index":1,"delta":"so"}' },
        { event: "response.content_part.done", payload: '{"output_index":1}' },
        {
          event: "response.completed",
          payload: '{"response":{"id":"resp-1","usage":{"input_tokens":3,"output_tokens":5}}}',
        },
      ],
      "responses",
    );

    expect(events).toEqual([
      { type: "start", id: "resp-1", model: "m" },
      { type: "blockStart", index: 0, block: { type: "thinking" } },
      { type: "blockDelta", index: 0, delta: { type: "thinking", text: "why" } },
      { type: "blockEnd", index: 0 },
      { type: "blockStart", index: 1, block: { type: "text" } },
      { type: "blockDelta", index: 1, delta: { type: "text", text: "so" } },
      { type: "blockEnd", index: 1 },
      {
        type: "end",
        stopReason: "endTurn",
        usage: { inputTokens: 3, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
      },
    ]);
  });

  test("responses failure events surface as canonical errors through the adapter", async () => {
    const events = await decodedEvents(
      [
        { event: "response.created", payload: '{"response":{"id":"resp-1","model":"m"}}' },
        {
          event: "error",
          payload: '{"error":{"code":"rate_limit_exceeded","message":"slow down"}}',
        },
      ],
      "responses",
    );

    expect(events).toEqual([
      { type: "start", id: "resp-1", model: "m" },
      { type: "error", code: "RATE_LIMIT", message: "slow down", retryable: true },
    ]);
  });
});

// Base paths exist so reverse-proxied servers (`https://host/api`) are
// expressible. A base ending in `/v1` already says where the API lives, and a
// blind append would double it; bare-origin rows predate basePath entirely.
describe("custom adapter joins stored base paths", () => {
  const cases = [
    {
      name: "path sits between origin and /v1",
      basePath: "/api",
      url: "http://localhost:8000/api/v1/chat/completions",
    },
    {
      name: "a /v1-ending path is not doubled",
      basePath: "/v1",
      url: "http://localhost:8000/v1/chat/completions",
    },
    {
      name: "deep paths join verbatim",
      basePath: "/llm/prod",
      url: "http://localhost:8000/llm/prod/v1/chat/completions",
    },
    {
      name: "responses swaps only the suffix",
      basePath: "/api",
      protocol: "responses" as const,
      url: "http://localhost:8000/api/v1/responses",
    },
  ];

  for (const c of cases) {
    test(c.name, async () => {
      const sent = await sentFor(c.protocol ?? "chat_completions", { basePath: c.basePath });
      expect(sent.url).toBe(c.url);
    });
  }
});

test("registry includes custom provider", () => {
  expect(Object.keys(ADAPTERS).sort()).toEqual([
    "anthropic",
    "custom",
    "grok",
    "kilo",
    "kimi",
    "openai",
  ]);
});

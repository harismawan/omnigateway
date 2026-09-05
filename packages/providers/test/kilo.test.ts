import { expect, test } from "bun:test";
import {
  type ChatRequest,
  CONTEXT_1M_BETA,
  collect as collectResponse,
  type StopReason,
  type StreamEvent,
} from "@omni/ir";
import type { AdapterCredentials, HttpRequest, HttpResponse } from "../src/index.ts";
import { decodeKiloChat } from "../src/kilo/decode.ts";
import { kiloAdapter } from "../src/kilo/index.ts";
import { toKiloWire } from "../src/kilo/wire.ts";
import { ADAPTERS } from "../src/registry.ts";
import type { SseMessage } from "../src/sse.ts";
import { entry } from "./entry.ts";

const OAUTH_URL = "https://api.kilo.ai/api/openrouter/chat/completions";
const API_URL = "https://api.kilo.ai/api/gateway/chat/completions";

const base: ChatRequest = {
  model: "cheap",
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  stream: true,
};

const oauthCredentials: AdapterCredentials = {
  accessToken: "kilo-oauth-token",
  apiKey: null,
  providerData: {},
};

const apiKeyCredentials: AdapterCredentials = {
  accessToken: null,
  apiKey: "kilo-api-key",
  providerData: {},
};

async function* msgs(...m: SseMessage[]): AsyncGenerator<SseMessage> {
  for (const x of m) yield x;
}

async function collect(g: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of g) out.push(e);
  return out;
}

/** An SSE body carrying one `data:` record per payload. */
function sseBody(...payloads: string[]): ReadableStream<Uint8Array> {
  const text = payloads.map((p) => `data: ${p}\n\n`).join("");
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

const REPLY = [
  JSON.stringify({
    id: "gen-1",
    model: "anthropic/claude-sonnet-5",
    choices: [{ index: 0, delta: { role: "assistant", content: "Hel" } }],
  }),
  JSON.stringify({ choices: [{ index: 0, delta: { content: "lo" } }] }),
  JSON.stringify({
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  }),
  "[DONE]",
];

type SendResult = { sent: HttpRequest; events: StreamEvent[]; degradations: string[] };

async function send(options: {
  credentials: AdapterCredentials;
  request?: ChatRequest;
  model?: string;
  payloads?: string[];
}): Promise<SendResult> {
  let sent: HttpRequest | null = null;
  const result = await kiloAdapter.send({
    request: options.request ?? base,
    model: options.model ?? "anthropic/claude-sonnet-5",
    credentials: options.credentials,
    http: async (value): Promise<HttpResponse> => {
      sent = value;
      return {
        status: 200,
        headers: new Headers({ "content-type": "text/event-stream" }),
        body: sseBody(...(options.payloads ?? REPLY)),
        text: async () => "",
      };
    },
    signal: new AbortController().signal,
  });
  if (sent === null) throw new Error("adapter did not send a request");
  return {
    sent,
    events: await collect(result.events),
    degradations: result.degradations,
  };
}

/** Block open/close events in the order they were emitted, for nesting checks. */
function blockSpans(events: readonly StreamEvent[]): string[] {
  return events.flatMap((e) =>
    e.type === "blockStart"
      ? [`open ${e.index}`]
      : e.type === "blockEnd"
        ? [`close ${e.index}`]
        : [],
  );
}

function header(sent: HttpRequest, name: string): string | undefined {
  return sent.headers.find(([n]) => n.toLowerCase() === name.toLowerCase())?.[1];
}

// --- URL selection -----------------------------------------------------------
// Crossing the two paths does not fail loudly: Kilo answers with a billing or
// entitlement error, which reads as anything but a routing bug. Both directions
// are asserted so inverting the selection cannot pass.

test("an OAuth credential is served by the OpenRouter path", async () => {
  const { sent } = await send({ credentials: oauthCredentials });

  expect(sent.url).toBe(OAUTH_URL);
  expect(header(sent, "authorization")).toBe("Bearer kilo-oauth-token");
});

test("an API key is served by the gateway path", async () => {
  const { sent } = await send({ credentials: apiKeyCredentials });

  expect(sent.url).toBe(API_URL);
  expect(header(sent, "authorization")).toBe("Bearer kilo-api-key");
});

test("a credential with neither token is an AUTH failure, not a bare request", async () => {
  await expect(
    send({ credentials: { accessToken: null, apiKey: null, providerData: {} } }),
  ).rejects.toThrow(/token/);
});

// --- Streaming and non-streaming on both paths -------------------------------

test("decodes a streamed reply on either path", async () => {
  for (const credentials of [oauthCredentials, apiKeyCredentials]) {
    const { sent, events } = await send({ credentials, request: { ...base, stream: true } });

    expect(JSON.parse(sent.body)).toMatchObject({ stream: true });
    expect(events[0]).toEqual({ type: "start", id: "gen-1", model: "anthropic/claude-sonnet-5" });
    expect(events[1]).toEqual({ type: "blockStart", index: 0, block: { type: "text" } });
    expect(events[2]).toEqual({
      type: "blockDelta",
      index: 0,
      delta: { type: "text", text: "Hel" },
    });
    expect(events.at(-1)).toEqual({
      type: "end",
      stopReason: "endTurn",
      usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
    });
  }
});

test("a non-streaming client request still streams upstream on either path", async () => {
  for (const credentials of [oauthCredentials, apiKeyCredentials]) {
    const { sent, events } = await send({ credentials, request: { ...base, stream: false } });

    // Dispatch collects the stream for a non-streaming client, so the upstream
    // request is streamed either way.
    expect(JSON.parse(sent.body)).toMatchObject({ stream: true });
    expect(events.at(-1)).toEqual({
      type: "end",
      stopReason: "endTurn",
      usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
    });
  }
});

// --- Usage -------------------------------------------------------------------

test("asks for usage on every stream, because this surface reports none without it", () => {
  const { body } = toKiloWire(base, "anthropic/claude-sonnet-5");

  expect(body.stream_options).toEqual({ include_usage: true });
});

test("a stream with no usage payload ends reporting zeros", async () => {
  // Which is exactly why the request always carries `stream_options`: a stream
  // without it reaches the request log as a request that cost nothing.
  const events = await collect(
    decodeKiloChat(
      msgs(
        { event: "message", data: JSON.stringify({ id: "gen-1", model: "m", choices: [] }) },
        {
          event: "message",
          data: JSON.stringify({ choices: [{ delta: { content: "x" }, finish_reason: "stop" }] }),
        },
        { event: "message", data: "[DONE]" },
      ),
    ),
  );

  expect(events.at(-1)).toMatchObject({
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
  });
});

test("subtracts cache hits and writes out of the prompt total", async () => {
  const events = await collect(
    decodeKiloChat(
      msgs(
        { event: "message", data: JSON.stringify({ id: "gen-1", model: "m", choices: [] }) },
        {
          event: "message",
          data: JSON.stringify({
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            usage: {
              prompt_tokens: 100,
              completion_tokens: 5,
              prompt_tokens_details: { cached_tokens: 60, cache_creation_tokens: 10 },
            },
          }),
        },
        { event: "message", data: "[DONE]" },
      ),
    ),
  );

  // `inputTokens` is uncached input only: 100 - 60 read - 10 written.
  expect(events.at(-1)).toMatchObject({
    usage: { inputTokens: 30, outputTokens: 5, cacheReadTokens: 60, cacheWriteTokens: 10 },
  });
});

// --- Tool round-trip ---------------------------------------------------------

test("emits assistant tool_calls and a tool role result", () => {
  const { body } = toKiloWire(
    {
      ...base,
      messages: [
        { role: "assistant", content: [{ type: "toolUse", id: "c1", name: "f", input: { a: 1 } }] },
        {
          role: "user",
          content: [{ type: "toolResult", toolUseId: "c1", content: "ok", isError: false }],
        },
      ],
      tools: [
        {
          kind: "portable",
          name: "f",
          description: "does f",
          inputSchema: { type: "object", properties: {} },
        },
      ],
      toolChoice: { type: "any" },
    },
    "anthropic/claude-sonnet-5",
  );

  expect(body.messages[0]).toEqual({
    role: "assistant",
    content: null,
    tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: '{"a":1}' } }],
  });
  expect(body.messages[1]).toEqual({ role: "tool", tool_call_id: "c1", content: "ok" });
  expect(body.tools).toEqual([
    {
      type: "function",
      function: {
        name: "f",
        description: "does f",
        parameters: { type: "object", properties: {} },
      },
    },
  ]);
  expect(body.tool_choice).toBe("required");
});

test("decodes streamed tool calls back into canonical blocks", async () => {
  const { events } = await send({
    credentials: apiKeyCredentials,
    payloads: [
      JSON.stringify({
        id: "gen-2",
        model: "m",
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, id: "c1", function: { name: "f", arguments: '{"a"' } }],
            },
          },
        ],
      }),
      JSON.stringify({
        choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ":1}" } }] } }],
      }),
      JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
      "[DONE]",
    ],
  });

  expect(events[1]).toEqual({
    type: "blockStart",
    index: 0,
    block: { type: "toolUse", id: "c1", name: "f" },
  });
  expect(events[2]).toEqual({
    type: "blockDelta",
    index: 0,
    delta: { type: "toolJson", partial: '{"a"' },
  });
  expect(events[3]).toEqual({
    type: "blockDelta",
    index: 0,
    delta: { type: "toolJson", partial: ":1}" },
  });
  expect(events.at(-1)).toMatchObject({ type: "end", stopReason: "toolUse" });
});

// --- Message shape -----------------------------------------------------------

test("passes a mid-conversation system turn through in position", () => {
  const { body } = toKiloWire(
    {
      model: "m",
      system: [{ type: "text", text: "top-level prompt" }],
      messages: [
        { role: "user", content: [{ type: "text", text: "hi" }] },
        { role: "system", content: [{ type: "text", text: "Write Go." }] },
        { role: "assistant", content: [{ type: "text", text: "ok" }] },
      ],
      stream: false,
    },
    "anthropic/claude-sonnet-5",
  );

  // The request-level prompt leads, and the mid-conversation turn keeps its own
  // place rather than being folded into it.
  expect(body.messages).toEqual([
    { role: "system", content: "top-level prompt" },
    { role: "user", content: "hi" },
    { role: "system", content: "Write Go." },
    { role: "assistant", content: "ok" },
  ]);
});

test("sends images as chat image parts rather than dropping them", () => {
  const { body, degradations } = toKiloWire(
    {
      ...base,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "look" },
            { type: "image", mediaType: "image/png", data: "AAAA" },
          ],
        },
      ],
    },
    "anthropic/claude-sonnet-5",
  );

  expect(body.messages[0]).toEqual({
    role: "user",
    content: [
      { type: "text", text: "look" },
      { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
    ],
  });
  expect(degradations).toEqual([]);
});

// --- Degradations ------------------------------------------------------------

test("records a degradation for cache breakpoints this wire cannot express", () => {
  const { degradations } = toKiloWire(
    {
      ...base,
      system: [{ type: "text", text: "be terse", cacheControl: { type: "ephemeral", ttl: "1h" } }],
    },
    "anthropic/claude-sonnet-5",
  );

  expect(degradations).toContain("kilo:cache-control-dropped");
});

test("records a cache degradation for a breakpoint on a message block too", () => {
  const { degradations } = toKiloWire(
    {
      ...base,
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "hi", cacheControl: { type: "ephemeral" } }],
        },
      ],
    },
    "anthropic/claude-sonnet-5",
  );

  expect(degradations).toContain("kilo:cache-control-dropped");
});

test("records no cache degradation when the caller placed no breakpoint", () => {
  const { degradations } = toKiloWire(
    { ...base, system: [{ type: "text", text: "be terse" }] },
    "anthropic/claude-sonnet-5",
  );

  expect(degradations).not.toContain("kilo:cache-control-dropped");
});

test("degradations name kilo rather than the provider this encoder was forked from", () => {
  // A thinking block is something this wire genuinely cannot replay, so the
  // fixture records a real loss; effort levels now cross verbatim and record
  // nothing at all.
  const { degradations } = toKiloWire(
    {
      ...base,
      messages: [
        ...base.messages,
        { role: "assistant", content: [{ type: "thinking", text: "prior turn" }] },
      ],
    },
    "anthropic/claude-sonnet-5",
  );

  // `[].every()` is `true`, so without this line the assertion below passes on
  // an encoder that records nothing at all — which is how the reasoning branch
  // went uncovered in the first place.
  expect(degradations.length).toBeGreaterThan(0);
  expect(degradations.every((value) => value.startsWith("kilo:"))).toBe(true);
});

test("records a degradation for a 1M-context beta this wire has no mechanism for", () => {
  const { degradations } = toKiloWire(
    { ...base, betas: [CONTEXT_1M_BETA] },
    "anthropic/claude-sonnet-5",
  );

  expect(degradations).toContain("kilo:context-1m-dropped");
});

test("records a degradation for a thinking block nothing on this wire replays", () => {
  const { body, degradations } = toKiloWire(
    {
      ...base,
      messages: [
        {
          role: "assistant",
          content: [
            { type: "thinking", text: "hmm", signature: "sig" },
            { type: "text", text: "ok" },
          ],
        },
      ],
    },
    "anthropic/claude-sonnet-5",
  );

  expect(degradations).toContain("kilo:thinking-dropped");
  // The thinking is gone from the body, which is what the degradation records.
  expect(body.messages).toEqual([{ role: "assistant", content: "ok" }]);
});

test("records a degradation for an Anthropic-native history block", () => {
  const { body, degradations } = toKiloWire(
    {
      ...base,
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "providerNative",
              provider: "anthropic",
              blockType: "server_tool_use",
              data: { id: "srvtoolu_1" },
            },
            { type: "text", text: "ok" },
          ],
        },
      ],
    },
    "anthropic/claude-sonnet-5",
  );

  // Routing should keep such a request off kilo entirely (the block names
  // Anthropic as its producer, and kilo is not it), so this is defence in
  // depth — but it must never be forwarded as if this wire understood it.
  expect(degradations).toContain("kilo:anthropic-native-block-dropped");
  expect(body.messages).toEqual([{ role: "assistant", content: "ok" }]);
});

test("drops an Anthropic-defined tool rather than forwarding a malformed function", () => {
  const { body, degradations } = toKiloWire(
    {
      ...base,
      tools: [
        {
          kind: "portable",
          name: "f",
          description: "does f",
          inputSchema: { type: "object", properties: {} },
        },
        {
          kind: "provider",
          provider: "anthropic",
          family: "webSearch",
          type: "web_search_20250305",
          name: "web_search",
          wire: { max_uses: 3 },
        },
      ],
    },
    "anthropic/claude-sonnet-5",
  );

  // Without the filter the Anthropic tool is forwarded as
  // `{type:"function", function:{name, description: undefined, parameters: undefined}}`,
  // which is malformed to an OpenAI-chat surface: it has no schema at all.
  expect(body.tools).toEqual([
    {
      type: "function",
      function: {
        name: "f",
        description: "does f",
        parameters: { type: "object", properties: {} },
      },
    },
  ]);
  expect(degradations).toContain("kilo:anthropic-tool-dropped");
});

test("records no tool degradation when every tool is portable", () => {
  const { degradations } = toKiloWire(
    {
      ...base,
      tools: [{ kind: "portable", name: "f", inputSchema: { type: "object" } }],
    },
    "anthropic/claude-sonnet-5",
  );

  expect(degradations).not.toContain("kilo:anthropic-tool-dropped");
});

// --- Reasoning request -------------------------------------------------------
// The kilo descriptor declares `reasoning: true`, so the router actively sends
// reasoning requests here. What the encoder puts on the wire is therefore
// load-bearing, not incidental.

test("encodes a token budget as OpenRouter's max_tokens form", () => {
  const { body, degradations } = toKiloWire(
    { ...base, reasoning: { mode: "budget", budgetTokens: 8000 } },
    "anthropic/claude-sonnet-5",
  );

  expect(body.reasoning).toEqual({ max_tokens: 8000 });
  expect(degradations).toEqual([]);
});

test("encodes an adaptive effort as OpenRouter's effort form", () => {
  const { body, degradations } = toKiloWire(
    { ...base, reasoning: { mode: "adaptive", effort: "low" } },
    "anthropic/claude-sonnet-5",
  );

  expect(body.reasoning).toEqual({ effort: "low" });
  expect(degradations).toEqual([]);
});

test("defaults an adaptive request with no effort to medium", () => {
  const { body } = toKiloWire(
    { ...base, reasoning: { mode: "adaptive" } },
    "anthropic/claude-sonnet-5",
  );

  expect(body.reasoning).toEqual({ effort: "medium" });
});

test("forwards the full official effort ladder unclamped", () => {
  for (const effort of ["none", "minimal", "xhigh", "max"] as const) {
    const { body, degradations } = toKiloWire(
      { ...base, reasoning: { mode: "adaptive", effort } },
      "anthropic/claude-sonnet-5",
    );

    expect(body.reasoning).toEqual({ effort });
    expect(degradations).toEqual([]);
  }
});

test("sends no reasoning field when the caller opted out", () => {
  const { body } = toKiloWire({ ...base, reasoning: { mode: "off" } }, "anthropic/claude-sonnet-5");

  expect(body.reasoning).toBeUndefined();
});

// --- Reasoning response ------------------------------------------------------
// The encoder asks for reasoning and this surface bills what comes back inside
// `completion_tokens`. A decoder that drops it has the operator paying for
// thinking that reaches neither the client nor the collected response.

/** A stream that thinks under `spelling`, then answers, then reports usage. */
function reasoningReply(delta: Record<string, unknown>): string[] {
  return [
    JSON.stringify({
      id: "gen-r",
      model: "anthropic/claude-sonnet-5",
      choices: [{ index: 0, delta: { role: "assistant", ...delta } }],
    }),
    JSON.stringify({ choices: [{ index: 0, delta: { content: "answer" } }] }),
    JSON.stringify({
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 40 },
    }),
    "[DONE]",
  ];
}

test("decodes OpenRouter's reasoning field into a thinking block", async () => {
  const { events } = await send({
    credentials: apiKeyCredentials,
    payloads: reasoningReply({ reasoning: "step one" }),
  });

  expect(events[1]).toEqual({ type: "blockStart", index: 0, block: { type: "thinking" } });
  expect(events[2]).toEqual({
    type: "blockDelta",
    index: 0,
    delta: { type: "thinking", text: "step one" },
  });
  // Sequential blocks: the thinking closes before the answer opens, which is
  // what an Anthropic-shaped egress renders.
  expect(events[3]).toEqual({ type: "blockEnd", index: 0 });
  expect(events[4]).toEqual({ type: "blockStart", index: 1, block: { type: "text" } });
});

test("decodes the DeepSeek-family reasoning_content spelling too", async () => {
  const { events } = await send({
    credentials: apiKeyCredentials,
    payloads: reasoningReply({ reasoning_content: "step one" }),
  });

  expect(events[2]).toEqual({
    type: "blockDelta",
    index: 0,
    delta: { type: "thinking", text: "step one" },
  });
});

test("falls back to reasoning_details when no plain reasoning string arrives", async () => {
  const { events } = await send({
    credentials: apiKeyCredentials,
    payloads: reasoningReply({
      reasoning_details: [
        { type: "reasoning.text", text: "detailed " },
        { type: "reasoning.summary", summary: "thought" },
      ],
    }),
  });

  expect(events[2]).toEqual({
    type: "blockDelta",
    index: 0,
    delta: { type: "thinking", text: "detailed thought" },
  });
});

test("reads a delta carrying both spellings once, not twice", async () => {
  // OpenRouter sends `reasoning` and `reasoning_details` in the same delta
  // describing the same tokens. Reading both doubles the thinking.
  const { events } = await send({
    credentials: apiKeyCredentials,
    payloads: reasoningReply({
      reasoning: "step one",
      reasoning_details: [{ type: "reasoning.text", text: "step one" }],
    }),
  });

  const thinking = events.filter(
    (e) => e.type === "blockDelta" && e.delta.type === "thinking",
  ) as Extract<StreamEvent, { type: "blockDelta" }>[];
  expect(thinking).toHaveLength(1);
  expect(thinking[0]?.delta).toEqual({ type: "thinking", text: "step one" });
});

test("never claims a proxied signature, so the block cannot poison an Anthropic replay", async () => {
  const { events } = await send({
    credentials: apiKeyCredentials,
    payloads: reasoningReply({
      reasoning: "step one",
      reasoning_details: [
        {
          type: "reasoning.text",
          text: "step one",
          signature: "ErUBCkYIBxgCIkA",
          format: "anthropic-claude-v1",
        },
      ],
    }),
  });

  // The signature was minted over the request Kilo made, on Kilo's account.
  // Replaying it to Anthropic through this gateway fails the whole turn, so the
  // block is reported unsigned — displayable, not replayable.
  expect(events[1]).toEqual({ type: "blockStart", index: 0, block: { type: "thinking" } });
  expect(events.some((e) => e.type === "blockDelta" && e.delta.type === "thinkingSignature")).toBe(
    false,
  );
});

test("an unreadable reasoning shape costs the text, not the response", async () => {
  const { events } = await send({
    credentials: apiKeyCredentials,
    payloads: reasoningReply({
      reasoning_details: [{ type: "reasoning.encrypted", data: "b3BhcXVl" }],
    }),
  });

  // No thinking block, because there is no text to show — but the answer, the
  // stop reason and the usage all still arrive. Erroring here would throw away
  // a good response every time a proxied vendor adds a field.
  expect(events.some((e) => e.type === "blockStart" && e.block.type === "thinking")).toBe(false);
  expect(events[1]).toEqual({ type: "blockStart", index: 0, block: { type: "text" } });
  expect(events.at(-1)).toEqual({
    type: "end",
    stopReason: "endTurn",
    usage: { inputTokens: 10, outputTokens: 40, cacheReadTokens: 0, cacheWriteTokens: 0 },
  });
});

test("a non-streaming request collects the reasoning into the response content", async () => {
  const { events } = await send({
    credentials: oauthCredentials,
    request: { ...base, stream: false, reasoning: { mode: "adaptive", effort: "high" } },
    payloads: [
      JSON.stringify({
        id: "gen-r",
        model: "anthropic/claude-sonnet-5",
        choices: [{ index: 0, delta: { role: "assistant", reasoning: "step " } }],
      }),
      JSON.stringify({ choices: [{ index: 0, delta: { reasoning: "two" } }] }),
      JSON.stringify({ choices: [{ index: 0, delta: { content: "answer" } }] }),
      JSON.stringify({
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 40 },
      }),
      "[DONE]",
    ],
  });

  // Dispatch collapses the upstream stream for a non-streaming client, so this
  // is the shape that surface actually renders.
  const response = collectResponse(events);
  expect(response.content).toEqual([
    { type: "thinking", text: "step two" },
    { type: "text", text: "answer" },
  ]);
  expect(response.usage.outputTokens).toBe(40);
});

test("reasoning that resumes after text opens a second block rather than reopening the first", async () => {
  const { events } = await send({
    credentials: apiKeyCredentials,
    payloads: [
      JSON.stringify({
        id: "gen-r",
        model: "m",
        choices: [{ index: 0, delta: { reasoning: "first" } }],
      }),
      JSON.stringify({ choices: [{ index: 0, delta: { content: "partial" } }] }),
      JSON.stringify({ choices: [{ index: 0, delta: { reasoning: "second" } }] }),
      JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
      "[DONE]",
    ],
  });

  const response = collectResponse(events);
  expect(response.content).toEqual([
    { type: "thinking", text: "first" },
    { type: "text", text: "partial" },
    { type: "thinking", text: "second" },
  ]);
  // On the reasoning axis, each block closes before the next opens. An
  // Anthropic-shaped egress renders these as content_block_start /
  // content_block_stop pairs, and a start that arrives while another block is
  // still open is malformed on that wire.
  //
  // The text/tool axis holds to the same rule; see the block-sequencing tests
  // at the end of this file, which cover it directly.
  expect(blockSpans(events)).toEqual([
    "open 0",
    "close 0",
    "open 1",
    "close 1",
    "open 2",
    "close 2",
  ]);
});

test("a tool call closes the thinking block before its own opens", async () => {
  const { events } = await send({
    credentials: apiKeyCredentials,
    payloads: [
      JSON.stringify({
        id: "gen-r",
        model: "m",
        choices: [{ index: 0, delta: { reasoning: "which tool" } }],
      }),
      JSON.stringify({
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, id: "c1", function: { name: "f", arguments: "{}" } }],
            },
          },
        ],
      }),
      JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
      "[DONE]",
    ],
  });

  expect(events[1]).toEqual({ type: "blockStart", index: 0, block: { type: "thinking" } });
  expect(events[3]).toEqual({ type: "blockEnd", index: 0 });
  expect(events[4]).toEqual({
    type: "blockStart",
    index: 1,
    block: { type: "toolUse", id: "c1", name: "f" },
  });
});

// --- Organization header -----------------------------------------------------

test("sends the organization header when the credential carries one", async () => {
  const { sent } = await send({
    credentials: { ...oauthCredentials, providerData: { orgId: "org-42" } },
  });

  expect(header(sent, "x-kilocode-organizationid")).toBe("org-42");
});

test("omits the organization header when the credential has no organization", async () => {
  const { sent } = await send({ credentials: oauthCredentials });

  expect(sent.headers.map(([name]) => name.toLowerCase())).not.toContain(
    "x-kilocode-organizationid",
  );
});

test("identifies the editor on every request", async () => {
  const { sent } = await send({ credentials: apiKeyCredentials });

  expect(header(sent, "x-kilocode-editorname")).toBeDefined();
});

// --- Registry ----------------------------------------------------------------

test("the registry serves kilo with its canonical capabilities", () => {
  expect(Object.keys(ADAPTERS).sort()).toEqual([
    "anthropic",
    "antigravity",
    "custom",
    "grok",
    "kilo",
    "kimi",
    "openai",
  ]);
  expect(entry(ADAPTERS, "kilo", "ADAPTERS").id).toBe("kilo");
  // Kilo fronts Claude, GPT and Gemini: an under-claimed `images` would drop
  // every kilo target from a request carrying a screenshot.
  expect(entry(ADAPTERS, "kilo", "ADAPTERS").capabilities).toEqual({
    tools: true,
    images: true,
    reasoning: true,
  });
});

// --- Block sequencing, text and tool calls ------------------------------------
// The reasoning axis was made strictly sequential when this decoder was
// written; the text/tool axis was inherited overlapping from the kimi decoder
// this one was forked from and is fixed here. All three axes now share one
// cursor: at most one block is open at a time.
//
// This matters because the Anthropic egress reproduces the decoder's order
// verbatim as content_block_start / content_block_stop, and the official
// Anthropic SDK reports every content_block_stop against the most recently
// started block. Overlapping blocks therefore make a real client announce the
// later block twice and never announce the earlier one.
//
// The assertions are on order, not counts: the number of starts and ends is
// identical whether or not the blocks overlap.

test("text closes before a tool call opens", async () => {
  const { events } = await send({
    credentials: apiKeyCredentials,
    payloads: [
      JSON.stringify({
        id: "gen-t",
        model: "m",
        choices: [{ delta: { content: "Let me check." } }],
      }),
      JSON.stringify({
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, id: "c1", function: { name: "f", arguments: "{}" } }],
            },
          },
        ],
      }),
      JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
      "[DONE]",
    ],
  });

  expect(blockSpans(events)).toEqual(["open 0", "close 0", "open 1", "close 1"]);
});

test("each tool call closes before the next one opens", async () => {
  const { events } = await send({
    credentials: apiKeyCredentials,
    payloads: [
      JSON.stringify({ id: "gen-t", model: "m", choices: [{ delta: { role: "assistant" } }] }),
      JSON.stringify({
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, id: "c1", function: { name: "f", arguments: "{}" } }],
            },
          },
        ],
      }),
      JSON.stringify({
        choices: [
          {
            delta: {
              tool_calls: [{ index: 1, id: "c2", function: { name: "g", arguments: "{}" } }],
            },
          },
        ],
      }),
      JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
      "[DONE]",
    ],
  });

  expect(blockSpans(events)).toEqual(["open 0", "close 0", "open 1", "close 1"]);
});

test("text after a tool call opens a second text block rather than reopening the first", async () => {
  const { events } = await send({
    credentials: apiKeyCredentials,
    payloads: [
      JSON.stringify({ id: "gen-t", model: "m", choices: [{ delta: { content: "Checking." } }] }),
      JSON.stringify({
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, id: "c1", function: { name: "f", arguments: "{}" } }],
            },
          },
        ],
      }),
      JSON.stringify({ choices: [{ delta: { content: "All done." } }] }),
      JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] }),
      "[DONE]",
    ],
  });

  expect(blockSpans(events)).toEqual([
    "open 0",
    "close 0",
    "open 1",
    "close 1",
    "open 2",
    "close 2",
  ]);

  // The non-streaming fold keeps the trailing text after the call it followed.
  expect(collectResponse(events).content).toEqual([
    { type: "text", text: "Checking." },
    { type: "toolUse", id: "c1", name: "f", input: {} },
    { type: "text", text: "All done." },
  ]);
});

test("reasoning, text and a tool call in one turn stay a flat sequence", async () => {
  const { events } = await send({
    credentials: apiKeyCredentials,
    payloads: [
      JSON.stringify({ id: "gen-t", model: "m", choices: [{ delta: { reasoning: "thinking" } }] }),
      JSON.stringify({ choices: [{ delta: { content: "Calling now." } }] }),
      JSON.stringify({
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, id: "c1", function: { name: "f", arguments: '{"a":1}' } }],
            },
          },
        ],
      }),
      JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
      "[DONE]",
    ],
  });

  expect(blockSpans(events)).toEqual([
    "open 0",
    "close 0",
    "open 1",
    "close 1",
    "open 2",
    "close 2",
  ]);
  expect(collectResponse(events).content).toEqual([
    { type: "thinking", text: "thinking" },
    { type: "text", text: "Calling now." },
    { type: "toolUse", id: "c1", name: "f", input: { a: 1 } },
  ]);
});

test("content and tool_calls in one chunk still produce a flat sequence", async () => {
  const { events } = await send({
    credentials: apiKeyCredentials,
    payloads: [
      JSON.stringify({
        id: "gen-t",
        model: "m",
        choices: [
          {
            delta: {
              content: "Calling now.",
              tool_calls: [{ index: 0, id: "c1", function: { name: "f", arguments: '{"a":1}' } }],
            },
          },
        ],
      }),
      JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
      "[DONE]",
    ],
  });

  expect(blockSpans(events)).toEqual(["open 0", "close 0", "open 1", "close 1"]);
  expect(collectResponse(events).content).toEqual([
    { type: "text", text: "Calling now." },
    { type: "toolUse", id: "c1", name: "f", input: { a: 1 } },
  ]);
});

// `FINISH[reason] ?? "endTurn"` used to answer for a reason this decoder has
// never heard of, and `endTurn` is the one wrong answer that cannot be noticed:
// a truncated turn, a filtered one and a new spelling of tool_calls all reach
// the client as a complete reply, with nothing in `request_logs` disagreeing.
// Likelier here than on a direct upstream — the vocabulary belongs to whatever
// model the proxy routed to, not to the proxy.
test("fails visibly on a finish reason it does not know", async () => {
  const events = await collect(
    decodeKiloChat(
      msgs(
        {
          event: "message",
          data: JSON.stringify({ choices: [{ delta: {}, finish_reason: "invented_reason" }] }),
        },
        { event: "message", data: "[DONE]" },
      ),
    ),
  );

  expect(events.at(-1)).toMatchObject({
    type: "error",
    code: "UPSTREAM",
    message: 'unrecognized Kilo finish reason "invented_reason"',
  });
  expect(events.some((event) => event.type === "end")).toBe(false);
});

test("a prototype key is not a finish reason", async () => {
  // `FINISH` is an ordinary object literal, so `FINISH["constructor"]` answers
  // the Object constructor: present, so `?? "endTurn"` never fired and never
  // would have. It was assigned into the end event as the stop reason, where
  // `JSON.stringify` drops a function and leaves the field simply absent.
  const events = await collect(
    decodeKiloChat(
      msgs(
        {
          event: "message",
          data: JSON.stringify({ choices: [{ delta: {}, finish_reason: "constructor" }] }),
        },
        { event: "message", data: "[DONE]" },
      ),
    ),
  );

  expect(events.at(-1)).toMatchObject({ type: "error", code: "UPSTREAM" });
  expect(events.some((event) => event.type === "end")).toBe(false);
});

test("every finish reason the table names still maps", async () => {
  // The positive control. A decoder refusing all four passes the two tests
  // above and serves nothing at all.
  const expected: ReadonlyArray<[string, StopReason]> = [
    ["stop", "endTurn"],
    ["length", "maxTokens"],
    ["tool_calls", "toolUse"],
    ["content_filter", "contentFilter"],
  ];

  for (const [reason, stopReason] of expected) {
    const events = await collect(
      decodeKiloChat(
        msgs(
          {
            event: "message",
            data: JSON.stringify({ choices: [{ delta: {}, finish_reason: reason }] }),
          },
          { event: "message", data: "[DONE]" },
        ),
      ),
    );
    expect([reason, events.at(-1)]).toMatchObject([reason, { type: "end", stopReason }]);
  }
});

test("an explicit null finish reason mid-stream is not a failure", async () => {
  // This wire spells "not finished yet" as `null` and sends it on nearly every
  // chunk. A guard reading absence as an unknown reason would fail every
  // request the moment it was written, which is the direction this must not be
  // wrong in.
  const events = await collect(
    decodeKiloChat(
      msgs(
        {
          event: "message",
          data: JSON.stringify({
            choices: [{ delta: { content: "partial" }, finish_reason: null }],
          }),
        },
        {
          event: "message",
          data: JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] }),
        },
        { event: "message", data: "[DONE]" },
      ),
    ),
  );

  expect(events.at(-1)).toMatchObject({ type: "end", stopReason: "endTurn" });
  expect(events.some((event) => event.type === "error")).toBe(false);
});

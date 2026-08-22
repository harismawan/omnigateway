import { expect, test } from "bun:test";
import { type ChatRequest, collect, type StreamEvent } from "@omni/ir";
import {
  anthropicAdapter,
  decodeAnthropic,
  decodeChat,
  toAnthropicWire,
  toChatWire,
  toResponsesWire,
} from "@omni/providers";
import { anthropicResponse, anthropicStream } from "../../src/egress/anthropic.ts";
import { openaiResponse, openaiStream } from "../../src/egress/openai.ts";
import { parseAnthropicRequest } from "../../src/ingress/anthropic.ts";
import { parseOpenAIRequest } from "../../src/ingress/openai.ts";

/**
 * Re-parses rendered SSE frames as if they had arrived from an upstream.
 *
 * The egress renderers emit `{event, data}` records, which is exactly what the
 * provider decoders consume, so a frame stream can be fed straight back in
 * without serializing to bytes and parsing them again.
 */
async function* replay(
  frames: AsyncGenerator<{ event: string; data: string }>,
): AsyncGenerator<{ event: string; data: string }> {
  for await (const f of frames) yield f;
}

async function drain(events: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

const RESPONSE: StreamEvent[] = [
  { type: "start", id: "msg_1", model: "claude-opus-4" },
  { type: "blockStart", index: 0, block: { type: "text" } },
  { type: "blockDelta", index: 0, delta: { type: "text", text: "Hello " } },
  { type: "blockDelta", index: 0, delta: { type: "text", text: "world" } },
  { type: "blockEnd", index: 0 },
  {
    type: "end",
    stopReason: "endTurn",
    usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
  },
];

const TOOL_RESPONSE: StreamEvent[] = [
  { type: "start", id: "msg_2", model: "claude-opus-4" },
  { type: "blockStart", index: 0, block: { type: "toolUse", id: "tu_1", name: "get_weather" } },
  { type: "blockDelta", index: 0, delta: { type: "toolJson", partial: '{"city":' } },
  { type: "blockDelta", index: 0, delta: { type: "toolJson", partial: '"SF"}' } },
  { type: "blockEnd", index: 0 },
  {
    type: "end",
    stopReason: "toolUse",
    usage: { inputTokens: 5, outputTokens: 7, cacheReadTokens: 0, cacheWriteTokens: 0 },
  },
];

async function* source(events: StreamEvent[]): AsyncGenerator<StreamEvent> {
  for (const e of events) yield e;
}

test("an anthropic response survives the round trip through anthropic egress", async () => {
  const back = await drain(decodeAnthropic(replay(anthropicStream(source(RESPONSE), "msg_1"))));
  expect(collect(back)).toEqual(collect(RESPONSE));
});

test("tool use survives the round trip through anthropic egress", async () => {
  const back = await drain(
    decodeAnthropic(replay(anthropicStream(source(TOOL_RESPONSE), "msg_2"))),
  );
  const [a, b] = [collect(back), collect(TOOL_RESPONSE)];
  expect(a.content).toEqual(b.content);
  expect(a.stopReason).toBe(b.stopReason);
});

test("a response survives the round trip through openai egress", async () => {
  const back = await drain(decodeChat(replay(openaiStream(source(RESPONSE), "msg_1", 0))));
  const [a, b] = [collect(back), collect(RESPONSE)];
  expect(a.content).toEqual(b.content);
  expect(a.stopReason).toBe(b.stopReason);
  expect(a.usage.inputTokens).toBe(b.usage.inputTokens);
  expect(a.usage.outputTokens).toBe(b.usage.outputTokens);
});

test("tool use survives the round trip through openai egress", async () => {
  const back = await drain(decodeChat(replay(openaiStream(source(TOOL_RESPONSE), "msg_2", 0))));
  expect(collect(back).content).toEqual(collect(TOOL_RESPONSE).content);
});

test("a non-streaming anthropic body carries the same content as the stream", () => {
  const body = anthropicResponse(collect(RESPONSE), "msg_1") as Record<string, unknown>;
  expect(body.content).toEqual([{ type: "text", text: "Hello world" }]);
  expect(body.usage).toEqual({
    input_tokens: 10,
    output_tokens: 2,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  });
});

test("a non-streaming openai body carries the same content as the stream", () => {
  const body = openaiResponse(collect(RESPONSE), "msg_1", 0) as {
    choices: { message: { content: string } }[];
    usage: { total_tokens: number };
  };
  expect(body.choices[0]?.message.content).toBe("Hello world");
  expect(body.usage.total_tokens).toBe(12);
});

const REQUEST: ChatRequest = {
  model: "claude-opus-4",
  system: [{ type: "text", text: "be terse" }],
  messages: [
    { role: "user", content: [{ type: "text", text: "weather in SF?" }] },
    {
      role: "assistant",
      content: [{ type: "toolUse", id: "tu_1", name: "get_weather", input: { city: "SF" } }],
    },
    {
      role: "user",
      content: [{ type: "toolResult", toolUseId: "tu_1", content: "sunny", isError: false }],
    },
  ],
  tools: [
    {
      provider: "custom",
      name: "get_weather",
      description: "look up weather",
      inputSchema: { type: "object", properties: { city: { type: "string" } } },
    },
  ],
  toolChoice: { type: "auto" },
  maxTokens: 1024,
  temperature: 0.5,
  stream: false,
};

test("a request survives ingress after anthropic encoding", () => {
  const { body } = toAnthropicWire(REQUEST, "claude-opus-4", { oauth: false });
  const back = parseAnthropicRequest(body);

  expect(back.messages).toEqual(REQUEST.messages);
  expect(back.system).toEqual(REQUEST.system);
  expect(back.tools).toEqual(REQUEST.tools);
  expect(back.toolChoice).toEqual(REQUEST.toolChoice);
  expect(back.maxTokens).toBe(1024);
  expect(back.temperature).toBe(0.5);
});

test("a request survives ingress after kimi encoding, minus what that format cannot hold", () => {
  const { body } = toChatWire(REQUEST, "kimi-k2");
  const back = parseOpenAIRequest(body);

  // The Chat Completions format carries the system prompt as a message rather
  // than a top-level field, and ingress puts it back where the IR expects it.
  expect(back.system).toEqual(REQUEST.system);
  expect(back.messages).toEqual(REQUEST.messages);
  expect(back.tools).toEqual(REQUEST.tools);
  expect(back.toolChoice).toEqual(REQUEST.toolChoice);
});

test("an image is reported as a degradation rather than silently dropped", () => {
  const withImage: ChatRequest = {
    model: "kimi-k2",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "what is this?" },
          { type: "image", mediaType: "image/png", data: "aGk=" },
        ],
      },
    ],
    stream: false,
  };

  const { body, degradations } = toChatWire(withImage, "kimi-k2");
  expect(degradations).toContain("kimi:images-dropped");

  // The text survives; only the image is gone, and the caller was told.
  const back = parseOpenAIRequest(body);
  expect(back.messages[0]?.content).toEqual([{ type: "text", text: "what is this?" }]);
});

test("the responses format round-trips a request through openai encoding", () => {
  const { body } = toResponsesWire(REQUEST, "gpt-5");
  // No ingress parser reads the Responses format — the gateway speaks Chat
  // Completions to clients — so this asserts the encoder's own invariants:
  // every IR message is represented, and nothing is invented.
  expect(Array.isArray(body.input)).toBe(true);
  expect(JSON.stringify(body.input)).toContain("weather in SF?");
  expect(JSON.stringify(body.input)).toContain("sunny");
  expect(body.tools?.[0]).toMatchObject({ name: "get_weather" });
});

/**
 * The Anthropic-native loop, end to end.
 *
 * A server tool run only works if the blocks survive every hop: upstream SSE ->
 * decoder -> client egress -> the client's stored history -> ingress -> encoder
 * -> upstream again. A single hop that drops or reshapes one block breaks the
 * continuation, and the failure shows up as a confused model rather than an
 * error, so the whole circuit is asserted at once.
 */
const NATIVE_UPSTREAM = [
  {
    event: "message_start",
    data: JSON.stringify({
      message: { id: "msg_3", model: "claude-opus-4", usage: { input_tokens: 5 } },
    }),
  },
  {
    event: "content_block_start",
    data: JSON.stringify({
      index: 0,
      content_block: { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: {} },
    }),
  },
  {
    event: "content_block_delta",
    data: JSON.stringify({
      index: 0,
      delta: { type: "input_json_delta", partial_json: '{"query":"bun"}' },
    }),
  },
  { event: "content_block_stop", data: JSON.stringify({ index: 0 }) },
  {
    event: "content_block_start",
    data: JSON.stringify({
      index: 1,
      content_block: {
        type: "web_search_tool_result",
        tool_use_id: "srvtoolu_1",
        content: [
          { type: "web_search_result", url: "https://x.test", encrypted_content: "OPAQUE" },
        ],
      },
    }),
  },
  { event: "content_block_stop", data: JSON.stringify({ index: 1 }) },
  {
    event: "message_delta",
    data: JSON.stringify({ delta: { stop_reason: "pause_turn" }, usage: { output_tokens: 4 } }),
  },
  { event: "message_stop", data: "{}" },
];

test("a paused server tool run survives the whole client round trip", async () => {
  async function* upstream(): AsyncGenerator<{ event: string; data: string }> {
    for (const m of NATIVE_UPSTREAM) yield m;
  }

  const decoded = await drain(decodeAnthropic(upstream()));
  const collected = collect(decoded);
  expect(collected.stopReason).toBe("pauseTurn");

  // What the client is handed for a non-streaming request.
  const rendered = anthropicResponse(collected, "req_1") as {
    content: Record<string, unknown>[];
    stop_reason: string;
  };
  expect(rendered.stop_reason).toBe("pause_turn");
  expect(rendered.content.map((b) => b.type)).toEqual([
    "server_tool_use",
    "web_search_tool_result",
  ]);

  // The client appends that turn verbatim and resends, which is the documented
  // way to continue a paused run — no synthetic `Continue` message.
  const resent = parseAnthropicRequest({
    model: "claude-opus-4",
    max_tokens: 64,
    messages: [
      { role: "user", content: "search" },
      { role: "assistant", content: rendered.content },
    ],
    tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }],
  });
  expect(resent.messages[1]?.content).toEqual(collected.content);

  // And the encoder puts the blocks back on the wire exactly as they arrived.
  const { body, degradations } = toAnthropicWire(resent, "claude-opus-4", { oauth: false });
  expect(degradations).toEqual([]);
  expect(body.messages[1]).toEqual({
    role: "assistant",
    content: [
      { id: "srvtoolu_1", name: "web_search", input: { query: "bun" }, type: "server_tool_use" },
      {
        tool_use_id: "srvtoolu_1",
        content: [
          { type: "web_search_result", url: "https://x.test", encrypted_content: "OPAQUE" },
        ],
        type: "web_search_tool_result",
      },
    ],
  });
  expect(body.tools).toEqual([{ type: "web_search_20250305", name: "web_search", max_uses: 5 }]);
});

test("the streaming path renders the same native blocks", async () => {
  async function* upstream(): AsyncGenerator<{ event: string; data: string }> {
    for (const m of NATIVE_UPSTREAM) yield m;
  }
  const frames: { event: string; data: unknown }[] = [];
  for await (const f of anthropicStream(decodeAnthropic(upstream()), "req_1")) {
    frames.push({ event: f.event, data: JSON.parse(f.data) as unknown });
  }
  const starts = frames.filter((f) => f.event === "content_block_start");
  expect(
    starts.map((f) => (f.data as { content_block: { type: string } }).content_block.type),
  ).toEqual(["server_tool_use", "web_search_tool_result"]);
});

test("beta names the client opted into survive to the request", () => {
  const req = parseAnthropicRequest(
    {
      model: "claude-opus-4",
      max_tokens: 16,
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "web_fetch_20250910", name: "web_fetch" }],
    },
    new Headers({ "anthropic-beta": "web-fetch-2025-09-10, context-management-2025-06-27" }),
  );
  expect(req.betas).toEqual(["web-fetch-2025-09-10", "context-management-2025-06-27"]);
});

/**
 * A request whose tool name the Anthropic OAuth leg renames, and the upstream
 * answer that comes back naming the alias rather than the client's own name.
 *
 * `SessionSearch` is what `session_search` derives to, so this fixture is the
 * upstream behaving exactly as it must: it only ever saw the alias, so that is
 * the only name it can call back with.
 */
const CLOAKED_REQUEST: ChatRequest = {
  model: "claude-opus-4",
  stream: true,
  messages: [{ role: "user", content: [{ type: "text", text: "find it" }] }],
  tools: [{ provider: "custom", name: "session_search", inputSchema: { type: "object" } }],
};

const ALIASED_UPSTREAM = [
  {
    event: "message_start",
    data: { type: "message_start", message: { id: "msg_3", model: "claude-opus-4" } },
  },
  {
    event: "content_block_start",
    data: {
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: "tu_9", name: "SessionSearch" },
    },
  },
  {
    event: "content_block_delta",
    data: {
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: "{}" },
    },
  },
  { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
  {
    event: "message_delta",
    data: {
      type: "message_delta",
      delta: { stop_reason: "tool_use" },
      usage: { input_tokens: 4, output_tokens: 5 },
    },
  },
];

/**
 * Runs the whole Anthropic OAuth leg and hands back both halves of the trip:
 * the tool names that went upstream, and the IR events that came back.
 *
 * Going through `anthropicAdapter.send` rather than through `toWire` and
 * `decodeAnthropic` separately is the point — the cloak is derived inside
 * `send`, so any test that builds one by hand proves nothing about whether the
 * adapter builds the same one for both directions.
 */
async function cloakedRoundTrip(): Promise<{ wireNames: string[]; events: StreamEvent[] }> {
  let wireNames: string[] = [];
  const result = await anthropicAdapter.send({
    request: CLOAKED_REQUEST,
    model: "claude-opus-4",
    credentials: { accessToken: "oauth-token", apiKey: null, providerData: {} },
    signal: new AbortController().signal,
    http: async (request) => {
      const body = JSON.parse(request.body) as { tools?: { name: string }[] };
      wireNames = (body.tools ?? []).map((t) => t.name);
      const sse = ALIASED_UPSTREAM.map(
        (f) => `event: ${f.event}\ndata: ${JSON.stringify(f.data)}\n\n`,
      ).join("");
      return {
        status: 200,
        headers: new Headers({ "content-type": "text/event-stream" }),
        body: new Response(sse).body as ReadableStream<Uint8Array>,
        text: async () => sse,
      };
    },
  });
  return { wireNames, events: await drain(result.events) };
}

async function renderedFrames(
  frames: AsyncGenerator<{ event: string; data: string }>,
): Promise<{ event: string; data: unknown }[]> {
  const out: { event: string; data: unknown }[] = [];
  for await (const f of frames) out.push({ event: f.event, data: JSON.parse(f.data) as unknown });
  return out;
}

test("the client sees its own tool name on the anthropic surface, never the alias", async () => {
  const { wireNames, events } = await cloakedRoundTrip();
  // The trip is only meaningful if the upstream really was told something else.
  expect(wireNames).toEqual(["SessionSearch"]);

  // Restored in the decoder, so the IR itself already holds the client's name.
  // Asserting on the IR and not only on the rendered frames is what separates
  // "restored at decode" from "restored at egress": the second would render
  // identically here while leaving every other reader of these events — RTK's
  // classification, the token estimate, the next turn's replayed history —
  // looking at a name the client never sent.
  const irStart = events.find((e) => e.type === "blockStart");
  expect(irStart).toMatchObject({ block: { name: "session_search" } });

  const frames = await renderedFrames(anthropicStream(source(events), "msg_3"));
  const start = frames.find((f) => f.event === "content_block_start");
  expect(start?.data).toMatchObject({ content_block: { name: "session_search" } });
  expect(JSON.stringify(frames)).not.toContain("SessionSearch");
});

test("the client sees its own tool name on the openai surface, never the alias", async () => {
  const { events } = await cloakedRoundTrip();
  const frames = await renderedFrames(openaiStream(source(events), "msg_3", 0));
  const names = frames.flatMap((f) => {
    const calls = (
      f.data as { choices?: { delta?: { tool_calls?: { function?: { name?: string } }[] } }[] }
    ).choices?.[0]?.delta?.tool_calls;
    return (calls ?? []).map((c) => c.function?.name).filter((n): n is string => n !== undefined);
  });
  expect(names).toContain("session_search");
  expect(JSON.stringify(frames)).not.toContain("SessionSearch");
});

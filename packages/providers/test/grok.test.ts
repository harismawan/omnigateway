import { expect, test } from "bun:test";
import type { ChatRequest, StreamEvent, ToolChoice } from "@omni/ir";
import { decodeGrokResponses } from "../src/grok/decode.ts";
import { grokDeviceHeaders, mintGrokDevice } from "../src/grok/device.ts";
import { grokAdapter } from "../src/grok/index.ts";
import { toGrokWire } from "../src/grok/wire.ts";
import type { SseMessage } from "../src/sse.ts";
import type { AdapterRequest, HeaderPair, HttpRequest } from "../src/types.ts";

const base: ChatRequest = {
  model: "smart",
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  stream: true,
};

async function* msgs(...m: SseMessage[]): AsyncGenerator<SseMessage> {
  for (const x of m) yield x;
}

async function collect(g: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of g) out.push(e);
  return out;
}

/** Runs the adapter against a stub transport and hands back the exact bytes. */
async function capture(over: Partial<AdapterRequest> = {}): Promise<HttpRequest> {
  let sent: HttpRequest | null = null;
  await grokAdapter.send({
    request: base,
    model: "grok-4.6",
    credentials: { accessToken: "oauth-token", apiKey: null, providerData: {} },
    signal: new AbortController().signal,
    ...over,
    http: async (request) => {
      sent = request;
      return {
        status: 200,
        headers: new Headers({ "content-type": "text/event-stream" }),
        body: new ReadableStream({ start: (controller) => controller.close() }),
        text: async () => "",
      };
    },
  });
  if (sent === null) throw new Error("adapter did not send a request");
  return sent;
}

function headerOf(req: HttpRequest, name: string): string | undefined {
  const lower = name.toLowerCase();
  return req.headers.find(([n]: HeaderPair) => n.toLowerCase() === lower)?.[1];
}

function bodyOf(req: HttpRequest): Record<string, unknown> {
  const parsed: unknown = JSON.parse(req.body);
  if (typeof parsed !== "object" || parsed === null) throw new Error("body is not an object");
  return parsed as Record<string, unknown>;
}

test("maps messages onto responses input items", () => {
  const { body } = toGrokWire(base, "grok-4.6");
  expect(body.model).toBe("grok-4.6");
  expect(body.input).toEqual([
    { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
  ]);
  expect(body.stream).toBe(true);
});

test("sets the three fields xAI's own client sets on every request", () => {
  const { body } = toGrokWire(base, "grok-4.6");
  // `store` defaults to true upstream, which breaks zero-data-retention and is
  // separately advised against for image requests.
  expect(body.store).toBe(false);
  expect(body.include).toEqual(["reasoning.encrypted_content"]);
  expect(typeof body.prompt_cache_key).toBe("string");
  expect(body.prompt_cache_key).not.toBe("");
});

test("keys the prompt cache on the stable prefix, not on the turn", () => {
  const first = toGrokWire({ ...base, system: [{ type: "text", text: "be terse" }] }, "grok-4.6");
  const later = toGrokWire(
    {
      ...base,
      system: [{ type: "text", text: "be terse" }],
      messages: [
        ...base.messages,
        { role: "assistant", content: [{ type: "text", text: "ok" }] },
        { role: "user", content: [{ type: "text", text: "more" }] },
      ],
    },
    "grok-4.6",
  );
  const other = toGrokWire({ ...base, system: [{ type: "text", text: "be verbose" }] }, "grok-4.6");

  // Affinity only pays off if a follow-up turn lands on the same server.
  expect(later.body.prompt_cache_key).toBe(first.body.prompt_cache_key);
  expect(other.body.prompt_cache_key).not.toBe(first.body.prompt_cache_key);
});

test("asks for a concise reasoning summary", () => {
  const { body } = toGrokWire({ ...base, reasoning: { mode: "adaptive", effort: "low" } }, "g");
  expect(body.reasoning).toEqual({ effort: "low", summary: "concise" });
});

test("forwards xhigh effort unclamped", () => {
  const { body, degradations } = toGrokWire(
    { ...base, reasoning: { mode: "adaptive", effort: "xhigh" } },
    "grok-4.6",
  );
  // xAI clamps server-side on models that lack the level; a second clamp here
  // could only get it wrong as the model line moves.
  expect(body.reasoning).toEqual({ effort: "xhigh", summary: "concise" });
  expect(degradations).toEqual([]);
});

test("forwards max effort unclamped", () => {
  const { body, degradations } = toGrokWire(
    { ...base, reasoning: { mode: "adaptive", effort: "max" } },
    "grok-4.6",
  );
  expect(body.reasoning).toEqual({ effort: "max", summary: "concise" });
  expect(degradations).toEqual([]);
});

test("records a lost budget instead of inventing an effort", () => {
  const { body, degradations } = toGrokWire(
    { ...base, reasoning: { mode: "budget", budgetTokens: 8000 } },
    "grok-4.6",
  );
  // These models think by default; mapping a budget onto an effort would
  // tune thinking to a depth no client asked for. Recorded, not mapped.
  expect(body.reasoning).toBeUndefined();
  expect(degradations).toContain("grok:reasoning-budget-dropped");
});

test("sends no reasoning at all when the client turned it off", () => {
  const { body } = toGrokWire({ ...base, reasoning: { mode: "off" } }, "grok-4.6");
  expect(body.reasoning).toBeUndefined();
});

test("keeps max_output_tokens and temperature on both routes", () => {
  // The OpenAI encoder drops these under OAuth because the *Codex* backend
  // rejects them. That has nothing to do with xAI, and the fork exists so the
  // constraint does not travel.
  const { body, degradations } = toGrokWire(
    { ...base, maxTokens: 2048, temperature: 0.4 },
    "grok-4.6",
  );
  expect(body.max_output_tokens).toBe(2048);
  expect(body.temperature).toBe(0.4);
  expect(degradations).toEqual([]);
});

test("never emits the parameters the proxy 400s on", () => {
  const { body } = toGrokWire(
    { ...base, temperature: 0.4, stopSequences: ["STOP"], maxTokens: 10 },
    "grok-4.6",
  );
  for (const field of [
    "presence_penalty",
    "frequency_penalty",
    "logprobs",
    "top_logprobs",
    "stop",
  ]) {
    expect(body[field]).toBeUndefined();
  }
});

test("truncates a tool list past the proxy's ceiling", () => {
  const tools: ChatRequest["tools"] = Array.from({ length: 250 }, (_, i) => ({
    kind: "portable" as const,
    name: `f${i}`,
    inputSchema: { type: "object" },
  }));
  const { body, degradations } = toGrokWire({ ...base, tools }, "grok-4.6");

  // Above 200 the proxy answers "Maximum tools limit reached", which is far
  // harder to diagnose than a recorded degradation.
  expect(body.tools).toHaveLength(200);
  expect(degradations).toContain("grok:tools-truncated");
});

test("records nothing when the tool list fits", () => {
  const tools: ChatRequest["tools"] = Array.from({ length: 200 }, (_, i) => ({
    kind: "portable" as const,
    name: `f${i}`,
    inputSchema: { type: "object" },
  }));
  const { body, degradations } = toGrokWire({ ...base, tools }, "grok-4.6");
  expect(body.tools).toHaveLength(200);
  expect(degradations).not.toContain("grok:tools-truncated");
});

test("round-trips a tool call and its result as top-level input items", () => {
  const { body, degradations } = toGrokWire(
    {
      ...base,
      messages: [
        {
          role: "assistant",
          content: [
            { type: "text", text: "looking" },
            { type: "toolUse", id: "call_1", name: "search", input: { q: "x" } },
          ],
        },
        { role: "user", content: [{ type: "toolResult", toolUseId: "call_1", content: "found" }] },
      ],
    },
    "grok-4.6",
  );

  // Both halves are siblings of the message items, not content inside one, and
  // the call has to be flushed out of the surrounding message in order. Losing
  // the result half leaves the model an unanswered call it will keep retrying.
  expect(body.input).toEqual([
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "looking" }] },
    { type: "function_call", call_id: "call_1", name: "search", arguments: '{"q":"x"}' },
    { type: "function_call_output", call_id: "call_1", output: "found" },
  ]);
  expect(degradations).toEqual([]);
});

test("serializes a tool result carrying a broken escape sequence as valid JSON", () => {
  // The proxy answers `input[N].output: unexpected end of hex escape` when the
  // body is not strictly valid JSON, so a tool result holding a bare backslash
  // or a truncated \u sequence has to survive the serializer unchanged.
  const content = "path C:\\temp and a truncated \\u00 tail";
  const { body } = toGrokWire(
    {
      ...base,
      messages: [{ role: "user", content: [{ type: "toolResult", toolUseId: "call_1", content }] }],
    },
    "grok-4.6",
  );

  const reparsed: unknown = JSON.parse(JSON.stringify(body));
  const input = (reparsed as { input: { type: string; output?: string }[] }).input;
  const output = input.find((item) => item.type === "function_call_output");
  expect(output?.output).toBe(content);
});

test("encodes every tool_choice form in the proxy's own spelling", () => {
  const encoded = (choice: ToolChoice): unknown =>
    toGrokWire({ ...base, toolChoice: choice }, "grok-4.6").body.tool_choice;

  // The IR uses neither vendor's word, so `any` -> `required` is a translation
  // and not a rename: sending `auto` instead lets the model answer with prose
  // where the client demanded a call.
  expect(encoded({ type: "auto" })).toBe("auto");
  expect(encoded({ type: "any" })).toBe("required");
  expect(encoded({ type: "none" })).toBe("none");
  expect(encoded({ type: "tool", name: "search" })).toEqual({ type: "function", name: "search" });
  expect(toGrokWire(base, "grok-4.6").body.tool_choice).toBeUndefined();
});

test("keeps a mid-conversation system turn where the client put it", () => {
  const { body, degradations } = toGrokWire(
    {
      ...base,
      messages: [
        { role: "user", content: [{ type: "text", text: "hi" }] },
        { role: "system", content: [{ type: "text", text: "be brief" }] },
        { role: "user", content: [{ type: "text", text: "more" }] },
      ],
    },
    "grok-4.6",
  );

  // A system turn applies from its position forward, so folding it into
  // `instructions` would move it to the front of the history and change when it
  // takes effect. No xAI source says the proxy accepts a `system` role inside
  // `input`, so it keeps its slot as a marked user turn instead.
  expect(body.input).toEqual([
    { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
    {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "<system-reminder>\nbe brief\n</system-reminder>" }],
    },
    { type: "message", role: "user", content: [{ type: "input_text", text: "more" }] },
  ]);
  expect(body.instructions).toBeUndefined();
  expect(degradations).toContain("grok:system-turn-inlined");
});

test("encodes an image with image_url as a plain string", () => {
  const { body, degradations } = toGrokWire(
    {
      ...base,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "look" },
            { type: "image", mediaType: "image/jpeg", data: "AAAA" },
          ],
        },
      ],
    },
    "grok-4.6",
  );

  // xAI takes the data URL directly; OpenAI's `{ url: … }` object shape is the
  // one difference a copy-paste fork could silently get wrong.
  expect(body.input[0]).toEqual({
    type: "message",
    role: "user",
    content: [
      { type: "input_text", text: "look" },
      { type: "input_image", image_url: "data:image/jpeg;base64,AAAA" },
    ],
  });
  const image = (body.input[0] as { content: { image_url?: unknown }[] }).content[1];
  expect(typeof image?.image_url).toBe("string");
  expect(degradations).toEqual([]);
});

test("drops thinking blocks with a degradation", () => {
  const { body, degradations } = toGrokWire(
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
    "grok-4.6",
  );
  expect(body.input).toEqual([
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] },
  ]);
  expect(degradations).toContain("grok:thinking-dropped");
});

test("records an anthropic-native block the router should never have sent here", () => {
  const { degradations } = toGrokWire(
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
              data: {},
            },
          ],
        },
      ],
    },
    "grok-4.6",
  );
  expect(degradations).toContain("grok:anthropic-native-block-dropped");
});

test("merges the vendor passthrough last", () => {
  const { body } = toGrokWire(
    { ...base, vendor: { grok: { store: true, search_parameters: { mode: "auto" } } } },
    "grok-4.6",
  );
  // The operator's own escape hatch, deliberately unfiltered.
  expect(body.store).toBe(true);
  expect(body.search_parameters).toEqual({ mode: "auto" });
});

test("records that a 1m request could not be honoured here", () => {
  const { degradations } = toGrokWire({ ...base, betas: ["context-1m-2025-08-07"] }, "grok-4.6");
  expect(degradations).toContain("grok:context-1m-dropped");
});

test("decodes a text response stream", async () => {
  const events = await collect(
    decodeGrokResponses(
      msgs(
        {
          event: "response.created",
          data: JSON.stringify({ response: { id: "resp_1", model: "grok-4.6" } }),
        },
        {
          event: "response.content_part.added",
          data: JSON.stringify({
            output_index: 0,
            content_index: 0,
            part: { type: "output_text" },
          }),
        },
        {
          event: "response.output_text.delta",
          data: JSON.stringify({ output_index: 0, content_index: 0, delta: "Hel" }),
        },
        {
          event: "response.output_text.delta",
          data: JSON.stringify({ output_index: 0, content_index: 0, delta: "lo" }),
        },
        {
          event: "response.content_part.done",
          data: JSON.stringify({ output_index: 0, content_index: 0 }),
        },
        {
          event: "response.completed",
          data: JSON.stringify({ response: { status: "completed", usage: {} } }),
        },
      ),
    ),
  );

  expect(events[0]).toEqual({ type: "start", id: "resp_1", model: "grok-4.6" });
  expect(events[1]).toEqual({ type: "blockStart", index: 0, block: { type: "text" } });
  expect(events[2]).toEqual({ type: "blockDelta", index: 0, delta: { type: "text", text: "Hel" } });
  expect(events[4]).toEqual({ type: "blockEnd", index: 0 });
  expect(events.at(-1)).toMatchObject({ type: "end", stopReason: "endTurn" });
});

test("decodes reasoning deltas onto thinking blocks", async () => {
  const events = await collect(
    decodeGrokResponses(
      msgs(
        {
          event: "response.output_item.added",
          data: JSON.stringify({ output_index: 0, item: { type: "reasoning" } }),
        },
        {
          event: "response.reasoning_summary_text.delta",
          data: JSON.stringify({ output_index: 0, delta: "thinking" }),
        },
        { event: "response.output_item.done", data: JSON.stringify({ output_index: 0 }) },
        {
          event: "response.completed",
          data: JSON.stringify({ response: { status: "completed", usage: {} } }),
        },
      ),
    ),
  );
  expect(events[0]).toEqual({ type: "blockStart", index: 0, block: { type: "thinking" } });
  expect(events[1]).toEqual({
    type: "blockDelta",
    index: 0,
    delta: { type: "thinking", text: "thinking" },
  });
  expect(events[2]).toEqual({ type: "blockEnd", index: 0 });
});

test("decodes function call items with argument deltas", async () => {
  const events = await collect(
    decodeGrokResponses(
      msgs(
        {
          event: "response.output_item.added",
          data: JSON.stringify({
            output_index: 0,
            item: { type: "function_call", call_id: "call_1", name: "f" },
          }),
        },
        {
          event: "response.function_call_arguments.delta",
          data: JSON.stringify({ output_index: 0, delta: '{"a":1}' }),
        },
        { event: "response.output_item.done", data: JSON.stringify({ output_index: 0 }) },
        {
          event: "response.completed",
          data: JSON.stringify({ response: { status: "completed", usage: {} } }),
        },
      ),
    ),
  );
  expect(events[0]).toEqual({
    type: "blockStart",
    index: 0,
    block: { type: "toolUse", id: "call_1", name: "f" },
  });
  expect(events[1]).toEqual({
    type: "blockDelta",
    index: 0,
    delta: { type: "toolJson", partial: '{"a":1}' },
  });
  expect(events.at(-1)).toMatchObject({ type: "end", stopReason: "toolUse" });
});

test("maps an incomplete response with a token cap onto maxTokens", async () => {
  const events = await collect(
    decodeGrokResponses(
      msgs({
        event: "response.incomplete",
        data: JSON.stringify({
          response: {
            status: "incomplete",
            incomplete_details: { reason: "max_output_tokens" },
            usage: {},
          },
        }),
      }),
    ),
  );
  expect(events[0]).toMatchObject({ type: "end", stopReason: "maxTokens" });
});

test("fails visibly on an incomplete response with an unrecognized reason", async () => {
  const events = await collect(
    decodeGrokResponses(
      msgs({
        event: "response.incomplete",
        data: JSON.stringify({
          response: {
            status: "incomplete",
            incomplete_details: { reason: "ran_out_of_goodwill" },
            usage: {},
          },
        }),
      }),
    ),
  );
  expect(events).toEqual([
    {
      type: "error",
      code: "UPSTREAM",
      message: 'unrecognized xAI incomplete reason "ran_out_of_goodwill"',
      retryable: false,
    },
  ]);
});

test("fails visibly on an incomplete response that names no reason", async () => {
  const events = await collect(
    decodeGrokResponses(
      msgs({
        event: "response.incomplete",
        data: JSON.stringify({ response: { status: "incomplete", usage: {} } }),
      }),
    ),
  );
  expect(events).toEqual([
    {
      type: "error",
      code: "UPSTREAM",
      message: "xAI reported the response incomplete without a reason",
      retryable: false,
    },
  ]);
});

test("fails visibly on a bare response.incomplete event with an empty payload", async () => {
  // The payload arms cannot see this one: no status, no details, no `response`
  // at all. The event's own name is the only thing left saying the turn was
  // cut, which is why the guard keeps it as a backstop.
  const events = await collect(
    decodeGrokResponses(msgs({ event: "response.incomplete", data: "{}" })),
  );
  expect(events).toEqual([
    {
      type: "error",
      code: "UPSTREAM",
      message: "xAI reported the response incomplete without a reason",
      retryable: false,
    },
  ]);
});

test("fails visibly on a terminal status that is neither completed nor incomplete", async () => {
  const events = await collect(
    decodeGrokResponses(
      msgs({
        event: "response.completed",
        data: JSON.stringify({ response: { status: "cancelled", usage: {} } }),
      }),
    ),
  );
  expect(events).toEqual([
    {
      type: "error",
      code: "UPSTREAM",
      message: 'xAI reported terminal response status "cancelled"',
      retryable: false,
    },
  ]);
});

test("an unrecognized reason fails even when the status claims completed", async () => {
  // What keeps the reason arm load-bearing: every other unknown-reason fixture
  // also says `status: "incomplete"`, so the status arm alone would satisfy
  // all of them and deleting the reason check would go unnoticed.
  const events = await collect(
    decodeGrokResponses(
      msgs({
        event: "response.completed",
        data: JSON.stringify({
          response: { status: "completed", incomplete_details: { reason: "weird" }, usage: {} },
        }),
      }),
    ),
  );
  expect(events).toEqual([
    {
      type: "error",
      code: "UPSTREAM",
      message: 'unrecognized xAI incomplete reason "weird"',
      retryable: false,
    },
  ]);
});

test("a known event the decoder ignores does not end the stream", async () => {
  // What makes the set an allowlist rather than a restatement of the switch.
  // Written from the switch instead, every one of these would fail — and the
  // failure would be a real xAI turn refused by its own gateway.
  const ignored = [
    "response.queued",
    "response.in_progress",
    "response.output_text.done",
    "response.output_text.annotation.added",
    "response.refusal.delta",
    "response.refusal.done",
    "response.reasoning_summary_part.added",
    "response.reasoning_summary_part.done",
    "response.reasoning_summary_text.done",
    "response.reasoning_text.done",
    "response.function_call_arguments.done",
  ];

  for (const event of ignored) {
    const events = await collect(
      decodeGrokResponses(
        msgs(
          { event, data: JSON.stringify({ output_index: 0 }) },
          {
            event: "response.completed",
            data: JSON.stringify({ response: { status: "completed", usage: {} } }),
          },
        ),
      ),
    );
    expect([event, events.at(-1)?.type]).toEqual([event, "end"]);
  }
});

test("a prototype-key error code still classifies as UPSTREAM", async () => {
  // `ERROR_CODE` is an ordinary literal, so `code: "constructor"` used to read
  // the Object constructor back out — truthy, so `?? "UPSTREAM"` never fired
  // and a function landed in a typed ErrorCode field.
  const events = await collect(
    decodeGrokResponses(
      msgs({
        event: "error",
        data: JSON.stringify({ error: { code: "constructor", message: "boom" } }),
      }),
    ),
  );
  expect(events).toEqual([{ type: "error", code: "UPSTREAM", message: "boom", retryable: true }]);
});

test("a [DONE] sentinel alone is skipped, never read as completion", async () => {
  // The openai fork carries this pin and this fork did not, which is how a
  // sweep stops one site short: the skip guard here is byte-identical, and a
  // mutant making the sentinel terminal reported a clean short stream.
  const events = await collect(decodeGrokResponses(msgs({ event: "message", data: "[DONE]" })));
  expect(events).toEqual([
    {
      type: "error",
      code: "UPSTREAM",
      message: "upstream stream ended before response completion",
      retryable: true,
    },
  ]);
});

test("a response.completed with no status at all still ends clean", async () => {
  // Pins the guard's deliberate leniency: the status arm asks
  // `status !== undefined && status !== "completed"`, and dropping the first
  // half turns absent-status streams from compatible proxies into refusals.
  const events = await collect(
    decodeGrokResponses(
      msgs({ event: "response.completed", data: JSON.stringify({ response: { usage: {} } }) }),
    ),
  );
  expect(events.at(-1)).toMatchObject({ type: "end", stopReason: "endTurn" });
});

test("subtracts xAI's cached tokens out of the prompt total", async () => {
  const events = await collect(
    decodeGrokResponses(
      msgs({
        event: "response.completed",
        data: JSON.stringify({
          response: {
            status: "completed",
            usage: {
              input_tokens: 10,
              output_tokens: 5,
              input_tokens_details: { cached_tokens: 4 },
            },
          },
        }),
      }),
    ),
  );
  // xAI counts cached tokens *inside* input_tokens, the reverse of Anthropic's
  // disjoint classes. Leaving them in bills those tokens twice on every request.
  expect(events.at(-1)).toEqual({
    type: "end",
    stopReason: "endTurn",
    usage: { inputTokens: 6, outputTokens: 5, cacheReadTokens: 4, cacheWriteTokens: 0 },
  });
});

test("fails visibly on an SSE event it does not know", async () => {
  const events = await collect(
    decodeGrokResponses(
      msgs(
        {
          event: "response.created",
          data: JSON.stringify({ response: { id: "resp_1", model: "grok-4.6" } }),
        },
        { event: "response.tool_call.invented", data: JSON.stringify({ output_index: 0 }) },
        {
          event: "response.completed",
          data: JSON.stringify({ response: { status: "completed", usage: {} } }),
        },
      ),
    ),
  );

  // No authoritative enumeration of xAI's event set exists, so a surprise is
  // reported rather than skipped: skipping would drop content silently.
  expect(events.at(-1)).toMatchObject({ type: "error", code: "UPSTREAM" });
  expect(events.some((e) => e.type === "end")).toBe(false);
});

test("fails visibly on an unknown SSE event whose data is not JSON", async () => {
  const events = await collect(
    decodeGrokResponses(
      msgs(
        {
          event: "response.created",
          data: JSON.stringify({ response: { id: "resp_1", model: "grok-4.6" } }),
        },
        { event: "response.tool_call.invented", data: "not json at all" },
        {
          event: "response.completed",
          data: JSON.stringify({ response: { status: "completed", usage: {} } }),
        },
      ),
    ),
  );

  // Parsing before checking the event name would let an unrecognized event hide
  // behind its own payload: the stream would end clean and short, which is the
  // exact silent-truncation this decoder refuses.
  expect(events.at(-1)).toMatchObject({ type: "error", code: "UPSTREAM" });
  expect(events.some((e) => e.type === "end")).toBe(false);
});

test("accepts the [DONE] sentinel instead of reading it as an unknown event", async () => {
  const events = await collect(
    decodeGrokResponses(
      msgs(
        {
          event: "response.completed",
          data: JSON.stringify({ response: { status: "completed", usage: {} } }),
        },
        // `parseSse` names an unlabelled record "message", so the transport
        // sentinel would otherwise arrive as an event outside the known set.
        { event: "message", data: "[DONE]" },
      ),
    ),
  );
  expect(events.at(-1)).toMatchObject({ type: "end", stopReason: "endTurn" });
  expect(events.some((e) => e.type === "error")).toBe(false);
});

test("emits UPSTREAM when EOF arrives before response completion", async () => {
  const events = await collect(
    decodeGrokResponses(
      msgs({
        event: "response.output_text.delta",
        data: JSON.stringify({ output_index: 0, content_index: 0, delta: "partial" }),
      }),
    ),
  );
  expect(events.at(-1)).toMatchObject({ type: "error", code: "UPSTREAM" });
});

test("turns a response.failed event into an error event", async () => {
  const events = await collect(
    decodeGrokResponses(
      msgs({
        event: "response.failed",
        data: JSON.stringify({
          response: { error: { code: "rate_limit_exceeded", message: "slow down" } },
        }),
      }),
    ),
  );
  expect(events[0]).toEqual({
    type: "error",
    code: "RATE_LIMIT",
    message: "slow down",
    retryable: true,
  });
});

test("routes an OAuth credential to the cli chat proxy", async () => {
  const sent = await capture({
    credentials: { accessToken: "oauth-token", apiKey: null, providerData: {} },
  });

  // Crossing the two hosts is the single easiest way to break this provider:
  // an OAuth bearer sent to api.x.ai bills API credits and returns 402 even on
  // a healthy subscription.
  expect(sent.url).toBe("https://cli-chat-proxy.grok.com/v1/responses");
  expect(headerOf(sent, "Authorization")).toBe("Bearer oauth-token");
  expect(headerOf(sent, "X-XAI-Token-Auth")).toBe("xai-grok-cli");
  expect(headerOf(sent, "x-authenticateresponse")).toBe("authenticate-response");
});

test("routes an API key to api.x.ai without the proxy-only headers", async () => {
  const sent = await capture({
    credentials: { accessToken: null, apiKey: "xai-key", providerData: {} },
  });

  expect(sent.url).toBe("https://api.x.ai/v1/responses");
  expect(headerOf(sent, "Authorization")).toBe("Bearer xai-key");
  expect(headerOf(sent, "X-XAI-Token-Auth")).toBeUndefined();
  expect(headerOf(sent, "x-authenticateresponse")).toBeUndefined();
});

test("rejects a credential carrying neither token form", async () => {
  await expect(
    capture({ credentials: { accessToken: null, apiKey: null, providerData: {} } }),
  ).rejects.toThrow(/token/);
});

test("derives the per-request ids from the gateway request id", async () => {
  const sent = await capture({ requestId: "req-abc" });

  expect(headerOf(sent, "x-grok-req-id")).toBe("req-abc");
  const conv = headerOf(sent, "x-grok-conv-id");
  const session = headerOf(sent, "x-grok-session-id");
  // xAI's client sets conv-id to the session id for main turns.
  expect(conv).toBe(session as string);
  expect(conv).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  expect(headerOf(sent, "x-grok-model-override")).toBe("grok-4.6");

  // Derived, never minted, so the same request id always produces the same ids.
  const again = await capture({ requestId: "req-abc" });
  expect(headerOf(again, "x-grok-conv-id")).toBe(conv as string);
  const other = await capture({ requestId: "req-xyz" });
  expect(headerOf(other, "x-grok-conv-id")).not.toBe(conv as string);
});

test("omits the conversation ids rather than inventing one", async () => {
  const sent = await capture();
  expect(headerOf(sent, "x-grok-req-id")).toBeUndefined();
  expect(headerOf(sent, "x-grok-conv-id")).toBeUndefined();
  expect(headerOf(sent, "x-grok-session-id")).toBeUndefined();
  // The model override needs no request id and is always sent.
  expect(headerOf(sent, "x-grok-model-override")).toBe("grok-4.6");
});

test("sends the device identity frozen onto the credential", async () => {
  const sent = await capture({
    credentials: { accessToken: "t", apiKey: null, providerData: { agentId: "agent-1" } },
  });
  expect(headerOf(sent, "x-grok-agent-id")).toBe("agent-1");
});

test("emits no device header for a credential that predates it", async () => {
  const sent = await capture();
  expect(headerOf(sent, "x-grok-agent-id")).toBeUndefined();
});

test("mints a synthetic-but-stable agent id", () => {
  const a = mintGrokDevice();
  expect(a.agentId).toMatch(/^[0-9a-f-]{36}$/);
  expect(mintGrokDevice().agentId).not.toBe(a.agentId);
  expect(grokDeviceHeaders(a)).toEqual([["x-grok-agent-id", a.agentId]]);
  expect(grokDeviceHeaders({})).toEqual([]);
});

test("asks for SSE even when the client did not", async () => {
  const sent = await capture({ request: { ...base, stream: false } });
  // Non-streaming client requests are served by collecting the stream in
  // dispatch, so the upstream request always streams.
  expect(bodyOf(sent).stream).toBe(true);
  expect(headerOf(sent, "Accept")).toBe("text/event-stream");
});

test("serializes the body in the profile's field order", async () => {
  const sent = await capture({ request: { ...base, system: [{ type: "text", text: "s" }] } });
  const keys = Object.keys(bodyOf(sent));
  // `reasoning` sits between `store` and `prompt_cache_key` when present; this
  // request asks for none, and an absent field is skipped rather than emitted.
  expect(keys).toEqual([
    "model",
    "stream",
    "input",
    "instructions",
    "store",
    "prompt_cache_key",
    "include",
  ]);
});

test("orders the grok headers ahead of the appended ones", async () => {
  const sent = await capture({
    requestId: "req-abc",
    credentials: { accessToken: "t", apiKey: null, providerData: { agentId: "agent-1" } },
  });
  const names = sent.headers.map(([n]: HeaderPair) => n.toLowerCase());

  expect(names.indexOf("authorization")).toBeLessThan(names.indexOf("x-xai-token-auth"));
  expect(names.indexOf("x-grok-client-identifier")).toBeLessThan(names.indexOf("user-agent"));
  for (const name of ["x-grok-agent-id", "x-grok-req-id", "x-grok-conv-id", "x-grok-session-id"]) {
    expect(names.indexOf(name)).toBeGreaterThan(-1);
    expect(names.indexOf(name)).toBeLessThan(names.indexOf("user-agent"));
  }
});

test("decodes the stream the adapter returns", async () => {
  const sse = [
    'event: response.created\ndata: {"response":{"id":"r1","model":"grok-4.6"}}\n\n',
    'event: response.completed\ndata: {"response":{"status":"completed","usage":{"input_tokens":3,"output_tokens":2}}}\n\n',
  ].join("");

  const { events, degradations } = await grokAdapter.send({
    request: base,
    model: "grok-4.6",
    credentials: { accessToken: null, apiKey: "xai-key", providerData: {} },
    signal: new AbortController().signal,
    http: async () => ({
      status: 200,
      headers: new Headers({ "content-type": "text/event-stream" }),
      body: new ReadableStream({
        start: (controller) => {
          controller.enqueue(new TextEncoder().encode(sse));
          controller.close();
        },
      }),
      text: async () => "",
    }),
  });

  expect(degradations).toEqual([]);
  const collected = await collect(events);
  expect(collected[0]).toEqual({ type: "start", id: "r1", model: "grok-4.6" });
  expect(collected.at(-1)).toMatchObject({
    type: "end",
    usage: { inputTokens: 3, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
  });
});

test("surfaces an upstream rejection as a typed error", async () => {
  await expect(
    grokAdapter.send({
      request: base,
      model: "grok-4.6",
      credentials: { accessToken: null, apiKey: "xai-key", providerData: {} },
      signal: new AbortController().signal,
      http: async () => ({
        status: 402,
        headers: new Headers({ "content-type": "application/json" }),
        body: null,
        text: async () => JSON.stringify({ error: { message: "payment required" } }),
      }),
    }),
  ).rejects.toThrow();
});

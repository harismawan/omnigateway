import { anthropicResponse } from "../../../apps/gateway/src/egress/anthropic.ts";
import { openaiResponse } from "../../../apps/gateway/src/egress/openai.ts";
import { responsesResponse } from "../../../apps/gateway/src/egress/responses.ts";
import { collect } from "../../../packages/ir/src/index.ts";
import { decodeResponses } from "../../../packages/providers/src/openai/decode.ts";
import { parseSse } from "../../../packages/providers/src/sse.ts";

const m = (e: string, d: unknown) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`,
  end = m("response.completed", {}),
  cases: { name: string; wire: string; native: boolean }[] = [];
const add = (name: string, wire: string, native = false, raw?: number[]) =>
  cases.push({ name, wire, native, raw });
const start = m("response.content_part.added", { part: { type: "output_text" } }),
  delta = m("response.output_text.delta", { delta: '🌍é\u2028\u2029\0\\"' }),
  done = m("response.content_part.done", {});
const source = await Bun.file(
  new URL("../../../packages/providers/src/openai/decode.ts", import.meta.url),
).text();
for (const e of [...source.matchAll(/^ {2}"((?:response\.|keepalive|error)[^"]*)",$/gm)].map(
  (x) => x[1],
))
  for (const d of [
    {},
    { delta: "value", item: { type: "unknown" }, part: { type: "refusal" } },
    [],
    null,
    42,
  ])
    add("coverage:" + e, m(e, d) + end);
for (const w of [
  "",
  ":heartbeat\n\n",
  "data: [DONE]\n\n",
  end + end,
  end + start + delta + done,
  delta + m("response.created", { response: { id: "late" } }) + end,
  m("response.output_item.done", { item: { type: "function_call", arguments: "{}" } }) + end,
  start + delta + done,
  "event: response.output_text.delta\ndata: {bad}\n\n" + end,
])
  add("order", w);
for (const native of [false, true])
  for (const item of [
    { type: "reasoning" },
    { type: "reasoning", summary: [{ type: "summary_text", text: "why" }] },
    { type: "reasoning", encrypted_content: "secret" },
    { type: "reasoning", encrypted_content: "secret", summary: [] },
  ])
    add(
      "reasoning",
      m("response.output_item.added", { item }) +
        m("response.reasoning_summary_text.delta", { delta: "why" }) +
        m("response.output_item.done", { item }) +
        end,
      native,
    );
for (const type of [
  "web_search_call",
  "file_search_call",
  "code_interpreter_call",
  "computer_call",
  "image_generation_call",
  "mcp_call",
  "unknown",
]) {
  add(
    type,
    m("response.output_item.added", { item: { type } }) +
      m("response.output_item.done", { item: { type, output: "x" } }) +
      end,
    true,
  );
  add(type + "-event", m("response." + type + ".completed", {}) + end);
}
for (const args of ["", "{bad", "{}", '{"x":1}', "null"])
  for (const streamed of [false, true])
    add(
      "tool",
      m("response.output_item.added", { item: { type: "function_call" } }) +
        (streamed
          ? m("response.function_call_arguments.delta", { delta: args.slice(0, 2) }) +
            m("response.function_call_arguments.delta", { delta: args.slice(2) })
          : "") +
        m("response.function_call_arguments.done", { arguments: args }) +
        m("response.output_item.done", { item: { type: "function_call", arguments: args } }) +
        end,
    );
add(
  "interleaved",
  [0, 1]
    .map((output_index) =>
      m("response.output_item.added", {
        output_index,
        item: { type: "function_call", name: "f", call_id: `c${output_index}` },
      }),
    )
    .join("") +
    [1, 0, 1, 0]
      .map((output_index) =>
        m("response.function_call_arguments.delta", { output_index, delta: " " }),
      )
      .join("") +
    [1, 0]
      .map((output_index) =>
        m("response.output_item.done", { output_index, item: { type: "function_call" } }),
      )
      .join("") +
    end,
);
for (const event of ["response.completed", "response.incomplete"])
  for (const reason of [undefined, null, "max_output_tokens", "content_filter", "other", 0, {}, []])
    add("reason", m(event, { response: { incomplete_details: { reason } } }));
for (const event of ["response.failed", "error"])
  for (const error of [
    undefined,
    null,
    {},
    "bad",
    42,
    { code: 429, message: 12, status: 429 },
    { type: "rate_limit_exceeded", message: ["a", "b"] },
    { code: "constructor", message: {} },
    { code: "server_error", message: false },
    { code: "invalid_api_key", message: "secret" },
    { error: { code: "invalid_api_key", message: "nested" } },
    { code: "content_policy_violation" },
    { code: "context_length_exceeded" },
    { code: "insufficient_quota" },
  ])
    for (const nested of [false, true])
      add(
        "error",
        m(event, nested ? { response: { error }, status: 500 } : { error, status: 401 }) + delta,
      );
for (const field of ["input_tokens", "output_tokens", "cached_tokens", "reasoning_tokens"])
  for (const value of [undefined, null, 0, -1, 0.125, 9007199254740994, 1e100]) {
    const usage: Record<string, unknown> = {
      input_tokens: 10,
      output_tokens: 2,
      input_tokens_details: {},
      output_tokens_details: {},
    };
    if (field === "cached_tokens") usage.input_tokens_details[field] = value;
    else if (field === "reasoning_tokens") usage.output_tokens_details[field] = value;
    else usage[field] = value;
    add("usage", m("response.completed", { response: { usage } }));
  }
for (const n of ["9007199254740993", "1e309", "-1e309", "-0", "1e-999", "1.234567890123456789"]) {
  add(
    "numeric-delta",
    start + `event: response.output_text.delta\ndata: {"delta":${n}}\n\n` + done + end,
  );
  add(
    "numeric-native",
    m("response.output_item.added", { item: { type: "reasoning" } }) +
      `event: response.output_item.done\ndata: {"item":{"type":"reasoning","n":${n}}}\n\n` +
      end,
    true,
  );
}
for (const newline of ["\n", "\r\n", "\r"])
  add("newline", (start + delta + done + end).replaceAll("\n", newline));
for (const wire of [
  "\ufeff" + start + delta + done + end,
  (start + delta + done + end).replaceAll(": ", ":"),
  'event: response.output_text.delta\ndata: {\ndata: "delta":"multi"}\n\n' + end,
  'data: {"type":"response.completed"}\n\n',
  'event: response.output_text.delta\nid: 1\nretry: 5\ndata: {"type":"response.failed","delta":"ok"}\n\n' +
    end,
  "\n\n\n" + end,
])
  add("framing", wire);
for (const raw of [[255], [0xc0, 0xaf], [0xed, 0xa0, 0x80], [0xf0, 0x9f], [0xe2, 0x28, 0xa1]])
  add("invalid-utf8", "", false, [
    ...new TextEncoder().encode(start + 'event: response.output_text.delta\ndata: {"delta":"'),
    ...raw,
    ...new TextEncoder().encode('"}\n\n' + done + end),
  ]);
for (const raw of [[0xf0], [0xe2, 0x82]])
  add("trailing-utf8", "", false, [...new TextEncoder().encode(end), ...raw]);
// The two ~10 MiB cap streams stay in the review evidence, not the ordinary corpus.
for (const v of [{ toString: null }, { toString: 1 }, { toString: [], valueOf: 0 }]) {
  add("shadow-coercion", start + m("response.output_text.delta", { delta: v }) + end);
  add("shadow-error", m("error", { error: { message: v } }));
}
add(
  "overflow-usage",
  'event: response.completed\ndata: {"response":{"usage":{"output_tokens":1e309}}}\n\n',
);
add(
  "overflow-ignored",
  'event: response.output_text.delta\ndata: {"delta":"keep me","ignored":1e309}\n\n' + end,
);
const rows = [];
for (const c of cases) {
  // The six shadows and six overflows are already in the primary reference.
  if (c.name.startsWith("shadow-") || c.wire.includes("1e309")) continue;
  const bytes = c.raw ? new Uint8Array(c.raw) : new TextEncoder().encode(c.wire);
  let expected: string | undefined;
  for (const chunk of [bytes.length || 1, 1, 7, 13]) {
    const events: import("../../../packages/ir/src/index.ts").StreamEvent[] = [];
    const body = new ReadableStream({
      start(controller) {
        for (let i = 0; i < bytes.length; i += chunk) controller.enqueue(bytes.slice(i, i + chunk));
        controller.close();
      },
    });
    for await (const e of decodeResponses(parseSse(body), { nativeReasoning: c.native }))
      events.push(e);
    const collected = collect(events);
    const json = [
      anthropicResponse(collected, "req"),
      openaiResponse(collected, "req", 123),
      responsesResponse(collected, { requestId: "req", created: 123, customToolNames: new Set() }),
    ].map(JSON.stringify);
    const result = JSON.stringify({ events, json });
    if (expected !== undefined && expected !== result) throw new Error("chunk dependence");
    expected = result;
  }
  rows.push({ ...c, category: "review:" + c.name, ...JSON.parse(expected!) });
}
console.log(JSON.stringify(rows));

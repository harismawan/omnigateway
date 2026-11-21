import {
  decodeCustomChat,
  decodeCustomResponses,
} from "../../../packages/providers/src/custom/decode.ts";

const rows: unknown[] = [];
const s = { toString: null };
const m = (event: string, data: unknown) => ({ event, data: JSON.stringify(data) });
const chat = (data: unknown) => m("message", data);
const prefix = { id: "r", choices: [{ delta: { content: "prefix" } }] };
for (const value of [s, null]) {
  for (const field of ["id", "model"])
    rows.push({ protocol: "chat", messages: [chat({ [field]: value })] });
  for (const field of ["id", "name", "index"])
    rows.push({
      protocol: "chat",
      messages: [
        chat({
          ...prefix,
          choices: [
            {
              delta: {
                content: "prefix",
                tool_calls: [field === "name" ? { function: { name: value } } : { [field]: value }],
              },
            },
          ],
        }),
      ],
    });
  for (const usage of [
    { prompt_tokens: value },
    { prompt_tokens_details: { cached_tokens: value } },
    { prompt_cache_hit_tokens: value },
    { prompt_tokens_details: { cache_creation_tokens: value } },
    { prompt_tokens_details: { cache_write_tokens: value } },
  ])
    rows.push({ protocol: "chat", messages: [chat({ ...prefix, usage })] });
  for (const field of ["id", "model"])
    rows.push({
      protocol: "responses",
      messages: [m("response.created", { response: { [field]: value } })],
    });
  for (const field of ["call_id", "name"])
    rows.push({
      protocol: "responses",
      messages: [
        m("response.output_item.added", { item: { type: "function_call", [field]: value } }),
      ],
    });
  for (const event of [
    "response.output_text.delta",
    "response.reasoning_summary_text.delta",
    "response.function_call_arguments.delta",
  ])
    rows.push({ protocol: "responses", messages: [m(event, { delta: value })] });
  for (const field of ["output_index", "content_index"])
    rows.push({
      protocol: "responses",
      messages: [m("response.output_text.delta", { [field]: value, delta: "x" })],
    });
  rows.push(
    {
      protocol: "responses",
      messages: [m("response.incomplete", { response: { incomplete_details: { reason: value } } })],
    },
    { protocol: "responses", messages: [m("response.completed", { response: { status: value } })] },
  );
  for (const field of ["code", "type", "message"])
    rows.push({ protocol: "responses", messages: [m("error", { error: { [field]: value } })] });
  for (const usage of [
    { input_tokens: value },
    { input_tokens_details: { cached_tokens: value } },
    { prompt_tokens_details: { cached_tokens: value } },
  ])
    rows.push({
      protocol: "responses",
      messages: [m("response.completed", { response: { usage } })],
    });
}
for (const data of ['{"id":1e309,"choices":[]}', '{"usage":{"prompt_tokens":1e309}}'])
  rows.push({ protocol: "chat", overflow: true, messages: [{ event: "message", data }] });
for (const data of ['{"response":{"id":1e309}}', '{"response":{"id":"keep"},"ignored":1e309}'])
  rows.push({
    protocol: "responses",
    overflow: true,
    messages: [{ event: "response.created", data }],
  });
for (const row of rows) {
  const events = [];
  let throws = false;
  try {
    for await (const e of (row.protocol === "chat" ? decodeCustomChat : decodeCustomResponses)(
      (async function* () {
        yield* row.messages;
      })(),
    ))
      events.push(e);
  } catch (e) {
    if (!(e instanceof TypeError)) throw e;
    throws = true;
  }
  row.events = events;
  row.throws = throws;
}
console.log(JSON.stringify(rows));

import { collect } from "../packages/ir/src/stream";
import { decodeCustomResponses } from "../packages/providers/src/custom/decode";

for (const string of [true, false]) {
  const deltas = string
    ? [['"'], "[".repeat(40001), '"']
    : [["[".repeat(40001)], "0", ["]".repeat(40001)]];
  async function* messages() {
    yield {
      event: "response.output_item.added",
      data: JSON.stringify({
        output_index: 0,
        item: { type: "function_call", call_id: "c", name: "f" },
      }),
    };
    for (const delta of deltas)
      yield {
        event: "response.function_call_arguments.delta",
        data: JSON.stringify({ output_index: 0, delta }),
      };
    yield { event: "response.completed", data: '{"response":{"status":"completed"}}' };
  }
  const events = [];
  let raw = "";
  for await (const e of decodeCustomResponses(messages())) {
    events.push(e);
    if (e.type === "blockDelta" && e.delta.type === "toolJson") raw += e.delta.partial;
  }
  if (raw !== deltas.map(String).join("")) throw Error("coercion");
  const tool = collect(events).content.find((b) => b.type === "toolUse");
  if (!tool || tool.type !== "toolUse") throw Error("missing tool");
  if (string) {
    if (tool.input !== "[".repeat(40001)) throw Error("valid string lost");
  } else {
    let value: unknown = tool.input;
    for (let i = 0; i < 40001; i++) {
      if (!Array.isArray(value)) throw Error("depth");
      value = value[0];
    }
    if (value !== 0) throw Error("leaf");
  }
  console.log(string ? "string preserved" : "depth40001 emitted");
}

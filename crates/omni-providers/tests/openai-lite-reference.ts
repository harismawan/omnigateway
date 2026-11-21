import { toLiteInput } from "../../../packages/providers/src/openai/codexLite.ts";

const items = [
  {
    type: "message",
    role: "user",
    content: [
      { type: "input_text", text: "hello" },
      { type: "input_image", image_url: "data:image/png;base64,a" },
    ],
  },
  {
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text: "answer", annotations: [{ old: true }] }],
  },
  { type: "function_call", name: "f", arguments: '{"x":1}', call_id: "c" },
  { type: "function_call_output", call_id: "c", output: "done" },
  {
    type: "reasoning",
    encrypted_content: "opaque",
    summary: [],
    internal_chat_message_metadata_passthrough: { untrusted: true },
  },
  { type: "message", role: "user", content: [{ type: "input_file", file_data: "abc" }] },
  { type: "future", nested: { keep: [1, 2] } },
];
const rows = [];
for (const lite of [false, true])
  for (const salted of [false, true])
    for (const history of [[], items, items.slice(0, 4)])
      for (const prefixes of [false, true]) {
        const input = structuredClone(history);
        const turns = input.map((_, i) => (i >= 5 ? 1 : 0));
        const toolIndices = input.map((_, i) => (i === 5 ? [0] : []));
        const turnOf = new WeakMap<object, number>();
        const toolParts = new WeakSet<object>();
        input.forEach((v, i) => {
          const turn = turns[i];
          const indices = toolIndices[i];
          if (turn === undefined || !indices) throw Error("missing turn fixture");
          turnOf.set(v, turn);
          if (Array.isArray(v.content)) {
            for (const j of indices) {
              const part = v.content[j];
              if (!part) throw Error("missing tool part fixture");
              toolParts.add(part);
            }
          }
        });
        const args = {
          threadId: "019b86b5-42c0-7505-b36d-80ccdd119119",
          input,
          lite,
          ...(salted
            ? { idSalt: "ab".repeat(32), requestId: "req-😀", startedAt: 1790812800123 }
            : {}),
          ...(prefixes
            ? {
                instructions: "be helpful 😀",
                tools: [{ type: "function", name: "f", parameters: { type: "object" } }],
                effortUpdate: "high",
              }
            : {}),
        };
        rows.push({
          args,
          turns,
          toolIndices,
          result: toLiteInput({ ...args, turnOf, toolParts }),
        });
      }
console.log(JSON.stringify(rows));

import { toAntigravityWire } from "../../../packages/providers/src/antigravity/wire.ts";

let nested: unknown = null;
for (let i = 0; i < 39990; i++) nested = { items: nested };
const rows = [];
for (const kind of ["input", "schema", "vendor", "tool"]) {
  const request = { model: "m", messages: [], stream: true };
  if (kind === "input")
    request.messages = [
      { role: "assistant", content: [{ type: "toolUse", id: "i", name: "tool", input: nested }] },
    ];
  if (kind === "schema")
    request.vendor = {
      openai: { response_format: { type: "json_schema", json_schema: { schema: nested } } },
    };
  if (kind === "vendor") request.vendor = { antigravity: { extra: nested } };
  if (kind === "tool") request.tools = [{ kind: "portable", name: "tool", inputSchema: nested }];
  try {
    // `toAntigravityWire` receives the already-decorated ID from the codec.
    const r = toAntigravityWire(request, "m", { project: "p", requestId: "agent/r" });
    const body = JSON.stringify(r.body);
    rows.push({
      kind,
      length: body.length,
      sha256: new Bun.CryptoHasher("sha256").update(body).digest("hex"),
      notes: r.degradations,
    });
  } catch (e) {
    rows.push({ kind, error: String(e) });
  }
}
console.log(JSON.stringify(rows));

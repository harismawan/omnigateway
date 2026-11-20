import { antigravityCodec } from "../../../packages/providers/src/antigravity/codec.ts";

type BuildInput = Parameters<typeof antigravityCodec.buildRequest>[0];
const base = { model: "m", stream: true, messages: [] };
const cases: [string, unknown, string, string][] = [
  ["vendor", { ...base, vendor: { antigravity: "🙂" } }, "p", "r"],
  ["name", { ...base, tools: [{ kind: "portable", name: "\ud800", inputSchema: {} }] }, "p", "r"],
  [
    "id",
    {
      ...base,
      messages: [
        { role: "assistant", content: [{ type: "toolUse", id: "\ud800", name: "t", input: {} }] },
      ],
    },
    "p",
    "r",
  ],
  [
    "value",
    {
      ...base,
      messages: [
        {
          role: "assistant",
          content: [{ type: "toolUse", id: "i", name: "t", input: { x: "\ud800" } }],
        },
      ],
    },
    "p",
    "r",
  ],
  [
    "key",
    {
      ...base,
      messages: [
        {
          role: "assistant",
          content: [{ type: "toolUse", id: "i", name: "t", input: { "\ud800": 1 } }],
        },
      ],
    },
    "p",
    "r",
  ],
  ["system", { ...base, system: [{ type: "text", text: "\ud800" }] }, "p", "r"],
  ["project", base, "\ud800", undefined],
  ["request_id", base, "p", "\ud800"],
];
const rows = cases.map(([label, request, project, requestId]) => ({
  label,
  input: JSON.stringify({ request, project, requestId }),
  expected: antigravityCodec.buildRequest({
    request: request as BuildInput["request"],
    model: "m",
    credentials: { accessToken: "t", apiKey: null, providerData: { projectId: project } },
    requestId,
    fail: (code, message) => ({ code, message }),
  }).request.body,
}));
// Keep raw numeric tokens: stringify before transport would erase Infinity.
for (const [label, raw] of [
  [
    "overflow_input",
    '{"model":"m","stream":true,"messages":[{"role":"user","content":[{"type":"toolUse","id":"i","name":"t","input":1e309}]}]}',
  ],
  [
    "overflow_nested_input",
    '{"model":"m","stream":true,"messages":[{"role":"user","content":[{"type":"toolUse","id":"i","name":"t","input":{"x":1e309}}]}]}',
  ],
  [
    "overflow_schema_default",
    '{"model":"m","stream":true,"messages":[],"tools":[{"kind":"portable","name":"t","inputSchema":{"type":"object","default":1e309}}]}',
  ],
]) {
  const request = JSON.parse(raw!);
  rows.push({
    label,
    input: '{"request":' + raw + ',"project":"p","requestId":"r"}',
    expected: antigravityCodec.buildRequest({
      request,
      model: "m",
      credentials: { accessToken: "t", apiKey: null, providerData: { projectId: "p" } },
      requestId: "r",
      fail: (code, message) => ({ code, message }),
    }).request.body,
  });
}
console.log(JSON.stringify(rows));

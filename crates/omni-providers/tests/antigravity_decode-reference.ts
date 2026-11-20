import { decodeAntigravityStream } from "../../../packages/providers/src/antigravity/decode.ts";
import { parseSse } from "../../../packages/providers/src/sse.ts";

const enc = new TextEncoder(),
  cases: { name: string; chunks: number[][]; cloak: [string, string][] }[] = [],
  rows: unknown[] = [];
const raw = (name: string, ss: string[], cloak: [string, string][] = []) =>
  cases.push({ name, chunks: ss.map((s) => Array.from(enc.encode(s))), cloak });
const frame = (x: unknown) => `data: ${JSON.stringify(x)}\n\n`;
const add = (name: string, ...xs: unknown[]) => raw(name, xs.map(frame));
const r = (x: unknown) => ({ response: x }),
  c = (x: unknown) => r({ candidates: [x] }),
  p = (x: unknown) => c({ content: { parts: x }, finishReason: "STOP" });
const text = c({ content: { parts: [{ text: "before" }] } });
// Exact payloads from frozen antigravityDecode.test.ts.
add("billing/cache-hit", {
  response: {
    candidates: [{ finishReason: "STOP" }],
    usageMetadata: {
      promptTokenCount: 61_244,
      candidatesTokenCount: 12,
      cachedContentTokenCount: 57_309,
    },
  },
});
add("billing/blocked-12", {
  response: { promptFeedback: { blockReason: "SAFETY" }, usageMetadata: { promptTokenCount: 12 } },
});
add(
  "billing/hel-lo",
  { response: { responseId: "r1", modelVersion: "gemini-3.6-flash-high", candidates: [] } },
  c({ content: { parts: [{ text: "hel" }] } }),
  c({ content: { parts: [{ text: "lo" }] } }),
  {
    response: {
      candidates: [{ finishReason: "STOP" }],
      usageMetadata: {
        promptTokenCount: 100,
        candidatesTokenCount: 20,
        thoughtsTokenCount: 15,
        cachedContentTokenCount: 30,
      },
    },
  },
);
add(
  "billing/thought-text",
  c({ content: { parts: [{ text: "hmm", thought: true }] } }),
  c({ content: { parts: [{ text: "answer" }] } }),
  c({ finishReason: "STOP" }),
);
add(
  "billing/tool-later-finish",
  c({ content: { parts: [{ functionCall: { name: "Read", args: { path: "/a" } } }] } }),
  c({ finishReason: "STOP" }),
);
add(
  "billing/no-cloak-Read",
  c({ content: { parts: [{ functionCall: { name: "Read", args: {} } }] } }),
);
raw("empty", []);
raw("done", ["data: [DONE]\n\n"]);
raw("invalid", ["data: {\n\n"]);
const values = [
  undefined,
  null,
  false,
  true,
  0,
  2,
  -1,
  1.5,
  1e21,
  -0,
  "",
  "x",
  "ab",
  [],
  [null],
  {},
  { length: 0 },
  { length: 2 },
  { toString: null },
];
for (const [i, v] of values.entries()) {
  add(`frame/${i}`, v);
  add(`error/${i}`, { error: v });
  add(`wrapped-error/${i}`, { error: null, response: { error: v } });
  add(`response/${i}`, r(v));
  for (const k of ["promptFeedback", "candidates", "usageMetadata", "responseId", "modelVersion"])
    add(`${k}/${i}`, r({ [k]: v }));
  add(`final-usageMetadata/${i}`, r({ candidates: [{ finishReason: "STOP" }], usageMetadata: v }));
  add(`candidate-length/${i}`, r({ candidates: { length: v, 0: { finishReason: "STOP" } } }));
  add(`error-precedence/${i}`, { error: v, response: { error: { status: "UNAUTHENTICATED" } } });
  add(`candidate/${i}`, r({ candidates: [v] }));
  add(`content/${i}`, c({ content: v, finishReason: "STOP" }));
  add(`parts/${i}`, c({ content: { parts: v }, finishReason: "STOP" }));
  add(`part/${i}`, p([v]));
  add(`functionCall/${i}`, p([{ functionCall: v, text: "fallback" }]));
  for (const k of ["name", "id", "args"])
    add(`${k}/${i}`, p([{ functionCall: { name: "wire", [k]: v }, text: "fallback" }]));
  for (const k of ["text", "thought"]) add(`${k}/${i}`, p([{ text: "", [k]: v }]));
  add(`finishReason/${i}`, text, c({ finishReason: v }));
  for (const k of ["status", "message"]) add(`failure-${k}/${i}`, text, { error: { [k]: v } });
  for (const k of [
    "promptTokenCount",
    "candidatesTokenCount",
    "thoughtsTokenCount",
    "cachedContentTokenCount",
  ])
    add(
      `count-${k}/${i}`,
      r({ candidates: [{ finishReason: "STOP" }], usageMetadata: { [k]: v } }),
    );
  for (const candidates of [undefined, [], [{}], 0, "", {}, { length: 0 }])
    for (const prefix of [[], [text]])
      add(
        `blocked/${i}/${JSON.stringify(candidates)}/${prefix.length}`,
        ...prefix,
        r({ promptFeedback: { blockReason: v }, candidates }),
      );
}
for (const s of [
  "STOP",
  "MAX_TOKENS",
  "SAFETY",
  "PROHIBITED_CONTENT",
  "SPII",
  "BLOCKLIST",
  "RECITATION",
  "MALFORMED_FUNCTION_CALL",
  "unknown",
  "toString",
  "__proto__",
  "constructor",
  "hasOwnProperty",
]) {
  add(`stop/${s}`, text, c({ finishReason: s }), { response: null });
  add(
    `tool-stop/${s}`,
    c({ content: { parts: [{ functionCall: { name: "wire" } }] }, finishReason: s }),
  );
}
for (const s of [
  "RESOURCE_EXHAUSTED",
  "UNAUTHENTICATED",
  "PERMISSION_DENIED",
  "INVALID_ARGUMENT",
  "FAILED_PRECONDITION",
  "UNAVAILABLE",
  "INTERNAL",
  "DEADLINE_EXCEEDED",
  "unknown",
  "toString",
  "__proto__",
  "constructor",
  "hasOwnProperty",
]) {
  add(`error-code/${s}`, text, { error: { status: s, message: "bad" } }, { response: null });
  add(`wrapped-code/${s}`, r({ error: { status: s } }));
}
add(
  "alternation",
  p([
    { text: "a" },
    { text: "" },
    { text: "b", thought: true },
    { text: "c" },
    { functionCall: { name: "wire" } },
    { text: "d" },
    { functionCall: { name: "unknown", id: "" } },
    { functionCall: { name: "wire", id: "given" } },
  ]),
);
raw(
  "cloak",
  [frame(p([{ functionCall: { name: "wire" } }, { functionCall: { name: "unknown" } }]))],
  [["wire", "original / tool"]],
);
add("two-candidates", r({ candidates: [{}, {}] }));
add("cross-frame-block", text, text, c({ finishReason: "STOP" }));
for (const v of [
  { toString: {} },
  { toString: [] },
  { toString: "x" },
  { toString: null, valueOf: 2 },
  ["STOP"],
  { valueOf: null },
]) {
  for (const k of ["responseId", "modelVersion"])
    add(`coercion/${k}/${JSON.stringify(v)}`, r({ [k]: v }));
  for (const k of ["status", "message"])
    add(`coercion/${k}/${JSON.stringify(v)}`, text, { error: { [k]: v } });
  add(`coercion/finish/${JSON.stringify(v)}`, text, c({ finishReason: v }));
}
add(
  "nonfinal-usage",
  r({ usageMetadata: { promptTokenCount: 99 } }),
  r({
    candidates: [{ finishReason: "STOP" }],
    usageMetadata: {
      promptTokenCount: 8,
      cachedContentTokenCount: 3,
      candidatesTokenCount: 2,
      thoughtsTokenCount: 4,
    },
  }),
);
for (const args of [
  "-0",
  "1e21",
  "1E2",
  "9007199254740993",
  "1.0",
  '{"b":1,"2":2,"a":3,"b":4,"__proto__":5}',
  '"\\n\\t\\""',
])
  raw(`raw-args/${args}`, [
    `data: {"response":{"candidates":[{"content":{"parts":[{"functionCall":{"name":"x","args":${args}}}]},"finishReason":"STOP"}]}}\n\n`,
  ]);
const bytes = enc.encode(frame(p([{ text: "é😀" }])));
for (let i = 0; i <= bytes.length; i++)
  cases.push({
    name: `split/${i}`,
    chunks: [Array.from(bytes.slice(0, i)), Array.from(bytes.slice(i))],
    cloak: [],
  });
raw("crlf", [frame(p([{ text: "hi" }])).replaceAll("\n", "\r\n")]);
raw("multiline", [
  ': comment\nevent: ignored\ndata: {"response":\ndata: {"candidates":[{"finishReason":"STOP"}]}}\n\n',
]);
raw("no-data", ["event: ignored\n\n"]);
raw("unterminated", [frame(p([])).trimEnd()]);
if (process.argv.includes("--depth")) {
  cases.length = 0;
  for (const n of [100, 1000, 5000, 10000, 39990])
    raw(`depth/${n}`, [
      `data: {"response":{"candidates":[{"content":{"parts":[{"functionCall":{"name":"x","args":${"[".repeat(n)}0${"]".repeat(n)}}}]},"finishReason":"STOP"}]}}\n\n`,
    ]);
}
if (process.argv.includes("--bounded-depth")) {
  cases.length = 0;
  const nested = (n: number) => "[".repeat(n) + "0" + "]".repeat(n);
  const frames = [
    ["ignored", `{"response":{"candidates":[{"finishReason":"STOP"}],"ignored":${nested(39999)}}}`],
    [
      "usageMetadata",
      `{"response":{"candidates":[{"finishReason":"STOP"}],"usageMetadata":${nested(39999)}}}`,
    ],
    ["error", `{"error":${nested(40000)}}`],
    [
      "args",
      `{"response":{"candidates":[{"content":{"parts":[{"functionCall":{"name":"x","args":${nested(39993)}}}]},"finishReason":"STOP"}]}}`,
    ],
    [
      "args-stringify",
      `{"response":{"candidates":[{"content":{"parts":[{"functionCall":{"name":"x","args":${nested(40001)}}}]},"finishReason":"STOP"}]}}`,
    ],
  ];
  for (const [position, json] of frames)
    for (const prior of [false, true]) {
      raw(`bounded-depth/${position}/${prior ? "after-text" : "first"}`, [
        ...(prior ? [frame(text)] : []),
        `data: ${json}\n\n`,
      ]);
    }
}
if (process.argv.includes("--x1")) {
  cases.length = 0;
  raw("X1/surrogate/finishReason", [
    'data: {"response":{"candidates":[{"finishReason":"\\ud800"}]}}\n\n',
  ]);
  // Frozen emits fully representable output: the offending blockReason is not emitted.
  raw("X1/surrogate/blockReason", [
    'data: {"response":{"promptFeedback":{"blockReason":"\\ud800"}}}\n\n',
  ]);
  raw("X1/overflow/candidatesLength", ['data: {"response":{"candidates":{"length":1e309}}}\n\n']);
  for (const kind of ["surrogate", "overflow"])
    for (const position of [
      "text",
      "thought",
      "name",
      "id",
      "args",
      "argskey",
      "responseId",
      "modelVersion",
      "message",
      "status",
      "promptTokenCount",
      "candidatesTokenCount",
      "thoughtsTokenCount",
      "cachedContentTokenCount",
      "ignored",
    ]) {
      const value = kind === "surrogate" ? '"\\ud800"' : "1e309";
      let json: string;
      if (position === "text" || position === "thought")
        json = `{"response":{"candidates":[{"content":{"parts":[{"text":${value}${position === "thought" ? ',"thought":true' : ""}}]},"finishReason":"STOP"}]}}`;
      else if (["name", "id", "args", "argskey"].includes(position))
        json = `{"response":{"candidates":[{"content":{"parts":[{"functionCall":{"name":"x","${position === "argskey" ? "args" : position}":${position === "argskey" ? '{"\\ud800":0}' : value}}}]},"finishReason":"STOP"}]}}`;
      else if (position === "message" || position === "status")
        json = `{"error":{"${position}":${value}}}`;
      else if (position.endsWith("TokenCount"))
        json = `{"response":{"usageMetadata":{"${position}":${value}},"candidates":[{"finishReason":"STOP"}]}}`;
      else json = `{"response":{"${position}":${value},"candidates":[{"finishReason":"STOP"}]}}`;
      raw(`X1/${kind}/${position}`, [`data: ${json}\n\n`]);
    }
}
// JSON text inside a safe envelope preserves lone UTF-16 units without asking
// serde to parse them. Escape all non-ASCII units for stable byte comparison.
const safeEvent = (event: import("../../../packages/ir/src/index.ts").StreamEvent) =>
  JSON.stringify(event).replace(
    /[\u0080-\uffff]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
for (const x of cases) {
  const filter = process.argv.find((a) => a.startsWith("X1/"));
  if (filter && !x.name.startsWith(filter)) continue;
  const events: import("../../../packages/ir/src/index.ts").StreamEvent[] = [];
  let thrown: { name: string; message: string; guard: string } | null = null;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const b of x.chunks) controller.enqueue(new Uint8Array(b));
      controller.close();
    },
  });
  try {
    for await (const e of decodeAntigravityStream(parseSse(body), {
      cloak: { fromWire: new Map(x.cloak), toWire: new Map() },
    }))
      events.push(e);
  } catch (e) {
    thrown = {
      name: (e as Error).name,
      message: (e as Error).message,
      guard: "antigravity codec decode threw",
    };
  }
  rows.push({
    ...x,
    events: process.argv.includes("--x1") ? events.map(safeEvent) : events,
    thrown,
  });
}
console.log(JSON.stringify(rows));

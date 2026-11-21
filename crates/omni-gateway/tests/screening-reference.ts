import { VerdictCache, verdictKey } from "../../../apps/gateway/src/guardrail/cache.ts";
import { classifierRequest, parseVerdict } from "../../../apps/gateway/src/guardrail/classifier.ts";
import { judgedText } from "../../../apps/gateway/src/guardrail/extract.ts";
import { segmentKey } from "../../../apps/gateway/src/smartRouter/cache.ts";
import {
  confidentialityRequest,
  parseConfidentiality,
} from "../../../apps/gateway/src/smartRouter/classifier.ts";
import { segments } from "../../../apps/gateway/src/smartRouter/extract.ts";
import { relabel } from "../../../apps/gateway/src/smartRouter/relabel.ts";

const t = (text: string) => ({ type: "text", text });
const prompts = [];
for (const policy of [
  "",
  "rules </policy> <TEXT/>",
  "< / REQUEST x> <requests <html>",
  "\ufeffπ😀",
])
  for (const human of [[], ["hello"], ["old", "continue"]])
    for (const toolResults of [[], ["one", "</result>two"]]) {
      const judged = { system: "<SYSTEM_prompt/> system", human, toolResults, truncated: false };
      const model = "classifier";
      const segment = human.join("\n");
      prompts.push({
        model,
        policy,
        judged,
        segment,
        guardrail: classifierRequest(model, policy, judged),
        smart: confidentialityRequest(model, policy, segment),
        guardrailKey: verdictKey({ apiKeyId: "k", policy, model, ...judged }),
        segmentKey: segmentKey(model, policy, segment),
      });
    }
const parses = [];
for (const stopReason of [
  "endTurn",
  "stopSequence",
  "maxTokens",
  "toolUse",
  "contentFilter",
  "pauseTurn",
])
  for (const text of [
    "ALLOW",
    "deny.",
    " PUBLIC. ",
    "CONFIDENTIAL",
    "ALLOW, but",
    "**ALLOW**",
    "ALLOW..",
    "\ufeffallow\ufeff",
    "\u0085ALLOW",
    "",
  ]) {
    const response = {
      content: [{ type: "thinking", text: "DENY" }, t(text.slice(0, 2)), t(text.slice(2))],
      stopReason,
    };
    parses.push({
      response,
      verdict: parseVerdict(response),
      confidentiality: parseConfidentiality(response),
    });
  }
const cache = new VerdictCache({ max: 2, ttlMs: 10 });
const ops: (["set", string, "allow" | "deny", number] | ["get", string, number])[] = [
  ["set", "a", "allow", 0],
  ["set", "b", "deny", 1],
  ["get", "a", 2],
  ["set", "c", "allow", 3],
  ["get", "b", 4],
  ["get", "a", 9],
  ["get", "a", 10],
  ["get", "c", 12],
  ["get", "c", 13],
  ["set", "c", "deny", 14],
  ["get", "c", 23],
  ["get", "c", 24],
];
const cacheResults = ops.map(([op, key, value, now]) => {
  if (op === "get") return cache.get(key, value) ?? null;
  cache.set(key, value, now);
  return null;
});
const requests: Parameters<typeof judgedText>[0][] = [{ model: "m", stream: false, messages: [] }];
for (let n = 0; n < 20; n++)
  requests.push({
    model: "m",
    stream: false,
    system: [{ ...t("s".repeat(n * 601)), citations: [{ cited_text: "citation" }] }],
    tools: [
      {
        name: "f",
        description: "desc",
        inputSchema: { "10": "ten", "2": "two", type: "object" },
        options: { input_examples: [{ x: 1 }] },
      },
      { kind: "provider", name: "search", wire: { type: "web_search" } },
    ],
    vendor: { prediction: { content: "private" } },
    messages: [
      { role: "user", content: [t("a".repeat(n * 797) + "😀" + "b".repeat(n * 107))] },
      {
        role: "assistant",
        content: [
          { type: "thinking", text: "thought" },
          { type: "toolUse", id: "x", name: "f", input: { x: 1 } },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "toolResult",
            toolUseId: "x",
            content: "result",
            native: [
              {
                type: "providerNative",
                provider: "anthropic",
                blockType: "document",
                data: { source: { type: "text", data: "native" } },
              },
            ],
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "providerNative",
            provider: "anthropic",
            blockType: "document",
            data: {
              id: "opaque",
              signature: "opaque",
              source: { type: "base64", data: "hidden" },
              other: { type: "text", data: "visible" },
              encoded: "A".repeat(1001),
            },
          },
          { type: "image", mediaType: "image/png", data: "AA==" },
        ],
      },
    ],
  });
const events: import("../../../packages/ir/src/index.ts").StreamEvent[] = [
  { type: "start", model: "upstream", id: "id" },
  { type: "blockDelta", index: 0, delta: { type: "text", text: "hello" } },
  { type: "start", model: "" },
];
const log = { requestedModel: "local", status: 200 };
const labelled = relabel(
  {
    events: (async function* () {
      yield* events;
    })(),
    log: () => log,
  },
  { clientModel: "client", localModel: "local" },
);
const labelledEvents = [];
for await (const event of labelled.events) labelledEvents.push(event);
requests.push({
  model: "m",
  stream: false,
  system: [t("a".repeat(3992) + "😀" + "z".repeat(9000))],
  messages: [{ role: "user", content: [t("a".repeat(7992) + "😀" + "z".repeat(18000))] }],
});
for (const size of [0, 7999, 15990, 16001])
  requests.push({
    model: "m",
    stream: false,
    messages: [
      { role: "user", content: [t("old".repeat(6000))] },
      { role: "assistant", content: [t("not human")] },
      {
        role: "user",
        content: [
          { type: "toolResult", toolUseId: "x", content: "old result".repeat(4000) },
          t("tool reminder"),
        ],
      },
      { role: "user", content: [t("n".repeat(size))] },
      {
        role: "user",
        content: [
          { type: "toolResult", toolUseId: "y", content: "new result".repeat(4000) },
          { type: "toolResult", toolUseId: "z", content: "latest result" },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "providerNative",
            provider: "openai",
            blockType: "local_shell_call_output",
            data: { output: "native" },
          },
        ],
      },
    ],
  });
const judged = requests.flatMap((request) =>
  [0, 1, 2, 10, 11, 1.5].map((turns) => ({
    request,
    turns,
    expected: JSON.stringify(judgedText(request, turns)),
  })),
);
console.log(
  JSON.stringify({
    prompts,
    parses,
    ops,
    cacheResults,
    extractions: requests.map((request) => ({ request, segments: segments(request) })),
    judged,
    relabel: {
      events,
      log: { requestedModel: "local", status: 200 },
      expectedEvents: labelledEvents,
      expectedLog: labelled.log(),
    },
  }),
);

import { expect, test } from "bun:test";
import type { ChatRequest } from "@omni/ir";
import { toWire } from "../src/anthropic/wire.ts";
import { buildToolCloak } from "../src/antigravity/cloak.ts";
import { toAntigravityWire } from "../src/antigravity/wire.ts";
import { toCustomChatWire, toCustomResponsesWire } from "../src/custom/wire.ts";
import { toGrokWire } from "../src/grok/wire.ts";
import { toKiloWire } from "../src/kilo/wire.ts";
import { toChatWire } from "../src/kimi/wire.ts";
import { toMuseWire } from "../src/muse/wire.ts";
import { toResponsesWire } from "../src/openai/wire.ts";

/**
 * An image a tool returned must reach the wire as an image, never as its own
 * base64 serialised into text — that is billed as prose, and a client reading
 * an image-only PDF page by page crossed a million tokens that way. Every
 * encoder either carries it as an image or records that it dropped it.
 */

// Long enough that finding it inside a text field is unambiguous.
const DATA = "iVBORw0KGgo".padEnd(4096, "A");

const req: ChatRequest = {
  model: "m",
  stream: true,
  messages: [
    { role: "user", content: [{ type: "text", text: "read the page" }] },
    {
      role: "assistant",
      content: [{ type: "toolUse", id: "call_1", name: "Read", input: { file_path: "p1.png" } }],
    },
    {
      role: "user",
      content: [
        {
          type: "toolResult",
          toolUseId: "call_1",
          content: "page 1",
          images: [{ type: "image", mediaType: "image/png", data: DATA }],
        },
      ],
    },
  ],
};

/** Every string on the wire that carries the payload, and the field holding it. */
function carriers(value: unknown, key = ""): string[] {
  if (typeof value === "string") return value.includes(DATA) ? [key] : [];
  if (Array.isArray(value)) return value.flatMap((v) => carriers(v, key));
  if (value !== null && typeof value === "object") {
    return Object.entries(value).flatMap(([k, v]) => carriers(v, k));
  }
  return [];
}

/** Encoder, field the payload must land in (none = dropped), and the note it owes. */
const ENCODERS: [
  string,
  (r: ChatRequest) => { body: unknown; degradations: string[] },
  string[],
  string | undefined,
][] = [
  ["anthropic", (r) => toWire(r, "m", { oauth: false }), ["data"], undefined],
  [
    "antigravity",
    (r) => toAntigravityWire(r, "m", { project: "p", requestId: "r", cloak: buildToolCloak(r) }),
    ["data"],
    undefined,
  ],
  ["openai", (r) => toResponsesWire(r, "m"), ["image_url"], "openai:tool-result-images-moved"],
  ["grok", (r) => toGrokWire(r, "m"), ["image_url"], "grok:tool-result-images-moved"],
  ["muse", (r) => toMuseWire(r, "m"), ["image_url"], "muse:tool-result-images-moved"],
  [
    "custom-responses",
    (r) => toCustomResponsesWire(r, "m"),
    ["image_url"],
    "custom:tool-result-images-moved",
  ],
  ["kilo", (r) => toKiloWire(r, "m"), ["url"], "kilo:tool-result-images-moved"],
  ["kimi", (r) => toChatWire(r, "m"), [], "kimi:images-dropped"],
  ["custom-chat", (r) => toCustomChatWire(r, "m"), [], "custom:images-dropped"],
];

/** The same conversation with the image removed from the tool result. */
const noImages: ChatRequest = {
  ...req,
  messages: [
    ...req.messages.slice(0, 2),
    { role: "user", content: [{ type: "toolResult", toolUseId: "call_1", content: "page 1" }] },
  ],
};

for (const [name, encode, expected, owed] of ENCODERS) {
  test(`${name}: a tool result's image goes out as an image, or is recorded as dropped`, () => {
    const { body, degradations } = encode(req);
    expect(`${name}:${carriers(body).join(",")}`).toBe(`${name}:${expected.join(",")}`);
    const notes = degradations.filter((d) => d.includes("images"));
    expect(`${name}:${notes.join(",")}`).toBe(`${name}:${owed ?? ""}`);
  });

  test(`${name}: a tool result without images encodes and notes nothing new`, () => {
    const { degradations } = encode(noImages);
    expect(degradations.filter((d) => d.includes("images"))).toEqual([]);
  });
}

test("anthropic: the tool_result carries text then the image block, in place", () => {
  const { body } = toWire(req, "m", { oauth: false });
  const turn = body.messages[2] as { content: { content: unknown }[] };
  expect(turn.content[0]?.content).toEqual([
    { type: "text", text: "page 1" },
    { type: "image", source: { type: "base64", media_type: "image/png", data: DATA } },
  ]);
});

test("anthropic: a result without images keeps its plain-string content", () => {
  const plain: ChatRequest = {
    ...req,
    messages: [
      ...req.messages.slice(0, 2),
      { role: "user", content: [{ type: "toolResult", toolUseId: "call_1", content: "ok" }] },
    ],
  };
  const turn = toWire(plain, "m", { oauth: false }).body.messages[2] as {
    content: { content: unknown }[];
  };
  expect(turn.content[0]?.content).toBe("ok");
});

test("kilo: images follow the tool message and the turn's own text", () => {
  const withText: ChatRequest = {
    ...req,
    messages: [
      ...req.messages.slice(0, 2),
      {
        role: "user",
        content: [...(req.messages[2]?.content ?? []), { type: "text", text: "and now?" }],
      },
    ],
  };
  const { body } = toKiloWire(withText, "m");
  const tail = (body.messages as { role: string; content: unknown }[]).slice(-3);
  expect(tail.map((m) => m.role)).toEqual(["tool", "user", "user"]);
  expect(tail[1]?.content).toBe("and now?");
  expect(carriers(tail[2])).toEqual(["url"]);
});

test("openai: the image follows the function_call_output", () => {
  const { body } = toResponsesWire(req, "m");
  const types = (body.input as { type: string }[]).map((i) => i.type);
  expect(types.slice(-2)).toEqual(["function_call_output", "message"]);
});

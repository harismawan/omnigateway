import { describe, expect, test } from "bun:test";
import type { ChatRequest } from "@omni/ir";
import { toWire } from "../../../../packages/providers/src/anthropic/wire.ts";
import { toAntigravityWire } from "../../../../packages/providers/src/antigravity/wire.ts";
import {
  toCustomChatWire,
  toCustomResponsesWire,
} from "../../../../packages/providers/src/custom/wire.ts";
import { toGrokWire } from "../../../../packages/providers/src/grok/wire.ts";
import { toKiloWire } from "../../../../packages/providers/src/kilo/wire.ts";
import { toChatWire } from "../../../../packages/providers/src/kimi/wire.ts";
import { toMuseWire } from "../../../../packages/providers/src/muse/wire.ts";
import { toResponsesWire } from "../../../../packages/providers/src/openai/wire.ts";
import { parseAnthropicRequest } from "../../src/ingress/anthropic.ts";
import { parseOpenAIRequest } from "../../src/ingress/openai.ts";
import { parseResponsesRequest } from "../../src/ingress/responses.ts";

/**
 * A structured-output request survives being routed to a provider that spells
 * it differently.
 *
 * Three client surfaces each have their own spelling, and none of them is a
 * field any ingress names — all three ride the vendor bag named after the
 * *surface*, so both Responses-shaped ingresses write `vendor.openai` and only
 * `/v1/messages` writes `vendor.anthropic`. Before this was read properly, a
 * request only kept its schema when the ingress and the target happened to
 * share a dialect: a Codex client routed to Gemini, or a Claude Code client
 * routed to GPT, silently got prose back.
 *
 * This is the whole matrix, asserted through the real parsers rather than
 * hand-built `vendor` bags, because the bag layout is exactly the thing that
 * makes it break.
 */
const SCHEMA = {
  type: "object",
  properties: { clips: { type: "array", items: { type: "string" } } },
  required: ["clips"],
};

/** What each surface's client actually sends, parsed by that surface's ingress. */
const surfaces: Record<string, () => ChatRequest> = {
  "chat/completions (response_format)": () =>
    parseOpenAIRequest({
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      response_format: { type: "json_schema", json_schema: { name: "clips", schema: SCHEMA } },
    }),
  "responses (text.format)": () =>
    parseResponsesRequest({
      model: "m",
      input: "hi",
      text: { format: { type: "json_schema", name: "clips", schema: SCHEMA, strict: true } },
    }),
  "messages (output_config.format)": () =>
    parseAnthropicRequest({
      model: "m",
      max_tokens: 8,
      messages: [{ role: "user", content: "hi" }],
      output_config: { format: { type: "json_schema", schema: SCHEMA } },
    }),
};

/** Walks a wire path, returning undefined rather than throwing on a gap. */
function at(body: unknown, ...path: string[]): unknown {
  let value: unknown = body;
  for (const key of path) {
    if (typeof value !== "object" || value === null) return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

/** The three spellings. Exactly one belongs on any given backend's body. */
const SPELLINGS = ["response_format", "text", "output_config"] as const;

/**
 * Every target: how to encode for it, and where its own API puts the schema.
 *
 * The path doubles as the accepted top-level key, which is what makes a leak
 * detectable — a body carrying any *other* spelling is carrying a field that
 * backend does not define, still holding an untranslated schema.
 */
const targets: Record<string, { encode: (req: ChatRequest) => unknown; path: string[] }> = {
  openai: {
    encode: (req) => toResponsesWire(req, "gpt-5").body,
    path: ["text", "format", "schema"],
  },
  muse: { encode: (req) => toMuseWire(req, "m").body, path: ["text", "format", "schema"] },
  grok: { encode: (req) => toGrokWire(req, "grok-4").body, path: ["text", "format", "schema"] },
  "custom-responses": {
    encode: (req) => toCustomResponsesWire(req, "m").body,
    path: ["text", "format", "schema"],
  },
  "custom-chat": {
    encode: (req) => toCustomChatWire(req, "m").body,
    path: ["response_format", "json_schema", "schema"],
  },
  kimi: {
    encode: (req) => toChatWire(req, "m").body,
    path: ["response_format", "json_schema", "schema"],
  },
  kilo: {
    encode: (req) => toKiloWire(req, "m").body,
    path: ["response_format", "json_schema", "schema"],
  },
  anthropic: {
    encode: (req) => toWire({ ...req, maxTokens: 8 }, "claude-sonnet-4-5", { oauth: false }).body,
    path: ["output_config", "format", "schema"],
  },
  antigravity: {
    encode: (req) =>
      toAntigravityWire(req, "gemini-3.8-flash-high", {
        project: "p",
        requestId: "r",
        cloak: null,
      }).body.request,
    path: ["generationConfig", "responseSchema"],
  },
};

describe("a structured-output request survives every surface/target pairing", () => {
  for (const [surface, build] of Object.entries(surfaces)) {
    for (const [target, { encode, path }] of Object.entries(targets)) {
      test(`${surface} -> ${target}`, () => {
        const body = encode(build());

        // Arrived, in this backend's own spelling.
        const schema = at(body, ...path);
        expect(schema).toBeDefined();
        // The client's own property survives the trip, so this cannot pass on
        // an empty object placed at the right path.
        expect(at(schema, "properties", "clips")).toBeDefined();

        // And no *other* spelling rode along. The vendor merge is bag-shaped
        // rather than endpoint-shaped, so a foreign spelling here is a field
        // this backend never defined, carrying a schema it will not read.
        const accepted = path[0];
        const foreign = SPELLINGS.filter((k) => k !== accepted && at(body, k) !== undefined);
        expect(foreign).toEqual([]);
      });
    }
  }

  test("no structured-output request means no field at any target", () => {
    const plain = parseOpenAIRequest({ model: "m", messages: [{ role: "user", content: "hi" }] });
    for (const [target, { encode, path }] of Object.entries(targets)) {
      expect({ target, schema: at(encode(plain), ...path) }).toEqual({ target, schema: undefined });
    }
  });

  test("the client's own spelling is forwarded verbatim, not rebuilt", () => {
    // `strict: true` came from the client here. A translation that overwrote the
    // merged copy would still pass the matrix above while discarding fields the
    // client set beside the schema.
    const req = surfaces["responses (text.format)"]?.();
    if (req === undefined) throw new Error("surface missing");
    const { body, degradations } = toResponsesWire(req, "gpt-5");
    expect(at(body, "text", "format", "strict")).toBe(true);
    expect(degradations).toEqual([]);
  });
});

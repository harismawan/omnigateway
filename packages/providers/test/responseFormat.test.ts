import { describe, expect, test } from "bun:test";
import type { ChatRequest } from "@omni/ir";
import { toWire } from "../src/anthropic/wire.ts";
import { toAntigravityWire } from "../src/antigravity/wire.ts";
import { toCustomChatWire, toCustomResponsesWire } from "../src/custom/wire.ts";
import { toGrokWire } from "../src/grok/wire.ts";
import { toKiloWire } from "../src/kilo/wire.ts";
import { toChatWire } from "../src/kimi/wire.ts";
import { toMuseWire } from "../src/muse/wire.ts";
import { toResponsesWire } from "../src/openai/wire.ts";
import { closeObjects, readResponseFormat } from "../src/responseFormat.ts";

/**
 * One structured-output request, encoded by every provider.
 *
 * The spellings below are not style choices — each was measured against the
 * live backend on 2026-09-21, and the wrong one fails the request rather than
 * degrading it: the Responses API answers `Unsupported parameter:
 * response_format`, Anthropic answers `Extra inputs are not permitted`, and
 * Cloud Code answers `Invalid JSON payload received. Unknown name`. A provider
 * silently dropping the field is the bug this replaced, so every arm asserts
 * the field arrived rather than that nothing threw.
 */
const SCHEMA = {
  type: "object",
  properties: {
    clips: {
      type: "array",
      items: {
        type: "object",
        properties: { start: { type: "number" }, line: { type: "string" } },
        required: ["start", "line"],
      },
    },
  },
  required: ["clips"],
};

const base: ChatRequest = {
  model: "m",
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  stream: false,
  vendor: {
    openai: {
      response_format: { type: "json_schema", json_schema: { name: "clips", schema: SCHEMA } },
    },
  },
};

/** Narrows an unknown wire position to a record, failing the test if it is not one. */
function rec(value: unknown): Record<string, unknown> {
  expect(typeof value === "object" && value !== null && !Array.isArray(value)).toBe(true);
  return value as Record<string, unknown>;
}

describe("readResponseFormat", () => {
  test("reads the schema and the client's name for it", () => {
    expect(readResponseFormat(base)).toEqual({ schema: SCHEMA, name: "clips" });
  });

  test("reads the Responses surface's own spelling, `text.format`", () => {
    const req: ChatRequest = {
      ...base,
      vendor: {
        openai: { text: { format: { type: "json_schema", name: "clips", schema: SCHEMA } } },
      },
    };
    expect(readResponseFormat(req)).toEqual({ schema: SCHEMA, name: "clips" });
  });

  test("reads the Anthropic surface's own spelling, `output_config.format`", () => {
    const req: ChatRequest = {
      ...base,
      vendor: { anthropic: { output_config: { format: { type: "json_schema", schema: SCHEMA } } } },
    };
    // That surface has no name field, so the default stands in.
    expect(readResponseFormat(req)).toEqual({ schema: SCHEMA, name: "response" });
  });

  test("an unrelated output_config (reasoning effort) is not a format request", () => {
    const req: ChatRequest = {
      ...base,
      vendor: { anthropic: { output_config: { effort: "high" } } },
    };
    expect(readResponseFormat(req)).toBeUndefined();
  });

  test("`text.format` asking for plain text is not a schema request", () => {
    // The Responses API spells plain prose `{type: "text"}`. A client that
    // switched back to it while leaving a schema behind is asking for text, and
    // reading the leftover schema would force JSON onto a request that declined
    // it.
    const req: ChatRequest = {
      ...base,
      vendor: { openai: { text: { format: { type: "text", schema: SCHEMA } } } },
    };
    expect(readResponseFormat(req)).toBeUndefined();
  });

  test("precedence is chat, then Responses, then Messages", () => {
    // All three at once is unusual but reachable, and which one wins must be a
    // decision rather than an accident of ordering.
    const chat = { type: "json_schema", json_schema: { name: "from-chat", schema: SCHEMA } };
    const text = { format: { type: "json_schema", name: "from-responses", schema: SCHEMA } };
    const output_config = {
      format: { type: "json_schema", name: "from-messages", schema: SCHEMA },
    };

    const all: ChatRequest = {
      ...base,
      vendor: { openai: { response_format: chat, text }, anthropic: { output_config } },
    };
    expect(readResponseFormat(all)?.name).toBe("from-chat");

    const withoutChat: ChatRequest = {
      ...base,
      vendor: { openai: { text }, anthropic: { output_config } },
    };
    expect(readResponseFormat(withoutChat)?.name).toBe("from-responses");

    const onlyMessages: ChatRequest = { ...base, vendor: { anthropic: { output_config } } };
    expect(readResponseFormat(onlyMessages)?.name).toBe("from-messages");
  });

  test("an array is never mistaken for a record, at any position", () => {
    // `isRecord` guards every spelling, format, and schema position. Arrays are
    // objects in JavaScript, so a guard that forgot them would read `[]` as a
    // schema and send it.
    const cases: NonNullable<ChatRequest["vendor"]>[] = [
      { openai: { response_format: [] } },
      { openai: { response_format: { type: "json_schema", json_schema: [] } } },
      { openai: { response_format: { type: "json_schema", json_schema: { schema: [] } } } },
      { openai: { text: { format: [] } } },
      { openai: { text: { format: { type: "json_schema", schema: [] } } } },
      { anthropic: { output_config: { format: { type: "json_schema", schema: [] } } } },
    ];
    for (const vendor of cases) {
      const read = readResponseFormat({ ...base, vendor });
      expect({ vendor, read }).toEqual({ vendor, read: undefined });
    }
  });

  test("a malformed chat spelling is refused, not silently replaced", () => {
    // A Responses client can legitimately send both spellings. If the one it
    // named first is broken, falling through to the other would answer a
    // different request than the one it wrote — so the broken field wins and
    // the request goes out unstructured, the way it did before any of this.
    const req: ChatRequest = {
      ...base,
      vendor: {
        openai: {
          // Broken at the `type` guard, which is what the fall-through would
          // step past — a malformed `json_schema` leaf returns undefined either
          // way and proves nothing.
          response_format: { type: "text", json_schema: { name: "x", schema: SCHEMA } },
          text: { format: { type: "json_schema", name: "clips", schema: SCHEMA } },
        },
      },
    };
    expect(readResponseFormat(req)).toBeUndefined();
  });

  test("names it `response` when the client left the name off", () => {
    const req: ChatRequest = {
      ...base,
      vendor: { openai: { response_format: { type: "json_schema", json_schema: { schema: {} } } } },
    };
    expect(readResponseFormat(req)?.name).toBe("response");
  });

  test("an empty name is a missing name, not a name", () => {
    // Two of the three backends reject `name: ""`, so forwarding the client's
    // empty string turns a working request into a 400.
    const req: ChatRequest = {
      ...base,
      vendor: {
        openai: { response_format: { type: "json_schema", json_schema: { name: "", schema: {} } } },
      },
    };
    expect(readResponseFormat(req)?.name).toBe("response");
  });

  test("ignores `json_object`, which carries no schema to translate", () => {
    const req: ChatRequest = {
      ...base,
      vendor: { openai: { response_format: { type: "json_object" } } },
    };
    expect(readResponseFormat(req)).toBeUndefined();
  });

  test("the type is what decides, not the presence of a schema beside it", () => {
    // Without this the `type` guard is dead: every other shape happens to lack
    // a `json_schema` and would be refused a line later for that instead.
    const req: ChatRequest = {
      ...base,
      vendor: {
        openai: {
          response_format: { type: "json_object", json_schema: { name: "x", schema: SCHEMA } },
        },
      },
    };
    expect(readResponseFormat(req)).toBeUndefined();
  });

  test("ignores a malformed field rather than failing a request ingress accepted", () => {
    const bad: unknown[] = [
      null,
      "json",
      7,
      { type: "json_schema" },
      { type: "json_schema", json_schema: { schema: "no" } },
    ];
    for (const value of bad) {
      const req: ChatRequest = { ...base, vendor: { openai: { response_format: value } } };
      expect(readResponseFormat(req)).toBeUndefined();
    }
  });

  test("absent bag is absent format", () => {
    const { vendor: _vendor, ...bare } = base;
    expect(readResponseFormat(bare)).toBeUndefined();
  });
});

describe("closeObjects", () => {
  test("closes every object node, at every depth", () => {
    const out = closeObjects(SCHEMA);
    expect(out.additionalProperties).toBe(false);
    const clips = rec(rec(out.properties).clips);
    // The array itself is not an object node and takes no flag.
    expect(clips.additionalProperties).toBeUndefined();
    expect(rec(clips.items).additionalProperties).toBe(false);
  });

  test("`additionalProperties: true` is replaced, because the backend refuses it", () => {
    // Measured: `'additionalProperties: true' is not supported. Please set
    // 'additionalProperties' to false`. Honouring the client's word here would
    // be honouring it into a 400.
    expect(closeObjects({ type: "object", additionalProperties: true }).additionalProperties).toBe(
      false,
    );
  });

  test("a schema-valued additionalProperties is walked, then the node is still closed", () => {
    const out = closeObjects({
      type: "object",
      additionalProperties: { type: "object", properties: { a: { type: "string" } } },
    });
    // The node itself must end up `false` — a subschema is not `false`, and the
    // backend accepts nothing else.
    expect(out.additionalProperties).toBe(false);
  });

  test("closes every schema-bearing position, not only the common three", () => {
    // Each of these can hold an object node, and Anthropic refuses any object
    // node that does not say `additionalProperties: false` — measured against
    // `$defs` specifically, which 400s when left open. Grouped by the shape the
    // position has, because that is what decides how the walker must descend.
    const OPEN = { type: "object" };
    const map = [
      "$defs",
      "definitions",
      "patternProperties",
      "dependentSchemas",
      "dependencies",
      "properties",
    ];
    const list = ["anyOf", "allOf", "oneOf", "prefixItems", "items"];
    const single = [
      "items",
      "additionalItems",
      "contains",
      "contentSchema",
      "if",
      "then",
      "else",
      "not",
      "propertyNames",
      "unevaluatedItems",
      "unevaluatedProperties",
      "additionalProperties",
    ];

    for (const key of map) {
      const node = rec(rec(closeObjects({ [key]: { m: OPEN } })[key]).m);
      expect({ key, closed: node.additionalProperties }).toEqual({ key, closed: false });
    }
    for (const key of list) {
      const arm = closeObjects({ [key]: [OPEN] })[key];
      const node = rec(Array.isArray(arm) ? arm[0] : undefined);
      expect({ key, closed: node.additionalProperties }).toEqual({ key, closed: false });
    }
    for (const key of single) {
      const node = rec(closeObjects({ [key]: OPEN })[key]);
      expect({ key, closed: node.additionalProperties }).toEqual({ key, closed: false });
    }
  });

  test("a property named __proto__ survives instead of vanishing into the prototype", () => {
    // Plain assignment would invoke the legacy setter: the member disappears
    // from the wire schema and the map's prototype is replaced.
    const out = closeObjects(
      JSON.parse('{"type":"object","properties":{"__proto__":{"type":"object"},"keep":{}}}'),
    );
    const props = rec(out.properties);
    expect(Object.hasOwn(props, "__proto__")).toBe(true);
    expect(Object.keys(props).sort()).toEqual(["__proto__", "keep"]);
  });

  test("a schema past the depth cap is reported, not silently half-closed", () => {
    // The cap stops a stack overflow, but what it leaves behind still has open
    // object nodes this backend refuses. Silence there would be the same silent
    // drop this whole change exists to remove.
    let deep: Record<string, unknown> = { type: "object" };
    for (let i = 0; i < 70; i++) deep = { type: "object", properties: { n: deep } };
    const req: ChatRequest = {
      ...base,
      maxTokens: 16,
      vendor: { anthropic: { output_config: { format: { type: "json_schema", schema: deep } } } },
    };
    const { degradations } = toWire(req, "claude-sonnet-4-5", { oauth: false });
    expect(degradations).toContain("anthropic:response-schema-too-deep");
  });

  test("a schema deep enough to overflow a recursive compare still encodes", () => {
    // Regression: deciding "did it change?" with JSON.stringify recursed as deep
    // as the schema and threw RangeError immediately after the cap avoided one.
    let deep: Record<string, unknown> = { type: "object" };
    for (let i = 0; i < 20_000; i++) deep = { type: "object", properties: { n: deep } };
    const req: ChatRequest = {
      ...base,
      maxTokens: 16,
      vendor: { anthropic: { output_config: { format: { type: "json_schema", schema: deep } } } },
    };
    expect(() => toWire(req, "claude-sonnet-4-5", { oauth: false })).not.toThrow();
  });

  test("a native anthropic request is not reported as translated", () => {
    // The vendor merge overwrites whatever the translation wrote, so recording
    // one would describe a wire body that never existed.
    const req: ChatRequest = {
      ...base,
      maxTokens: 16,
      vendor: {
        anthropic: {
          output_config: { format: { type: "json_schema", schema: { type: "object" } } },
        },
      },
    };
    const { degradations } = toWire(req, "claude-sonnet-4-5", { oauth: false });
    expect(degradations).not.toContain("anthropic:response-format-translated");
  });

  test("a non-record `text` is removed rather than forwarded", () => {
    // `text` is an object on this API. A string or array is not a field it
    // defines, so it goes the same way a foreign spelling does.
    for (const bad of ["bad", null, ["bad"]]) {
      const req: ChatRequest = { ...base, vendor: { openai: { text: bad } } };
      const { body, degradations } = toResponsesWire(req, "gpt-5");
      expect({ bad, text: body.text }).toEqual({ bad, text: undefined });
      expect(degradations).toContain("openai:response-format-dropped");
    }
  });

  test("text siblings alone are not reported as a lost response format", () => {
    // `text: {verbosity}` is not a structured-output request. Logging its
    // removal as a dropped format would be a false forensic record.
    const req: ChatRequest = { ...base, vendor: { openai: { text: { verbosity: "low" } } } };
    expect(toCustomChatWire(req, "m").degradations).not.toContain("custom:response-format-dropped");
    expect(toResponsesWire(req, "gpt-5").degradations).toEqual([]);
  });

  test("a schema too deep to walk is returned rather than overflowing the stack", () => {
    // Ingress accepted it, so throwing here would turn accepted input into a
    // crash. The backend refuses what it cannot read; that is its answer to give.
    let deep: Record<string, unknown> = { type: "object" };
    for (let i = 0; i < 20_000; i++) deep = { type: "object", properties: { n: deep } };
    expect(() => closeObjects(deep)).not.toThrow();
  });

  test("truncation begins at the documented depth, not one either side of it", () => {
    // The cap is a number the codec's own recursion limit justifies, so where it
    // starts is the contract. Without this, moving it by one is invisible.
    const nest = (levels: number): Record<string, unknown> => {
      let node: Record<string, unknown> = { type: "object" };
      for (let i = 0; i < levels; i++) node = { type: "object", properties: { n: node } };
      return node;
    };
    const truncatedAt = (levels: number): boolean => {
      const stats = { changed: false, truncated: false };
      closeObjects(nest(levels), stats);
      return stats.truncated;
    };
    expect(truncatedAt(62)).toBe(false);
    expect(truncatedAt(63)).toBe(false);
    expect(truncatedAt(64)).toBe(true);
    expect(truncatedAt(65)).toBe(true);
  });

  test("a stats object reused across schemas reports only the current one", () => {
    // The out-param answers "what happened to THIS schema". A caller holding one
    // object would otherwise read the first verdict and log it against the second.
    const stats = { changed: false, truncated: false };
    closeObjects({ type: "object" }, stats);
    expect(stats.changed).toBe(true);
    closeObjects({ type: "object", additionalProperties: false }, stats);
    expect(stats.changed).toBe(false);
  });

  test("leaves the caller's schema untouched", () => {
    const input = { type: "object", properties: { a: { type: "object" } } };
    const before = structuredClone(input);
    closeObjects(input);
    expect(input).toEqual(before);
  });

  test("walks schema positions only, never a property merely NAMED like one", () => {
    // A property called `items` is data. A walk that recursed by name would
    // close it as if it were an array's element schema.
    const out = closeObjects({ type: "object", properties: { items: { type: "string" } } });
    const items = rec(rec(out.properties).items);
    expect(items.additionalProperties).toBeUndefined();
    expect(items.type).toBe("string");
  });

  test("closes union arms", () => {
    const out = closeObjects({ anyOf: [{ type: "object" }, { type: "string" }] });
    const arms = out.anyOf as unknown[];
    expect(rec(arms[0]).additionalProperties).toBe(false);
    expect(rec(arms[1]).additionalProperties).toBeUndefined();
  });
});

describe("every encoder sends the spelling its backend accepts", () => {
  test("anthropic: output_config.format, with every object node closed", () => {
    const { body, degradations } = toWire({ ...base, maxTokens: 16 }, "claude-sonnet-4-5", {
      oauth: false,
    });
    const format = rec(rec(body.output_config).format);
    expect(format.type).toBe("json_schema");
    // Closed at the root *and* at the nested node: this backend refuses either
    // one left open, so asserting the root alone proves almost nothing.
    const schema = rec(format.schema);
    expect(schema.additionalProperties).toBe(false);
    expect(rec(rec(rec(schema.properties).clips).items).additionalProperties).toBe(false);
    expect(body.response_format).toBeUndefined();
    expect(degradations).toContain("anthropic:response-format-translated");
  });

  test("anthropic: a client's own output_config keeps its schema, closed", () => {
    const req: ChatRequest = {
      ...base,
      maxTokens: 16,
      vendor: {
        ...base.vendor,
        anthropic: {
          output_config: { format: { type: "json_schema", schema: { type: "object" } } },
        },
      },
    };
    const { body, degradations } = toWire(req, "claude-sonnet-4-5", { oauth: false });
    // The client's schema, not the translated one: no `properties` key. But
    // closed, because this backend refuses an open object node whoever wrote it.
    expect(rec(rec(body.output_config).format).schema).toEqual({
      type: "object",
      additionalProperties: false,
    });
    expect(degradations).toContain("anthropic:response-schema-closed");
  });

  test("anthropic: a schema already closed is left alone and records nothing", () => {
    const req: ChatRequest = {
      ...base,
      maxTokens: 16,
      vendor: {
        anthropic: {
          output_config: {
            format: {
              type: "json_schema",
              schema: { type: "object", additionalProperties: false },
            },
          },
        },
      },
    };
    const { degradations } = toWire(req, "claude-sonnet-4-5", { oauth: false });
    expect(degradations).not.toContain("anthropic:response-schema-closed");
  });

  test("anthropic: the reasoning effort on output_config survives beside the format", () => {
    const req: ChatRequest = {
      ...base,
      maxTokens: 16,
      reasoning: { mode: "adaptive", effort: "high" },
    };
    const config = rec(toWire(req, "claude-sonnet-4-5", { oauth: false }).body.output_config);
    expect(config.effort).toBe("high");
    expect(config.format).toBeDefined();
  });

  test("antigravity: generationConfig.responseSchema, pruned for the proto", () => {
    const { body, degradations } = toAntigravityWire(base, "gemini-3.8-flash-high", {
      project: "p",
      requestId: "r",
      cloak: null,
    });
    expect(rec(body.request.generationConfig).responseSchema).toBeDefined();
    expect(body.request.response_format).toBeUndefined();
    expect(degradations).toContain("antigravity:response-format-translated");
  });

  test("antigravity: the prune drops what the proto refuses", () => {
    const req: ChatRequest = {
      ...base,
      vendor: {
        openai: {
          response_format: {
            type: "json_schema",
            json_schema: {
              name: "x",
              // `const` and an unknown keyword: both refused by Gemini's Schema.
              schema: { type: "object", properties: { a: { const: "lit", nope: 1 } } },
            },
          },
        },
      },
    };
    const { body } = toAntigravityWire(req, "gemini-3.8-flash-high", {
      project: "p",
      requestId: "r",
      cloak: null,
    });
    const schema = rec(rec(body.request.generationConfig).responseSchema);
    const a = rec(rec(schema.properties).a);
    expect(a.const).toBeUndefined();
    expect(a.nope).toBeUndefined();
    // `const` becomes the one-member enum that says the same thing here.
    expect(a.enum).toEqual(["lit"]);
  });

  test("openai: text.format, and the refused raw copy is gone", () => {
    const { body, degradations } = toResponsesWire(base, "gpt-5");
    const format = rec(rec(body.text).format);
    expect(format.type).toBe("json_schema");
    expect(format.name).toBe("clips");
    expect(format.strict).toBe(true);
    // The whole point: the merge copied it in, and this API 400s on it.
    expect(body.response_format).toBeUndefined();
    expect(degradations).toContain("openai:response-format-translated");
  });

  test("muse: text.format, and the refused raw copy is gone", () => {
    const { body, degradations } = toMuseWire(base, "m");
    const format = rec(rec(body.text).format);
    expect(format.name).toBe("clips");
    expect(format.strict).toBe(true);
    expect(body.response_format).toBeUndefined();
    expect(degradations).toContain("muse:response-format-translated");
  });

  test("custom responses: text.format, raw copy removed", () => {
    const { body, degradations } = toCustomResponsesWire(base, "m");
    const format = rec(rec(body.text).format);
    expect(format.type).toBe("json_schema");
    expect(format.strict).toBe(true);
    expect(body.response_format).toBeUndefined();
    expect(degradations).toContain("custom:response-format-translated");
  });

  test("grok: text.format, reached through a bag no ingress writes", () => {
    const { body, degradations } = toGrokWire(base, "grok-4");
    const format = rec(rec(body.text).format);
    expect(format.name).toBe("clips");
    expect(format.strict).toBe(true);
    expect(degradations).toContain("grok:response-format-translated");
  });

  test("kilo: response_format, the spelling chat completions takes", () => {
    const { body, degradations } = toKiloWire(base, "m");
    const rf = rec(body.response_format);
    expect(rf.type).toBe("json_schema");
    expect(rec(rf.json_schema).name).toBe("clips");
    expect(rec(rf.json_schema).strict).toBe(true);
    expect(degradations).toContain("kilo:response-format-translated");
  });

  test("kimi: response_format, the spelling chat completions takes", () => {
    const { body, degradations } = toChatWire(base, "m");
    // The whole object, not just the name: a wrong discriminator or a missing
    // `strict` is a different request, and the schema path alone hides both.
    expect(body.response_format).toEqual({
      type: "json_schema",
      json_schema: { name: "clips", schema: SCHEMA, strict: true },
    });
    expect(degradations).toContain("kimi:response-format-translated");
  });

  test("custom chat: a Responses spelling is translated whole", () => {
    // The native-spelling test below proves passthrough; this one proves the
    // translation, which is where the discriminator and `strict` are written.
    const req: ChatRequest = {
      ...base,
      vendor: {
        openai: { text: { format: { type: "json_schema", name: "clips", schema: SCHEMA } } },
      },
    };
    const { body, degradations } = toCustomChatWire(req, "m");
    expect(body.response_format).toEqual({
      type: "json_schema",
      json_schema: { name: "clips", schema: SCHEMA, strict: true },
    });
    expect(degradations).toContain("custom:response-format-translated");
  });

  test("custom chat: the bag merge already carried it, so nothing is added twice", () => {
    const { body, degradations } = toCustomChatWire(base, "m");
    // Verbatim from the client, not a rebuilt copy: no `strict` was sent.
    expect(body.response_format).toEqual({
      type: "json_schema",
      json_schema: { name: "clips", schema: SCHEMA },
    });
    expect(degradations).not.toContain("custom:response-format-translated");
  });

  test("json_object reaches a Responses backend in that backend's spelling", () => {
    // It carries no schema, so `readResponseFormat` declines it — but leaving it
    // on the body leaves the field the API answers `Unsupported parameter` to.
    const req: ChatRequest = {
      ...base,
      vendor: { openai: { response_format: { type: "json_object" } } },
    };
    const { body, degradations } = toResponsesWire(req, "gpt-5");
    expect(body.response_format).toBeUndefined();
    expect(rec(rec(body.text).format).type).toBe("json_object");
    expect(degradations).toContain("openai:response-format-translated");
  });

  test("a sibling on `text` does not cost the client its schema", () => {
    // `text` holds more than the format — `verbosity` is the common one. Treating
    // any `text` as an override silently discarded the schema.
    const req: ChatRequest = {
      ...base,
      vendor: { openai: { ...base.vendor?.openai, text: { verbosity: "low" } } },
    };
    const { body } = toResponsesWire(req, "gpt-5");
    const text = rec(body.text);
    expect(text.verbosity).toBe("low");
    expect(rec(text.format).name).toBe("clips");
  });

  test("an unreadable foreign spelling is still removed, and said so", () => {
    // The schema cannot be translated, but `text` is not a field a chat
    // completions endpoint defines — leaving it is leaving a 400.
    const req: ChatRequest = {
      ...base,
      vendor: { openai: { text: { format: { type: "json_schema", schema: "nonsense" } } } },
    };
    const { body, degradations } = toCustomChatWire(req, "m");
    expect(body.text).toBeUndefined();
    expect(degradations).toContain("custom:response-format-dropped");
  });

  test("a malformed native spelling does not outrank a valid one on the same request", () => {
    // A client can send both. `readResponseFormat` refuses a malformed *earlier*
    // spelling rather than falling through, and a malformed *later* one must not
    // win either: `text: {format: null}` is not a request this API can answer,
    // so the valid `response_format` beside it is what goes out.
    const { body, degradations } = toResponsesWire(
      { ...base, vendor: { openai: { ...base.vendor?.openai, text: { format: null } } } },
      "gpt-5",
    );
    expect(rec(rec(body.text).format).name).toBe("clips");
    expect(degradations).toContain("openai:response-format-translated");
  });

  test("anthropic: a malformed native format loses to the translation it would bury", () => {
    // The vendor bag is merged whole and merged last, so an unreadable
    // `output_config.format` would overwrite a translated one written before it.
    const { body, degradations } = toWire(
      {
        ...base,
        maxTokens: 16,
        vendor: {
          ...base.vendor,
          anthropic: { output_config: { format: null } },
        },
      },
      "claude-sonnet-4-5",
      { oauth: false },
    );
    const format = rec(rec(body.output_config).format);
    expect(rec(format.schema).additionalProperties).toBe(false);
    expect(degradations).toContain("anthropic:response-format-translated");
  });

  test("a schema too deep to serialize is dropped on every target, not thrown", () => {
    // Every codec renders its body with `JSON.stringify`, which recurses as deep
    // as the schema does. Reading such a schema at all would move the crash from
    // the walker into the codec, so the reader refuses it and the field goes.
    let deep: Record<string, unknown> = { type: "object" };
    for (let i = 0; i < 20_000; i++) deep = { type: "object", properties: { n: deep } };
    const req: ChatRequest = {
      ...base,
      vendor: {
        openai: {
          response_format: { type: "json_schema", json_schema: { name: "c", schema: deep } },
        },
      },
    };
    for (const body of [
      toResponsesWire(req, "gpt-5").body as Record<string, unknown>,
      toChatWire(req, "m").body as Record<string, unknown>,
      toWire({ ...req, maxTokens: 16 }, "claude-sonnet-4-5", { oauth: false })
        .body as unknown as Record<string, unknown>,
    ]) {
      expect(() => JSON.stringify(body)).not.toThrow();
    }
  });

  test("the reader and the walker refuse at the same depth, through every position", () => {
    // Two limits answering one question — whether the codec can serialize this
    // body. They once counted different units: the walker counted schema levels
    // and the reader counted raw object levels, converted with a constant. That
    // constant fitted only positions that cross a container before the child.
    // `items` crosses one level per schema level, so a schema nested through it
    // was read at twice the depth the walker would close, and went out
    // half-closed — the exact 400 the cap exists to prevent. Every shape is
    // asserted because the bug lived in the shapes that were not.
    const SHAPES: Record<string, (child: Record<string, unknown>) => Record<string, unknown>> = {
      properties: (child) => ({ type: "object", properties: { n: child } }),
      $defs: (child) => ({ type: "object", $defs: { d: child } }),
      patternProperties: (child) => ({ type: "object", patternProperties: { "^a": child } }),
      anyOf: (child) => ({ type: "object", anyOf: [child] }),
      prefixItems: (child) => ({ type: "array", prefixItems: [child] }),
      items: (child) => ({ type: "array", items: child }),
      contains: (child) => ({ type: "array", contains: child }),
      not: (child) => ({ type: "object", not: child }),
      propertyNames: (child) => ({ type: "object", propertyNames: child }),
    };
    const nest = (
      levels: number,
      wrap: (c: Record<string, unknown>) => Record<string, unknown>,
    ) => {
      let node: Record<string, unknown> = { type: "object" };
      for (let i = 0; i < levels; i++) node = wrap(node);
      return node;
    };
    const reads = (schema: Record<string, unknown>): boolean =>
      readResponseFormat({
        ...base,
        vendor: {
          openai: { response_format: { type: "json_schema", json_schema: { name: "c", schema } } },
        },
      }) !== undefined;
    const truncates = (schema: Record<string, unknown>): boolean => {
      const stats = { changed: false, truncated: false };
      closeObjects(schema, stats);
      return stats.truncated;
    };
    // 63 is the last depth the walker closes fully. The reader must reach it —
    // one level tighter and it refuses schemas this gateway could have sent —
    // and must not reach past it, or a half-closed schema goes out.
    for (const [name, wrap] of Object.entries(SHAPES)) {
      expect(`${name}:${truncates(nest(63, wrap))}`).toBe(`${name}:false`);
      expect(`${name}:${reads(nest(63, wrap))}`).toBe(`${name}:true`);
      expect(`${name}:${truncates(nest(64, wrap))}`).toBe(`${name}:true`);
      expect(`${name}:${reads(nest(64, wrap))}`).toBe(`${name}:false`);
    }
  });

  test("a native schema past the cap is removed, not sent half-closed", () => {
    // It arrives through the vendor bag, so the reader never saw it. What the
    // walker could not finish closing this backend rejects — and the codec
    // cannot serialize it anyway, so the field goes rather than the request.
    let deep: Record<string, unknown> = { type: "object" };
    for (let i = 0; i < 20_000; i++) deep = { type: "object", properties: { n: deep } };
    const { body, degradations } = toWire(
      {
        ...base,
        maxTokens: 16,
        vendor: { anthropic: { output_config: { format: { type: "json_schema", schema: deep } } } },
      },
      "claude-sonnet-4-5",
      { oauth: false },
    );
    expect(rec(body.output_config).format).toBeUndefined();
    expect(degradations).toContain("anthropic:response-schema-too-deep");
    expect(() => JSON.stringify(body)).not.toThrow();
  });

  test("an unreadable native format is reported as dropped, not silently removed", () => {
    // Nothing else in the request asked for structured output, so the removal is
    // the whole story — and a removal nobody records is the bug this all started
    // as.
    const { vendor: _vendor, ...bare } = base;
    const { degradations } = toResponsesWire(
      { ...bare, vendor: { openai: { text: { format: null } } } },
      "gpt-5",
    );
    expect(degradations).toContain("openai:response-format-dropped");
  });

  test("a malformed native format never buries a valid one, record or not", () => {
    // `isRecord` alone is not "readable": `{}`, a wrong discriminator and a null
    // schema are all records this API cannot answer, and letting one outrank a
    // valid spelling the same request carried loses the schema in silence.
    const MALFORMED: unknown[] = [
      null,
      "nope",
      {},
      { type: "wrong", schema: { type: "object" } },
      { type: "json_schema", schema: null },
    ];
    for (const bad of MALFORMED) {
      const req: ChatRequest = {
        ...base,
        vendor: {
          openai: {
            response_format: { type: "json_schema", json_schema: { name: "c", schema: SCHEMA } },
            text: { format: bad },
          },
        },
      };
      const { body, degradations } = toResponsesWire(req, "gpt-5", { oauth: false });
      const text = body.text as { format?: { schema?: Record<string, unknown> } };
      expect(`${JSON.stringify(bad)} -> ${text.format?.schema !== undefined}`).toBe(
        `${JSON.stringify(bad)} -> true`,
      );
      expect(degradations).toContain("openai:response-format-translated");
    }
  });

  test("translating never edits the request the next retry will read", () => {
    // `body.text` is the caller's own `req.vendor.openai.text`, carried here by a
    // shallow merge, and the IR is shared across dispatch attempts. Deleting from
    // it would change what every later attempt sees — and throw on a frozen one.
    const text = Object.freeze({ verbosity: "low", format: null });
    const req: ChatRequest = {
      ...base,
      vendor: {
        openai: {
          response_format: { type: "json_schema", json_schema: { name: "c", schema: SCHEMA } },
          text,
        },
      },
    };
    const { body } = toResponsesWire(req, "gpt-5", { oauth: false });
    expect(text).toEqual({ verbosity: "low", format: null });
    expect((body.text as { verbosity?: string }).verbosity).toBe("low");
    expect((body.text as { format?: { schema?: unknown } }).format?.schema).toEqual(SCHEMA);
  });

  test("anthropic: an unreadable output_config costs neither the schema nor the effort", () => {
    // The bag is merged whole, so a value this API cannot read replaces the whole
    // field — taking the translation and the `effort` the reasoning path wrote to
    // that same field with it.
    for (const bag of ["bad", null, [], { format: null }]) {
      const req: ChatRequest = {
        ...base,
        reasoning: { mode: "adaptive", effort: "high" },
        vendor: {
          openai: {
            response_format: { type: "json_schema", json_schema: { name: "c", schema: SCHEMA } },
          },
          anthropic: { output_config: bag },
        },
      };
      const { body, degradations } = toWire(req, "claude-opus-4-5", { oauth: false });
      const config = body.output_config as {
        effort?: string;
        format?: { schema?: Record<string, unknown> };
      };
      const label = JSON.stringify(bag);
      expect(`${label} effort=${config.effort}`).toBe(`${label} effort=high`);
      expect(`${label} schema=${config.format?.schema !== undefined}`).toBe(`${label} schema=true`);
      // The client's own field was discarded. That is the fact the degradation
      // names, whether or not a translation survived in its place.
      expect(degradations).toContain("anthropic:response-format-dropped");
    }
  });

  test("anthropic: rescuing encoder members does not outrank the client's own", () => {
    // Carrying `effort` across the merge must not invert the merge: vendor
    // passthrough is last because the client's own field wins, and a rescue that
    // reorders the spread silently overrides the value they sent.
    const req: ChatRequest = {
      ...base,
      reasoning: { mode: "adaptive", effort: "high" },
      vendor: {
        openai: {
          response_format: { type: "json_schema", json_schema: { name: "c", schema: SCHEMA } },
        },
        anthropic: { output_config: { effort: "low" } },
      },
    };
    const { body } = toWire(req, "claude-opus-4-5", { oauth: false });
    const config = body.output_config as { effort?: string; format?: { schema?: unknown } };
    expect(config.effort).toBe("low");
    expect(config.format?.schema).not.toBeUndefined();
  });

  test("a schema refused by the reader is dropped out loud, on every target", () => {
    // Past the cap the reader returns nothing, which looks exactly like a request
    // that never asked. Without a word here the response comes back unstructured
    // and the log says the request was ordinary.
    let deep: Record<string, unknown> = { type: "object" };
    for (let i = 0; i < 80; i++) deep = { type: "array", items: deep };
    const req: ChatRequest = {
      ...base,
      vendor: {
        openai: {
          response_format: { type: "json_schema", json_schema: { name: "c", schema: deep } },
        },
      },
    };
    expect(toWire(req, "claude-opus-4-5", { oauth: false }).degradations).toContain(
      "anthropic:response-schema-too-deep",
    );
    expect(toChatWire(req, "k2").degradations).toContain("kimi:response-schema-too-deep");
    expect(toResponsesWire(req, "gpt-5", { oauth: false }).degradations).toContain(
      "openai:response-format-dropped",
    );
  });

  test("no structured-output request means no field and no degradation anywhere", () => {
    const { vendor: _vendor, ...bare } = base;

    const anthropic = toWire({ ...bare, maxTokens: 16 }, "claude-sonnet-4-5", { oauth: false });
    expect(anthropic.body.output_config).toBeUndefined();
    expect(anthropic.degradations).toEqual([]);

    const gemini = toAntigravityWire(bare, "gemini-3.8-flash-high", {
      project: "p",
      requestId: "r",
      cloak: null,
    });
    const config = gemini.body.request.generationConfig;
    expect(config === undefined ? undefined : rec(config).responseSchema).toBeUndefined();

    const openai = toResponsesWire(bare, "gpt-5");
    expect(openai.body.text).toBeUndefined();
    expect(openai.degradations).not.toContain("openai:response-format-translated");
  });
});

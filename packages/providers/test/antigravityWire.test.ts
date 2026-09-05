import { describe, expect, test } from "bun:test";
import type { ChatRequest } from "@omni/ir";
import { buildToolCloak, cloakName, uncloakName } from "../src/antigravity/cloak.ts";
import { ANTIGRAVITY_MODELS } from "../src/antigravity/models.ts";
import { toAntigravityWire } from "../src/antigravity/wire.ts";
import { AGENT_PREAMBLE } from "../src/body.ts";

const base: ChatRequest = { model: "gemini-3.6-flash-high", messages: [], stream: true };

function build(req: Partial<ChatRequest>) {
  const request = { ...base, ...req };
  // The cloak is built here because `codec.ts` builds it here — a harness that
  // passed none would test an encoder no caller has.
  return toAntigravityWire(request, "gemini-3.6-flash-high", {
    project: "projects/p-1",
    requestId: "req-1",
    cloak: buildToolCloak(request),
  });
}

/**
 * The one declaration a single-tool fixture produces.
 *
 * `functionDeclarations` is `unknown[]` because the encoder builds what Google's
 * proto accepts rather than a type this package restates; narrowing once here
 * keeps that honest and every assertion below readable.
 */
function declaration(body: { request: { tools?: { functionDeclarations: unknown[] }[] } }) {
  return body.request.tools?.[0]?.functionDeclarations[0] as Record<string, unknown>;
}

describe("the Cloud Code envelope", () => {
  test("carries exactly the six keys Google accepts", () => {
    const { body } = build({});
    expect(Object.keys(body).sort()).toEqual([
      "model",
      "project",
      "request",
      "requestId",
      "requestType",
      "userAgent",
    ]);
    expect(body.project).toBe("projects/p-1");
    expect(body.requestId).toBe("req-1");
    expect(body.model).toBe("gemini-3.6-flash-high");
    expect(body.userAgent).toBe("antigravity");
    expect(body.requestType).toBe("agent");
  });

  test("merges vendor passthrough into request, never into the envelope", () => {
    const { body } = build({
      vendor: { antigravity: { generationConfig: { topP: 0.5 }, somethingNew: 1 } },
    });
    expect(Object.keys(body).sort()).toEqual([
      "model",
      "project",
      "request",
      "requestId",
      "requestType",
      "userAgent",
    ]);
    expect(body.request.somethingNew).toBe(1);
  });
});

describe("message mapping", () => {
  test("system becomes systemInstruction and assistant becomes model", () => {
    const { body } = build({
      system: [{ type: "text", text: "be terse" }],
      messages: [
        { role: "user", content: [{ type: "text", text: "hi" }] },
        { role: "assistant", content: [{ type: "text", text: "hello" }] },
      ],
    });
    expect(body.request.systemInstruction).toEqual({ parts: [{ text: "be terse" }] });
    expect(body.request.contents).toEqual([
      { role: "user", parts: [{ text: "hi" }] },
      { role: "model", parts: [{ text: "hello" }] },
      // Appended by `closingTurn`, which has its own test: this history ends on
      // a model turn, and the upstream refuses those outright.
      { role: "user", parts: [{ text: " " }] },
    ]);
  });

  test("drops the Claude Agent SDK preamble, which the upstream refuses verbatim", () => {
    const { body, degradations } = build({
      system: [
        { type: "text", text: AGENT_PREAMBLE },
        { type: "text", text: "You are an agent for Claude Code." },
      ],
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    });
    expect(body.request.systemInstruction).toEqual({
      parts: [{ text: "You are an agent for Claude Code." }],
    });
    expect(degradations).toContain("antigravity:agent-preamble-dropped");
  });

  test("drops the preamble as a paragraph inside a block, and only that paragraph", () => {
    const { body, degradations } = build({
      system: [{ type: "text", text: `before\n\n${AGENT_PREAMBLE}\n\nafter` }],
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    });
    expect(body.request.systemInstruction).toEqual({ parts: [{ text: "before\n\nafter" }] });
    expect(degradations).toContain("antigravity:agent-preamble-dropped");
  });

  test("leaves a near-miss paragraph alone: the upstream matches the exact string", () => {
    const { body, degradations } = build({
      system: [{ type: "text", text: "You are an agent, built on the Claude Agent SDK." }],
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    });
    expect(body.request.systemInstruction).toEqual({
      parts: [{ text: "You are an agent, built on the Claude Agent SDK." }],
    });
    expect(degradations).not.toContain("antigravity:agent-preamble-dropped");
  });

  test("a mid-conversation system turn keeps its position as a user turn", () => {
    const { body, degradations } = build({
      messages: [
        { role: "user", content: [{ type: "text", text: "one" }] },
        { role: "system", content: [{ type: "text", text: "rule" }] },
        { role: "user", content: [{ type: "text", text: "two" }] },
      ],
    });
    // One turn, not three: Gemini refuses consecutive same-role entries, so the
    // three `user` turns this produces are merged. What must survive is the
    // **position** — the instruction sits between the two user texts, in the
    // order the client wrote them.
    expect(body.request.contents.map((c) => c.role)).toEqual(["user"]);
    expect(body.request.contents[0]?.parts).toEqual([
      { text: "one" },
      { text: "rule" },
      { text: "two" },
    ]);
    expect(degradations).toContain("antigravity:system-turn-as-user");
    // Never folded into the request-level instruction, which would move an
    // instruction the client placed deliberately to the front of the prompt.
    expect(body.request.systemInstruction).toBeUndefined();
  });

  test("a turn carrying a tool result is sent as user even when the IR says assistant", () => {
    const { body } = build({
      messages: [
        {
          role: "assistant",
          content: [{ type: "toolResult", toolUseId: "t1", content: "42" }],
        },
      ],
    });
    expect(body.request.contents[0]?.role).toBe("user");
  });

  test("tool use and tool result round-trip by name", () => {
    const { body } = build({
      messages: [
        // A real opening user turn: a history that starts on a tool exchange is
        // repaired by `openingTurn`, which its own test covers.
        { role: "user", content: [{ type: "text", text: "read it" }] },
        {
          role: "assistant",
          content: [{ type: "toolUse", id: "t1", name: "Read", input: { path: "/a" } }],
        },
        { role: "user", content: [{ type: "toolResult", toolUseId: "t1", content: "ok" }] },
      ],
    });
    expect(body.request.contents[1]?.parts).toEqual([
      {
        // Without a signature Gemini refuses the continuation outright — the
        // first tool call works and its result cannot be sent back — so a
        // replayed call carries the sentinel the backend accepts in place of the
        // one the IR cannot keep.
        thoughtSignature: "skip_thought_signature_validator",
        functionCall: { name: "Read", args: { path: "/a" } },
      },
    ]);
    expect(body.request.contents[2]?.parts).toEqual([
      { functionResponse: { name: "Read", response: { output: "ok" } } },
    ]);
  });

  test("adjacent turns that end up with one role are merged", () => {
    // Gemini answers 400 INVALID_ARGUMENT on consecutive same-role entries, and
    // this encoder produces them without any help from a malformed client: the
    // tool-result turn is forced to `user` and the client's next turn is a user
    // turn already.
    const { body } = build({
      messages: [
        { role: "user", content: [{ type: "text", text: "read it" }] },
        {
          role: "assistant",
          content: [{ type: "toolUse", id: "t1", name: "Read", input: {} }],
        },
        { role: "user", content: [{ type: "toolResult", toolUseId: "t1", content: "ok" }] },
        { role: "user", content: [{ type: "text", text: "and now?" }] },
      ],
    });

    expect(body.request.contents.map((c) => c.role)).toEqual(["user", "model", "user"]);
    // Merged by concatenation, so nothing is lost and the order is the client's.
    expect(body.request.contents[2]?.parts).toEqual([
      { functionResponse: { name: "Read", response: { output: "ok" } } },
      { text: "and now?" },
    ]);
  });

  test("a failed tool result reaches the model, and the loss of its flag is recorded", () => {
    const { body, degradations } = build({
      messages: [
        { role: "user", content: [{ type: "text", text: "run it" }] },
        {
          role: "user",
          content: [
            { type: "toolResult", toolUseId: "t9", content: "permission denied", isError: true },
          ],
        },
      ],
    });
    // Gemini's functionResponse has no failure flag, so the text is all that
    // survives — indistinguishable from a successful result without the record.
    expect(body.request.contents[0]?.parts[1]).toMatchObject({
      functionResponse: { response: { output: "permission denied" } },
    });
    expect(degradations).toContain("antigravity:tool-result-error-flag-dropped");
  });

  test("a history opening on a tool exchange gets an empty user turn", () => {
    // Measured: a conversation whose first entry is a model turn, or a function
    // response, is a 400 — `Please ensure that function call turn comes
    // immediately after a user turn …`. This is what a client that trims
    // history sends, so it is repaired rather than refused.
    const call = build({
      messages: [
        { role: "assistant", content: [{ type: "toolUse", id: "t1", name: "Read", input: {} }] },
        { role: "user", content: [{ type: "toolResult", toolUseId: "t1", content: "ok" }] },
      ],
    });
    expect(call.body.request.contents[0]).toEqual({ role: "user", parts: [{ text: "" }] });
    expect(call.body.request.contents.map((c) => c.role)).toEqual(["user", "model", "user"]);
    expect(call.degradations).toContain("antigravity:opening-turn-added");

    const response = build({
      messages: [
        { role: "user", content: [{ type: "toolResult", toolUseId: "t1", content: "ok" }] },
        { role: "assistant", content: [{ type: "text", text: "done" }] },
      ],
    });
    // Empty, not "(continued)": a placeholder would put words in the prompt the
    // client never wrote and the model would read them.
    expect(response.body.request.contents[0]?.parts[0]).toEqual({ text: "" });
    expect(response.degradations).toContain("antigravity:opening-turn-added");
  });

  test("a history ending on a model turn gets a trailing user turn", () => {
    // Measured: `Requests ending with a model turn are not supported.` — and
    // reachable from an ordinary feature, since an Anthropic client prefills the
    // answer with a trailing assistant turn for the model to continue from.
    const { body, degradations } = build({
      messages: [
        { role: "user", content: [{ type: "text", text: "Count to three." }] },
        { role: "assistant", content: [{ type: "text", text: "1, 2," }] },
      ],
    });
    // The prefill is kept, not dropped: it is the thing the client asked for.
    expect(body.request.contents.map((c) => c.role)).toEqual(["user", "model", "user"]);
    expect(body.request.contents[1]?.parts).toEqual([{ text: "1, 2," }]);
    // A space, not the empty string `openingTurn` uses — measured: a trailing
    // turn holding only `{ text: "" }` is refused with the same message.
    expect(body.request.contents[2]).toEqual({ role: "user", parts: [{ text: " " }] });
    expect(degradations).toContain("antigravity:closing-turn-added");
  });

  test("a history already ending on a user turn is left alone", () => {
    const { body, degradations } = build({
      messages: [
        { role: "user", content: [{ type: "text", text: "hi" }] },
        { role: "assistant", content: [{ type: "text", text: "hello" }] },
        { role: "user", content: [{ type: "text", text: "again" }] },
      ],
    });
    expect(body.request.contents.map((c) => c.role)).toEqual(["user", "model", "user"]);
    expect(body.request.contents[2]?.parts).toEqual([{ text: "again" }]);
    expect(degradations).not.toContain("antigravity:closing-turn-added");
  });

  test("a lone model turn is repaired at both ends", () => {
    const { body, degradations } = build({
      messages: [{ role: "assistant", content: [{ type: "text", text: "hello" }] }],
    });
    expect(body.request.contents).toEqual([
      { role: "user", parts: [{ text: "" }] },
      { role: "model", parts: [{ text: "hello" }] },
      { role: "user", parts: [{ text: " " }] },
    ]);
    expect(degradations).toContain("antigravity:opening-turn-added");
    expect(degradations).toContain("antigravity:closing-turn-added");
  });

  test("a history already opening on a user turn is left alone", () => {
    // The positive control: prepending unconditionally would satisfy the test
    // above while corrupting every ordinary conversation.
    const { body, degradations } = build({
      messages: [
        { role: "user", content: [{ type: "text", text: "go" }] },
        { role: "assistant", content: [{ type: "toolUse", id: "t1", name: "Read", input: {} }] },
      ],
    });
    expect(body.request.contents[0]?.parts).toEqual([{ text: "go" }]);
    expect(degradations).not.toContain("antigravity:opening-turn-added");
  });

  test("a cache breakpoint the envelope cannot carry is recorded", () => {
    const { degradations } = build({
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "long prefix", cacheControl: { type: "ephemeral" } }],
        },
      ],
    });
    expect(degradations).toContain("antigravity:cache-control-dropped");
  });

  test("a request carrying no breakpoint degrades nothing", () => {
    // The positive control: an encoder that recorded the loss unconditionally
    // would satisfy the test above and say nothing true.
    const { degradations } = build({
      messages: [{ role: "user", content: [{ type: "text", text: "plain" }] }],
    });
    expect(degradations).toEqual([]);
  });

  test("a tool result whose call is not in history still names something", () => {
    const { body, degradations } = build({
      messages: [
        { role: "user", content: [{ type: "text", text: "run it" }] },
        { role: "user", content: [{ type: "toolResult", toolUseId: "t9", content: "x" }] },
      ],
    });
    const part = body.request.contents[0]?.parts[1];
    expect(part).toEqual({ functionResponse: { name: "t9", response: { output: "x" } } });
    expect(degradations).toContain("antigravity:tool-result-unmatched");
  });

  test("images become inlineData and thinking is dropped with a degradation", () => {
    const { body, degradations } = build({
      messages: [
        {
          role: "user",
          content: [
            { type: "image", mediaType: "image/png", data: "AAA" },
            { type: "thinking", text: "hmm" },
          ],
        },
      ],
    });
    expect(body.request.contents[0]?.parts).toEqual([
      { inlineData: { mimeType: "image/png", data: "AAA" } },
    ]);
    expect(degradations).toContain("antigravity:thinking-dropped");
  });
});

describe("generation config and tools", () => {
  test("maxTokens and temperature reach generationConfig", () => {
    const { body } = build({ maxTokens: 100, temperature: 0.2 });
    expect(body.request.generationConfig).toEqual({ maxOutputTokens: 100, temperature: 0.2 });
  });

  test("portable tools become functionDeclarations and provider tools are dropped", () => {
    const { body, degradations } = build({
      tools: [
        {
          kind: "portable",
          name: "Read",
          description: "read a file",
          inputSchema: { type: "object" },
        },
        {
          kind: "provider",
          provider: "anthropic",
          name: "bash",
          family: "bash",
          type: "bash_20250124",
          wire: {},
        },
      ],
    });
    expect(body.request.tools).toEqual([
      {
        functionDeclarations: [
          { name: "Read", description: "read a file", parameters: { type: "object" } },
        ],
      },
    ]);
    expect(degradations).toContain("antigravity:provider-tool-dropped");
  });

  test("a tool schema is pruned to the fields Gemini's Schema message declares", () => {
    // Every keyword here was named by a live `400 Invalid JSON payload received`
    // on 2026-09-05; the values are the shapes the real payload carried.
    const { body, degradations } = build({
      tools: [
        {
          kind: "portable",
          name: "Read",
          description: "read a file",
          inputSchema: {
            $schema: "https://json-schema.org/draft/2020-12/schema",
            type: "object",
            additionalProperties: false,
            properties: {
              limit: { type: "number", exclusiveMinimum: 0, description: "how many" },
              status: { const: "proactive" },
              metadata: { type: "object", propertyNames: { type: "string" } },
              tags: { type: "array", items: { type: "string", $comment: "drop me" } },
              to: { type: "string", allOf: [{ pattern: "^[^\\n]*$" }] },
            },
            required: ["limit"],
          },
        },
      ],
    });
    expect(declaration(body)).toEqual({
      name: "Read",
      description: "read a file",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          limit: { type: "number", description: "how many" },
          // `const` is the one keyword worth translating rather than dropping:
          // it is how a discriminated union names its arm.
          status: { enum: ["proactive"] },
          metadata: { type: "object" },
          tags: { type: "array", items: { type: "string" } },
          to: { type: "string", allOf: [{ pattern: "^[^\\n]*$" }] },
        },
        required: ["limit"],
      },
    });
    expect(degradations).toContain("antigravity:tool-schema-pruned");
  });

  test("a tool schema Gemini already accepts is passed through unpruned", () => {
    const schema = { type: "object", properties: { path: { type: "string" } } };
    const { body, degradations } = build({
      tools: [{ kind: "portable", name: "Read", description: "d", inputSchema: schema }],
    });
    expect(declaration(body)).toEqual({
      name: "Read",
      description: "d",
      parameters: schema,
    });
    expect(degradations).not.toContain("antigravity:tool-schema-pruned");
  });

  test("every field in the allowlist survives a round trip", () => {
    // The allowlist *is* the load-bearing data of the prune, so it is asserted
    // whole: without this, dropping a member is invisible until a client that
    // uses it loses a constraint upstream.
    const schema = {
      type: "object",
      format: "custom",
      title: "T",
      description: "d",
      nullable: false,
      default: {},
      example: { a: 1 },
      enum: ["x"],
      minProperties: 1,
      maxProperties: 9,
      required: ["a"],
      propertyOrdering: ["a"],
      additionalProperties: false,
      properties: {
        a: { type: "string", minLength: 1, maxLength: 4, pattern: "^a" },
        b: { type: "number", minimum: 0, maximum: 10 },
        c: { type: "array", minItems: 1, maxItems: 3, items: { type: "string" } },
        d: { anyOf: [{ type: "string" }], allOf: [{ pattern: "^d" }] },
        e: { type: "object", additionalProperties: { type: "string" } },
      },
    };
    const { body, degradations } = build({
      tools: [{ kind: "portable", name: "T", description: "d", inputSchema: schema }],
    });
    expect(declaration(body)).toEqual({
      name: "T",
      description: "d",
      parameters: schema,
    });
    expect(degradations).not.toContain("antigravity:tool-schema-pruned");
  });

  test("an unknown keyword is pruned from every position that holds a schema", () => {
    // One fixture per recursion site, because a missing `case` in the walk is
    // silent: the keyword simply survives at that depth.
    const { body, degradations } = build({
      tools: [
        {
          kind: "portable",
          name: "T",
          description: "d",
          inputSchema: {
            type: "object",
            properties: {
              a: { type: "array", items: { type: "string", $comment: "x" } },
              b: { anyOf: [{ type: "string", $comment: "x" }] },
              c: { allOf: [{ type: "string", $comment: "x" }] },
              d: { type: "object", additionalProperties: { type: "string", $comment: "x" } },
            },
          },
        },
      ],
    });
    expect(declaration(body).parameters).toEqual({
      type: "object",
      properties: {
        a: { type: "array", items: { type: "string" } },
        b: { anyOf: [{ type: "string" }] },
        c: { allOf: [{ type: "string" }] },
        d: { type: "object", additionalProperties: { type: "string" } },
      },
    });
    expect(degradations).toContain("antigravity:tool-schema-pruned");
  });

  test("a const beside an existing enum is dropped rather than overwriting it", () => {
    const { body } = build({
      tools: [
        {
          kind: "portable",
          name: "T",
          description: "d",
          inputSchema: {
            type: "object",
            properties: { mode: { type: "string", enum: ["a", "b"], const: "a" } },
          },
        },
      ],
    });
    expect(declaration(body).parameters).toEqual({
      type: "object",
      properties: { mode: { type: "string", enum: ["a", "b"] } },
    });
  });

  test("a const the proto cannot hold is dropped, not turned into a bad enum", () => {
    // `Schema.enum` is `repeated string`. Translating `const: 5` would swap
    // `Unknown name "const"` for `Invalid value at '…enum[0]'` — same dead
    // request, worse message.
    const { body, degradations } = build({
      tools: [
        {
          kind: "portable",
          name: "T",
          description: "d",
          inputSchema: {
            type: "object",
            properties: {
              n: { type: "number", const: 5 },
              b: { type: "boolean", const: false },
              o: { const: { a: 1 } },
            },
          },
        },
      ],
    });
    expect(declaration(body).parameters).toEqual({
      type: "object",
      properties: { n: { type: "number" }, b: { type: "boolean" }, o: {} },
    });
    expect(degradations).toContain("antigravity:tool-schema-pruned");
  });

  test("a union type becomes the proto's type plus nullable", () => {
    const { body, degradations } = build({
      tools: [
        {
          kind: "portable",
          name: "T",
          description: "d",
          inputSchema: {
            type: "object",
            properties: {
              a: { type: ["string", "null"] },
              b: { type: ["string", "number"] },
            },
          },
        },
      ],
    });
    expect(declaration(body).parameters).toEqual({
      type: "object",
      properties: {
        // Lossless: two JSON Schema words for two proto fields.
        a: { type: "string", nullable: true },
        // Lossy: the proto's `type` is singular, so the second arm goes.
        b: { type: "string" },
      },
    });
    expect(degradations).toContain("antigravity:tool-schema-pruned");
  });

  test("a nullable union type is a lossless translation and degrades nothing", () => {
    // The positive control for the case above: `["string", "null"]` is two
    // JSON Schema words for two proto fields, so nothing is lost and nothing
    // should be recorded. Without this, a walk that recorded a prune on every
    // union would satisfy the lossy assertion and say something untrue.
    const { body, degradations } = build({
      tools: [
        {
          kind: "portable",
          name: "T",
          description: "d",
          inputSchema: { type: "object", properties: { a: { type: ["string", "null"] } } },
        },
      ],
    });
    expect(declaration(body).parameters).toEqual({
      type: "object",
      properties: { a: { type: "string", nullable: true } },
    });
    expect(degradations).not.toContain("antigravity:tool-schema-pruned");
  });

  test("a properties member that is not a schema leaves no key behind", () => {
    const { body, degradations } = build({
      tools: [
        {
          kind: "portable",
          name: "T",
          description: "d",
          inputSchema: {
            type: "object",
            properties: { good: { type: "string" }, bad: null, worse: "nope" },
          },
        },
      ],
    });
    const { properties } = declaration(body).parameters as {
      properties: Record<string, unknown>;
    };
    // The key set, not `toEqual`: an entry whose value is `undefined` compares
    // equal to an absent one, which is exactly the bug this guards.
    expect(Object.keys(properties)).toEqual(["good"]);
    expect(degradations).toContain("antigravity:tool-schema-pruned");
  });

  test("a non-schema in a schema position is dropped rather than forwarded", () => {
    // Tuple-form `items` is the reachable case — an array in a singular message
    // field, which the proto refuses exactly as it refuses an unknown name.
    const { body, degradations } = build({
      tools: [
        {
          kind: "portable",
          name: "T",
          description: "d",
          inputSchema: {
            type: "object",
            properties: {
              a: { anyOf: "not-an-array" },
              b: { properties: "not-an-object" },
            },
          },
        },
      ],
    });
    expect(declaration(body).parameters).toEqual({
      type: "object",
      properties: { a: {}, b: {} },
    });
    expect(degradations).toContain("antigravity:tool-schema-pruned");
  });

  test("a tuple keeps its first arm rather than losing items entirely", () => {
    // `items: [A, B]` is an array in a singular message field. Reducing to `A`
    // is wrong about the tail and right about the shape; dropping it outright
    // would produce the itemless array the case below shows is refused.
    const { body, degradations } = build({
      tools: [
        {
          kind: "portable",
          name: "T",
          description: "d",
          inputSchema: {
            type: "object",
            properties: {
              a: { type: "array", items: [{ type: "string", $comment: "x" }, { type: "number" }] },
            },
          },
        },
      ],
    });
    expect(declaration(body).parameters).toEqual({
      type: "object",
      properties: { a: { type: "array", items: { type: "string" } } },
    });
    expect(degradations).toContain("antigravity:tool-schema-pruned");
  });

  test("an array left with no items loses its type rather than the request", () => {
    // Measured: Cloud Code answers `* GenerateContentRequest…properties[x].items:
    // missing field.` — a required-field error, which the keyword allowlist can
    // never see. Reachable from an unusable `items` and from a client that sent
    // none at all, so both are covered here.
    const { body, degradations } = build({
      tools: [
        {
          kind: "portable",
          name: "T",
          description: "d",
          inputSchema: {
            type: "object",
            properties: {
              bare: { type: "array", description: "no items at all" },
              broken: { type: "array", items: null },
              empty: { type: "array", items: [] },
            },
          },
        },
      ],
    });
    expect(declaration(body).parameters).toEqual({
      type: "object",
      properties: { bare: { description: "no items at all" }, broken: {}, empty: {} },
    });
    expect(degradations).toContain("antigravity:tool-schema-pruned");
  });

  test("a type the proto's enum does not name is dropped", () => {
    // `Schema.type` is an enum, so its *value* is checked too:
    // `Invalid value at '…value.type' (…master.Type), "text"`. Measured live —
    // these eight names are accepted case-insensitively, nothing else was.
    const { body, degradations } = build({
      tools: [
        {
          kind: "portable",
          name: "T",
          description: "d",
          inputSchema: {
            type: "object",
            properties: {
              ok: { type: "integer" },
              cased: { type: "STRING" },
              bad: { type: "text" },
              blank: { type: "" },
              junk: { type: ["string", "bogus"] },
              // The unnameable arm comes *first* here: a walk that filtered the
              // union by `typeof` alone would keep it and 400.
              junkFirst: { type: ["bogus", "string"] },
            },
          },
        },
      ],
    });
    expect(declaration(body).parameters).toEqual({
      type: "object",
      properties: {
        ok: { type: "integer" },
        cased: { type: "STRING" },
        bad: {},
        blank: {},
        junk: { type: "string" },
        junkFirst: { type: "string" },
      },
    });
    expect(degradations).toContain("antigravity:tool-schema-pruned");
  });

  test("a scalar field carrying the wrong type is dropped, member-wise for a list", () => {
    // The second error class: `Invalid value at '…value.pattern' (TYPE_STRING),
    // 5`. `enum` is the reachable one — a numeric literal union exports as
    // `enum: [1, 2]` into a `repeated string`.
    const { body, degradations } = build({
      tools: [
        {
          kind: "portable",
          name: "T",
          description: "d",
          inputSchema: {
            type: "object",
            properties: {
              a: { type: "string", pattern: 5, description: 7, title: { x: 1 } },
              b: { type: "string", enum: ["keep", 5, { x: 1 }] },
              c: { type: "number", enum: [1, 2] },
              // Lenient where a JSON string reads as the number, strict on
              // spelling: `"1e3"` is refused by an int64 field.
              d: { type: "string", minLength: "1", maxLength: "1e3" },
              e: { type: "string", minLength: 1.5 },
              f: { type: "number", minimum: "0", maximum: true },
              // `Value` fields take any JSON at all.
              g: { type: "string", default: { x: [1, null] }, example: [1, "x"] },
            },
          },
        },
      ],
    });
    expect(declaration(body).parameters).toEqual({
      type: "object",
      properties: {
        a: { type: "string" },
        b: { type: "string", enum: ["keep"] },
        c: { type: "number" },
        d: { type: "string", minLength: "1" },
        e: { type: "string" },
        f: { type: "number", minimum: "0" },
        g: { type: "string", default: { x: [1, null] }, example: [1, "x"] },
      },
    });
    expect(degradations).toContain("antigravity:tool-schema-pruned");
  });

  test("required and propertyOrdering may only name properties that survived", () => {
    // A cross-field check the encoder can trip on its own: dropping a member
    // the client listed as required answers
    // `* …required[1]: property is not defined`.
    const { body, degradations } = build({
      tools: [
        {
          kind: "portable",
          name: "T",
          description: "d",
          inputSchema: {
            type: "object",
            properties: { keep: { type: "string" }, gone: null, "": { type: "string" } },
            required: ["keep", "gone", "never-existed", ""],
            propertyOrdering: ["keep", "gone"],
          },
        },
      ],
    });
    expect(declaration(body).parameters).toEqual({
      type: "object",
      // An empty property name is refused outright — `properties[]: key cannot
      // be empty` — so it cannot be kept under any name.
      properties: { keep: { type: "string" } },
      required: ["keep"],
      propertyOrdering: ["keep"],
    });
    expect(degradations).toContain("antigravity:tool-schema-pruned");
  });

  test("a required list left naming nothing is removed rather than sent empty", () => {
    const { body } = build({
      tools: [
        {
          kind: "portable",
          name: "T",
          description: "d",
          inputSchema: { type: "object", properties: { a: null }, required: ["a"] },
        },
      ],
    });
    expect(declaration(body).parameters).toEqual({ type: "object", properties: {} });
  });

  test("a schema whose only loss is an unknown required name still records the prune", () => {
    const { degradations } = build({
      tools: [
        {
          kind: "portable",
          name: "T",
          description: "d",
          inputSchema: {
            type: "object",
            properties: { a: { type: "string" } },
            required: ["a", "ghost"],
          },
        },
      ],
    });
    expect(degradations).toContain("antigravity:tool-schema-pruned");
  });

  test("type agreement reads the type case-insensitively, as the proto does", () => {
    const { body, degradations } = build({
      tools: [
        {
          kind: "portable",
          name: "T",
          description: "d",
          inputSchema: {
            type: "OBJECT",
            properties: { a: { type: "Array", items: { type: "string" } } },
            required: ["a"],
          },
        },
      ],
    });
    // Nothing here needs repairing, so nothing is lost — a case-sensitive
    // comparison would gut both nodes instead.
    expect(declaration(body).parameters).toEqual({
      type: "OBJECT",
      properties: { a: { type: "Array", items: { type: "string" } } },
      required: ["a"],
    });
    expect(degradations).not.toContain("antigravity:tool-schema-pruned");
  });

  test("required alone is enough to infer the object type", () => {
    // `required` is gated on OBJECT just as `properties` is, so a node carrying
    // only the former still needs the type — checking `properties` alone would
    // send a bare `required` the upstream refuses.
    const { body } = build({
      tools: [
        {
          kind: "portable",
          name: "T",
          description: "d",
          inputSchema: { type: "object", properties: { a: { required: ["x"] } } },
        },
      ],
    });
    expect(declaration(body).parameters).toEqual({
      type: "object",
      properties: { a: { type: "object" } },
    });
  });

  test("a structural field with no type infers one rather than losing the structure", () => {
    // `properties` answers `only allowed for OBJECT type` and `items` answers
    // `field predicate failed: $type == Type.ARRAY` — and an *absent* type
    // fails both, which this function produces whenever it drops a type it
    // could not name.
    const { body } = build({
      tools: [
        {
          kind: "portable",
          name: "T",
          description: "d",
          inputSchema: {
            type: "object",
            properties: {
              a: { properties: { b: { type: "string" } }, required: ["b"] },
              c: { items: { type: "string" } },
              // A dropped-because-unnameable type reaches the same place.
              d: { type: "text", items: { type: "string" } },
            },
          },
        },
      ],
    });
    expect(declaration(body).parameters).toEqual({
      type: "object",
      properties: {
        a: { type: "object", properties: { b: { type: "string" } }, required: ["b"] },
        c: { type: "array", items: { type: "string" } },
        d: { type: "array", items: { type: "string" } },
      },
    });
  });

  test("a structural field contradicting a stated type loses the structure, not the type", () => {
    // The other direction: here the client said something explicit, and the
    // encoder is not entitled to overrule it.
    const { body, degradations } = build({
      tools: [
        {
          kind: "portable",
          name: "T",
          description: "d",
          inputSchema: {
            type: "object",
            properties: {
              a: { type: "string", properties: { b: { type: "string" } }, required: ["b"] },
              c: { type: "object", items: { type: "string" } },
            },
          },
        },
      ],
    });
    expect(declaration(body).parameters).toEqual({
      type: "object",
      properties: { a: { type: "string" }, c: { type: "object" } },
    });
    expect(degradations).toContain("antigravity:tool-schema-pruned");
  });

  test("a schema deeper than the upstream's JSON parser allows is cut, not sent", () => {
    // `Message too deep. Max recursion depth reached for key '…'` carries no
    // `function_declarations[N]`, so one such tool kills the whole request and
    // the log cannot say which one did it.
    let deep: Record<string, unknown> = { type: "string", description: "floor" };
    for (let i = 0; i < 40; i++) {
      deep = { type: "object", properties: { x: deep } };
    }
    const { body, degradations } = build({
      tools: [{ kind: "portable", name: "T", description: "d", inputSchema: deep }],
    });
    let node = declaration(body).parameters as Record<string, unknown> | undefined;
    let levels = 0;
    while (node !== undefined) {
      const next = (node.properties as Record<string, Record<string, unknown>> | undefined)?.x;
      if (next === undefined) break;
      node = next;
      levels++;
    }
    // 24 hops below the root, then the cut — the floor never reaches the wire.
    expect(levels).toBe(24);
    expect(node).toEqual({ type: "object", properties: {} });
    expect(JSON.stringify(declaration(body))).not.toContain("floor");
    expect(degradations).toContain("antigravity:tool-schema-pruned");
  });

  test("a schema whose only loss is an itemless array still records the prune", () => {
    // Isolated from the fixture above, where an unusable `items` notes on its
    // own way through and would satisfy the assertion by itself.
    const { degradations } = build({
      tools: [
        {
          kind: "portable",
          name: "T",
          description: "d",
          inputSchema: { type: "object", properties: { a: { type: "array" } } },
        },
      ],
    });
    expect(degradations).toContain("antigravity:tool-schema-pruned");
  });

  test("a schema carrying only a const still records the prune", () => {
    // Split from the unknown-keyword fixture on purpose: with both in one
    // schema, either `note()` call alone satisfies the assertion.
    const { degradations } = build({
      tools: [
        {
          kind: "portable",
          name: "T",
          description: "d",
          inputSchema: { type: "object", properties: { s: { const: "a" } } },
        },
      ],
    });
    expect(degradations).toContain("antigravity:tool-schema-pruned");
  });

  test("a schema carrying only an unknown keyword still records the prune", () => {
    const { degradations } = build({
      tools: [
        {
          kind: "portable",
          name: "T",
          description: "d",
          inputSchema: { type: "object", $schema: "https://example.test/schema" },
        },
      ],
    });
    expect(degradations).toContain("antigravity:tool-schema-pruned");
  });

  test("enum members and defaults are data, never walked as schemas", () => {
    const { body } = build({
      tools: [
        {
          kind: "portable",
          name: "T",
          description: "d",
          inputSchema: {
            type: "object",
            properties: {
              // Object-valued on purpose: with string members, a walk that
              // recursed into `enum` and `default` would be indistinguishable
              // from one that did not.
              mode: {
                type: "string",
                enum: ["const", "$schema"],
                default: { $comment: "keep" },
                example: { $schema: "keep" },
              },
              // A property *named* like a keyword is still a property.
              const: { type: "string" },
            },
          },
        },
      ],
    });
    expect(declaration(body)).toEqual({
      name: "T",
      description: "d",
      parameters: {
        type: "object",
        properties: {
          mode: {
            type: "string",
            enum: ["const", "$schema"],
            default: { $comment: "keep" },
            example: { $schema: "keep" },
          },
          const: { type: "string" },
        },
      },
    });
  });

  test("a tool name the upstream refuses is renamed, not dropped", () => {
    // Measured: `Invalid function name …` kills the **whole** request, every
    // other tool included. Renamed rather than dropped so the client keeps the
    // capability; `decode.ts` restores the name on the way back.
    const { body, degradations } = build({
      tools: [
        { kind: "portable", name: "Read", description: "d", inputSchema: {} },
        { kind: "portable", name: "mcp__srv__tool.v2-beta", description: "d", inputSchema: {} },
        { kind: "portable", name: "has space", description: "d", inputSchema: {} },
        { kind: "portable", name: "1leading", description: "d", inputSchema: {} },
        { kind: "portable", name: "new\nline", description: "d", inputSchema: {} },
      ],
    });
    const decls = body.request.tools?.[0]?.functionDeclarations as { name: string }[];
    expect(decls.map((d) => d.name)).toEqual([
      // Already legal, so untouched — dots and dashes included.
      "Read",
      "mcp__srv__tool.v2-beta",
      "has_space",
      // A digit is legal inside a name and refused at the front.
      "_1leading",
      "new_line",
    ]);
    expect(degradations).toContain("antigravity:tool-name-renamed");
  });

  test("a renamed tool round-trips through the cloak", () => {
    // The half that makes renaming safe: the model answers with the name it was
    // given, so `uncloakName` has to return the client's.
    const request: ChatRequest = {
      ...base,
      tools: [{ kind: "portable", name: "has space", description: "d", inputSchema: {} }],
    };
    const cloak = buildToolCloak(request);
    expect(cloak).not.toBeNull();
    expect(cloakName(cloak, "has space")).toBe("has_space");
    expect(uncloakName(cloak, "has_space")).toBe("has space");
    // A name the cloak never saw passes through both ways unchanged.
    expect(uncloakName(cloak, "Read")).toBe("Read");
  });

  test("a legal tool set builds no cloak at all", () => {
    const { degradations } = build({
      tools: [{ kind: "portable", name: "Read", description: "d", inputSchema: {} }],
    });
    expect(
      buildToolCloak({
        ...base,
        tools: [{ kind: "portable", name: "Read", description: "d", inputSchema: {} }],
      }),
    ).toBeNull();
    expect(degradations).not.toContain("antigravity:tool-name-renamed");
  });

  test("an alias colliding with a real tool name takes a suffix, and the real one does not", () => {
    // Without the claim loop, `read file` would derive `read_file` and land on
    // the genuine `read_file` beside it — two tools under one name upstream, and
    // the real one's replies coming back as the other's.
    const request: ChatRequest = {
      ...base,
      tools: [
        { kind: "portable", name: "read_file", description: "d", inputSchema: {} },
        { kind: "portable", name: "read file", description: "d", inputSchema: {} },
      ],
    };
    const cloak = buildToolCloak(request);
    expect(cloakName(cloak, "read_file")).toBe("read_file");
    const alias = cloakName(cloak, "read file");
    expect(alias).not.toBe("read_file");
    expect(alias.startsWith("read_file")).toBe(true);
    expect(uncloakName(cloak, alias)).toBe("read file");
  });

  test("a name too long to send keeps a distinct alias inside the 128 ceiling", () => {
    const long = `a${"b".repeat(200)}`;
    const cloak = buildToolCloak({
      ...base,
      tools: [{ kind: "portable", name: long, description: "d", inputSchema: {} }],
    });
    const alias = cloakName(cloak, long);
    expect(alias.length).toBe(128);
    // Truncation destroys distinctness, so a truncated alias always carries the
    // suffix that restores it.
    expect(alias).not.toBe(long.slice(0, 128));
    expect(uncloakName(cloak, alias)).toBe(long);
  });

  test("every alias satisfies the grammar the upstream stated", () => {
    const names = [
      "has space",
      "1leading",
      "",
      "ünicode",
      "emoji🙂",
      "new\nline",
      "trailing ",
      "semi;colon",
      "sla/sh",
      " ",
      "!!!",
      "a".repeat(300),
    ];
    const cloak = buildToolCloak({
      ...base,
      tools: names.map((name) => ({
        kind: "portable" as const,
        name,
        description: "d",
        inputSchema: {},
      })),
    });
    const aliases = names.map((n) => cloakName(cloak, n));
    for (const alias of aliases) expect(alias).toMatch(/^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/);
    // Distinct in, distinct out — the sanitiser is lossy, so this is the suffix
    // doing the work rather than the transformation.
    expect(new Set(aliases).size).toBe(names.length);
  });

  test("two declarations landing on one wire name lose the second, not the request", () => {
    // `Duplicate function declaration found: …` is its own 400 and survives the
    // rename: the first wins, so the survivor is the client's own.
    const { body, degradations } = build({
      tools: [
        { kind: "portable", name: "Read", description: "first", inputSchema: {} },
        { kind: "portable", name: "Read", description: "second", inputSchema: {} },
      ],
    });
    const decls = body.request.tools?.[0]?.functionDeclarations as { description: string }[];
    expect(decls.map((d) => d.description)).toEqual(["first"]);
    expect(degradations).toContain("antigravity:duplicate-tool-dropped");
  });

  test("history and tool choice are cloaked with the declarations", () => {
    // A name reaches the wire from four places, and one spelling missed is a
    // call the model cannot correlate.
    const { body } = build({
      tools: [{ kind: "portable", name: "has space", description: "d", inputSchema: {} }],
      toolChoice: { type: "tool", name: "has space" },
      messages: [
        { role: "user", content: [{ type: "text", text: "go" }] },
        {
          role: "assistant",
          content: [{ type: "toolUse", id: "t1", name: "has space", input: {} }],
        },
        { role: "user", content: [{ type: "toolResult", toolUseId: "t1", content: "ok" }] },
      ],
    });
    expect(body.request.contents[1]?.parts[0]).toMatchObject({
      functionCall: { name: "has_space" },
    });
    expect(body.request.contents[2]?.parts[0]).toMatchObject({
      functionResponse: { name: "has_space" },
    });
    expect(body.request.toolConfig).toEqual({
      functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["has_space"] },
    });
  });

  test("a name reaching the wire only from history is still cloaked", () => {
    // The client dropped the tool but kept the turn that called it. Building the
    // cloak from `tools[]` alone would send this one out under its own spelling.
    const { body } = build({
      messages: [
        { role: "user", content: [{ type: "text", text: "go" }] },
        {
          role: "assistant",
          content: [{ type: "toolUse", id: "t1", name: "has space", input: {} }],
        },
        { role: "user", content: [{ type: "toolResult", toolUseId: "t1", content: "ok" }] },
      ],
    });
    expect(body.request.contents[1]?.parts[0]).toMatchObject({
      functionCall: { name: "has_space" },
    });
  });

  test("a tool choice naming an undeclared tool is still cloaked", () => {
    const { body } = build({ toolChoice: { type: "tool", name: "has space" } });
    expect(body.request.toolConfig).toEqual({
      functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["has_space"] },
    });
  });

  test("a name with nothing usable in it gets a readable base, not a bare underscore", () => {
    const cloak = buildToolCloak({
      ...base,
      tools: [{ kind: "portable", name: "!!!", description: "d", inputSchema: {} }],
    });
    const alias = cloakName(cloak, "!!!");
    // `_` alone satisfies the grammar, so nothing upstream would object — but it
    // is what the *model* reads when deciding whether to call the tool.
    expect(alias.startsWith("_tool")).toBe(true);
    expect(uncloakName(cloak, alias)).toBe("!!!");
  });

  test("an unmatched tool result's id is cloaked too, since it becomes the name", () => {
    // This encoder's own fourth source: with no call in history the id is sent
    // in place of a name, and a client's id is as free-form as its names.
    const { body } = build({
      messages: [
        { role: "user", content: [{ type: "text", text: "go" }] },
        { role: "user", content: [{ type: "toolResult", toolUseId: "call id!", content: "x" }] },
      ],
    });
    expect(body.request.contents[0]?.parts[1]).toMatchObject({
      functionResponse: { name: "call_id_" },
    });
  });

  test("generation config is clamped to the ranges the upstream states", () => {
    // Each measured live, in the upstream's own semantic pass:
    // `temperature must be in the range [0.0, 2.0]`,
    // `the number of stop_sequences must not exceed 5`.
    const hot = build({ temperature: 5, stopSequences: ["a", "b", "c", "d", "e", "f"] });
    expect(hot.body.request.generationConfig).toEqual({
      temperature: 2,
      stopSequences: ["a", "b", "c", "d", "e"],
    });
    expect(hot.degradations).toContain("antigravity:temperature-clamped");
    expect(hot.degradations).toContain("antigravity:stop-sequences-dropped");

    const cold = build({ temperature: -1 });
    expect(cold.body.request.generationConfig?.temperature).toBe(0);
  });

  test("an in-range generation config is forwarded untouched", () => {
    const { body, degradations } = build({
      temperature: 0.7,
      stopSequences: ["a", "b", "c", "d", "e"],
      maxTokens: 100,
    });
    expect(body.request.generationConfig).toEqual({
      temperature: 0.7,
      stopSequences: ["a", "b", "c", "d", "e"],
      maxOutputTokens: 100,
    });
    expect(degradations).toEqual([]);
  });

  test("a non-positive max tokens is dropped so the model uses its own default", () => {
    // `maxTokens: 0` answers a bare `Request contains an invalid argument.`
    // Clamping to 1 would be a worse answer than saying nothing.
    const zero = build({ maxTokens: 0 });
    expect(zero.body.request.generationConfig?.maxOutputTokens).toBeUndefined();
    expect(zero.degradations).toContain("antigravity:max-tokens-dropped");
    expect(build({ maxTokens: -5 }).body.request.generationConfig?.maxOutputTokens).toBeUndefined();
  });

  test("a thinking budget is clamped to the range the upstream states", () => {
    // `thinking_budget must be in the range [-1, 65535]`.
    const big = build({ reasoning: { mode: "budget", budgetTokens: 100_000 } });
    expect(big.body.request.generationConfig?.thinkingConfig).toEqual({
      thinkingBudget: 65_535,
      includeThoughts: true,
    });
    expect(big.degradations).toContain("antigravity:thinking-budget-clamped");

    const negative = build({ reasoning: { mode: "budget", budgetTokens: -50 } });
    expect(negative.body.request.generationConfig?.thinkingConfig?.thinkingBudget).toBe(-1);

    // In range, so nothing moves and nothing is recorded.
    const fine = build({ reasoning: { mode: "budget", budgetTokens: 2048 } });
    expect(fine.degradations).not.toContain("antigravity:thinking-budget-clamped");
  });

  test("an off reasoning request disables thinking rather than saying nothing", () => {
    const { body } = build({ reasoning: { mode: "off" } });
    expect(body.request.generationConfig?.thinkingConfig).toEqual({
      thinkingBudget: 0,
      includeThoughts: false,
    });
  });

  test("a budget reasoning request asks for the thoughts as well as the budget", () => {
    const { body } = build({ reasoning: { mode: "budget", budgetTokens: 2048 } });
    // `includeThoughts` is what makes the reasoning come back. A budget alone
    // spends the tokens and returns no thought parts, so the client pays for
    // reasoning it asked to see and is shown none of it.
    expect(body.request.generationConfig?.thinkingConfig).toEqual({
      thinkingBudget: 2048,
      includeThoughts: true,
    });
  });

  test("an adaptive request asks for thoughts without naming a budget", () => {
    const { body } = build({ reasoning: { mode: "adaptive" } });
    expect(body.request.generationConfig?.thinkingConfig).toEqual({ includeThoughts: true });
  });

  test("an adaptive request that asked for silence gets it", () => {
    const { body } = build({ reasoning: { mode: "adaptive", display: "omitted" } });
    expect(body.request.generationConfig?.thinkingConfig).toEqual({ includeThoughts: false });
  });
});

describe("the Cloud Code output ceiling", () => {
  test("a request above the ceiling is clamped and says so", () => {
    // A client naming a figure above what the backend advertises has it lowered
    // rather than refused.
    const { body, degradations } = build({ maxTokens: 131_072 });
    expect(body.request.generationConfig?.maxOutputTokens).toBe(65_536);
    expect(degradations).toContain("antigravity:max-tokens-clamped");
  });

  test("a request inside the limit is left alone", () => {
    const { body, degradations } = build({ maxTokens: 4_096 });
    expect(body.request.generationConfig?.maxOutputTokens).toBe(4_096);
    expect(degradations).toEqual([]);
  });

  test("the catalog advertises what the live catalog reports per row", () => {
    // A client paces itself by `GET /v1/models`. The Flash rows report 65,536
    // and the Pro and Lite rows one below that; nothing may exceed the figure
    // `wire.ts` clamps against.
    for (const model of ANTIGRAVITY_MODELS.models) {
      expect({ id: model.id, ok: model.limits.maxOutputTokens <= 65_536 }).toEqual({
        id: model.id,
        ok: true,
      });
    }
    const byId = new Map(ANTIGRAVITY_MODELS.models.map((m) => [m.id, m.limits.maxOutputTokens]));
    expect(byId.get("gemini-3.8-flash-high")).toBe(65_536);
    expect(byId.get("gemini-pro-agent")).toBe(65_535);
  });

  test("a thinking budget leaves room for an answer above it", () => {
    // Cloud Code refuses a budget at or above the output ceiling rather than
    // reconciling the two.
    const { body } = build({
      maxTokens: 2_048,
      reasoning: { mode: "budget", budgetTokens: 2_048 },
    });
    expect(body.request.generationConfig?.maxOutputTokens).toBe(2_049);
  });

  test("the room made for a budget still respects the ceiling", () => {
    const { body } = build({ reasoning: { mode: "budget", budgetTokens: 65_536 } });
    expect(body.request.generationConfig?.maxOutputTokens).toBe(65_536);
  });
});

describe("the catalog's list prices", () => {
  // Read 2026-09-05 from ai.google.dev/gemini-api/docs/pricing, keyed by the
  // model each row's *displayName* names. The 3.8/3.7/3.6 Flash families are on
  // their **standard** rate, not the introductory one that expires 2026-12-31 —
  // a promotional figure would be right today and wrong on a date nobody
  // watches for — the `-high`/`-low` suffixes are
  // Antigravity's own tiers and the public API prices one model per family.
  const PUBLISHED: Record<string, { input: number; output: number; cacheRead: number }> = {
    "Gemini 3.8 Flash": { input: 1.5, output: 7.5, cacheRead: 0.15 },
    "Gemini 3.7 Flash": { input: 1.5, output: 7.5, cacheRead: 0.15 },
    "Gemini 3.6 Flash": { input: 1.5, output: 7.5, cacheRead: 0.15 },
    "Gemini 3.5 Flash": { input: 1.5, output: 9, cacheRead: 0.15 },
    "Gemini 3.5 Flash Lite": { input: 0.3, output: 2.5, cacheRead: 0.03 },
    "Gemini 3.1 Pro": { input: 2, output: 12, cacheRead: 0.2 },
    "Gemini 3.1 Flash Lite": { input: 0.25, output: 1.5, cacheRead: 0.025 },
    "Gemini 2.5 Pro": { input: 1.25, output: 10, cacheRead: 0.125 },
  };

  /** The family a row's label names, with any `(High)`/`(Low)` tier removed. */
  const familyOf = (label: string) => label.replace(/\s*\((?:High|Medium|Low)\)$/, "");

  test("every row carries its family's published rate", () => {
    // A row priced from the wrong family is silent money: it reaches `cost_usd`
    // and an API key's dollar limit debits it.
    for (const model of ANTIGRAVITY_MODELS.models) {
      const published = PUBLISHED[familyOf(model.label)];
      if (published === undefined) continue;
      expect({ id: model.id, ...published }).toEqual({
        id: model.id,
        input: model.pricing.input,
        output: model.pricing.output,
        cacheRead: model.pricing.cacheRead,
      });
    }
  });

  test("the only unpriced row is the one the price list does not name", () => {
    // The guard against a future row landing at zero by omission rather than by
    // decision. "Gemini 3 Flash" has no published row; everything else does.
    const unpriced = ANTIGRAVITY_MODELS.models.filter((m) => m.pricing.input === 0);
    expect(unpriced.map((m) => m.id)).toEqual(["gemini-3-flash"]);
    expect(PUBLISHED[familyOf("Gemini 3 Flash")]).toBeUndefined();
  });

  test("cache writes are zero because Google bills storage by the hour", () => {
    // A real price, not a missing one: $/1M/hour is a different quantity from
    // the per-token write premium these fields hold, and converting it would
    // need an invented residency time.
    for (const model of ANTIGRAVITY_MODELS.models) {
      expect(model.pricing.cacheWrite5m).toBe(0);
      expect(model.pricing.cacheWrite1h).toBe(0);
    }
  });

  test("output costs more than input wherever a row is priced at all", () => {
    // Catches a transposed pair, which the table above would not: swapping the
    // two numbers on one row keeps both of them "published".
    for (const model of ANTIGRAVITY_MODELS.models) {
      if (model.pricing.input === 0) continue;
      expect(model.pricing.output).toBeGreaterThan(model.pricing.input);
      expect(model.pricing.cacheRead).toBeLessThan(model.pricing.input);
    }
  });
});

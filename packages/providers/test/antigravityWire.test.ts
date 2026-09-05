import { describe, expect, test } from "bun:test";
import type { ChatRequest } from "@omni/ir";
import { ANTIGRAVITY_MODELS } from "../src/antigravity/models.ts";
import { toAntigravityWire } from "../src/antigravity/wire.ts";

const base: ChatRequest = { model: "gemini-3.6-flash-high", messages: [], stream: true };

function build(req: Partial<ChatRequest>) {
  return toAntigravityWire({ ...base, ...req }, "gemini-3.6-flash-high", {
    project: "projects/p-1",
    requestId: "req-1",
  });
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
    ]);
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
        {
          role: "assistant",
          content: [{ type: "toolUse", id: "t1", name: "Read", input: { path: "/a" } }],
        },
        { role: "user", content: [{ type: "toolResult", toolUseId: "t1", content: "ok" }] },
      ],
    });
    expect(body.request.contents[0]?.parts).toEqual([
      {
        // Without a signature Gemini refuses the continuation outright — the
        // first tool call works and its result cannot be sent back — so a
        // replayed call carries the sentinel the backend accepts in place of the
        // one the IR cannot keep.
        thoughtSignature: "skip_thought_signature_validator",
        functionCall: { name: "Read", args: { path: "/a" } },
      },
    ]);
    expect(body.request.contents[1]?.parts).toEqual([
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
        {
          role: "assistant",
          content: [{ type: "toolUse", id: "t1", name: "Read", input: {} }],
        },
        { role: "user", content: [{ type: "toolResult", toolUseId: "t1", content: "ok" }] },
        { role: "user", content: [{ type: "text", text: "and now?" }] },
      ],
    });

    expect(body.request.contents.map((c) => c.role)).toEqual(["model", "user"]);
    // Merged by concatenation, so nothing is lost and the order is the client's.
    expect(body.request.contents[1]?.parts).toEqual([
      { functionResponse: { name: "Read", response: { output: "ok" } } },
      { text: "and now?" },
    ]);
  });

  test("a failed tool result reaches the model, and the loss of its flag is recorded", () => {
    const { body, degradations } = build({
      messages: [
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
    expect(body.request.contents[0]?.parts[0]).toMatchObject({
      functionResponse: { response: { output: "permission denied" } },
    });
    expect(degradations).toContain("antigravity:tool-result-error-flag-dropped");
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
        { role: "user", content: [{ type: "toolResult", toolUseId: "t9", content: "x" }] },
      ],
    });
    const part = body.request.contents[0]?.parts[0];
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
    expect(byId.get("gemini-3.1-pro-high")).toBe(65_535);
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

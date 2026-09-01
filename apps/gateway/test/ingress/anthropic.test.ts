import { expect, test } from "bun:test";
import { GatewayError } from "@omni/ir";
import { parseAnthropicRequest } from "../../src/ingress/anthropic.ts";

const minimal = {
  model: "claude-opus-4",
  max_tokens: 1024,
  messages: [{ role: "user", content: "hi" }],
};

test("parses a minimal request and defaults stream to false", () => {
  const req = parseAnthropicRequest(minimal);
  expect(req.model).toBe("claude-opus-4");
  expect(req.maxTokens).toBe(1024);
  expect(req.stream).toBe(false);
  expect(req.messages).toEqual([{ role: "user", content: [{ type: "text", text: "hi" }] }]);
});

test("normalises a string system prompt to blocks", () => {
  expect(parseAnthropicRequest({ ...minimal, system: "be terse" }).system).toEqual([
    { type: "text", text: "be terse" },
  ]);
});

test("accepts a block-array system prompt", () => {
  expect(
    parseAnthropicRequest({ ...minimal, system: [{ type: "text", text: "a" }] }).system,
  ).toEqual([{ type: "text", text: "a" }]);
});

test("parses image blocks", () => {
  const req = parseAnthropicRequest({
    ...minimal,
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
        ],
      },
    ],
  });
  expect(req.messages[0]?.content[0]).toEqual({
    type: "image",
    mediaType: "image/png",
    data: "AAAA",
  });
});

test("parses tool use and tool result blocks", () => {
  const req = parseAnthropicRequest({
    ...minimal,
    messages: [
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "tu_1", name: "f", input: { a: 1 } }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tu_1", content: "ok" }],
      },
    ],
  });
  expect(req.messages[0]?.content[0]).toEqual({
    type: "toolUse",
    id: "tu_1",
    name: "f",
    input: { a: 1 },
  });
  expect(req.messages[1]?.content[0]).toEqual({
    type: "toolResult",
    toolUseId: "tu_1",
    content: "ok",
    isError: false,
  });
});

test("stringifies structured tool result content", () => {
  const req = parseAnthropicRequest({
    ...minimal,
    messages: [
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "t", name: "f", input: {} }],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t", content: [{ type: "text", text: "one" }] },
        ],
      },
    ],
  });
  expect(req.messages[1]?.content[0]).toMatchObject({ type: "toolResult", content: "one" });
});

test("stringifies non-text tool result parts without throwing", () => {
  const req = parseAnthropicRequest({
    ...minimal,
    messages: [
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "t", name: "f", input: {} }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t", content: [42, null, { foo: "bar" }] }],
      },
    ],
  });
  const result = req.messages[1]?.content[0];
  expect(result).toMatchObject({ type: "toolResult" });
  if (result?.type === "toolResult") {
    expect(result.content).toBe(["42", "null", '{"foo":"bar"}'].join("\n"));
  }
});

test("parses tools and tool choice", () => {
  const req = parseAnthropicRequest({
    ...minimal,
    tools: [{ name: "f", description: "d", input_schema: { type: "object" } }],
    tool_choice: { type: "tool", name: "f" },
  });
  expect(req.tools).toEqual([
    { kind: "portable", name: "f", description: "d", inputSchema: { type: "object" } },
  ]);
  expect(req.toolChoice).toEqual({ type: "tool", name: "f" });
});

test("rejects a non-object tool input_schema", () => {
  expect(() =>
    parseAnthropicRequest({
      ...minimal,
      tools: [{ name: "f", input_schema: "not-an-object" }],
    }),
  ).toThrow(GatewayError);
});

test("maps a thinking block onto the reasoning config", () => {
  const req = parseAnthropicRequest({
    ...minimal,
    thinking: { type: "enabled", budget_tokens: 8000 },
  });
  // A budget the client named is carried verbatim, not reinterpreted as an
  // effort level — providers reject a synthesized one.
  expect(req.reasoning).toEqual({ mode: "budget", budgetTokens: 8000 });
});

test("accepts adaptive thinking, the current wire shape", () => {
  const req = parseAnthropicRequest({ ...minimal, thinking: { type: "adaptive" } });
  expect(req.reasoning).toEqual({ mode: "adaptive" });
});

test("carries the thinking display preference", () => {
  const req = parseAnthropicRequest({
    ...minimal,
    thinking: { type: "adaptive", display: "summarized" },
  });
  expect(req.reasoning).toEqual({ mode: "adaptive", display: "summarized" });
});

test("reads effort out of output_config so it survives cross-provider routing", () => {
  const req = parseAnthropicRequest({
    ...minimal,
    thinking: { type: "adaptive" },
    output_config: { effort: "xhigh" },
  });
  expect(req.reasoning).toEqual({ mode: "adaptive", effort: "xhigh" });
  // The field itself is left intact for Anthropic, alongside anything else in
  // it that this gateway does not model.
  expect(req.vendor?.anthropic?.output_config).toEqual({ effort: "xhigh" });
});

test("effort alone implies adaptive thinking", () => {
  const req = parseAnthropicRequest({ ...minimal, output_config: { effort: "high" } });
  expect(req.reasoning).toEqual({ mode: "adaptive", effort: "high" });
});

test("the full published ladder is recognised, including none and minimal", () => {
  for (const effort of ["none", "minimal"] as const) {
    const req = parseAnthropicRequest({ ...minimal, output_config: { effort } });
    expect(req.reasoning).toEqual({ mode: "adaptive", effort });
    expect(req.vendor?.anthropic?.output_config).toEqual({ effort });
  }
});

test("ignores an effort level it does not recognise", () => {
  const req = parseAnthropicRequest({ ...minimal, output_config: { effort: "turbo" } });
  expect(req.reasoning).toBeUndefined();
});

test("keeps an explicit opt-out rather than dropping it", () => {
  const req = parseAnthropicRequest({ ...minimal, thinking: { type: "disabled" } });
  expect(req.reasoning).toEqual({ mode: "off" });
});

test("passes unknown top-level fields through as vendor extras", () => {
  expect(parseAnthropicRequest({ ...minimal, top_k: 40 }).vendor?.anthropic).toEqual({ top_k: 40 });
});

test("reads the client's session out of metadata.user_id, verbatim", () => {
  // The one identity a conversation carries across its turns, and the whole
  // input to prompt-cache affinity on the OpenAI leg. `metadata` was in KNOWN
  // but not in the schema, so it was parsed by nothing and excluded from the
  // vendor bag — discarded silently, with the cost showing up only as a
  // cache-read column of zeroes.
  //
  // The fixture is the shape actually measured on the wire, not a bare id:
  // across 1,240 captured Claude Code requests, every `user_id` is a string
  // that is itself JSON carrying a nested `session_id`. Taken whole and never
  // parsed — the nested id is why the string is conversation-scoped, but a
  // client's JSON is not a schema this gateway owns.
  const userId = JSON.stringify({
    account_uuid: "",
    device_id: "d-1",
    session_id: "47cbbada-89ca-4800-b7ef-2c1d3e4f5a6b",
  });
  expect(parseAnthropicRequest({ ...minimal, metadata: { user_id: userId } }).conversationId).toBe(
    userId,
  );
});

test("two sessions from one device are two conversations", () => {
  // The property the nested id buys, and the reason the whole string is usable
  // as-is. A key that collapsed these would put every session on the machine
  // into one cache partition.
  const uid = (session: string): string =>
    JSON.stringify({ account_uuid: "", device_id: "d-1", session_id: session });
  const a = parseAnthropicRequest({ ...minimal, metadata: { user_id: uid("s-a") } });
  const b = parseAnthropicRequest({ ...minimal, metadata: { user_id: uid("s-b") } });
  expect(a.conversationId).not.toBe(b.conversationId);
});

test("metadata that names no user leaves the request without a conversation", () => {
  // Absent, null and empty all mean the client did not name one. An empty
  // string would otherwise become an id every conversation shares.
  expect(parseAnthropicRequest(minimal).conversationId).toBeUndefined();
  expect(parseAnthropicRequest({ ...minimal, metadata: {} }).conversationId).toBeUndefined();
  expect(
    parseAnthropicRequest({ ...minimal, metadata: { user_id: null } }).conversationId,
  ).toBeUndefined();
  expect(
    parseAnthropicRequest({ ...minimal, metadata: { user_id: "" } }).conversationId,
  ).toBeUndefined();
});

test("a null metadata is accepted, not a 400", () => {
  // Before the field was modelled, zod stripped it unread, so `metadata: null`
  // — what a typed client SDK serializes for an unset optional — parsed fine.
  // Modelling it is what could turn a previously-working request into a refusal
  // over a field it does not even use.
  expect(parseAnthropicRequest({ ...minimal, metadata: null }).conversationId).toBeUndefined();
});

test("falls back to a session header when the body names no conversation", () => {
  // opencode and dsh both send a per-session id in a header and nothing in the
  // body, so a gateway reading bodies alone sees them as anonymous.
  const headers = new Headers({ "X-Session-Id": "ses_0123456789ab" });
  expect(parseAnthropicRequest(minimal, headers).conversationId).toBe("ses_0123456789ab");

  const dsh = new Headers({ "x-deepseek-harness-session-id": "dsh-1" });
  expect(parseAnthropicRequest(minimal, dsh).conversationId).toBe("dsh-1");
});

test("the body wins over a header when both name a conversation", () => {
  const headers = new Headers({ "x-session-affinity": "from-header" });
  const req = parseAnthropicRequest({ ...minimal, metadata: { user_id: "from-body" } }, headers);
  expect(req.conversationId).toBe("from-body");
});

test("an unusable session header is ignored rather than becoming a shared id", () => {
  // Whitespace and over-long values are the two ways a header arrives useless.
  // Taking either would hand every request that sends one the same key.
  expect(
    parseAnthropicRequest(minimal, new Headers({ "x-session-id": "   " })).conversationId,
  ).toBeUndefined();
  const long = new Headers({ "x-session-id": "s".repeat(513) });
  expect(parseAnthropicRequest(minimal, long).conversationId).toBeUndefined();
});

test("an unknown metadata subfield rides through rather than failing the request", () => {
  // This surface filters rather than rejects, and a client sending a field the
  // spec has since grown must not get a 400 from the gateway.
  const req = parseAnthropicRequest({
    ...minimal,
    metadata: { user_id: "u1", session_id: "s1", future: 1 },
  });
  expect(req.conversationId).toBe("u1");
});

test("applies IR validation to the parsed request", () => {
  // An orphaned tool result is dropped by validateRequest, leaving an empty
  // message that is then removed.
  const req = parseAnthropicRequest({
    ...minimal,
    messages: [
      { role: "user", content: "hi" },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "nope", content: "x" }] },
    ],
  });
  expect(req.messages).toHaveLength(1);
});

test("rejects a request with no messages", () => {
  expect(() => parseAnthropicRequest({ ...minimal, messages: [] })).toThrow(GatewayError);
});

test("rejects a missing model with a field path in the message", () => {
  try {
    parseAnthropicRequest({ max_tokens: 1, messages: [{ role: "user", content: "hi" }] });
    throw new Error("expected throw");
  } catch (e) {
    expect((e as GatewayError).code).toBe("BAD_REQUEST");
    expect((e as GatewayError).message).toContain("model");
  }
});

test("carries a mid-conversation system message through in place", () => {
  const req = parseAnthropicRequest({
    ...minimal,
    system: "You are a helpful assistant.",
    messages: [
      { role: "user", content: "hi" },
      { role: "system", content: "Terse mode enabled — keep responses under 40 words." },
    ],
  });

  // The request-level prompt and the mid-conversation turn are different
  // things: folding the turn into the prompt would move it to the front of the
  // conversation and change when it applies.
  expect(req.system).toEqual([{ type: "text", text: "You are a helpful assistant." }]);
  expect(req.messages).toEqual([
    { role: "user", content: [{ type: "text", text: "hi" }] },
    {
      role: "system",
      content: [{ type: "text", text: "Terse mode enabled — keep responses under 40 words." }],
    },
  ]);
});

test("accepts block content on a system turn", () => {
  const req = parseAnthropicRequest({
    ...minimal,
    messages: [
      { role: "user", content: "hi" },
      { role: "system", content: [{ type: "text", text: "Use Go." }] },
    ],
  });

  expect(req.messages.at(-1)).toEqual({
    role: "system",
    content: [{ type: "text", text: "Use Go." }],
  });
});

test("keeps a system turn in position rather than reordering the conversation", () => {
  const req = parseAnthropicRequest({
    ...minimal,
    messages: [
      { role: "user", content: "first" },
      { role: "system", content: "mid-flight instruction" },
      { role: "assistant", content: "ok" },
      { role: "user", content: "second" },
    ],
  });

  expect(req.messages.map((m) => m.role)).toEqual(["user", "system", "assistant", "user"]);
});

test("still rejects a role no surface defines", () => {
  expect(() =>
    parseAnthropicRequest({
      ...minimal,
      messages: [{ role: "developer", content: "hi" }],
    }),
  ).toThrow(GatewayError);
});

test("keeps a cache breakpoint on a system block, with its ttl", () => {
  const req = parseAnthropicRequest({
    ...minimal,
    system: [{ type: "text", text: "a", cache_control: { type: "ephemeral", ttl: "1h" } }],
  });
  expect(req.system).toEqual([
    { type: "text", text: "a", cacheControl: { type: "ephemeral", ttl: "1h" } },
  ]);
});

test("defaults a cache breakpoint with no ttl to the bare marker", () => {
  const req = parseAnthropicRequest({
    ...minimal,
    system: [{ type: "text", text: "a", cache_control: { type: "ephemeral" } }],
  });
  expect(req.system).toEqual([{ type: "text", text: "a", cacheControl: { type: "ephemeral" } }]);
});

test("keeps cache breakpoints on message blocks, text and otherwise", () => {
  const req = parseAnthropicRequest({
    ...minimal,
    messages: [
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "t", name: "f", input: {} }],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "t",
            content: "ok",
            cache_control: { type: "ephemeral" },
          },
          { type: "text", text: "next", cache_control: { type: "ephemeral", ttl: "5m" } },
        ],
      },
    ],
  });
  expect(req.messages[1]?.content[0]).toEqual({
    type: "toolResult",
    toolUseId: "t",
    content: "ok",
    isError: false,
    cacheControl: { type: "ephemeral" },
  });
  expect(req.messages[1]?.content[1]).toEqual({
    type: "text",
    text: "next",
    cacheControl: { type: "ephemeral", ttl: "5m" },
  });
});

test("keeps a cache breakpoint on a tool definition", () => {
  const req = parseAnthropicRequest({
    ...minimal,
    tools: [
      {
        name: "f",
        input_schema: { type: "object" },
        cache_control: { type: "ephemeral", ttl: "1h" },
      },
    ],
  });
  expect(req.tools).toEqual([
    {
      kind: "portable",
      name: "f",
      inputSchema: { type: "object" },
      cacheControl: { type: "ephemeral", ttl: "1h" },
    },
  ]);
});

test("rejects a cache control shape the provider does not accept", () => {
  expect(() =>
    parseAnthropicRequest({
      ...minimal,
      system: [{ type: "text", text: "a", cache_control: { type: "persistent" } }],
    }),
  ).toThrow(GatewayError);
  expect(() =>
    parseAnthropicRequest({
      ...minimal,
      system: [{ type: "text", text: "a", cache_control: { type: "ephemeral", ttl: "2h" } }],
    }),
  ).toThrow(GatewayError);
});

test("leaves an unmarked block without cache metadata", () => {
  const req = parseAnthropicRequest({ ...minimal, system: [{ type: "text", text: "a" }] });
  expect(req.system?.[0]).toEqual({ type: "text", text: "a" });
});

test("carries the betas the client opted into", () => {
  const req = parseAnthropicRequest(
    minimal,
    new Headers({ "anthropic-beta": "context-management-2025-06-27" }),
  );
  expect(req.betas).toEqual(["context-management-2025-06-27"]);
});

test("splits, trims and dedupes a multi-value beta header", () => {
  const req = parseAnthropicRequest(
    minimal,
    new Headers({ "anthropic-beta": "a-2025-01-01, b-2025-01-01 ,, a-2025-01-01" }),
  );
  expect(req.betas).toEqual(["a-2025-01-01", "b-2025-01-01"]);
});

test("leaves betas unset when the client named none", () => {
  expect(parseAnthropicRequest(minimal).betas).toBeUndefined();
  expect(
    parseAnthropicRequest(minimal, new Headers({ "anthropic-beta": " , " })).betas,
  ).toBeUndefined();
});

test("keeps a beta's body field in vendor passthrough beside its name", () => {
  const req = parseAnthropicRequest(
    { ...minimal, context_management: { edits: [{ type: "clear_tool_uses_20250919" }] } },
    new Headers({ "anthropic-beta": "context-management-2025-06-27" }),
  );
  expect(req.vendor?.anthropic?.context_management).toEqual({
    edits: [{ type: "clear_tool_uses_20250919" }],
  });
  expect(req.betas).toEqual(["context-management-2025-06-27"]);
});

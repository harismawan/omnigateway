import { expect, test } from "bun:test";
import type { ToolChoice } from "@omni/ir";
import { GatewayError } from "@omni/ir";
import { customToolNames, parseResponsesRequest } from "../../src/ingress/responses.ts";

const minimal = { model: "gpt-5-codex", input: "hi" };

test("parses a minimal responses request", () => {
  const req = parseResponsesRequest(minimal);
  expect(req.model).toBe("gpt-5-codex");
  expect(req.stream).toBe(false);
  expect(req.messages).toEqual([{ role: "user", content: [{ type: "text", text: "hi" }] }]);
});

test("lifts instructions to the system prompt", () => {
  const req = parseResponsesRequest({ ...minimal, instructions: "be terse" });
  expect(req.system).toEqual([{ type: "text", text: "be terse" }]);
});

test("maps the scalar knobs onto their IR names", () => {
  const req = parseResponsesRequest({
    ...minimal,
    max_output_tokens: 512,
    temperature: 0.25,
    stream: true,
  });
  expect(req.maxTokens).toBe(512);
  expect(req.temperature).toBe(0.25);
  expect(req.stream).toBe(true);
});

test("normalises the 1m suffix off the model before anything reads it", () => {
  // The allowlist is enforced against `ChatRequest.model`, so any spelling of a
  // pool has to reach key policy as the pool's own id.
  const req = parseResponsesRequest({ ...minimal, model: "claude-sonnet-4-5[1m]" });
  expect(req.model).toBe("claude-sonnet-4-5");
  expect(req.betas).toEqual(["context-1m-2025-08-07"]);
});

test("maps reasoning effort and the omitted summary", () => {
  expect(parseResponsesRequest({ ...minimal, reasoning: { effort: "high" } }).reasoning).toEqual({
    mode: "adaptive",
    effort: "high",
  });
  expect(
    parseResponsesRequest({ ...minimal, reasoning: { effort: "low", summary: "none" } }).reasoning,
  ).toEqual({ mode: "adaptive", effort: "low", display: "omitted" });
  // A summary the gateway has no IR spelling for says nothing about depth.
  expect(parseResponsesRequest({ ...minimal, reasoning: { summary: "auto" } }).reasoning).toEqual({
    mode: "adaptive",
  });
});

test("rejects an effort level outside the published ladder", () => {
  expect(() => parseResponsesRequest({ ...minimal, reasoning: { effort: "turbo" } })).toThrow(
    GatewayError,
  );
});

// Input items. `input` is either one string or the item array, and the array is
// where every shape this surface has to understand lives.

test("reads an item array of messages onto their own roles", () => {
  const req = parseResponsesRequest({
    ...minimal,
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "hello" }] },
    ],
  });
  expect(req.messages).toEqual([
    { role: "user", content: [{ type: "text", text: "hi" }] },
    { role: "assistant", content: [{ type: "text", text: "hello" }] },
  ]);
});

test("reads a message item whose content is a bare string", () => {
  const req = parseResponsesRequest({
    ...minimal,
    input: [{ type: "message", role: "user", content: "hi" }],
  });
  expect(req.messages).toEqual([{ role: "user", content: [{ type: "text", text: "hi" }] }]);
});

test("treats an item with no type but a role as a message", () => {
  // Measured, not defensive: Droid CLI sends role-bearing items with no `type`,
  // and both peer gateways carry the same fallback.
  const req = parseResponsesRequest({
    ...minimal,
    input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }],
  });
  expect(req.messages).toEqual([{ role: "user", content: [{ type: "text", text: "hi" }] }]);
});

test("keeps a mid-conversation system turn in place rather than hoisting it", () => {
  // `instructions` is this surface's request-level prompt, so a system or
  // developer item inside `input` is unambiguously the mid-conversation
  // feature. Folding it into `system` would move the instruction to the front
  // of the history and change when it takes effect.
  const req = parseResponsesRequest({
    ...minimal,
    instructions: "be terse",
    input: [
      { type: "message", role: "user", content: "hi" },
      { type: "message", role: "developer", content: "and precise" },
    ],
  });
  expect(req.system).toEqual([{ type: "text", text: "be terse" }]);
  expect(req.messages).toEqual([
    { role: "user", content: [{ type: "text", text: "hi" }] },
    { role: "system", content: [{ type: "text", text: "and precise" }] },
  ]);
});

test("reads an input_image data url as an image block", () => {
  const req = parseResponsesRequest({
    ...minimal,
    input: [
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "look" },
          { type: "input_image", image_url: "data:image/png;base64,AAAA" },
        ],
      },
    ],
  });
  expect(req.messages[0]?.content).toEqual([
    { type: "text", text: "look" },
    { type: "image", mediaType: "image/png", data: "AAAA" },
  ]);
});

test("drops a remote image url rather than fetching it or refusing the turn", () => {
  const req = parseResponsesRequest({
    ...minimal,
    input: [
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "look" },
          { type: "input_image", image_url: "https://example.com/a.png" },
        ],
      },
    ],
  });
  expect(req.messages[0]?.content).toEqual([{ type: "text", text: "look" }]);
});

test("parses a function call and the output that answers it", () => {
  const req = parseResponsesRequest({
    ...minimal,
    input: [
      { type: "message", role: "user", content: "run it" },
      { type: "function_call", call_id: "call_1", name: "shell", arguments: '{"cmd":"ls"}' },
      { type: "function_call_output", call_id: "call_1", output: "ok" },
    ],
  });
  expect(req.messages[1]).toEqual({
    role: "assistant",
    content: [{ type: "toolUse", id: "call_1", name: "shell", input: { cmd: "ls" } }],
  });
  expect(req.messages[2]).toEqual({
    role: "user",
    content: [{ type: "toolResult", toolUseId: "call_1", content: "ok", isError: false }],
  });
});

test("refuses arguments that are not JSON rather than dispatching an empty call", () => {
  // It names a real client bug, and the alternative is a tool call dispatched
  // with no arguments at all.
  expect(() =>
    parseResponsesRequest({
      ...minimal,
      input: [{ type: "function_call", call_id: "call_1", name: "shell", arguments: "{oops" }],
    }),
  ).toThrow(/arguments/);
});

test("carries a freeform custom tool call as its own program, not as JSON", () => {
  const req = parseResponsesRequest({
    ...minimal,
    input: [
      { type: "custom_tool_call", call_id: "c1", name: "apply_patch", input: "*** Begin Patch" },
      { type: "custom_tool_call_output", call_id: "c1", output: "done" },
    ],
  });
  expect(req.messages[0]?.content[0]).toEqual({
    type: "toolUse",
    id: "c1",
    name: "apply_patch",
    input: { input: "*** Begin Patch" },
  });
  expect(req.messages[1]?.content[0]).toEqual({
    type: "toolResult",
    toolUseId: "c1",
    content: "done",
    isError: false,
  });
});

test("carries a reasoning item verbatim as an openai-owned native block", () => {
  // Never decrypted, never inspected, never regenerated. `type` is lifted onto
  // the block's own discriminator and everything else is left alone — the `id`
  // included, because stripping it is the encoder's job on replay.
  const req = parseResponsesRequest({
    ...minimal,
    input: [
      {
        type: "reasoning",
        id: "rs_1",
        summary: [{ type: "summary_text", text: "considering" }],
        encrypted_content: "gAAAAA",
      },
    ],
  });
  expect(req.messages[0]).toEqual({
    role: "assistant",
    content: [
      {
        type: "providerNative",
        provider: "openai",
        blockType: "reasoning",
        data: {
          id: "rs_1",
          summary: [{ type: "summary_text", text: "considering" }],
          encrypted_content: "gAAAAA",
        },
      },
    ],
  });
});

test("gives a local shell call and its output the same native treatment", () => {
  // Model-produced, replayed verbatim, never reinterpreted.
  const req = parseResponsesRequest({
    ...minimal,
    input: [
      {
        type: "local_shell_call",
        id: "ls_1",
        call_id: "c9",
        action: { type: "exec", command: ["ls"] },
        status: "completed",
      },
      { type: "local_shell_call_output", id: "lso_1", call_id: "c9", output: "a.txt" },
    ],
  });
  expect(req.messages[0]).toEqual({
    role: "assistant",
    content: [
      {
        type: "providerNative",
        provider: "openai",
        blockType: "local_shell_call",
        data: {
          id: "ls_1",
          call_id: "c9",
          action: { type: "exec", command: ["ls"] },
          status: "completed",
        },
      },
    ],
  });
  expect(req.messages[1]).toEqual({
    role: "user",
    content: [
      {
        type: "providerNative",
        provider: "openai",
        blockType: "local_shell_call_output",
        data: { id: "lso_1", call_id: "c9", output: "a.txt" },
      },
    ],
  });
});

test("refuses an item_reference, which names state this gateway does not hold", () => {
  expect(() =>
    parseResponsesRequest({ ...minimal, input: [{ type: "item_reference", id: "msg_1" }] }),
  ).toThrow(/item_reference/);
});

test("refuses an item type it does not recognise rather than dropping it", () => {
  // A silently discarded item changes the conversation the model sees and the
  // client has no way to tell. Being loud here is also what makes the capture
  // step that freezes this schema worth running.
  expect(() =>
    parseResponsesRequest({ ...minimal, input: [{ type: "web_search_call", id: "ws_1" }] }),
  ).toThrow(/web_search_call/);
});

test("refuses a content part type it does not recognise", () => {
  expect(() =>
    parseResponsesRequest({
      ...minimal,
      input: [{ type: "message", role: "user", content: [{ type: "input_audio", data: "AA" }] }],
    }),
  ).toThrow(/input_audio/);
});

test("refuses an input that produced no message at all", () => {
  expect(() => parseResponsesRequest({ ...minimal, input: [] })).toThrow(GatewayError);
});

// Ids and names. Each of these constraints is one both peer gateways hit
// independently against the real backend.

test("clamps a long call_id so a call and its output still match", () => {
  // Deterministic, not truncated: two different long ids must not collide, and
  // the same id must clamp the same way in both items or the backend rejects an
  // orphaned result.
  const long = `call_${"x".repeat(100)}`;
  const req = parseResponsesRequest({
    ...minimal,
    input: [
      { type: "function_call", call_id: long, name: "shell", arguments: "{}" },
      { type: "function_call_output", call_id: long, output: "ok" },
    ],
  });
  const call = req.messages[0]?.content[0];
  const result = req.messages[1]?.content[0];
  expect(call?.type).toBe("toolUse");
  expect(result?.type).toBe("toolResult");
  const id = call?.type === "toolUse" ? call.id : "";
  expect(id).toHaveLength(64);
  expect(result?.type === "toolResult" ? result.toolUseId : "").toBe(id);
});

test("gives two different long call_ids two different clamped ids", () => {
  const clamp = (raw: string): string => {
    const req = parseResponsesRequest({
      ...minimal,
      input: [{ type: "function_call", call_id: raw, name: "f", arguments: "{}" }],
    });
    const block = req.messages[0]?.content[0];
    return block?.type === "toolUse" ? block.id : "";
  };
  // Identical for the first 64 characters, so a plain truncation would collide
  // and silently answer one call with the other's result.
  const a = clamp(`call_${"x".repeat(100)}a`);
  const b = clamp(`call_${"x".repeat(100)}b`);
  expect(a).not.toBe(b);
});

test("drops a function call with no name or no call_id", () => {
  // An empty name produces placeholder-tool loops, and an empty call_id can
  // never be matched to its output. The orphaned output goes with it.
  const req = parseResponsesRequest({
    ...minimal,
    input: [
      { type: "message", role: "user", content: "hi" },
      { type: "function_call", call_id: "c1", name: "", arguments: "{}" },
      { type: "function_call_output", call_id: "c1", output: "ok" },
      { type: "function_call", call_id: "", name: "shell", arguments: "{}" },
      { type: "function_call_output", call_id: "", output: "ok" },
    ],
  });
  expect(req.messages).toEqual([{ role: "user", content: [{ type: "text", text: "hi" }] }]);
});

// Refusals. Two, and both name the field, because answering a request for
// prior state with no prior state is a wrong answer that reads as a model
// failure rather than as a gateway that cannot do it.

test("refuses previous_response_id rather than stripping it silently", () => {
  expect(() => parseResponsesRequest({ ...minimal, previous_response_id: "resp_1" })).toThrow(
    /previous_response_id/,
  );
});

test("refuses store only when the client explicitly asked for it", () => {
  // The real API defaults `store` to true, so refusing on absence would reject
  // every stock SDK call; refusing on an explicit `true` catches the client
  // that actually asked for server-side state. Codex sends `false`.
  expect(() => parseResponsesRequest({ ...minimal, store: true })).toThrow(/store/);
  expect(parseResponsesRequest({ ...minimal, store: false }).model).toBe("gpt-5-codex");
  expect(parseResponsesRequest(minimal).model).toBe("gpt-5-codex");
});

test("drops background rather than refusing it", () => {
  // Codex agents set it opportunistically and do not depend on it, so the turn
  // is still answerable without it. It is consumed, so it never reaches the
  // vendor bag either.
  const req = parseResponsesRequest({ ...minimal, background: true });
  expect(req.vendor).toBeUndefined();
});

// The vendor bag. Everything this parser consumes is absent from it; everything
// it does not consume rides through to an OpenAI target's own dialect verbatim.

test("passes the responses-only fields through as vendor extras", () => {
  const req = parseResponsesRequest({
    ...minimal,
    text: { verbosity: "low" },
    service_tier: "priority",
    include: ["reasoning.encrypted_content"],
    client_metadata: { cli: "codex" },
    top_p: 0.5,
  });
  expect(req.vendor?.openai).toEqual({
    text: { verbosity: "low" },
    service_tier: "priority",
    include: ["reasoning.encrypted_content"],
    client_metadata: { cli: "codex" },
    top_p: 0.5,
  });
});

test("keeps the fields it consumed out of the vendor bag", () => {
  // `wire.ts` merges this bag verbatim into the upstream body, so a field this
  // parser already expressed in IR would be sent twice and could disagree with
  // itself.
  const req = parseResponsesRequest({
    ...minimal,
    instructions: "be terse",
    max_output_tokens: 8,
    temperature: 0,
    stream: false,
    store: false,
    background: false,
    reasoning: { effort: "low" },
    tools: [],
    tool_choice: "auto",
    metadata: { a: "b" },
    user: "u-42",
  });
  expect(req.vendor).toBeUndefined();
});

test("prefers the client's own cache key over the session header", () => {
  const headers = new Headers({ "x-session-affinity": "ses_header" });
  expect(
    parseResponsesRequest({ ...minimal, prompt_cache_key: "conv-7" }, headers).conversationId,
  ).toBe("conv-7");
  expect(parseResponsesRequest(minimal, headers).conversationId).toBe("ses_header");
  expect(parseResponsesRequest(minimal).conversationId).toBeUndefined();
});

test("the cache key still reaches the upstream body it belongs to", () => {
  // `openai/wire.ts` resolves the session id from `prompt_cache_key` in the
  // vendor bag first, so reading it here must not consume it.
  expect(parseResponsesRequest({ ...minimal, prompt_cache_key: "conv-7" }).vendor?.openai).toEqual({
    prompt_cache_key: "conv-7",
  });
});

test("the end-user id is not read as a conversation", () => {
  // `user` names the human, so keying cache affinity on it would merge every
  // conversation on an install into one partition.
  expect(parseResponsesRequest({ ...minimal, user: "u-42" }).conversationId).toBeUndefined();
});

test("maps every tool_choice spelling this surface defines", () => {
  const choice = (value: unknown): ToolChoice | undefined =>
    parseResponsesRequest({ ...minimal, tool_choice: value }).toolChoice;
  expect(choice("auto")).toEqual({ type: "auto" });
  expect(choice("none")).toEqual({ type: "none" });
  // OpenAI says `required` where the IR says `any`.
  expect(choice("required")).toEqual({ type: "any" });
  expect(choice({ type: "function", name: "f" })).toEqual({ type: "tool", name: "f" });
  expect(choice({ type: "custom", name: "apply_patch" })).toEqual({
    type: "tool",
    name: "apply_patch",
  });
});

test("a function tool becomes a portable tool", () => {
  const req = parseResponsesRequest({
    ...minimal,
    tools: [
      {
        type: "function",
        name: "shell",
        description: "run a command",
        parameters: { type: "object", properties: { cmd: { type: "string" } } },
      },
    ],
  });
  expect(req.tools).toEqual([
    {
      kind: "portable",
      name: "shell",
      description: "run a command",
      inputSchema: { type: "object", properties: { cmd: { type: "string" } } },
    },
  ]);
});

test("a freeform custom tool becomes portable with a one-string schema", () => {
  // It has no JSON schema on the wire, and the model answers it with a program
  // rather than arguments — so the portable shape it lands in has to be the one
  // `custom_tool_call` already parses into: a single `input` string.
  const req = parseResponsesRequest({
    ...minimal,
    tools: [{ type: "custom", name: "apply_patch", description: "edit files" }],
  });
  expect(req.tools).toEqual([
    {
      kind: "portable",
      name: "apply_patch",
      description: "edit files",
      inputSchema: {
        type: "object",
        properties: { input: { type: "string" } },
        required: ["input"],
      },
    },
  ]);
});

test("a hosted tool is carried as an openai-owned provider tool, declaration intact", () => {
  const req = parseResponsesRequest({
    ...minimal,
    tools: [{ type: "tool_search", max_results: 5 }],
  });
  expect(req.tools).toEqual([
    {
      kind: "provider",
      provider: "openai",
      type: "tool_search",
      name: "tool_search",
      wire: { max_results: 5 },
    },
  ]);
});

test("a hosted tool with no name of its own is named by its type", () => {
  // `requiredProviders` reads `provider`, but the encoder and every log line
  // read `name`, and an empty one reads as a tool that is not there.
  const req = parseResponsesRequest({
    ...minimal,
    tools: [{ type: "web_search_preview" }, { type: "mcp", server_label: "docs" }],
  });
  expect(req.tools?.map((t) => t.name)).toEqual(["web_search_preview", "mcp"]);
});

test("a tool name outside the accepted grammar is refused", () => {
  // 128 characters of [A-Za-z0-9_-], which is what the Responses API enforces.
  // The refusal states the rule and does not quote the value: the value is the
  // client's own text and this message reaches stdout.
  expect(() =>
    parseResponsesRequest({ ...minimal, tools: [{ type: "function", name: "bad name!" }] }),
  ).toThrow(/a tool name must match/);
  expect(() =>
    parseResponsesRequest({
      ...minimal,
      tools: [{ type: "function", name: "n".repeat(129) }],
    }),
  ).toThrow(GatewayError);
});

test("names the freeform tools so the egress can render their calls back", () => {
  // The two declarations differ only in `type`, and the difference decides
  // whether a call renders as `custom_tool_call` or `function_call`. A client
  // that dispatches only one of the two never runs the other.
  const body = {
    ...minimal,
    tools: [
      { type: "custom", name: "apply_patch" },
      { type: "function", name: "shell", parameters: { type: "object" } },
    ],
  };
  expect([...customToolNames(body)]).toEqual(["apply_patch"]);
  expect([...customToolNames(minimal)]).toEqual([]);
});

test("a refusal never echoes client-chosen text back into the log line", () => {
  // `reasonField` prints a message whose error names no provider, and every
  // refusal here is one — so an interpolated tool name would reach the
  // operator's stdout, chosen by whoever holds the key, and would do it even
  // for a key that opted out of body retention. That is exactly the breach
  // `LogFields` is a closed allowlist to prevent, and it is why
  // `LogFields.cloakedTools` is a count rather than a list.
  const marker = "CLIENT_CHOSEN_MARKER";

  const messages: string[] = [];
  const collect = (fn: () => void): void => {
    try {
      fn();
    } catch (error) {
      messages.push(error instanceof GatewayError ? error.message : String(error));
    }
  };

  collect(() =>
    parseResponsesRequest({
      ...minimal,
      input: [{ type: "function_call", call_id: "c1", name: marker, arguments: "not json" }],
    }),
  );
  collect(() =>
    parseResponsesRequest({ ...minimal, tools: [{ type: "function", name: `${marker} !` }] }),
  );
  collect(() =>
    parseResponsesRequest({ ...minimal, tools: [{ type: marker, name: `${marker}!` }] }),
  );

  expect(messages).toHaveLength(3);
  for (const message of messages) expect(message).not.toContain(marker);
});

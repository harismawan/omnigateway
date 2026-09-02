import { type ChatRequest, CONTEXT_1M_BETA, type ToolChoice } from "@omni/ir";
import { systemText } from "../system.ts";

/**
 * Custom's own wire codecs, one per protocol.
 *
 * Forked, not shared, on purpose: every other provider directory owns its
 * codecs outright so an adapter can be lifted into a standalone plugin without
 * dragging another provider along. These start as trimmed forks of the Kimi
 * (chat completions) and OpenAI (responses) encoders with every surface
 * constraint of those providers removed — no device headers, no OAuth, no
 * Codex parameter drops — plus one policy of their own: the client's thinking
 * level crosses verbatim, because a custom server answers for its own model
 * vocabulary and would reject nobody knows which values.
 */

export type CustomChatBody = {
  model: string;
  messages: unknown[];
  stream: boolean;
  stream_options?: { include_usage: boolean };
  max_tokens?: number;
  temperature?: number;
  stop?: string[];
  tools?: unknown[];
  tool_choice?: unknown;
  reasoning_effort?: string;
  [key: string]: unknown;
};

export type CustomResponsesBody = {
  model: string;
  input: unknown[];
  instructions?: string;
  stream: boolean;
  max_output_tokens?: number;
  temperature?: number;
  tools?: unknown[];
  tool_choice?: unknown;
  reasoning?: { effort: string; summary: string };
  store?: boolean;
  [key: string]: unknown;
};

function encodeChatToolChoice(c: ToolChoice): unknown {
  switch (c.type) {
    case "auto":
      return "auto";
    case "any":
      return "required";
    case "none":
      return "none";
    case "tool":
      return { type: "function", function: { name: c.name } };
  }
}

function encodeResponsesToolChoice(c: ToolChoice): unknown {
  switch (c.type) {
    case "auto":
      return "auto";
    case "any":
      return "required";
    case "none":
      return "none";
    case "tool":
      return { type: "function", name: c.name };
  }
}

/**
 * Resolves the client's thinking config into the coarse effort string both
 * surfaces carry.
 *
 * Verbatim, including levels the big-two surfaces clamp away. Nothing is
 * fabricated either way: an absent config and an explicit `off` produce no
 * field at all — omission must not silently turn thinking on or tune it — and
 * a token budget has no expression here, so it is the caller's degradation to
 * record rather than a level to invent. `undefined` means "not forwarded".
 */
function customEffort(reasoning: ChatRequest["reasoning"]): string | undefined {
  if (reasoning === undefined || reasoning.mode !== "adaptive") return undefined;
  return reasoning.effort ?? "medium";
}

/** Encodes a Chat Completions request for a custom OpenAI-compatible server. */
export function toCustomChatWire(
  req: ChatRequest,
  model: string,
): { body: CustomChatBody; degradations: string[] } {
  const degradations: string[] = [];
  const note = (d: string): void => {
    if (!degradations.includes(d)) degradations.push(d);
  };

  // There is no beta mechanism on this surface, so a client asking for the 1M
  // window is not refused, it is simply not honoured. Recorded because the
  // silence is the dangerous part: the client keeps pacing itself against a
  // megabyte while this target caps far lower.
  if (req.betas?.includes(CONTEXT_1M_BETA)) note("custom:context-1m-dropped");

  const messages: unknown[] = [];

  const system = systemText(req.system, "custom", note);
  if (system !== undefined && system.length > 0) messages.push({ role: "system", content: system });

  for (const message of req.messages) {
    const text: string[] = [];
    const toolCalls: unknown[] = [];

    for (const block of message.content) {
      switch (block.type) {
        case "text":
          text.push(block.text);
          break;
        case "image":
          note("custom:images-dropped");
          break;
        case "thinking":
          note("custom:thinking-dropped");
          break;
        case "toolUse":
          toolCalls.push({
            id: block.id,
            type: "function",
            function: { name: block.name, arguments: JSON.stringify(block.input) },
          });
          break;
        case "toolResult":
          // A tool result is its own message in this API, not a content block.
          messages.push({
            role: "tool",
            tool_call_id: block.toolUseId,
            content: block.content,
          });
          break;
        case "providerNative":
          // Unreachable: the router excludes this provider from any request
          // carrying another provider's native history. Recorded, not ignored.
          note("custom:anthropic-native-block-dropped");
          break;
      }
    }

    if (toolCalls.length > 0) {
      messages.push({
        role: message.role,
        content: text.length > 0 ? text.join("\n") : null,
        tool_calls: toolCalls,
      });
    } else if (text.length > 0) {
      messages.push({ role: message.role, content: text.join("\n") });
    }
  }

  // The adapter always streams upstream, and an OpenAI-compatible chat stream
  // reports no usage at all without this — which reaches the request log as a
  // request that cost nothing and cached nothing.
  const body: CustomChatBody = {
    model,
    messages,
    stream: req.stream,
    stream_options: { include_usage: true },
  };
  if (req.maxTokens !== undefined) body.max_tokens = req.maxTokens;
  if (req.temperature !== undefined) body.temperature = req.temperature;
  if (req.stopSequences !== undefined) body.stop = req.stopSequences;
  if (req.tools !== undefined) {
    const portable = req.tools.filter((t) => t.kind === "portable");
    if (portable.length !== req.tools.length) note("custom:anthropic-tool-dropped");
    body.tools = portable.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.inputSchema },
    }));
  }
  if (req.toolChoice !== undefined) body.tool_choice = encodeChatToolChoice(req.toolChoice);

  const effort = customEffort(req.reasoning);
  if (effort !== undefined) body.reasoning_effort = effort;
  else if (req.reasoning?.mode === "budget") note("custom:reasoning-budget-dropped");

  // Last, so an operator's passthrough can override anything above.
  Object.assign(body, req.vendor?.openai ?? {});

  return { body, degradations };
}

/** Encodes a Responses request for a custom server exposing that route. */
export function toCustomResponsesWire(
  req: ChatRequest,
  model: string,
): { body: CustomResponsesBody; degradations: string[] } {
  const degradations: string[] = [];
  const note = (d: string): void => {
    if (!degradations.includes(d)) degradations.push(d);
  };
  const input: unknown[] = [];

  if (req.betas?.includes(CONTEXT_1M_BETA)) note("custom:context-1m-dropped");

  for (const message of req.messages) {
    const parts: unknown[] = [];

    // This API takes conversation-level instructions separately, so a
    // mid-conversation operator turn goes as `developer` — the role the dialect
    // defines for exactly that — keeping both its position and its standing.
    //
    // Measured on two independent servers before it shipped: the Codex backend
    // and OpenRouter's `/api/v1/responses`, each answering 200 to a request
    // differing only in this role. That is weaker evidence here than it is for
    // the other two encoders and deliberately so — `custom` points at whatever
    // server an operator configured, and only that operator can test it. The
    // role is what the API defines, so a compliant endpoint accepts it, and one
    // that does not fails loudly on every request carrying such a turn rather
    // than quietly.
    //
    // Recorded as a degradation still, because the role is not the one the
    // client wrote. Rows written before the rename carry
    // `custom:system-turn-inlined` and stay readable: degradations are forensic
    // text, never parsed on read.
    const asDeveloper = message.role === "system";
    if (asDeveloper) note("custom:system-turn-as-developer");
    const role = asDeveloper ? "developer" : message.role;

    const flush = (): void => {
      if (parts.length === 0) return;
      input.push({ type: "message", role, content: [...parts] });
      parts.length = 0;
    };

    for (const block of message.content) {
      switch (block.type) {
        case "text":
          parts.push({
            type: role === "assistant" ? "output_text" : "input_text",
            text: block.text,
          });
          break;
        case "image":
          parts.push({
            type: "input_image",
            image_url: `data:${block.mediaType};base64,${block.data}`,
          });
          break;
        case "thinking":
          // Anthropic thinking blocks carry a provider-specific signature that
          // is meaningless here. Dropping them is lossless for the model.
          note("custom:thinking-dropped");
          break;
        case "toolUse":
          flush();
          input.push({
            type: "function_call",
            call_id: block.id,
            name: block.name,
            arguments: JSON.stringify(block.input),
          });
          break;
        case "toolResult":
          flush();
          input.push({
            type: "function_call_output",
            call_id: block.toolUseId,
            output: block.content,
          });
          break;
        case "providerNative":
          // Unreachable in practice: the router excludes this provider from any
          // request carrying another provider's native history. Recorded rather
          // than ignored so that if it ever does arrive, the request log says
          // what was lost instead of the client seeing a turn quietly rewritten.
          note("custom:anthropic-native-block-dropped");
          break;
      }
    }

    flush();
  }

  const body: CustomResponsesBody = { model, input, stream: req.stream, store: false };

  const instructions = systemText(req.system, "custom", note);
  if (instructions !== undefined && instructions.length > 0) body.instructions = instructions;

  if (req.maxTokens !== undefined) body.max_output_tokens = req.maxTokens;
  if (req.temperature !== undefined) body.temperature = req.temperature;
  if (req.tools !== undefined) {
    const portable = req.tools.filter((t) => t.kind === "portable");
    if (portable.length !== req.tools.length) note("custom:anthropic-tool-dropped");
    body.tools = portable.map((t) => ({
      type: "function",
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    }));
  }
  if (req.toolChoice !== undefined) body.tool_choice = encodeResponsesToolChoice(req.toolChoice);

  const effort = customEffort(req.reasoning);
  if (effort !== undefined) body.reasoning = { effort, summary: "auto" };
  else if (req.reasoning?.mode === "budget") note("custom:reasoning-budget-dropped");

  // Last, so an operator's passthrough can override anything above.
  Object.assign(body, req.vendor?.openai ?? {});

  return { body, degradations };
}

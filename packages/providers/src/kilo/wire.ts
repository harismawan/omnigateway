import {
  type ChatRequest,
  CONTEXT_1M_BETA,
  type ContentBlock,
  type Message,
  type ToolChoice,
} from "@omni/ir";

/**
 * Kilo's request body: OpenAI chat completions, plus OpenRouter's `reasoning`.
 *
 * Forked from the Kimi encoder rather than shared with it. The two surfaces are
 * near-identical today and will not stay that way — Kilo proxies a catalog of
 * several hundred third-party models and carries OpenRouter's own extensions,
 * so a shared encoder would collect a branch per vendor quirk. `custom/` is the
 * standing counterexample.
 */
export type KiloChatBody = {
  model: string;
  messages: unknown[];
  stream: boolean;
  stream_options?: { include_usage: boolean };
  max_tokens?: number;
  temperature?: number;
  stop?: string[];
  tools?: unknown[];
  tool_choice?: unknown;
  reasoning?: { effort?: string; max_tokens?: number };
  [key: string]: unknown;
};

/** One entry of a multipart chat message content array. */
type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

function encodeToolChoice(c: ToolChoice): unknown {
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

/**
 * Whether the caller placed a cache breakpoint anywhere in the request.
 *
 * The chat completions wire has no field for one at all, so the marker cannot
 * be forwarded and the loss is recorded instead of being silent.
 */
function hasCacheBreakpoint(req: ChatRequest): boolean {
  // Tested with `in` rather than a plain read because not every block variant
  // declares the field — a thinking block cannot carry a breakpoint at all —
  // and the union has no common `cacheControl` to narrow through otherwise.
  const marked = (block: ContentBlock): boolean =>
    "cacheControl" in block && block.cacheControl !== undefined;
  if (req.system?.some(marked) === true) return true;
  return req.messages.some((message: Message) => message.content.some(marked));
}

/**
 * Collapses content parts to what this wire wants.
 *
 * A message of nothing but text is a plain string, which is what every client
 * of this API sends and what the upstream echoes back. Only a message carrying
 * an image needs the array form.
 */
function collapse(parts: readonly ContentPart[]): string | ContentPart[] | null {
  if (parts.length === 0) return null;
  if (parts.every((part) => part.type === "text")) {
    return parts.map((part) => (part.type === "text" ? part.text : "")).join("\n");
  }
  return [...parts];
}

export function toKiloWire(
  req: ChatRequest,
  model: string,
): { body: KiloChatBody; degradations: string[] } {
  const degradations: string[] = [];
  const note = (d: string): void => {
    if (!degradations.includes(d)) degradations.push(d);
  };

  // Same reasoning as the OpenAI encoder: no beta mechanism, so a 1M request is
  // silently not honoured unless the loss is recorded here.
  if (req.betas?.includes(CONTEXT_1M_BETA)) note("kilo:context-1m-dropped");
  if (hasCacheBreakpoint(req)) note("kilo:cache-control-dropped");

  const messages: unknown[] = [];

  const system = req.system?.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n\n");
  if (system !== undefined && system.length > 0) messages.push({ role: "system", content: system });

  for (const message of req.messages) {
    let parts: ContentPart[] = [];
    const toolCalls: unknown[] = [];

    // A tool result is its own message in this API, so anything accumulated
    // before it has to be emitted first or the turn arrives out of order.
    const flush = (): void => {
      if (toolCalls.length > 0) {
        messages.push({ role: message.role, content: collapse(parts), tool_calls: [...toolCalls] });
      } else if (parts.length > 0) {
        messages.push({ role: message.role, content: collapse(parts) });
      }
      parts = [];
      toolCalls.length = 0;
    };

    for (const block of message.content) {
      switch (block.type) {
        case "text":
          parts.push({ type: "text", text: block.text });
          break;
        case "image":
          // Kilo claims images, and this wire can express them: a data URL is
          // the form every OpenAI-compatible surface takes.
          parts.push({
            type: "image_url",
            image_url: { url: `data:${block.mediaType};base64,${block.data}` },
          });
          break;
        case "thinking":
          // Nothing on this wire replays a thinking block back to the model.
          note("kilo:thinking-dropped");
          break;
        case "toolUse":
          toolCalls.push({
            id: block.id,
            type: "function",
            function: { name: block.name, arguments: JSON.stringify(block.input) },
          });
          break;
        case "toolResult":
          flush();
          messages.push({
            role: "tool",
            tool_call_id: block.toolUseId,
            content: block.content,
          });
          break;
        case "anthropicNative":
          // Unreachable: the router excludes this provider from any request
          // carrying Anthropic-native history. Recorded, not ignored.
          note("kilo:anthropic-native-block-dropped");
          break;
      }
    }

    flush();
  }

  // The adapter always streams upstream, and an OpenAI-compatible chat stream
  // reports no usage at all without this — which reaches the request log as a
  // request that cost nothing and cached nothing.
  const body: KiloChatBody = {
    model,
    messages,
    stream: req.stream,
    stream_options: { include_usage: true },
  };
  if (req.maxTokens !== undefined) body.max_tokens = req.maxTokens;
  if (req.temperature !== undefined) body.temperature = req.temperature;
  if (req.stopSequences !== undefined) body.stop = req.stopSequences;
  if (req.tools !== undefined) {
    const custom = req.tools.filter((t) => t.provider === "custom");
    if (custom.length !== req.tools.length) note("kilo:anthropic-tool-dropped");
    body.tools = custom.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.inputSchema },
    }));
  }
  if (req.toolChoice !== undefined) body.tool_choice = encodeToolChoice(req.toolChoice);
  if (req.reasoning !== undefined && req.reasoning.mode !== "off") {
    if (req.reasoning.mode === "budget") {
      body.reasoning = { max_tokens: req.reasoning.budgetTokens };
    } else {
      // OpenRouter's field tops out at `high`; the deeper Anthropic levels
      // clamp onto it rather than being forwarded as a value it rejects.
      const effort = req.reasoning.effort ?? "medium";
      if (effort === "xhigh" || effort === "max") note("kilo:reasoning-effort-clamped");
      body.reasoning = { effort: effort === "xhigh" || effort === "max" ? "high" : effort };
    }
  }

  // Last, so an operator's passthrough can override anything above.
  Object.assign(body, req.vendor?.kilo ?? {});

  return { body, degradations };
}

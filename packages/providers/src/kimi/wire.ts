import { type ChatRequest, CONTEXT_1M_BETA, type ToolChoice } from "@omni/ir";

export type ChatBody = {
  model: string;
  messages: unknown[];
  stream: boolean;
  stream_options?: { include_usage: boolean };
  max_tokens?: number;
  temperature?: number;
  stop?: string[];
  tools?: unknown[];
  tool_choice?: unknown;
  [key: string]: unknown;
};

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

export function toChatWire(
  req: ChatRequest,
  model: string,
  vendor: "kimi" | "openai" = "kimi",
): { body: ChatBody; degradations: string[] } {
  const degradations: string[] = [];
  const note = (d: string): void => {
    if (!degradations.includes(d)) degradations.push(d);
  };

  // Same reasoning as the OpenAI encoder: no beta mechanism, so a 1M request is
  // silently not honoured unless the loss is recorded here.
  if (req.betas?.includes(CONTEXT_1M_BETA)) note("kimi:context-1m-dropped");

  const messages: unknown[] = [];

  const system = req.system?.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n\n");
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
          note("kimi:images-dropped");
          break;
        case "thinking":
          note("kimi:thinking-dropped");
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
          note("kimi:anthropic-native-block-dropped");
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
  const body: ChatBody = {
    model,
    messages,
    stream: req.stream,
    stream_options: { include_usage: true },
  };
  if (req.maxTokens !== undefined) body.max_tokens = req.maxTokens;
  if (req.temperature !== undefined) body.temperature = req.temperature;
  if (req.stopSequences !== undefined) body.stop = req.stopSequences;
  if (req.tools !== undefined) {
    const custom = req.tools.filter((t) => t.kind === "portable");
    if (custom.length !== req.tools.length) note("kimi:anthropic-tool-dropped");
    body.tools = custom.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.inputSchema },
    }));
  }
  if (req.toolChoice !== undefined) body.tool_choice = encodeToolChoice(req.toolChoice);
  if (req.reasoning !== undefined) note("kimi:reasoning-dropped");

  Object.assign(body, req.vendor?.[vendor] ?? {});

  return { body, degradations };
}

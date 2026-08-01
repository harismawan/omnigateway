import type { ChatRequest, ContentBlock, ToolChoice } from "@omni/ir";

export const OAUTH_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";

export type AnthropicBody = {
  model: string;
  messages: unknown[];
  system?: { type: "text"; text: string }[];
  max_tokens: number;
  stream: boolean;
  temperature?: number;
  stop_sequences?: string[];
  tools?: { name: string; description?: string; input_schema: unknown }[];
  tool_choice?: unknown;
  thinking?: { type: "enabled"; budget_tokens: number };
  [key: string]: unknown;
};

const EFFORT_BUDGET = { low: 2048, medium: 8192, high: 24576 } as const;

function encodeBlock(b: ContentBlock): unknown {
  switch (b.type) {
    case "text":
      return { type: "text", text: b.text };
    case "image":
      return {
        type: "image",
        source: { type: "base64", media_type: b.mediaType, data: b.data },
      };
    case "thinking":
      return { type: "thinking", thinking: b.text, signature: b.signature };
    case "toolUse":
      return { type: "tool_use", id: b.id, name: b.name, input: b.input };
    case "toolResult":
      return {
        type: "tool_result",
        tool_use_id: b.toolUseId,
        content: b.content,
        is_error: b.isError,
      };
  }
}

function encodeToolChoice(c: ToolChoice): unknown {
  switch (c.type) {
    case "auto":
      return { type: "auto" };
    case "any":
      return { type: "any" };
    case "none":
      return { type: "none" };
    case "tool":
      return { type: "tool", name: c.name };
  }
}

export function toWire(
  req: ChatRequest,
  model: string,
  opts: { oauth: boolean },
): { body: AnthropicBody; degradations: string[] } {
  const degradations: string[] = [];

  let system = req.system?.flatMap((b) =>
    b.type === "text" ? [{ type: "text" as const, text: b.text }] : [],
  );

  // The OAuth token endpoint rejects requests whose first system block is not
  // this string. It is a functional requirement of the credential, not a
  // disguise: the User-Agent still identifies this gateway. Recorded as a
  // degradation so it is visible in the request log.
  if (opts.oauth && system?.[0]?.text !== OAUTH_IDENTITY) {
    system = [{ type: "text" as const, text: OAUTH_IDENTITY }, ...(system ?? [])];
    degradations.push("anthropic:oauth-system-prefix");
  }

  const body: AnthropicBody = {
    model,
    messages: req.messages.map((m) => ({ role: m.role, content: m.content.map(encodeBlock) })),
    max_tokens: req.maxTokens ?? 4096,
    stream: req.stream,
  };

  if (system !== undefined && system.length > 0) body.system = system;
  if (req.temperature !== undefined) body.temperature = req.temperature;
  if (req.stopSequences !== undefined) body.stop_sequences = req.stopSequences;
  if (req.tools !== undefined) {
    body.tools = req.tools.map((t) => ({
      name: t.name,
      ...(t.description === undefined ? {} : { description: t.description }),
      input_schema: t.inputSchema,
    }));
  }
  if (req.toolChoice !== undefined) body.tool_choice = encodeToolChoice(req.toolChoice);
  if (req.reasoning !== undefined) {
    const budget = req.reasoning.budgetTokens ?? EFFORT_BUDGET[req.reasoning.effort];
    body.thinking = { type: "enabled", budget_tokens: budget };
  }

  // Vendor passthrough is applied last: an operator setting a raw Anthropic
  // field is stating an explicit intent that outranks our mapping.
  Object.assign(body, req.vendor?.anthropic ?? {});

  return { body, degradations };
}

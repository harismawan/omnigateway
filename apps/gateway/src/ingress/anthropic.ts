import type { ChatRequest, ContentBlock, Message, ToolChoice } from "@omni/ir";
import { GatewayError, validateRequest } from "@omni/ir";
import { z } from "zod";
import { extraFields, parseOrThrow } from "./schemas.ts";

const textBlock = z.object({ type: z.literal("text"), text: z.string() });

const imageBlock = z.object({
  type: z.literal("image"),
  source: z.object({
    type: z.literal("base64"),
    media_type: z.string(),
    data: z.string(),
  }),
});

const thinkingBlock = z.object({
  type: z.literal("thinking"),
  thinking: z.string(),
  signature: z.string().optional(),
});

const toolUseBlock = z.object({
  type: z.literal("tool_use"),
  id: z.string(),
  name: z.string(),
  input: z.record(z.string(), z.unknown()).default({}),
});

const toolResultBlock = z.object({
  type: z.literal("tool_result"),
  tool_use_id: z.string(),
  content: z.union([z.string(), z.array(z.unknown())]).optional(),
  is_error: z.boolean().optional(),
});

const block = z.discriminatedUnion("type", [
  textBlock,
  imageBlock,
  thinkingBlock,
  toolUseBlock,
  toolResultBlock,
]);

const message = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.union([z.string(), z.array(block)]),
});

const schema = z.object({
  model: z.string().min(1),
  messages: z.array(message).min(1),
  system: z.union([z.string(), z.array(textBlock)]).optional(),
  max_tokens: z.number().int().positive().optional(),
  temperature: z.number().optional(),
  stop_sequences: z.array(z.string()).optional(),
  stream: z.boolean().optional(),
  tools: z
    .array(
      z.object({
        name: z.string(),
        description: z.string().optional(),
        input_schema: z.record(z.string(), z.unknown()),
      }),
    )
    .optional(),
  tool_choice: z
    .union([
      z.object({ type: z.enum(["auto", "any", "none"]) }),
      z.object({ type: z.literal("tool"), name: z.string() }),
    ])
    .optional(),
  thinking: z
    .union([
      z.object({ type: z.literal("enabled"), budget_tokens: z.number().int().positive() }),
      z.object({ type: z.literal("disabled") }),
    ])
    .optional(),
});

const KNOWN = [
  "model",
  "messages",
  "system",
  "max_tokens",
  "temperature",
  "stop_sequences",
  "stream",
  "tools",
  "tool_choice",
  "thinking",
  "metadata",
] as const;

/** Tool result content may be blocks; flatten to the text the model will see. */
function flattenToolResult(content: string | unknown[] | undefined): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      const p =
        part !== null && typeof part === "object"
          ? (part as { type?: string; text?: string })
          : undefined;
      return p?.type === "text" && typeof p.text === "string" ? p.text : JSON.stringify(part);
    })
    .join("\n");
}

function toIrBlock(b: z.infer<typeof block>): ContentBlock {
  switch (b.type) {
    case "text":
      return { type: "text", text: b.text };
    case "image":
      return { type: "image", mediaType: b.source.media_type, data: b.source.data };
    case "thinking":
      return {
        type: "thinking",
        text: b.thinking,
        ...(b.signature !== undefined && { signature: b.signature }),
      };
    case "tool_use":
      return { type: "toolUse", id: b.id, name: b.name, input: b.input };
    case "tool_result":
      return {
        type: "toolResult",
        toolUseId: b.tool_use_id,
        content: flattenToolResult(b.content),
        isError: b.is_error ?? false,
      };
  }
}

function toIrToolChoice(c: NonNullable<z.infer<typeof schema>["tool_choice"]>): ToolChoice {
  return c.type === "tool" ? { type: "tool", name: c.name } : { type: c.type };
}

export function parseAnthropicRequest(body: unknown): ChatRequest {
  if (typeof body !== "object" || body === null) {
    throw new GatewayError("BAD_REQUEST", "request body must be a JSON object");
  }

  const parsed = parseOrThrow(schema, body);

  const messages: Message[] = parsed.messages.map((m) => ({
    role: m.role,
    content:
      typeof m.content === "string"
        ? [{ type: "text", text: m.content }]
        : m.content.map(toIrBlock),
  }));

  const system =
    parsed.system === undefined
      ? undefined
      : typeof parsed.system === "string"
        ? [{ type: "text" as const, text: parsed.system }]
        : parsed.system.map((b) => ({ type: "text" as const, text: b.text }));

  const request: ChatRequest = {
    model: parsed.model,
    messages,
    stream: parsed.stream ?? false,
  };

  if (system !== undefined) request.system = system;
  if (parsed.max_tokens !== undefined) request.maxTokens = parsed.max_tokens;
  if (parsed.temperature !== undefined) request.temperature = parsed.temperature;
  if (parsed.stop_sequences !== undefined) request.stopSequences = parsed.stop_sequences;
  if (parsed.tools !== undefined) {
    request.tools = parsed.tools.map((t) => ({
      name: t.name,
      ...(t.description !== undefined && { description: t.description }),
      inputSchema: t.input_schema,
    }));
  }
  if (parsed.tool_choice !== undefined) request.toolChoice = toIrToolChoice(parsed.tool_choice);
  if (parsed.thinking?.type === "enabled") {
    // The wire format carries a budget, not an effort level; medium is the
    // neutral mapping for providers that only understand effort.
    request.reasoning = { effort: "medium", budgetTokens: parsed.thinking.budget_tokens };
  }

  const extras = extraFields(body as Record<string, unknown>, KNOWN);
  if (extras !== undefined) request.vendor = { anthropic: extras };

  return validateRequest(request);
}

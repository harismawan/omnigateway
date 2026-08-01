import type { ChatRequest, ContentBlock, Message, ToolChoice } from "@omni/ir";
import { GatewayError, validateRequest } from "@omni/ir";
import { z } from "zod";
import { extraFields, parseDataUrl, parseOrThrow } from "./schemas.ts";

const part = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({ type: z.literal("image_url"), image_url: z.object({ url: z.string() }) }),
]);

const toolCall = z.object({
  id: z.string(),
  type: z.literal("function"),
  function: z.object({ name: z.string(), arguments: z.string() }),
});

const message = z.object({
  role: z.enum(["system", "developer", "user", "assistant", "tool"]),
  content: z.union([z.string(), z.array(part), z.null()]).optional(),
  tool_calls: z.array(toolCall).optional(),
  tool_call_id: z.string().optional(),
});

const schema = z.object({
  model: z.string().min(1),
  messages: z.array(message).min(1),
  max_tokens: z.number().int().positive().optional(),
  max_completion_tokens: z.number().int().positive().optional(),
  temperature: z.number().optional(),
  stop: z.union([z.string(), z.array(z.string())]).optional(),
  stream: z.boolean().optional(),
  tools: z
    .array(
      z.object({
        type: z.literal("function"),
        function: z.object({
          name: z.string(),
          description: z.string().optional(),
          parameters: z.record(z.string(), z.unknown()).optional(),
        }),
      }),
    )
    .optional(),
  tool_choice: z
    .union([
      z.enum(["auto", "none", "required"]),
      z.object({ type: z.literal("function"), function: z.object({ name: z.string() }) }),
    ])
    .optional(),
  reasoning_effort: z.enum(["low", "medium", "high"]).optional(),
});

const KNOWN = [
  "model",
  "messages",
  "max_tokens",
  "max_completion_tokens",
  "temperature",
  "stop",
  "stream",
  "tools",
  "tool_choice",
  "reasoning_effort",
  "stream_options",
  "user",
  "n",
] as const;

/** Tool arguments arrive as a JSON string; a malformed one becomes `{}`. */
function parseArguments(raw: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(raw);
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function contentBlocks(content: z.infer<typeof message>["content"]): ContentBlock[] {
  if (typeof content === "string")
    return content.length > 0 ? [{ type: "text", text: content }] : [];
  if (!Array.isArray(content)) return [];
  return content.map((p): ContentBlock => {
    if (p.type === "text") return { type: "text", text: p.text };
    const { mediaType, data } = parseDataUrl(p.image_url.url);
    return { type: "image", mediaType, data };
  });
}

function toIrToolChoice(c: NonNullable<z.infer<typeof schema>["tool_choice"]>): ToolChoice {
  if (typeof c === "string") {
    if (c === "required") return { type: "any" };
    return { type: c };
  }
  return { type: "tool", name: c.function.name };
}

export function parseOpenAIRequest(body: unknown): ChatRequest {
  if (typeof body !== "object" || body === null) {
    throw new GatewayError("BAD_REQUEST", "request body must be a JSON object");
  }

  const parsed = parseOrThrow(schema, body);

  const system: ContentBlock[] = [];
  const messages: Message[] = [];

  for (const m of parsed.messages) {
    if (m.role === "system" || m.role === "developer") {
      // Both map to the IR system prompt; developer is the newer spelling.
      system.push(...contentBlocks(m.content));
      continue;
    }

    if (m.role === "tool") {
      if (m.tool_call_id === undefined) {
        throw new GatewayError("BAD_REQUEST", "messages: tool message requires tool_call_id");
      }
      // The IR follows Anthropic: a tool result is user-turn content.
      messages.push({
        role: "user",
        content: [
          {
            type: "toolResult",
            toolUseId: m.tool_call_id,
            content: typeof m.content === "string" ? m.content : "",
            isError: false,
          },
        ],
      });
      continue;
    }

    const content = contentBlocks(m.content);
    for (const call of m.tool_calls ?? []) {
      content.push({
        type: "toolUse",
        id: call.id,
        name: call.function.name,
        input: parseArguments(call.function.arguments),
      });
    }
    if (content.length > 0) messages.push({ role: m.role, content });
  }

  if (messages.length === 0) {
    throw new GatewayError("BAD_REQUEST", "messages: at least one non-system message is required");
  }

  const request: ChatRequest = {
    model: parsed.model,
    messages,
    stream: parsed.stream ?? false,
  };

  if (system.length > 0) request.system = system;
  const maxTokens = parsed.max_completion_tokens ?? parsed.max_tokens;
  if (maxTokens !== undefined) request.maxTokens = maxTokens;
  if (parsed.temperature !== undefined) request.temperature = parsed.temperature;
  if (parsed.stop !== undefined) {
    request.stopSequences = typeof parsed.stop === "string" ? [parsed.stop] : parsed.stop;
  }
  if (parsed.tools !== undefined) {
    request.tools = parsed.tools.map((t) => ({
      name: t.function.name,
      ...(t.function.description !== undefined && { description: t.function.description }),
      inputSchema: t.function.parameters ?? { type: "object" },
    }));
  }
  if (parsed.tool_choice !== undefined) request.toolChoice = toIrToolChoice(parsed.tool_choice);
  if (parsed.reasoning_effort !== undefined)
    request.reasoning = { effort: parsed.reasoning_effort };

  const extras = extraFields(body as Record<string, unknown>, KNOWN);
  if (extras !== undefined) request.vendor = { openai: extras };

  return validateRequest(request);
}

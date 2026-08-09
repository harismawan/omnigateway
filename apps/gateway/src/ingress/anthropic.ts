import type {
  ChatRequest,
  ContentBlock,
  Message,
  ReasoningConfig,
  ReasoningEffort,
  ToolChoice,
} from "@omni/ir";
import { GatewayError, validateRequest } from "@omni/ir";
import { z } from "zod";
import {
  cacheControlSchema as cacheControl,
  extraFields,
  irCacheControl,
  isRecord,
  parseOrThrow,
} from "./schemas.ts";

const textBlock = z.object({
  type: z.literal("text"),
  text: z.string(),
  cache_control: cacheControl.optional(),
});

const imageBlock = z.object({
  type: z.literal("image"),
  source: z.object({
    type: z.literal("base64"),
    media_type: z.string(),
    data: z.string(),
  }),
  cache_control: cacheControl.optional(),
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
  cache_control: cacheControl.optional(),
});

const toolResultBlock = z.object({
  type: z.literal("tool_result"),
  tool_use_id: z.string(),
  content: z.union([z.string(), z.array(z.unknown())]).optional(),
  is_error: z.boolean().optional(),
  cache_control: cacheControl.optional(),
});

const block = z.discriminatedUnion("type", [
  textBlock,
  imageBlock,
  thinkingBlock,
  toolUseBlock,
  toolResultBlock,
]);

/**
 * `system` here is Anthropic's mid-conversation system message, not the
 * top-level `system` prompt — this surface has a separate field for that, so a
 * system turn inside `messages` is unambiguously the mid-conversation feature
 * and is carried through in place rather than hoisted.
 */
const message = z.object({
  role: z.enum(["user", "assistant", "system"]),
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
        cache_control: cacheControl.optional(),
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
      // The current form: the model decides how much to think, and `effort`
      // (in output_config) tunes the depth.
      z.object({
        type: z.literal("adaptive"),
        display: z.enum(["summarized", "omitted"]).optional(),
      }),
      // The older fixed-budget form. Still accepted from a client that asks
      // for it, though current models reject it upstream.
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
      return { type: "text", text: b.text, ...irCacheControl(b.cache_control) };
    case "image":
      return {
        type: "image",
        mediaType: b.source.media_type,
        data: b.source.data,
        ...irCacheControl(b.cache_control),
      };
    case "thinking":
      return {
        type: "thinking",
        text: b.thinking,
        ...(b.signature !== undefined && { signature: b.signature }),
      };
    case "tool_use":
      return {
        type: "toolUse",
        id: b.id,
        name: b.name,
        input: b.input,
        ...irCacheControl(b.cache_control),
      };
    case "tool_result":
      return {
        type: "toolResult",
        toolUseId: b.tool_use_id,
        content: flattenToolResult(b.content),
        isError: b.is_error ?? false,
        ...irCacheControl(b.cache_control),
      };
  }
}

function toIrToolChoice(c: NonNullable<z.infer<typeof schema>["tool_choice"]>): ToolChoice {
  return c.type === "tool" ? { type: "tool", name: c.name } : { type: c.type };
}

const EFFORTS: readonly ReasoningEffort[] = ["low", "medium", "high", "xhigh", "max"];

/** Reads `output_config.effort` without consuming the field. */
function readEffort(body: unknown): ReasoningEffort | undefined {
  if (!isRecord(body)) return undefined;
  const outputConfig = body.output_config;
  if (!isRecord(outputConfig)) return undefined;
  const effort = outputConfig.effort;
  return EFFORTS.find((level) => level === effort);
}

function toIrReasoning(
  thinking: NonNullable<z.infer<typeof schema>["thinking"]>,
  effort: ReasoningEffort | undefined,
): ReasoningConfig {
  switch (thinking.type) {
    case "adaptive":
      return {
        mode: "adaptive",
        ...(effort === undefined ? {} : { effort }),
        ...(thinking.display === undefined ? {} : { display: thinking.display }),
      };
    case "enabled":
      return { mode: "budget", budgetTokens: thinking.budget_tokens };
    case "disabled":
      return { mode: "off" };
  }
}

/**
 * Reads the betas the client opted into out of `anthropic-beta`.
 *
 * The adapter rebuilds every upstream header from the client profile, so a
 * beta header arriving here is dropped unless it is carried on the request —
 * while the body field it authorises survives through `vendor` and is then
 * rejected upstream as an unknown key. Repeated headers arrive comma-joined,
 * which is also how a single header lists more than one beta.
 */
function readBetas(headers: Headers | undefined): string[] {
  const raw = headers?.get("anthropic-beta");
  if (raw === undefined || raw === null) return [];
  const names = raw
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  return [...new Set(names)];
}

export function parseAnthropicRequest(body: unknown, headers?: Headers): ChatRequest {
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
        : parsed.system.map((b) => ({
            type: "text" as const,
            text: b.text,
            ...irCacheControl(b.cache_control),
          }));

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
      ...irCacheControl(t.cache_control),
    }));
  }
  if (parsed.tool_choice !== undefined) request.toolChoice = toIrToolChoice(parsed.tool_choice);
  // `output_config` stays out of KNOWN so the whole object still reaches
  // Anthropic untouched; effort is only *read* out of it here, so that it
  // survives when the request is routed to a different provider.
  const effort = readEffort(body);
  if (parsed.thinking !== undefined) {
    request.reasoning = toIrReasoning(parsed.thinking, effort);
  } else if (effort !== undefined) {
    request.reasoning = { mode: "adaptive", effort };
  }

  const extras = extraFields(body as Record<string, unknown>, KNOWN);
  if (extras !== undefined) request.vendor = { anthropic: extras };

  const betas = readBetas(headers);
  if (betas.length > 0) request.betas = betas;

  return validateRequest(request);
}

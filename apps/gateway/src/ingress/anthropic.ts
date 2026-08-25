import type {
  ChatRequest,
  ContentBlock,
  Message,
  ReasoningConfig,
  ReasoningEffort,
  ToolChoice,
} from "@omni/ir";
import { GatewayError, REASONING_EFFORTS, validateRequest } from "@omni/ir";
import { ANTHROPIC_NATIVE_BLOCK_TYPES } from "@omni/providers";
import { z } from "zod";
import { mcpServerNames, parseTools } from "./anthropicTools.ts";
import { normalizeClientModel } from "./model.ts";
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
  citations: z.array(z.unknown()).optional(),
});

const midConversationTextBlock = textBlock.extend({
  cache_control: cacheControl.nullable().optional(),
  citations: z.array(z.unknown()).nullable().optional(),
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

const nativeBase = {
  cache_control: cacheControl.nullable().optional(),
};

const nativeResultContent = z.unknown().refine((value) => value !== null, {
  message: "expected native result content",
});

const caller = z
  .discriminatedUnion("type", [
    z.object({ type: z.literal("direct") }).strict(),
    z
      .object({
        type: z.enum([
          "code_execution_20250825",
          "code_execution_20260120",
          "code_execution_20260521",
        ]),
        tool_id: z.string(),
      })
      .strict(),
  ])
  .optional();

const documentSource = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("base64"),
      media_type: z.literal("application/pdf"),
      data: z.string(),
    })
    .strict(),
  z
    .object({ type: z.literal("text"), media_type: z.literal("text/plain"), data: z.string() })
    .strict(),
  z.object({ type: z.literal("content"), content: z.array(z.unknown()) }).strict(),
  z.object({ type: z.literal("url"), url: z.string() }).strict(),
  z.object({ type: z.literal("file"), file_id: z.string() }).strict(),
]);

const citationsConfig = z.object({ enabled: z.boolean().optional() }).strict();
const fallbackModel = z.object({ model: z.string() }).strict();
const toolChangeReference = z.discriminatedUnion("type", [
  z.object({ type: z.literal("tool_reference"), name: z.string() }).strict(),
  z
    .object({ type: z.literal("mcp_tool_reference"), server_name: z.string(), name: z.string() })
    .strict(),
  z.object({ type: z.literal("mcp_toolset_reference"), server_name: z.string() }).strict(),
]);

function nativeToolChange(type: "tool_addition" | "tool_removal") {
  return z.object({ type: z.literal(type), tool: toolChangeReference, ...nativeBase }).strict();
}

const toolAddition = nativeToolChange("tool_addition");
const toolRemoval = nativeToolChange("tool_removal");
const midConversationSystem = z
  .object({
    type: z.literal("mid_conv_system"),
    content: z.array(
      z.discriminatedUnion("type", [midConversationTextBlock.strict(), toolAddition, toolRemoval]),
    ),
    ...nativeBase,
  })
  .strict();

const nativeSchemas: Readonly<Record<string, z.ZodType<Record<string, unknown>>>> = {
  server_tool_use: z
    .object({
      type: z.literal("server_tool_use"),
      id: z.string(),
      name: z.enum([
        "advisor",
        "web_search",
        "web_fetch",
        "code_execution",
        "bash_code_execution",
        "text_editor_code_execution",
        "tool_search_tool_regex",
        "tool_search_tool_bm25",
      ]),
      input: z.unknown(),
      caller,
      ...nativeBase,
    })
    .strict(),
  web_search_tool_result: nativeResult("web_search_tool_result", true),
  web_fetch_tool_result: nativeResult("web_fetch_tool_result", true),
  code_execution_tool_result: nativeResult("code_execution_tool_result"),
  bash_code_execution_tool_result: nativeResult("bash_code_execution_tool_result"),
  text_editor_code_execution_tool_result: nativeResult("text_editor_code_execution_tool_result"),
  tool_search_tool_result: nativeResult("tool_search_tool_result"),
  advisor_tool_result: nativeResult("advisor_tool_result"),
  mcp_tool_use: z
    .object({
      type: z.literal("mcp_tool_use"),
      id: z.string(),
      name: z.string(),
      server_name: z.string(),
      input: z.unknown(),
      ...nativeBase,
    })
    .strict(),
  mcp_tool_result: z
    .object({
      type: z.literal("mcp_tool_result"),
      tool_use_id: z.string(),
      content: z.union([z.string(), z.array(z.unknown())]).optional(),
      is_error: z.boolean().optional(),
      ...nativeBase,
    })
    .strict(),
  container_upload: z
    .object({ type: z.literal("container_upload"), file_id: z.string(), ...nativeBase })
    .strict(),
  compaction: z
    .object({
      type: z.literal("compaction"),
      content: z.string().nullable(),
      encrypted_content: z.string().nullable().optional(),
      ...nativeBase,
    })
    .strict(),
  search_result: z
    .object({
      type: z.literal("search_result"),
      source: z.string(),
      title: z.string(),
      content: z.array(z.unknown()),
      citations: citationsConfig.optional(),
      ...nativeBase,
    })
    .strict(),
  redacted_thinking: z.object({ type: z.literal("redacted_thinking"), data: z.string() }).strict(),
  document: z
    .object({
      type: z.literal("document"),
      source: documentSource,
      citations: citationsConfig.nullable().optional(),
      context: z.string().nullable().optional(),
      title: z.string().nullable().optional(),
      ...nativeBase,
    })
    .strict(),
  mid_conv_system: midConversationSystem,
  tool_addition: toolAddition,
  tool_removal: toolRemoval,
  fallback: z
    .object({
      type: z.literal("fallback"),
      from: fallbackModel,
      to: fallbackModel,
      trigger: z.unknown().optional(),
    })
    .strict(),
};

function nativeResult(type: string, hasCaller = false): z.ZodType<Record<string, unknown>> {
  return z
    .object({
      type: z.literal(type),
      tool_use_id: z.string(),
      content: nativeResultContent,
      ...(hasCaller ? { caller } : {}),
      ...nativeBase,
    })
    .strict();
}

/**
 * `system` here is Anthropic's mid-conversation system message, not the
 * top-level `system` prompt — this surface has a separate field for that, so a
 * system turn inside `messages` is unambiguously the mid-conversation feature
 * and is carried through in place rather than hoisted.
 */
const message = z.object({
  role: z.enum(["user", "assistant", "system"]),
  // Blocks stay opaque here and are dispatched below: the portable five are
  // parsed by the union above, and Anthropic's own block types are recognised
  // by discriminator and carried whole.
  content: z.union([z.string(), z.array(z.unknown())]),
});

const schema = z.object({
  model: z.string().min(1),
  messages: z.array(message).min(1),
  system: z.union([z.string(), z.array(textBlock)]).optional(),
  max_tokens: z.number().int().positive().optional(),
  temperature: z.number().optional(),
  stop_sequences: z.array(z.string()).optional(),
  stream: z.boolean().optional(),
  // Read as opaque entries and validated per family in `anthropicTools.ts`:
  // the legal fields depend on the exact versioned `type`, which a single
  // object schema cannot express without flattening every version together.
  tools: z.array(z.unknown()).optional(),
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
      return {
        type: "text",
        text: b.text,
        ...(b.citations === undefined ? {} : { citations: b.citations }),
        ...irCacheControl(b.cache_control),
      };
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

/**
 * Reads one content block, at a path precise enough to act on.
 *
 * Anthropic's own block types are recognised before the portable union is
 * tried, and their payloads are kept whole — a `web_search_tool_result` carries
 * citations, encrypted page content and error objects this gateway has no
 * schema for and no reason to rewrite. A type in neither set is refused rather
 * than dropped: a silently discarded block changes the conversation the model
 * sees, and the client has no way to tell.
 */
const nativeRoles: Readonly<Record<string, Message["role"]>> = {
  server_tool_use: "assistant",
  web_search_tool_result: "assistant",
  web_fetch_tool_result: "assistant",
  code_execution_tool_result: "assistant",
  bash_code_execution_tool_result: "assistant",
  text_editor_code_execution_tool_result: "assistant",
  tool_search_tool_result: "assistant",
  advisor_tool_result: "assistant",
  mcp_tool_use: "assistant",
  mcp_tool_result: "user",
  container_upload: "user",
  compaction: "assistant",
  search_result: "user",
  redacted_thinking: "assistant",
  document: "user",
  mid_conv_system: "system",
  tool_addition: "system",
  tool_removal: "system",
  fallback: "assistant",
};

function readBlock(raw: unknown, role: Message["role"], path: string): ContentBlock {
  if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
    const type = (raw as { type?: unknown }).type;
    if (typeof type === "string" && ANTHROPIC_NATIVE_BLOCK_TYPES.has(type)) {
      const nativeSchema = nativeSchemas[type];
      const nativeRole = nativeRoles[type];
      if (nativeSchema === undefined || nativeRole === undefined) {
        throw new GatewayError(
          "BAD_REQUEST",
          `${path}.type: block type "${type}" is not legal in request history`,
        );
      }
      if (role !== nativeRole) {
        throw new GatewayError(
          "BAD_REQUEST",
          `${path}: block type "${type}" is not legal in ${role} messages`,
        );
      }
      const parsed = nativeSchema.safeParse(raw);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        const issuePath =
          issue?.code === "unrecognized_keys" ? [...issue.path, issue.keys[0]] : issue?.path;
        const suffix = issuePath?.length ? `.${issuePath.join(".")}` : "";
        throw new GatewayError(
          "BAD_REQUEST",
          `${path}${suffix}: ${issue?.message ?? "invalid native content block"}`,
        );
      }
      const { type: _type, cache_control, ...data } = parsed.data;
      return {
        type: "anthropicNative",
        blockType: type,
        data,
        ...(cache_control === undefined || cache_control === null
          ? {}
          : irCacheControl(cache_control as z.infer<typeof cacheControl>)),
      };
    }
  }
  const parsed = block.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    // A block whose discriminator is simply unrecognised is reported by name.
    // Zod's own message lists the five portable types, which reads as though
    // the native ones were never supported at all.
    if (issue?.code === "invalid_union" || issue?.path.at(-1) === "type") {
      const type = (raw as { type?: unknown } | null)?.type;
      if (typeof type === "string") {
        throw new GatewayError("BAD_REQUEST", `${path}.type: unrecognized block type "${type}"`);
      }
    }
    const suffix = issue?.path.length ? `.${issue.path.join(".")}` : "";
    throw new GatewayError(
      "BAD_REQUEST",
      `${path}${suffix}: ${issue?.message ?? "invalid content block"}`,
    );
  }
  return toIrBlock(parsed.data);
}

function toIrToolChoice(c: NonNullable<z.infer<typeof schema>["tool_choice"]>): ToolChoice {
  return c.type === "tool" ? { type: "tool", name: c.name } : { type: c.type };
}

// Anthropic's field *filters* rather than rejects: an unknown effort is read
// as absent while `output_config` itself still rides the vendor bag to the
// one provider whose field it is. The OpenAI surface rejects instead — its
// clients have no vendor passthrough to fall back on. Both draw from the
// same ladder; only the unknown-value policy differs.
const EFFORTS = REASONING_EFFORTS;

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

  const messages: Message[] = parsed.messages.map((m, i) => {
    const content =
      typeof m.content === "string"
        ? [{ type: "text" as const, text: m.content }]
        : m.content.map((b, j) => readBlock(b, m.role, `messages.${i}.content.${j}`));
    if (m.role === "system") {
      const previous = parsed.messages[i - 1];
      const next = parsed.messages[i + 1];
      if (previous === undefined || (next !== undefined && next.role !== "assistant")) {
        throw new GatewayError(
          "BAD_REQUEST",
          `messages.${i}: system message must follow another message and be last or precede an assistant message`,
        );
      }
    }
    return { role: m.role, content };
  });

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

  const named = normalizeClientModel(parsed.model, readBetas(headers));
  const request: ChatRequest = {
    model: named.model,
    messages,
    stream: parsed.stream ?? false,
  };

  if (system !== undefined) request.system = system;
  if (parsed.max_tokens !== undefined) request.maxTokens = parsed.max_tokens;
  if (parsed.temperature !== undefined) request.temperature = parsed.temperature;
  if (parsed.stop_sequences !== undefined) request.stopSequences = parsed.stop_sequences;
  if (parsed.tools !== undefined) {
    request.tools = parseTools(parsed.tools, mcpServerNames(body as Record<string, unknown>));
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

  if (named.betas.length > 0) request.betas = named.betas;

  return validateRequest(request);
}

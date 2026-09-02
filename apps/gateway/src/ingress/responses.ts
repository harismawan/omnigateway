import { createHash } from "node:crypto";
import type {
  ChatRequest,
  ContentBlock,
  Message,
  ReasoningConfig,
  ToolChoice,
  ToolDef,
} from "@omni/ir";
import { GatewayError, REASONING_EFFORTS, safeToken, validateRequest } from "@omni/ir";
import { z } from "zod";
import { MODEL_NAME_MAX, normalizeClientModel } from "./model.ts";
import {
  extraFields,
  isRecord,
  parseDataUrl,
  parseOrThrow,
  readConversationHeader,
} from "./schemas.ts";

/**
 * `reasoning` is read rather than forwarded, so the effort survives a request
 * routed anywhere else. The full IR ladder is accepted and an unknown level is
 * refused, matching the chat surface: this field is consumed here, so a value
 * waved through would be silently dropped rather than reaching an upstream that
 * could argue with it.
 */
const reasoning = z.object({
  effort: z.enum(REASONING_EFFORTS).optional(),
  summary: z.string().optional(),
});

const schema = z.object({
  model: z.string().min(1).max(MODEL_NAME_MAX),
  // Items are read by hand below rather than by a discriminated union, because
  // the vocabulary is open at the edges: an unknown item type must name itself
  // in the refusal, and a zod union reports every arm it tried instead.
  input: z.union([z.string(), z.array(z.unknown())]),
  // Hand-read for the same reason `input` is: the hosted vocabulary is the
  // provider's and grows without this gateway, so a closed union here would
  // refuse tomorrow's tool rather than carry it.
  tools: z.array(z.unknown()).optional(),
  instructions: z.string().optional(),
  max_output_tokens: z.number().int().positive().optional(),
  temperature: z.number().optional(),
  stream: z.boolean().optional(),
  reasoning: reasoning.optional(),
  tool_choice: z
    .union([
      z.enum(["auto", "none", "required"]),
      // `custom` is here because a freeform tool becomes a portable tool below,
      // and a choice naming one has to keep naming it.
      z.object({ type: z.enum(["function", "custom"]), name: z.string() }),
    ])
    .optional(),
  // Refused below rather than in the schema, so the message names the field and
  // the reason instead of reading as a shape error.
  previous_response_id: z.string().nullish(),
  store: z.boolean().nullish(),
  // Read, never expressed: this surface has no stateful half, and the turn is
  // answerable without it.
  background: z.boolean().nullish(),
  // Read but *not* consumed — see KNOWN.
  prompt_cache_key: z.string().nullish(),
});

/**
 * What this parser consumes, and therefore what does not ride the vendor bag.
 *
 * The split is the whole contract of this list. `wire.ts` merges the bag
 * verbatim into an upstream Responses body, so a field already expressed in IR
 * would arrive twice and could disagree with itself — while a field this parser
 * *reads* without expressing has to stay out, or it never reaches the one
 * provider whose dialect it is.
 *
 * Three sit on the second side deliberately. `prompt_cache_key` is read as the
 * conversation id here and resolved again by `openai/wire.ts` from the bag, so
 * consuming it would take the client's own key away from the encoder that wants
 * it most. `include: ["reasoning.encrypted_content"]` is the request that makes
 * the reasoning round trip work at all, and `text` carries the structured-output
 * format — both are OpenAI's own fields with no IR spelling, which is what the
 * bag is for. `service_tier` and `client_metadata` join them for the same
 * reason. This is the `output_config` idiom the Anthropic surface already uses:
 * reading a field is not the same as claiming it.
 */
const KNOWN = [
  "model",
  "input",
  "instructions",
  "tools",
  "tool_choice",
  "stream",
  "store",
  "reasoning",
  "background",
  "previous_response_id",
  "max_output_tokens",
  "temperature",
  // Neither names a conversation: `metadata` is store-side bookkeeping that
  // means nothing under `store: false`, and `user` names the human.
  "metadata",
  "user",
] as const;

/**
 * The two shapes this surface refuses instead of normalizing away.
 *
 * Both peers strip them silently. Silence there answers a question about prior
 * state with no prior state and calls it a success, which reaches the client as
 * a model that forgot rather than a gateway that does not store.
 *
 * `store` is refused only when it is explicitly `true`. The real API defaults it
 * to true, so refusing on absence would reject every stock SDK call, while
 * refusing on an explicit `true` catches the client that actually asked.
 */
function refuseStatefulFields(parsed: z.infer<typeof schema>): void {
  if (typeof parsed.previous_response_id === "string" && parsed.previous_response_id.length > 0) {
    throw new GatewayError(
      "BAD_REQUEST",
      "previous_response_id: this gateway stores no responses, so prior state cannot be resumed",
    );
  }
  if (parsed.store === true) {
    throw new GatewayError(
      "BAD_REQUEST",
      "store: this gateway stores no responses; send store: false or omit it",
    );
  }
}

/**
 * The client's own cache key, when it is one this gateway will hold.
 *
 * Bounded rather than refused, and at the same 512 characters
 * `readConversationHeader` uses: the value is only *read* here — it rides the
 * vendor bag to the encoder either way — so an oversized one falls through to
 * the header rather than failing a request over a field the client is entitled
 * to send.
 */
function readCacheKey(raw: string | null | undefined): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 && trimmed.length <= 512 ? trimmed : undefined;
}

function toIrToolChoice(c: NonNullable<z.infer<typeof schema>["tool_choice"]>): ToolChoice {
  if (typeof c === "string") return c === "required" ? { type: "any" } : { type: c };
  return { type: "tool", name: c.name };
}

/**
 * This surface has no budget or opt-out knob, so an effort alone means "think
 * adaptively, this deep". `summary: "none"` is the client asking not to be shown
 * the reasoning, which is the IR's `display: "omitted"`; every other summary
 * value says nothing about depth or display and maps to neither.
 */
function toIrReasoning(r: NonNullable<z.infer<typeof schema>["reasoning"]>): ReasoningConfig {
  return {
    mode: "adaptive",
    ...(r.effort === undefined ? {} : { effort: r.effort }),
    ...(r.summary === "none" ? { display: "omitted" as const } : {}),
  };
}

/**
 * A `call_id` bounded to what the Responses API accepts, deterministically.
 *
 * Truncation is the wrong tool: two ids sharing a 64-character prefix would
 * collapse onto one, and a call would be answered by another call's result. A
 * digest is the same length, is stable across the two items that have to agree,
 * and separates ids that differ anywhere at all.
 */
function clampCallId(raw: string): string {
  return raw.length <= 64 ? raw : createHash("sha256").update(raw).digest("hex");
}

/** `developer` is this dialect's spelling of an operator turn inside history. */
function roleOf(raw: unknown): Message["role"] {
  if (raw === "assistant") return "assistant";
  if (raw === "system" || raw === "developer") return "system";
  return "user";
}

/**
 * One content part of a message item.
 *
 * A remote image is dropped rather than refused — it was dropped before this
 * surface existed too, and fetching one is a request this gateway does not make
 * on a client's behalf. An unrecognised part is refused, because a silently
 * discarded part changes what the model reads with nothing said about it.
 */
function contentPart(part: unknown): ContentBlock | null {
  if (!isRecord(part))
    throw new GatewayError("BAD_REQUEST", "input: content part must be an object");
  const type = part.type;
  if (type === "input_text" || type === "output_text") {
    return { type: "text", text: String(part.text ?? "") };
  }
  if (type === "input_image") {
    const url = typeof part.image_url === "string" ? part.image_url : "";
    if (!url.startsWith("data:")) return null;
    const { mediaType, data } = parseDataUrl(url);
    return { type: "image", mediaType, data };
  }
  throw new GatewayError(
    "BAD_REQUEST",
    `input: unsupported content part type "${safeToken(type)}"`,
  );
}

/** A message item's content, which the API allows to be a bare string. */
function messageBlocks(content: unknown): ContentBlock[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!Array.isArray(content)) return [];
  const blocks: ContentBlock[] = [];
  for (const part of content) {
    const block = contentPart(part);
    if (block !== null) blocks.push(block);
  }
  return blocks;
}

/**
 * A model-produced item this gateway carries but never interprets: reasoning,
 * whose `encrypted_content` is the Codex backend's own continuity blob, and the
 * local shell pair. The payload is kept whole, `id` included — stripping that is
 * the encoder's job at replay time, where the rule about what a stateless
 * backend can resolve actually lives.
 */
function nativeBlock(item: Record<string, unknown>, blockType: string): ContentBlock {
  const { type: _type, ...data } = item;
  return { type: "providerNative", provider: "openai", blockType, data };
}

/**
 * Input items to IR messages, one message per item.
 *
 * Two passes, because a call and its output are separate items and a call this
 * parser drops must take its answer with it: a `function_call_output` whose call
 * never arrived is an orphan the upstream refuses outright.
 */
function readInputItems(items: readonly unknown[]): Message[] {
  const dropped = new Set<string>();
  const messages: Message[] = [];

  const push = (role: Message["role"], content: ContentBlock[]): void => {
    if (content.length > 0) messages.push({ role, content });
  };

  for (const raw of items) {
    if (!isRecord(raw)) throw new GatewayError("BAD_REQUEST", "input: item must be an object");
    // Droid CLI sends role-bearing items with no `type`, and both peer gateways
    // carry the same fallback. Measured, not defensive.
    const type = raw.type ?? (raw.role === undefined ? undefined : "message");

    switch (type) {
      case "message":
        push(roleOf(raw.role), messageBlocks(raw.content));
        break;

      case "function_call":
      case "custom_tool_call": {
        const name = typeof raw.name === "string" ? raw.name : "";
        const callId = typeof raw.call_id === "string" ? raw.call_id : "";
        // An empty name loops the model through a placeholder tool, and an empty
        // call_id can never be matched to its output. Both are dropped rather
        // than repaired: neither is a request this gateway can make sense of.
        if (name === "" || callId === "") {
          if (callId !== "") dropped.add(callId);
          else dropped.add("");
          break;
        }
        const input =
          type === "custom_tool_call"
            ? { input: typeof raw.input === "string" ? raw.input : "" }
            : jsonArguments(raw.arguments, clampCallId(callId));
        push("assistant", [{ type: "toolUse", id: clampCallId(callId), name, input }]);
        break;
      }

      case "function_call_output":
      case "custom_tool_call_output": {
        const callId = typeof raw.call_id === "string" ? raw.call_id : "";
        if (dropped.has(callId)) break;
        push("user", [
          {
            type: "toolResult",
            toolUseId: clampCallId(callId),
            content: typeof raw.output === "string" ? raw.output : JSON.stringify(raw.output ?? ""),
            isError: false,
          },
        ]);
        break;
      }

      case "reasoning":
      case "local_shell_call":
        push("assistant", [nativeBlock(raw, String(type))]);
        break;

      case "local_shell_call_output":
        push("user", [nativeBlock(raw, "local_shell_call_output")]);
        break;

      case "item_reference":
        throw new GatewayError(
          "BAD_REQUEST",
          "input: item_reference names a stored item, and this gateway stores no responses",
        );

      default:
        throw new GatewayError("BAD_REQUEST", `input: unsupported item type "${safeToken(type)}"`);
    }
  }

  return messages;
}

/**
 * A tool call's arguments, which are a JSON *string* on this wire.
 *
 * Refused rather than defaulted to `{}`: a call dispatched with no arguments is
 * a different call, and the failure belongs at the client that wrote it.
 */
function jsonArguments(raw: unknown, callId: string): Record<string, unknown> {
  const text = typeof raw === "string" ? raw : "";
  try {
    const parsed: unknown = text === "" ? {} : JSON.parse(text);
    return isRecord(parsed) ? parsed : { value: parsed };
  } catch {
    // Named by `call_id`, never by tool name. A refusal built here carries no
    // provider, so `reasonField` prints its message to stdout at default level
    // — and a tool name is text the client chose, which is the thing
    // `LogFields` is a closed allowlist to keep off that line. The call id is
    // this gateway's own correlation handle and enough to find the item.
    throw new GatewayError(
      "BAD_REQUEST",
      `input: arguments for call ${safeToken(callId)} are not valid JSON`,
    );
  }
}

/** What the Responses API accepts as a tool name, and therefore what is stored. */
const TOOL_NAME = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Tool declarations, in the three shapes this dialect has.
 *
 * `function` and `custom` are the client's own tools and become portable ones,
 * so they reach every provider. Everything else is *hosted*: a tool the provider
 * runs itself, whose declaration this gateway cannot interpret and does not try
 * to. Those become provider tools, which `requiredProviders` reads to admit only
 * OpenAI targets — the pin starts at turn 1 because a tool is declared on the
 * first request, and that is the cost of carrying them at all. Dropping them was
 * measured worse: a peer gateway found that discarding `tool_search` broke the
 * deferred tool-loading protocol outright, and Codex Desktop sends
 * `image_generation` on every request including text-only ones.
 */
function readTools(raw: readonly unknown[]): ToolDef[] {
  const tools: ToolDef[] = [];
  for (const entry of raw) {
    if (!isRecord(entry))
      throw new GatewayError("BAD_REQUEST", "tools: each tool must be an object");
    const type = typeof entry.type === "string" ? entry.type : "";
    const declared = typeof entry.name === "string" ? entry.name : "";

    if (type === "function" || type === "custom") {
      if (!TOOL_NAME.test(declared)) {
        // The offending value is deliberately absent: it is the client's own
        // text, it just failed the length and charset rule so it is unbounded
        // in both, and this message reaches stdout. The rule is stated instead,
        // which is what a client needs to fix its request anyway.
        throw new GatewayError("BAD_REQUEST", `tools: a tool name must match ${TOOL_NAME.source}`);
      }
      const description = typeof entry.description === "string" ? entry.description : undefined;
      tools.push({
        kind: "portable",
        name: declared,
        ...(description === undefined ? {} : { description }),
        // A freeform tool has no schema on the wire and is answered with a
        // program rather than arguments, so it lands in the one shape
        // `custom_tool_call` already parses into.
        inputSchema:
          type === "custom"
            ? { type: "object", properties: { input: { type: "string" } }, required: ["input"] }
            : isRecord(entry.parameters)
              ? entry.parameters
              : { type: "object" },
      });
      continue;
    }

    // A hosted tool often carries no name of its own — `{"type": "web_search"}`
    // is a complete declaration — and an unnamed tool reads as an absent one in
    // every log line and encoder that identifies tools by name.
    const name = declared === "" ? type : declared;
    if (!TOOL_NAME.test(name)) {
      throw new GatewayError("BAD_REQUEST", `tools: a tool name must match ${TOOL_NAME.source}`);
    }
    const { type: _type, name: _name, ...wire } = entry;
    tools.push({ kind: "provider", provider: "openai", type, name, wire });
  }
  return tools;
}

/**
 * The tools a client declared freeform, by name.
 *
 * Read from the body rather than from the parsed request, because IR has one
 * portable shape for both kinds and this distinction is the *client's* dialect,
 * not the model's: the same call renders as `custom_tool_call` or `function_call`
 * depending on it, and a client that dispatches only one of the two never runs
 * the other. It is deliberately not carried in `vendor.openai` — that bag is
 * merged verbatim into the upstream body, so a marker parked there would be sent
 * to the provider.
 */
export function customToolNames(body: unknown): ReadonlySet<string> {
  const names = new Set<string>();
  if (!isRecord(body) || !Array.isArray(body.tools)) return names;
  for (const entry of body.tools) {
    if (isRecord(entry) && entry.type === "custom" && typeof entry.name === "string") {
      names.add(entry.name);
    }
  }
  return names;
}

export function parseResponsesRequest(body: unknown, headers?: Headers): ChatRequest {
  if (typeof body !== "object" || body === null) {
    throw new GatewayError("BAD_REQUEST", "request body must be a JSON object");
  }

  const parsed = parseOrThrow(schema, body);
  refuseStatefulFields(parsed);

  const messages: Message[] =
    typeof parsed.input === "string"
      ? [{ role: "user", content: [{ type: "text", text: parsed.input }] }]
      : readInputItems(parsed.input);

  // The same guard the chat surface carries, and it earns its place twice over
  // here: every provider refuses an empty history, and `openai/wire.ts` derives
  // its cache key from the opening item, so a request with none collapses that
  // key onto one constant shared by every such request on the installation.
  if (messages.length === 0) {
    throw new GatewayError("BAD_REQUEST", "input: at least one input item is required");
  }

  const named = normalizeClientModel(parsed.model);
  const request: ChatRequest = {
    model: named.model,
    messages,
    stream: parsed.stream ?? false,
  };

  if (parsed.instructions !== undefined && parsed.instructions.length > 0) {
    request.system = [{ type: "text", text: parsed.instructions }];
  }
  if (parsed.max_output_tokens !== undefined) request.maxTokens = parsed.max_output_tokens;
  if (parsed.temperature !== undefined) request.temperature = parsed.temperature;
  if (parsed.tools !== undefined && parsed.tools.length > 0)
    request.tools = readTools(parsed.tools);
  if (parsed.tool_choice !== undefined) request.toolChoice = toIrToolChoice(parsed.tool_choice);
  if (parsed.reasoning !== undefined) request.reasoning = toIrReasoning(parsed.reasoning);
  if (named.betas.length > 0) request.betas = named.betas;

  // Body first, header second, same order the other two surfaces use: a client
  // filling `prompt_cache_key` is naming the conversation in the field its own
  // protocol defines, and the header is how the harnesses that put nothing in
  // the body say the same thing.
  const conversation = readCacheKey(parsed.prompt_cache_key) ?? readConversationHeader(headers);
  if (conversation !== undefined) request.conversationId = conversation;

  const extras = extraFields(body as Record<string, unknown>, KNOWN);
  if (extras !== undefined) request.vendor = { openai: extras };

  return validateRequest(request);
}

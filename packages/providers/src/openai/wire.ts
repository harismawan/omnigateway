import { createHash } from "node:crypto";
import { type ChatRequest, CONTEXT_1M_BETA, type ToolChoice } from "@omni/ir";
import { systemText } from "../system.ts";

export type ResponsesBody = {
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

/** A client-supplied cache key, when it is a usable string. */
function suppliedKey(req: ChatRequest): string | undefined {
  const vendor = req.vendor?.openai;
  for (const name of ["prompt_cache_key", "session_id"] as const) {
    const value = vendor?.[name];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

/**
 * Derives the cache-affinity key the Codex backend partitions its prompt cache
 * by.
 *
 * Measured, not assumed: byte-identical 10k-token requests 75s apart read back
 * 0 of 5 times without a session id and 14 of 15 with one, and the gateway's
 * own `request_logs` showed 2 cache reads in 21 requests before this existed.
 *
 * The key has to survive the turns of one conversation and separate it from the
 * next, which is why the client's own `conversationId` is preferred over
 * anything derived. The fallback follows the same rule the xAI encoder reasons
 * through at `grok/wire.ts:40-48`: the request id changes every turn and the
 * whole history changes every turn, so what is hashed is the instructions plus
 * the opening item, which is what a conversation keeps.
 *
 * Hashed rather than forwarded. `conversationId` reaches us from Anthropic's
 * `metadata.user_id` — a client identifier the operator never chose to
 * disclose, and on Claude Code a JSON string carrying a device id and an
 * account uuid, so forwarding it raw is the habit not to form. The digest also
 * lands inside the character set the backend accepts, so there is no
 * validate-or-drop branch to get wrong.
 */
function cacheKey(req: ChatRequest, instructions: string, firstInput: unknown): string {
  const stable =
    req.conversationId !== undefined && req.conversationId.length > 0
      ? JSON.stringify({ conversation: req.conversationId })
      : JSON.stringify({ instructions, firstInput });
  return createHash("sha256").update(stable).digest("hex").slice(0, 32);
}

function encodeToolChoice(c: ToolChoice): unknown {
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
 * Flattens IR messages into Responses input items.
 *
 * Tool use and tool result are top-level items in this API rather than content
 * blocks inside a message, so a single IR message can expand into several items.
 */
export function toResponsesWire(
  req: ChatRequest,
  model: string,
  /**
   * The Codex backend is a narrower surface than `api.openai.com`: it drives
   * one product and rejects several standard Responses parameters outright.
   * Defaults to the permissive API so only the OAuth path is constrained.
   */
  opts: { oauth: boolean } = { oauth: false },
): { body: ResponsesBody; degradations: string[]; cacheKey: string } {
  const degradations: string[] = [];
  const input: unknown[] = [];

  const note = (d: string): void => {
    if (!degradations.includes(d)) degradations.push(d);
  };

  // There is no beta mechanism here, so a client asking for the 1M window is
  // not refused, it is simply not honoured. Recorded because the silence is the
  // dangerous part: the client keeps pacing itself against a megabyte while
  // this target caps far lower, and the request that finally exceeds it fails
  // with nothing in the log explaining why.
  if (req.betas?.includes(CONTEXT_1M_BETA)) note("openai:context-1m-dropped");

  for (const message of req.messages) {
    const parts: unknown[] = [];

    // The Codex backend refuses a system turn inside `input` — it supplies its
    // own. The documented fallback is to carry the instruction in a user turn,
    // marked, so it keeps its position even though it loses the operator role.
    const inlined = message.role === "system";
    if (inlined) note("openai:system-turn-inlined");
    const role = inlined ? "user" : message.role;

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
            text: inlined ? `<system-reminder>\n${block.text}\n</system-reminder>` : block.text,
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
          if (!degradations.includes("openai:thinking-dropped")) {
            note("openai:thinking-dropped");
          }
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
          note("openai:anthropic-native-block-dropped");
          break;
      }
    }
    flush();
  }

  const body: ResponsesBody = { model, input, stream: req.stream, store: false };

  const instructions = systemText(req.system, "openai", note);
  if (instructions !== undefined && instructions.length > 0) body.instructions = instructions;

  if (req.maxTokens !== undefined) {
    // Rejected by the Codex backend with "Unsupported parameter".
    if (opts.oauth) note("openai:max-tokens-dropped");
    else body.max_output_tokens = req.maxTokens;
  }
  if (req.temperature !== undefined) {
    // Same surface, and the reasoning models it serves do not take sampling
    // parameters at all.
    if (opts.oauth) note("openai:temperature-dropped");
    else body.temperature = req.temperature;
  }
  if (req.tools !== undefined) {
    // Same reasoning as the native block above: an Anthropic-defined tool has
    // no function schema to send, and the router never routes one here.
    const custom = req.tools.filter((t) => t.kind === "portable");
    if (custom.length !== req.tools.length) note("openai:anthropic-tool-dropped");
    body.tools = custom.map((t) => ({
      type: "function",
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    }));
  }
  if (req.toolChoice !== undefined) body.tool_choice = encodeToolChoice(req.toolChoice);
  if (req.reasoning !== undefined && req.reasoning.mode !== "off") {
    // This API takes a coarse effort level, not a token budget. A budget
    // request is therefore recorded as lost rather than mapped onto an
    // invented medium nobody chose — these models think by default, so
    // sending nothing leaves them at their own depth instead of fabricating
    // one.
    if (req.reasoning.mode === "budget") {
      degradations.push("openai:reasoning-budget-dropped");
    } else {
      // The official ladder now runs `none` through `max`; model support
      // varies, and per the gateway's no-request-shape-validation rule an
      // unsupported value surfaces as the upstream error it is rather than
      // being pre-clamped into a different depth.
      const effort = req.reasoning.effort ?? "medium";
      body.reasoning = { effort, summary: "auto" };
    }
  }

  const key = suppliedKey(req) ?? cacheKey(req, instructions ?? "", input[0]);

  Object.assign(body, req.vendor?.openai ?? {});

  // Written **after** the vendor merge, and the order is the whole point. The
  // merge copies the client's bag verbatim, including a `prompt_cache_key` that
  // `suppliedKey` already rejected — an empty string, a number — so assigning
  // first let the merge put the rejected value back. On the OAuth leg the
  // header still carried the resolved key and the damage was invisible; on the
  // API-key leg this field is the only mechanism there is, so the request went
  // out with the useless value and nothing recorded it.
  body.prompt_cache_key = key;
  return { body, degradations, cacheKey: key };
}

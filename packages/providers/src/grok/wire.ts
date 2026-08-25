import { createHash } from "node:crypto";
import { type ChatRequest, CONTEXT_1M_BETA, type ToolChoice } from "@omni/ir";

/**
 * Above this the proxy answers `Maximum tools limit reached` and the whole
 * request fails. Truncating loses the tail of a tool list; a 400 loses the turn.
 */
const MAX_TOOLS = 200;

export type GrokResponsesBody = {
  model: string;
  input: unknown[];
  instructions?: string;
  stream: boolean;
  store: boolean;
  include: string[];
  prompt_cache_key: string;
  max_output_tokens?: number;
  temperature?: number;
  tools?: unknown[];
  tool_choice?: unknown;
  reasoning?: { effort: string; summary: string };
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
      return { type: "function", name: c.name };
  }
}

/**
 * Derives the cache-affinity key from the conversation's stable prefix.
 *
 * The key pins requests to one server, so it has to survive across the turns of
 * a conversation — keying it on the request id would hand every follow-up a
 * different server and buy nothing. Hashing the whole history is the opposite
 * failure: it changes on every turn too. The instructions plus the opening turn
 * are what a conversation keeps, so that is what is hashed.
 */
function promptCacheKey(instructions: string, firstInput: unknown): string {
  const stable = JSON.stringify({ instructions, firstInput });
  return createHash("sha256").update(stable).digest("hex").slice(0, 32);
}

/**
 * Flattens IR messages into Responses input items.
 *
 * Forked from the OpenAI encoder rather than shared with it: the two surfaces
 * agree today but already differ in reasoning effort, parameter drops and body
 * fields, and a shared file would mean every future xAI quirk lands as another
 * branch inside OpenAI's encoder.
 */
export function toGrokWire(
  req: ChatRequest,
  model: string,
): { body: GrokResponsesBody; degradations: string[] } {
  const degradations: string[] = [];
  const input: unknown[] = [];

  const note = (d: string): void => {
    if (!degradations.includes(d)) degradations.push(d);
  };

  // No beta mechanism here, so a client asking for the 1M window is not refused,
  // it is simply not honoured. Recorded because the silence is the dangerous
  // part: the client keeps pacing itself against a megabyte while this target
  // caps lower, and the request that finally exceeds it fails unexplained.
  if (req.betas?.includes(CONTEXT_1M_BETA)) note("grok:context-1m-dropped");

  for (const message of req.messages) {
    const parts: unknown[] = [];

    // No xAI source says whether the proxy accepts a system turn inside `input`,
    // and the OpenAI fork's answer is the safe one either way: the instruction
    // keeps its position, marked, rather than risking a rejected turn.
    const inlined = message.role === "system";
    if (inlined) note("grok:system-turn-inlined");
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
          // xAI takes the data URL as a plain string here, not OpenAI's
          // `{ url: … }` object — the one shape difference between the two.
          parts.push({
            type: "input_image",
            image_url: `data:${block.mediaType};base64,${block.data}`,
          });
          break;
        case "thinking":
          // xAI's own encrypted reasoning content could round-trip, but that
          // needs an IR representation for an opaque provider-owned blob.
          // Anthropic's signed thinking is meaningless here regardless.
          note("grok:thinking-dropped");
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
        case "anthropicNative":
          // Unreachable in practice: the router excludes this provider from any
          // request carrying Anthropic-native history. Recorded rather than
          // ignored so that if it ever does arrive, the request log says what
          // was lost instead of the client seeing a turn quietly rewritten.
          note("grok:anthropic-native-block-dropped");
          break;
      }
    }
    flush();
  }

  const instructions = req.system?.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n\n");

  const body: GrokResponsesBody = {
    model,
    input,
    stream: req.stream,
    // Defaults to true upstream, which breaks zero-data-retention expectations.
    // xAI's image documentation independently advises against storing, so this
    // stays set for two unrelated reasons.
    store: false,
    include: ["reasoning.encrypted_content"],
    prompt_cache_key: promptCacheKey(instructions ?? "", input[0]),
  };

  if (instructions !== undefined && instructions.length > 0) body.instructions = instructions;

  // Sent on both routes. The OpenAI encoder drops these under OAuth because the
  // Codex backend rejects them, which is a constraint of that product and not
  // of xAI's proxy.
  if (req.maxTokens !== undefined) body.max_output_tokens = req.maxTokens;
  if (req.temperature !== undefined) body.temperature = req.temperature;

  if (req.tools !== undefined) {
    // An Anthropic-defined tool has no function schema to send, and the router
    // never routes one here.
    const custom = req.tools.filter((t) => t.provider === "custom");
    if (custom.length !== req.tools.length) note("grok:anthropic-tool-dropped");
    if (custom.length > MAX_TOOLS) note("grok:tools-truncated");
    body.tools = custom.slice(0, MAX_TOOLS).map((t) => ({
      type: "function",
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    }));
  }
  if (req.toolChoice !== undefined) body.tool_choice = encodeToolChoice(req.toolChoice);
  if (req.reasoning !== undefined && req.reasoning.mode !== "off") {
    // Forwarded unclamped: xAI clamps server-side — `xhigh` is treated as `high`
    // on models that lack it — so a second clamp here could only get it wrong as
    // the model line moves.
    // A budget has no expression here. These models think by default, so
    // sending nothing leaves them at their own depth instead of fabricating
    // an effort nobody chose; the loss is recorded.
    if (req.reasoning.mode === "budget") {
      note("grok:reasoning-budget-dropped");
    } else {
      const effort = req.reasoning.effort ?? "medium";
      body.reasoning = { effort, summary: "concise" };
    }
  }

  // Last, so an operator can override anything above. Deliberately unfiltered:
  // it is the escape hatch. Note that the proxy 400s on `presence_penalty`,
  // `frequency_penalty`, `logprobs`, `top_logprobs` and `stop`, which the
  // encoder never emits — a passthrough carrying one is the likely cause.
  Object.assign(body, req.vendor?.grok ?? {});
  return { body, degradations };
}

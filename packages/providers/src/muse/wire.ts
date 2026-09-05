import { createHash } from "node:crypto";
import { type ChatRequest, CONTEXT_1M_BETA, type ToolChoice } from "@omni/ir";
import { systemText } from "../system.ts";

export type MuseResponsesBody = {
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

/**
 * A forked copy of the OpenAI Responses encoder, not an import of one.
 *
 * Meta's Model API serves the Responses dialect, so the two encoders start out
 * near-identical and the temptation to share is real. Boundary rule 4 refuses
 * it, and `custom/` is the worked example of why: it shipped importing another
 * provider's encoder and paid for it with a regex rewriting degradation
 * prefixes afterwards. The divergences are already here — no Codex parameter
 * bans, a different vendor bag key, a different session header — and vendors
 * that look alike on paper diverge in practice.
 */

/** A client-supplied cache key, when it is a usable string. */
function suppliedKey(req: ChatRequest): string | undefined {
  const vendor = req.vendor?.muse;
  for (const name of ["prompt_cache_key", "session_id"] as const) {
    const value = vendor?.[name];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

/**
 * Derives the cache-affinity key.
 *
 * Same construction and the same reasoning as the OpenAI encoder's, which was
 * measured against the Codex backend rather than guessed. Whether Meta's front
 * door partitions its prompt cache the same way is **not** measured here — what
 * is known is that its own client sends a session id on every request
 * (`x-meta-ai-gateway-session-id`, read out of the shipped binary), and that
 * this repository has already paid for sending no key at all.
 *
 * The key has to survive the turns of one conversation and separate it from the
 * next, which is why the client's own `conversationId` is preferred over
 * anything derived. The fallback hashes the instructions plus the opening item,
 * which is what a conversation keeps while the request id and the history
 * change every turn.
 *
 * Hashed rather than forwarded. `conversationId` reaches us from Anthropic's
 * `metadata.user_id` — a client identifier the operator never chose to
 * disclose, and on Claude Code a JSON string carrying a device id and an
 * account uuid — so forwarding it raw is the habit not to form.
 */
function cacheKey(req: ChatRequest, instructions: string, firstInput: unknown): string {
  const stable =
    req.conversationId !== undefined && req.conversationId.length > 0
      ? JSON.stringify({ conversation: req.conversationId })
      : // `?? null` because `JSON.stringify` **omits** a property whose value is
        // `undefined`, so an empty `input` would silently reduce the hash to the
        // instructions alone — and with no system prompt either, to one constant
        // shared by every such request on the installation.
        JSON.stringify({ instructions, firstInput: firstInput ?? null });
  return createHash("sha256").update(stable).digest("hex").slice(0, 32);
}

/**
 * Answers any tool call the history left unanswered.
 *
 * A Responses `input` array holding a `function_call` with no matching
 * `function_call_output` is rejected, and a turn interrupted after the model
 * asked for a tool but before the client ran it produces exactly that. The call
 * is real history, so it is completed with an empty output rather than dropped
 * — removing it would rewrite what the model said.
 *
 * IR strips orphaned tool *results* in `validateRequest`; nothing strips or
 * completes an orphaned *call*, which is why this sits here.
 *
 * `function_call` is the only type it looks for, and that is a fact about this
 * encoder rather than about the API: IR has one `toolUse` block, so a tool the
 * client declared freeform is flattened to a function call here exactly as its
 * declaration is flattened to a function tool. Teaching this encoder to emit
 * `custom_tool_call` means teaching this function `custom_tool_call_output` in
 * the same change.
 */
function repairOrphanedCalls(input: unknown[]): void {
  const answered = new Set<string>();
  for (const item of input) {
    const record = item as { type?: string; call_id?: string };
    if (record.type === "function_call_output" && typeof record.call_id === "string") {
      answered.add(record.call_id);
    }
  }

  for (let i = input.length - 1; i >= 0; i--) {
    const record = input[i] as { type?: string; call_id?: string };
    if (record.type !== "function_call" || typeof record.call_id !== "string") continue;
    if (answered.has(record.call_id)) continue;
    input.splice(i + 1, 0, { type: "function_call_output", call_id: record.call_id, output: "" });
  }
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
 *
 * There is no `oauth` option here, and its absence is the substantive
 * difference from the OpenAI encoder. That flag exists there to name the Codex
 * backend, a narrower surface than `api.openai.com` which rejects
 * `max_output_tokens` and `temperature` outright. Muse has one host: the OAuth
 * grant is spent minting a Model API key, and every inference request carries
 * that key against the same front door. A subscription and a
 * dashboard-issued key reach identical bytes.
 */
export function toMuseWire(
  req: ChatRequest,
  model: string,
): { body: MuseResponsesBody; degradations: string[]; cacheKey: string } {
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
  if (req.betas?.includes(CONTEXT_1M_BETA)) note("muse:context-1m-dropped");

  for (const message of req.messages) {
    const parts: unknown[] = [];

    // `developer` is this dialect's role for a mid-conversation operator turn.
    // It keeps both its position and its operator standing, and stays inside
    // the cacheable prefix. Recorded as a degradation because the role is not
    // the one the client wrote.
    const asDeveloper = message.role === "system";
    if (asDeveloper) note("muse:system-turn-as-developer");
    const role = asDeveloper ? "developer" : message.role;

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
            text: block.text,
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
          note("muse:thinking-dropped");
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
          if (block.provider === "muse") {
            // This provider's own item, going home. `id` is deliberately left
            // behind: under `store: false` no server-assigned id can be
            // resolved, and an item still carrying one is rejected outright.
            // What continuity needs is the payload — for a reasoning item,
            // `encrypted_content` — which is never decrypted, inspected or
            // regenerated on the way through.
            flush();
            const { id: _id, ...rest } = block.data;
            input.push({ type: block.blockType, ...rest });
            break;
          }
          // Another provider's. Unreachable in practice, since the router
          // excludes this provider from any request carrying one, and recorded
          // rather than ignored so that if it ever does arrive the request log
          // says what was lost instead of the client seeing a turn quietly
          // rewritten.
          note("muse:foreign-native-block-dropped");
          break;
      }
    }
    flush();
  }

  repairOrphanedCalls(input);

  // `store: false` for the reason this gateway's own Responses surface is
  // stateless: nothing here ever resolves a server-side id, so retention would
  // buy the operator nothing and leave prompts sitting upstream.
  const body: MuseResponsesBody = { model, input, stream: req.stream, store: false };

  const instructions = systemText(req.system, "muse", note);
  if (instructions !== undefined && instructions.length > 0) body.instructions = instructions;

  if (req.maxTokens !== undefined) body.max_output_tokens = req.maxTokens;
  if (req.temperature !== undefined) body.temperature = req.temperature;
  if (req.tools !== undefined) {
    // Same reasoning as the native block above: a provider-defined tool has no
    // function schema to send, and the router never routes one here.
    const portable = req.tools.filter((t) => t.kind === "portable");
    if (portable.length !== req.tools.length) note("muse:provider-tool-dropped");
    body.tools = portable.map((t) => ({
      type: "function",
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    }));
  }
  if (req.toolChoice !== undefined) body.tool_choice = encodeToolChoice(req.toolChoice);
  if (req.reasoning !== undefined && req.reasoning.mode !== "off") {
    // This API takes a coarse effort level, not a token budget. A budget
    // request is therefore recorded as lost rather than mapped onto an invented
    // medium nobody chose.
    if (req.reasoning.mode === "budget") {
      note("muse:reasoning-budget-dropped");
    } else {
      const effort = req.reasoning.effort ?? "medium";
      body.reasoning = { effort, summary: "auto" };
    }
  }

  const key = suppliedKey(req) ?? cacheKey(req, instructions ?? "", input[0]);

  Object.assign(body, req.vendor?.muse ?? {});

  // Written **after** the vendor merge, and the order is the whole point. The
  // merge copies the client's bag verbatim, including a `prompt_cache_key` that
  // `suppliedKey` already rejected — an empty string, a number — so assigning
  // first would let the merge put the rejected value back.
  body.prompt_cache_key = key;
  return { body, degradations, cacheKey: key };
}

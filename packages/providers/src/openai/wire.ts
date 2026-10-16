import { type ChatRequest, CONTEXT_1M_BETA, type ToolChoice } from "@omni/ir";
import { moveToResponsesText } from "../responseFormat.ts";
import { systemText } from "../system.ts";
import { responsesFiles, withFileText } from "../toolResultFiles.ts";
import { codexModel } from "./codexCatalog.ts";
import { isUuid, threadIdFrom } from "./codexIdentity.ts";
import { type CodexTurn, codexTurn, toLiteInput } from "./codexLite.ts";

export type ResponsesBody = {
  model: string;
  input: unknown[];
  instructions?: string;
  stream: boolean;
  max_output_tokens?: number;
  temperature?: number;
  tools?: unknown[];
  tool_choice?: unknown;
  reasoning?: { effort: string; summary?: string; context?: string };
  store?: boolean;
  [key: string]: unknown;
};

// Gateway header budget, not an upstream schema limit: the key rides three
// headers, so 1 KiB leaves room for auth within common 8 KiB header limits.
const MAX_CACHE_KEY_LENGTH = 1024;
const HEADER_SAFE_KEY = /^[\x21-\x7e]+$/;

/** A client-supplied cache key, safe for both the body and session headers. */
function suppliedKey(req: ChatRequest): string | undefined {
  const vendor = req.vendor?.openai;
  for (const name of ["prompt_cache_key", "session_id"] as const) {
    const value = vendor?.[name];
    if (
      typeof value === "string" &&
      value.length <= MAX_CACHE_KEY_LENGTH &&
      HEADER_SAFE_KEY.test(value)
    )
      return value;
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
 *
 * The key is Codex's thread id, which is a UUIDv7, so the digest is shaped as
 * one (`threadIdFrom`). A client-supplied key that already is a UUID — a Codex
 * client's own thread id — passes through unchanged; any other supplied key is
 * hashed into the same form. Precedence is unchanged: client
 * `prompt_cache_key`, client `session_id`, `conversationId`, fallback.
 *
 * Returns the key and the string it was derived from: the OAuth leg hashes the
 * latter into the installation id when the credential names no account.
 */
function cacheKey(
  req: ChatRequest,
  instructions: string,
  firstInput: unknown,
): { key: string; seed: string } {
  const supplied = suppliedKey(req);
  if (supplied !== undefined) {
    if (isUuid(supplied)) return { key: supplied, seed: supplied };
    const seed = JSON.stringify({ key: supplied });
    return { key: threadIdFrom(seed), seed };
  }
  const seed =
    req.conversationId !== undefined && req.conversationId.length > 0
      ? JSON.stringify({ conversation: req.conversationId })
      : // `?? null` because `JSON.stringify` **omits** a property whose value is
        // `undefined`, so an empty `input` silently reduced the hash to the
        // instructions alone — and with no system prompt either, to one
        // constant shared by every such request on the installation.
        // Reachable: `validateRequest` drops a message left empty after an
        // orphaned tool result is stripped, and the ingress non-empty guard
        // runs before that, so one crafted request empties `messages` on both
        // surfaces. Such a request has no prefix worth caching, so the
        // remaining collision between two of them costs nothing; what matters
        // is that the term stops vanishing without a trace.
        JSON.stringify({ instructions, firstInput: firstInput ?? null });
  return { key: threadIdFrom(seed), seed };
}

/**
 * Answers any tool call the history left unanswered.
 *
 * The Codex backend refuses an `input` array holding a `function_call` with no
 * matching `function_call_output`, and a turn interrupted after the model asked
 * for a tool but before the client ran it produces exactly that. The call is
 * real history, so it is completed with an empty output rather than dropped —
 * removing it would rewrite what the model said.
 *
 * IR strips orphaned tool *results* in `validateRequest`; nothing strips or
 * completes an orphaned *call*, which is why this sits here.
 *
 * `function_call` is the only type it looks for, and that is a fact about this
 * encoder rather than about the API: IR has one `toolUse` block, so a tool the
 * client declared freeform is flattened to a function call here exactly as its
 * declaration is flattened to a function tool. Teaching this encoder to emit
 * `custom_tool_call` means teaching this function `custom_tool_call_output` in
 * the same change — a review read the older wording as a claim that both were
 * already handled, which is the failure a comment broader than its code causes.
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

export type WireOptions = {
  /**
   * The Codex backend is a narrower surface than `api.openai.com`: it drives
   * one product and rejects several standard Responses parameters outright.
   * It is also the leg that presents itself as Codex 0.163.0, so everything in
   * the fingerprint spec happens only when this is set.
   */
  oauth: boolean;
  /** Seeds history ids that are fresh per request. OAuth leg only. */
  requestId?: string | undefined;
  /** When the request started, epoch ms: turn metadata and `create_time`. */
  startedAt?: number | undefined;
  /** The ChatGPT account the credential bills, which the installation id hashes. */
  accountId?: string | undefined;
};

/**
 * The reasoning block Codex sends, from the client's reasoning request.
 *
 * Codex always sends an effort, so every mode maps onto one: the client's own
 * effort as sent today; nothing named, or a token budget this API cannot
 * spell, the model's catalog default; `off` and `betweenTools` the lowest
 * level the model supports, since `none` is in no current model's list.
 * `summary` keeps the rule the API-key leg has — sent for a client reasoning
 * request unless its display is `omitted` or `updates` — and `context` is
 * `all_turns` whenever the model is lite, as Codex's `build_reasoning` writes.
 */
function codexReasoning(
  req: ChatRequest,
  model: string,
  note: (d: string) => void,
): { effort: string; summary?: string; context?: string } {
  const catalog = codexModel(model);
  const context = catalog.lite ? { context: "all_turns" } : {};
  const r = req.reasoning;
  if (r === undefined) return { effort: catalog.defaultEffort, ...context };
  if (r.mode === "off") {
    note("openai:reasoning-off-as-lowest");
    return { effort: catalog.lowestEffort, ...context };
  }
  if (r.mode === "betweenTools") return { effort: catalog.lowestEffort, ...context };
  if (r.mode === "budget") {
    note("openai:reasoning-budget-dropped");
    return { effort: catalog.defaultEffort, ...context };
  }
  return {
    effort: r.effort ?? catalog.defaultEffort,
    ...(r.display === "omitted" || r.display === "updates" ? {} : { summary: "auto" }),
    ...context,
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The client's vendor bag, merged onto a Codex-shaped body.
 *
 * `client_metadata` is always this leg's: a Codex client's own map carries its
 * real installation id, which would go upstream unhashed and contradict the
 * turn-metadata header, so it is dropped and the drop recorded. `text` and
 * `reasoning` merge per field, the client winning each — a client `text.format`
 * keeps Codex's `verbosity`, a client `reasoning.effort` keeps `context`. Every
 * other key is the whole-value merge the API-key leg does.
 */
function mergeCodexVendor(
  body: ResponsesBody,
  vendor: Record<string, unknown>,
  note: (d: string) => void,
): void {
  // Untyped view: a client may put anything under any key, `reasoning` included.
  const target: Record<string, unknown> = body;
  for (const [name, value] of Object.entries(vendor)) {
    if (name === "client_metadata") {
      note("openai:client-metadata-replaced");
      continue;
    }
    const ours = target[name];
    if ((name === "text" || name === "reasoning") && isRecord(ours) && isRecord(value)) {
      target[name] = { ...ours, ...value };
      continue;
    }
    target[name] = value;
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
  /** Defaults to the permissive API so only the OAuth path is constrained. */
  opts: WireOptions = { oauth: false },
): { body: ResponsesBody; degradations: string[]; cacheKey: string; codex?: CodexTurn } {
  const degradations: string[] = [];
  const input: unknown[] = [];

  const note = (d: string): void => {
    if (!degradations.includes(d)) degradations.push(d);
  };

  // The user turn each item belongs to, for the OAuth leg's turn ids. Codex's
  // boundary: a user message that is not only tool results opens a turn, and a
  // tool result answers the turn that asked for it even when new text follows
  // it in the same message.
  const turnOf = new WeakMap<object, number>();
  let turn = -1;
  const push = (item: object): void => {
    input.push(item);
    turnOf.set(item, Math.max(0, turn));
  };

  // There is no beta mechanism here, so a client asking for the 1M window is
  // not refused, it is simply not honoured. Recorded because the silence is the
  // dangerous part: the client keeps pacing itself against a megabyte while
  // this target caps far lower, and the request that finally exceeds it fails
  // with nothing in the log explaining why.
  if (req.betas?.includes(CONTEXT_1M_BETA)) note("openai:context-1m-dropped");

  for (const message of req.messages) {
    const parts: unknown[] = [];

    // The backend refuses a `system` turn inside `input` — it supplies its own —
    // so a mid-conversation operator turn goes as `developer`, which is this
    // dialect's role for exactly that. It keeps both its position and its
    // operator standing, where the `<system-reminder>` user turn this replaced
    // kept only the position; it also stays inside the cacheable prefix, which
    // a rewritten user turn did not.
    //
    // Measured against the live Codex backend on 2026-09-02, not inferred: the
    // same request sent twice, differing only in this role, came back 200 with
    // nine events and `response.completed` both times. The OAuth leg is the one
    // that was probed, and it is the narrower of the two hosts — `api.openai.com`
    // documents the role.
    //
    // Recorded as a degradation still, because the role is not the one the
    // client wrote. Rows written before the rename carry
    // `openai:system-turn-inlined` and stay readable: degradations are
    // forensic text, never parsed on read.
    const asDeveloper = message.role === "system";
    if (asDeveloper) note("openai:system-turn-as-developer");
    const role = asDeveloper ? "developer" : message.role;

    const flush = (): void => {
      if (parts.length === 0) return;
      push({ type: "message", role, content: [...parts] });
      parts.length = 0;
    };

    let opened = false;
    for (const block of message.content) {
      if (message.role === "user" && !opened && block.type !== "toolResult") {
        opened = true;
        turn++;
      }
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
          if (!degradations.includes("openai:thinking-dropped")) {
            note("openai:thinking-dropped");
          }
          break;
        case "toolUse":
          flush();
          push({
            type: "function_call",
            call_id: block.id,
            name: block.name,
            arguments: JSON.stringify(block.input),
          });
          break;
        case "toolResult": {
          // Unreachable: the router pins a result's native parts to their producer.
          if (block.native !== undefined) note("openai:anthropic-native-block-dropped");
          flush();
          const files = responsesFiles(block.files ?? []);
          push({
            type: "function_call_output",
            call_id: block.toolUseId,
            output: withFileText(block.content, files.text),
          });
          // `output` stays text; the result's images go as input parts of the
          // following Responses message, and the move is recorded.
          if (block.images !== undefined) {
            note("openai:tool-result-images-moved");
            for (const image of block.images) {
              parts.push({
                type: "input_image",
                image_url: `data:${image.mediaType};base64,${image.data}`,
              });
            }
          }
          // Its files go the same way, as `input_file` data URLs, where the
          // backend takes their type.
          if (files.parts.length > 0) {
            note("openai:tool-result-files-moved");
            parts.push(...files.parts);
          }
          if (files.text.length > 0) note("openai:tool-result-files-inlined");
          if (files.dropped) note("openai:files-dropped");
          break;
        }
        case "providerNative":
          if (block.provider === "openai") {
            // This provider's own item, going home. `id` is deliberately left
            // behind: under `store: false` the backend can resolve no
            // server-assigned id, and an item still carrying one is rejected
            // outright. What continuity needs is the payload — for a reasoning
            // item, `encrypted_content` — which is never decrypted, inspected
            // or regenerated on the way through.
            flush();
            const { id: _id, ...rest } = block.data;
            push({ type: block.blockType, ...rest });
            break;
          }
          // Another provider's. Unreachable in practice, since the router
          // excludes this provider from any request carrying one, and recorded
          // rather than ignored so that if it ever does arrive the request log
          // says what was lost instead of the client seeing a turn quietly
          // rewritten.
          note("openai:anthropic-native-block-dropped");
          break;
      }
    }
    flush();
  }

  repairOrphanedCalls(input);

  const body: ResponsesBody = { model, input, stream: req.stream, store: false };

  const instructions = systemText(req.system, "openai", note);
  // Codex 0.163 sends base instructions inside `input` on every request, and,
  // for a lite model, its tools too; the API-key leg keeps both body fields.
  const lite = opts.oauth && codexModel(model).lite;
  if (instructions !== undefined && instructions.length > 0 && !opts.oauth) {
    body.instructions = instructions;
  }

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
  let liteTools: unknown[] | undefined;
  if (req.tools !== undefined) {
    // Same reasoning as the native block above: an Anthropic-defined tool has
    // no function schema to send, and the router never routes one here.
    const custom = req.tools.filter((t) => t.kind === "portable");
    if (custom.length !== req.tools.length) note("openai:anthropic-tool-dropped");
    if (lite) {
      // Codex's `ResponsesTool` for a function, `strict` included. They go in
      // one `functions` namespace inside `additional_tools`; the backend
      // returns calls from it with no `namespace`, so the decoder is unchanged.
      liteTools = custom.map((t) => ({
        type: "function",
        name: t.name,
        description: t.description,
        strict: false,
        parameters: t.inputSchema,
      }));
    } else {
      body.tools = custom.map((t) => ({
        type: "function",
        name: t.name,
        description: t.description,
        parameters: t.inputSchema,
      }));
    }
  }
  if (req.toolChoice !== undefined) body.tool_choice = encodeToolChoice(req.toolChoice);
  else if (opts.oauth) body.tool_choice = "auto";
  // Codex sends `false` whenever the model is lite. Behaviour-changing — one
  // tool call per turn for every client on this leg — and the operator's
  // decision: exact over behaviour-preserving (spec, Decided).
  if (lite) body.parallel_tool_calls = false;
  if (req.reasoning?.mode === "betweenTools")
    degradations.push("openai:reasoning-between-tools-as-off");
  if (opts.oauth) {
    body.reasoning = codexReasoning(req, model, note);
  } else if (
    req.reasoning !== undefined &&
    req.reasoning.mode !== "off" &&
    req.reasoning.mode !== "betweenTools"
  ) {
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
      body.reasoning = {
        effort,
        ...(req.reasoning.display === "omitted" || req.reasoning.display === "updates"
          ? {}
          : { summary: "auto" }),
      };
    }
  }

  const { key, seed } = cacheKey(req, instructions ?? "", input[0]);

  if (opts.oauth) {
    // Codex's defaults for every request, which a client's own bag values
    // still override below.
    body.include = ["reasoning.encrypted_content"];
    body.text = { verbosity: codexModel(model).verbosity };
    mergeCodexVendor(body, req.vendor?.openai ?? {}, note);
  } else {
    Object.assign(body, req.vendor?.openai ?? {});
  }

  // **The merge above copies `response_format` in, and this API refuses it** —
  // `Unsupported parameter: response_format`, measured 2026-09-21. It is the
  // Chat Completions spelling; the Responses API takes `text.format`. Shared
  // with the other two Responses encoders, which had the same field to move.
  const moved = moveToResponsesText(req, body, "openai");
  if (moved !== undefined) note(moved);

  // Written **after** the vendor merge, and the order is the whole point. The
  // merge copies the client's bag verbatim, including a `prompt_cache_key` that
  // `suppliedKey` already rejected — an empty string, a number — so assigning
  // first let the merge put the rejected value back. On the OAuth leg the
  // header still carried the resolved key and the damage was invisible; on the
  // API-key leg this field is the only mechanism there is, so the request went
  // out with the useless value and nothing recorded it.
  body.prompt_cache_key = key;
  if (!opts.oauth) return { body, degradations, cacheKey: key };

  // Base instructions go into `input` lite or not (0.163 removed the body
  // field); `liteTools` is set only when the model is lite.
  const built = toLiteInput({
    threadId: key,
    input,
    turnOf,
    tools: liteTools,
    instructions,
    requestId: opts.requestId,
    startedAt: opts.startedAt,
  });
  body.input = built.input;
  // The effort actually sent, after the client's bag had its say.
  const sent = body.reasoning?.effort;
  const codex = codexTurn({
    threadId: key,
    turnId: built.turnId,
    installationSeed: opts.accountId ?? seed,
    model,
    effort: typeof sent === "string" ? sent : codexModel(model).defaultEffort,
    startedAt: built.startedAt,
  });
  body.client_metadata = codex.clientMetadata;
  return { body, degradations, cacheKey: key, codex };
}

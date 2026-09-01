/**
 * Which provider serves a request.
 *
 * A string, not a union of the six that ship in the box. A provider loaded from
 * `<root>/plugins/` at boot has an id that no compiled-in union could contain,
 * and this type appears in the request shape itself — `vendor` is keyed by it —
 * so a closed union here is a closed door there.
 *
 * The exhaustiveness this gave up was real and is not replaced by anything
 * equally strong. Stated exactly, because an earlier version of this comment
 * claimed more than holds and outlived the retraction in four other files:
 *
 * - Every field on `ProviderDescriptor` is required with no defaults, so a
 *   descriptor that *exists* but is incomplete does not compile. That much the
 *   compiler still does.
 * - A provider **missing** from one of the id-keyed tables is not a compile
 *   error. Five of them are hand-written literals typed `Record<string, …>`,
 *   which accepts any subset; only `PROVIDERS` is assembled by walking another.
 *   Deleting a built-in's line from any of the five typechecks cleanly —
 *   measured. The unused-import lint and
 *   `packages/providers/test/descriptor.test.ts` are what catch it.
 * - A lookup keyed on a *stored* id — a target read back from SQLite naming a
 *   provider no longer installed — is genuinely partial, and
 *   `noUncheckedIndexedAccess` makes each of those a compile error at the point
 *   of use. Lean on that rather than casting it away.
 *
 * The format rule lives in `@omni/providers`, next to the registry that enforces
 * it. It is not expressed here because `@omni/ir` must not know what a provider
 * is, only that a request names one.
 */
export type ProviderId = string;

/**
 * A caller-placed cache breakpoint, in the only shape providers accept.
 *
 * Modelled as a value rather than a boolean because the TTL is part of what the
 * caller asked for: a marker rendered without its `1h` silently buys a
 * five-minute cache. The union is closed on purpose — this is caller intent the
 * gateway forwards, not free-form metadata it carries.
 */
export type CacheControl = { type: "ephemeral"; ttl?: "5m" | "1h" };

export type TextBlock = {
  type: "text";
  text: string;
  cacheControl?: CacheControl;
  /** Anthropic citation payloads, preserved verbatim when present. */
  citations?: unknown[];
};
export type ImageBlock = {
  type: "image";
  mediaType: string;
  data: string;
  cacheControl?: CacheControl;
};
export type ThinkingBlock = { type: "thinking"; text: string; signature?: string };
export type ToolUseBlock = {
  type: "toolUse";
  id: string;
  name: string;
  input: unknown;
  cacheControl?: CacheControl;
};
/**
 * `content` is flattened text, not blocks.
 *
 * Anthropic accepts blocks here; OpenAI's `function_call_output` and Kimi's
 * `tool` message both take a plain string. Carrying blocks would mean the IR
 * models something two of three providers cannot express, so ingress flattens
 * once (Task 16) and every encoder passes the string straight through. The
 * cost is images inside a tool result, which no provider in this set accepts
 * anyway.
 */
export type ToolResultBlock = {
  type: "toolResult";
  toolUseId: string;
  content: string;
  isError?: boolean;
  cacheControl?: CacheControl;
};

/**
 * A content block one provider owns end to end, carried through unread.
 *
 * Server tool use, web-search and web-fetch results, code-execution output,
 * tool-search references, advisor results and MCP server-tool blocks are all
 * produced by one provider and replayed to it. Their payloads carry citations,
 * container state, caller metadata and signatures the gateway has no business
 * rewriting, and no other provider can express them — so the canonical form
 * holds the discriminator it needs to route on and keeps the rest of the payload
 * byte-identical.
 *
 * **`provider` is what makes the routing rule generic.** A block records who
 * produced it, and the router admits only targets of that provider. That is one
 * comparison against the block's own data, and it replaced both a
 * `target.provider === "anthropic"` test inside the pure router and a
 * `Record<ProviderId, boolean>` table in this file listing who could accept
 * Anthropic's dialect. Today Anthropic is the only producer; nothing about the
 * shape says so.
 *
 * Deliberately *not* a `toolUse`/`toolResult` pair: those two are the portable
 * shape, and they are the ones that enter tool-id correlation, orphan removal,
 * cross-provider translation and RTK compression. A native block does none of
 * that. Folding the two together would mean the gateway invents an `id` for a
 * block the provider already identified, or drops a result whose matching use it
 * never registered.
 */
export type ProviderNativeBlock = {
  type: "providerNative";
  /** Which provider produced it, and therefore the only one that may receive it. */
  provider: ProviderId;
  /** The provider's own `type` string, e.g. `server_tool_use`. Never normalized. */
  blockType: string;
  /** The whole wire object minus `type`, structurally intact. */
  data: Record<string, unknown>;
  cacheControl?: CacheControl;
};

export type ContentBlock =
  | TextBlock
  | ImageBlock
  | ThinkingBlock
  | ToolUseBlock
  | ToolResultBlock
  | ProviderNativeBlock;

/**
 * Reads a block's cache breakpoint without every caller narrowing the union.
 *
 * A thinking block cannot carry one — Anthropic rejects a marker there — so its
 * absence is a property of the type, not a case someone forgot.
 */
export function cacheControlOf(block: ContentBlock): CacheControl | undefined {
  return block.type === "thinking" ? undefined : block.cacheControl;
}

/**
 * `system` is a mid-conversation operator instruction, distinct from the
 * top-level `system` prompt on `ChatRequest`.
 *
 * It applies from its position in the conversation forward, which is why it
 * cannot be folded into the request-level prompt: doing so would move the
 * instruction to the front of the history, change when it takes effect, and
 * invalidate the provider's cached prefix. It is also the channel a caller uses
 * when the instruction must carry operator authority — text placed in a user
 * turn can be forged by anything that writes user-visible input.
 *
 * Every provider in this set accepts a system turn inside the message array, so
 * this stays provider-neutral. Which *models* accept one is the upstream's rule
 * to enforce, not the gateway's.
 */
export type Message = { role: "user" | "assistant" | "system"; content: ContentBlock[] };

/**
 * A portable tool: a name, a description and a JSON Schema every provider in
 * this set can express. Unchanged in meaning from when it was the only shape.
 *
 * The discriminant is `kind`, and it used to be `provider: "custom"` — the same
 * string as the `custom` **provider id**, meaning something else entirely. Two
 * core sites wrote `provider: "custom"` as this tool-kind tag
 * (`apps/gateway/src/ingress/openai.ts`, `packages/control/src/dryRun.ts`), so a
 * grep for the custom provider found both and was wrong about both. Once
 * `ProviderDefinedToolDef` below carries a real `ProviderId`, that collision
 * stops being merely confusing and starts being ambiguous, so the tag moved.
 */
export type CustomToolDef = {
  kind: "portable";
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  cacheControl?: CacheControl;
  /**
   * Anthropic-only definition options that do not change what the tool *is* —
   * `strict`, `defer_loading`, `input_examples` and friends. Carried so an
   * Anthropic target sees the request the client wrote, and ignored by the two
   * encoders that have no such fields, which is why they cannot cost
   * portability.
   */
  options?: Record<string, unknown>;
};

/**
 * The conceptual families Anthropic defines. Named rather than versioned
 * because a family is stable across the dated `type` strings inside it, and
 * routing and capability questions are asked of the family, never the date.
 */
export type AnthropicToolFamily =
  | "webSearch"
  | "webFetch"
  | "codeExecution"
  | "bash"
  | "textEditor"
  | "computer"
  | "memory"
  | "toolSearchRegex"
  | "toolSearchBm25"
  | "advisor"
  | "mcpToolset";

/**
 * A tool whose schema Anthropic owns.
 *
 * The version is the contract: `bash_20241022` and `bash_20250124` are
 * different tools with different inputs, so `type` is carried exactly as the
 * caller wrote it and is never upgraded on their behalf. `name` is fixed by
 * Anthropic per type and validated at ingress rather than defaulted, because a
 * mismatched pair is a request the client got wrong, not one to repair.
 */
export type AnthropicToolDef = {
  kind: "provider";
  /** Whose schema this is, and therefore the only provider that may receive it. */
  provider: ProviderId;
  family: AnthropicToolFamily;
  /** Exact versioned wire `type`. */
  type: string;
  /** The fixed name Anthropic pairs with `type`. */
  name: string;
  /** Every other validated wire field, verbatim, minus `type` and `name`. */
  wire: Record<string, unknown>;
  cacheControl?: CacheControl;
};

export type ToolDef = CustomToolDef | AnthropicToolDef;

/**
 * Tagged rather than a bare string union, so every encoder can `switch` on
 * `.type` and have the compiler prove all four cases are handled. The wire
 * spellings differ per provider — Anthropic says `any`, OpenAI says
 * `required` — so neither vendor's word is used as the canonical name.
 */
export type ToolChoice =
  | { type: "auto" }
  | { type: "any" }
  | { type: "none" }
  | { type: "tool"; name: string };

/**
 * The effort levels providers publish, not the intersection of them.
 *
 * Mirrors the widest official ladder (`none` through `max`, as OpenAI's
 * reasoning models define it); a provider that rejects a level surfaces that
 * as an upstream error rather than having the gateway pre-clamp the client's
 * choice. `none` tunes adaptive thinking to zero depth on models that support
 * it — distinct from `{mode:"off"}`, which asks every destination to not think.
 *
 * Ingresses validate against this constant rather than hand-listing values,
 * so the next ladder widening cannot desync a copy of it.
 */
export const REASONING_EFFORTS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

/**
 * How much the model should think, in the three shapes providers actually
 * offer.
 *
 * `adaptive` lets the model decide per request and is the current form; effort
 * tunes its depth. `budget` is the older fixed-token form, kept because a
 * client may still ask for it — but it is never synthesized, since providers
 * have started rejecting it outright. `off` is an explicit opt-out, which is
 * not the same as omitting reasoning entirely: several models think by default,
 * so silently dropping the opt-out would turn thinking back on.
 */
export type ReasoningConfig =
  | { mode: "adaptive"; effort?: ReasoningEffort; display?: "summarized" | "omitted" }
  | { mode: "budget"; budgetTokens: number }
  | { mode: "off" };

export type ChatRequest = {
  model: string;
  system?: ContentBlock[];
  messages: Message[];
  tools?: ToolDef[];
  toolChoice?: ToolChoice;
  maxTokens?: number;
  temperature?: number;
  stopSequences?: string[];
  stream: boolean;
  reasoning?: ReasoningConfig;
  vendor?: Record<string, Record<string, unknown>>;
  /**
   * Beta feature names the client opted into, verbatim.
   *
   * A beta is two halves: a body field and a header naming the beta. `vendor`
   * carries the field, and this carries the name, because a gateway that
   * forwards one without the other produces an upstream 400 on a request the
   * client had every right to make. Adapters decide what to do with the list;
   * a provider with no such mechanism ignores it.
   */
  betas?: string[];
  /**
   * The client's own name for the conversation this request belongs to.
   *
   * On the request rather than beside it — the distinction `autoCacheEnabled`
   * draws in the other direction — because it is the caller's value, not a
   * gateway decision. It is filled from Anthropic's `metadata.session_id`, and
   * from nothing else today.
   *
   * Only a **conversation**-scoped id belongs here. An identifier naming the
   * user, the account or the machine — `metadata.user_id`, `metadata.device_id`,
   * OpenAI's `user` — is deliberately not read: an adapter keying cache
   * affinity on one would merge every conversation on an installation into a
   * single partition.
   *
   * Opaque and never interpreted. An adapter that wants cache affinity derives
   * a key from it; one with no such mechanism ignores it. It is **not** safe to
   * forward verbatim — it is a client identifier the operator never chose to
   * disclose — so a provider-facing value is hashed.
   * `packages/providers/src/openai/wire.ts` is the worked example.
   */
  conversationId?: string;
};

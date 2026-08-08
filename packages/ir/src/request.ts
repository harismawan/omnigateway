export type ProviderId = "anthropic" | "openai" | "kimi";

export type TextBlock = { type: "text"; text: string; cacheBreakpoint?: boolean };
export type ImageBlock = { type: "image"; mediaType: string; data: string };
export type ThinkingBlock = { type: "thinking"; text: string; signature?: string };
export type ToolUseBlock = { type: "toolUse"; id: string; name: string; input: unknown };
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
};

export type ContentBlock = TextBlock | ImageBlock | ThinkingBlock | ToolUseBlock | ToolResultBlock;

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

export type ToolDef = {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
};

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

export type ReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max";

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
  vendor?: Partial<Record<ProviderId, Record<string, unknown>>>;
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
};

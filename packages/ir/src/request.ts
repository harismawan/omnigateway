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

export type Message = { role: "user" | "assistant"; content: ContentBlock[] };

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

export type ReasoningConfig = { effort: "low" | "medium" | "high"; budgetTokens?: number };

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
};

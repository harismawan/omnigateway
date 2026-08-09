import type { CacheControl, ChatRequest, ContentBlock, ToolChoice } from "@omni/ir";
import { cacheControlOf } from "@omni/ir";

export const OAUTH_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";

type WireCacheControl = { type: "ephemeral"; ttl?: "5m" | "1h" };

export type AnthropicBody = {
  model: string;
  messages: unknown[];
  system?: { type: "text"; text: string; cache_control?: WireCacheControl }[];
  max_tokens: number;
  stream: boolean;
  temperature?: number;
  stop_sequences?: string[];
  tools?: {
    name: string;
    description?: string;
    input_schema: unknown;
    cache_control?: WireCacheControl;
  }[];
  tool_choice?: unknown;
  thinking?:
    | { type: "adaptive"; display?: "summarized" | "omitted" }
    | { type: "enabled"; budget_tokens: number }
    | { type: "disabled" };
  output_config?: Record<string, unknown>;
  [key: string]: unknown;
};

/**
 * Renders a caller's breakpoint, omitting a TTL it did not ask for.
 *
 * Sending `ttl` explicitly would pin the request to one duration; leaving it
 * off is what asks for the provider's default.
 */
function wireCacheControl(c: CacheControl | undefined): { cache_control?: WireCacheControl } {
  if (c === undefined) return {};
  return { cache_control: { type: c.type, ...(c.ttl === undefined ? {} : { ttl: c.ttl }) } };
}

function encodeBlock(b: ContentBlock): unknown {
  const cache = wireCacheControl(cacheControlOf(b));
  switch (b.type) {
    case "text":
      return { type: "text", text: b.text, ...cache };
    case "image":
      return {
        type: "image",
        source: { type: "base64", media_type: b.mediaType, data: b.data },
        ...cache,
      };
    case "thinking":
      return { type: "thinking", thinking: b.text, signature: b.signature };
    case "toolUse":
      return { type: "tool_use", id: b.id, name: b.name, input: b.input, ...cache };
    case "toolResult":
      return {
        type: "tool_result",
        tool_use_id: b.toolUseId,
        content: b.content,
        is_error: b.isError,
        ...cache,
      };
  }
}

/**
 * Flattens a mid-conversation system turn to the plain string the API
 * documents for it. That role is text-only on the wire, and a string is the
 * shape Anthropic's own examples use; whether it also accepts a block array
 * there is unstated, so this takes the form that is known to work.
 */
function encodeSystemTurn(content: ContentBlock[]): string {
  return content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n");
}

function encodeToolChoice(c: ToolChoice): unknown {
  switch (c.type) {
    case "auto":
      return { type: "auto" };
    case "any":
      return { type: "any" };
    case "none":
      return { type: "none" };
    case "tool":
      return { type: "tool", name: c.name };
  }
}

export function toWire(
  req: ChatRequest,
  model: string,
  opts: { oauth: boolean },
): { body: AnthropicBody; degradations: string[] } {
  const degradations: string[] = [];

  let system = req.system?.flatMap((b) =>
    b.type === "text"
      ? [{ type: "text" as const, text: b.text, ...wireCacheControl(b.cacheControl) }]
      : [],
  );

  // The OAuth token endpoint rejects requests whose first system block is not
  // this string. It is a functional requirement of the credential, not a
  // disguise: the User-Agent still identifies this gateway. Recorded as a
  // degradation so it is visible in the request log.
  if (opts.oauth && system?.[0]?.text !== OAUTH_IDENTITY) {
    system = [{ type: "text" as const, text: OAUTH_IDENTITY }, ...(system ?? [])];
    degradations.push("anthropic:oauth-system-prefix");
  }

  const body: AnthropicBody = {
    model,
    messages: req.messages.map((m) => {
      if (m.role !== "system") return { role: m.role, content: m.content.map(encodeBlock) };
      // Flattening to a string has nowhere to put a block-level breakpoint, so
      // one the caller placed here is lost. Record it rather than let a caching
      // intent disappear between the request log and the upstream body.
      if (m.content.some((b) => cacheControlOf(b) !== undefined)) {
        degradations.push("anthropic:system-turn-cache-control-dropped");
      }
      return { role: m.role, content: encodeSystemTurn(m.content) };
    }),
    max_tokens: req.maxTokens ?? 4096,
    stream: req.stream,
  };

  if (system !== undefined && system.length > 0) body.system = system;
  if (req.temperature !== undefined) body.temperature = req.temperature;
  if (req.stopSequences !== undefined) body.stop_sequences = req.stopSequences;
  if (req.tools !== undefined) {
    body.tools = req.tools.map((t) => ({
      name: t.name,
      ...(t.description === undefined ? {} : { description: t.description }),
      input_schema: t.inputSchema,
      ...wireCacheControl(t.cacheControl),
    }));
  }
  if (req.toolChoice !== undefined) body.tool_choice = encodeToolChoice(req.toolChoice);
  if (req.reasoning !== undefined) {
    switch (req.reasoning.mode) {
      case "adaptive":
        body.thinking = {
          type: "adaptive",
          ...(req.reasoning.display === undefined ? {} : { display: req.reasoning.display }),
        };
        // Depth is an output-level control here, not a thinking-level one.
        if (req.reasoning.effort !== undefined) {
          body.output_config = { ...(body.output_config ?? {}), effort: req.reasoning.effort };
        }
        break;
      case "budget":
        // Only ever sent because a client asked for it by name. Current models
        // reject this form, so it is never synthesized from an effort level.
        body.thinking = { type: "enabled", budget_tokens: req.reasoning.budgetTokens };
        break;
      case "off":
        body.thinking = { type: "disabled" };
        break;
    }
  }

  // Vendor passthrough is applied last: an operator setting a raw Anthropic
  // field is stating an explicit intent that outranks our mapping.
  Object.assign(body, req.vendor?.anthropic ?? {});

  return { body, degradations };
}

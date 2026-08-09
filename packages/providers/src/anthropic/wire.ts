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

/**
 * Whether a thinking block can be replayed to Anthropic at all.
 *
 * A signature is minted by Anthropic over the reasoning it produced, and the
 * upstream verifies it on every later turn that carries the block. Reasoning
 * that came from another provider has none — the OpenAI decoder turns a
 * reasoning summary into a thinking block, and a client that stores the
 * assistant turn replays it here when the operator switches models. Forwarding
 * it fails the whole request with `Invalid \`signature\` in \`thinking\``, so
 * the block is dropped instead and the loss is recorded.
 */
function isReplayableThinking(b: ContentBlock): boolean {
  return b.type !== "thinking" || (b.signature !== undefined && b.signature !== "");
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

function systemCacheControl(req: ChatRequest): {
  promoted?: CacheControl;
  lost: boolean;
} {
  const cacheable = req.messages.flatMap((message) =>
    message.content.flatMap((block) =>
      block.type === "thinking" ? [] : [{ role: message.role, block }],
    ),
  );
  const markedSystemBlocks = cacheable.filter(
    ({ role, block }) => role === "system" && cacheControlOf(block) !== undefined,
  );
  const final = markedSystemBlocks.at(-1);
  const promoted =
    final !== undefined && final.block.type === "text" && cacheable.at(-1) === final
      ? cacheControlOf(final.block)
      : undefined;
  return {
    ...(promoted === undefined ? {} : { promoted }),
    lost: markedSystemBlocks.length > (promoted === undefined ? 0 : 1),
  };
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
  // A degradation names something the request lost, not how many times the
  // encoder noticed; the other two encoders dedupe the same way.
  const note = (d: string): void => {
    if (!degradations.includes(d)) degradations.push(d);
  };

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
    note("anthropic:oauth-system-prefix");
  }

  const systemCache = systemCacheControl(req);
  if (systemCache.lost) note("anthropic:system-turn-cache-control-dropped");
  const body: AnthropicBody = {
    model,
    messages: req.messages.flatMap((m): { role: string; content: unknown }[] => {
      if (m.role !== "system") {
        const replayable = m.content.filter(isReplayableThinking);
        if (replayable.length !== m.content.length) note("anthropic:unsigned-thinking-dropped");
        // A turn whose only content was unsignable reasoning has nothing left
        // to say. Anthropic rejects an empty content array, so the message goes
        // rather than being sent as one.
        if (replayable.length === 0) return [];
        return [{ role: m.role, content: replayable.map(encodeBlock) }];
      }
      return [{ role: m.role, content: encodeSystemTurn(m.content) }];
    }),
    max_tokens: req.maxTokens ?? 4096,
    stream: req.stream,
    ...(systemCache.promoted === undefined
      ? {}
      : {
          cache_control: {
            type: systemCache.promoted.type,
            ...(systemCache.promoted.ttl === undefined ? {} : { ttl: systemCache.promoted.ttl }),
          },
        }),
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

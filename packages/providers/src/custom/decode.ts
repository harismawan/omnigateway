import {
  type ErrorCode,
  RETRYABLE,
  type StopReason,
  type StreamEvent,
  usageFromPromptTotal,
} from "@omni/ir";
import type { SseMessage } from "../sse.ts";

/**
 * Custom's own stream decoders, one per protocol.
 *
 * Forked, not shared, for the same reason the wire codecs are: an adapter that
 * can be lifted into a standalone plugin carries no other provider with it.
 * The chat decoder starts from Kilo's rather than Kimi's because a custom
 * server may reason in any of the spellings OpenRouter normalizes, and those
 * deltas must reach the client as thinking rather than vanish. The responses
 * decoder starts from OpenAI's unchanged.
 */

const CHAT_FINISH: Readonly<Record<string, StopReason>> = {
  stop: "endTurn",
  length: "maxTokens",
  tool_calls: "toolUse",
  content_filter: "contentFilter",
};

/** The subset of the chat completions SSE payload shapes this decoder reads. */
type ChatChunk = {
  id?: string;
  model?: string;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    /** The OpenAI-compatible spelling, which is what this surface uses. */
    prompt_tokens_details?: {
      cached_tokens?: number;
      cache_creation_tokens?: number;
      cache_write_tokens?: number;
    };
    /** The DeepSeek-family spelling, kept as a fallback. */
    prompt_cache_hit_tokens?: number;
  };
  choices?: {
    delta?: ChatDelta;
    finish_reason?: string;
  }[];
};

/**
 * One delta, including the three spellings this family has shipped reasoning
 * under. All three are read because a custom server may be proxied or native,
 * and the spelling follows whichever upstream produced the turn.
 */
type ChatDelta = {
  role?: string;
  content?: string;
  /** OpenRouter's normalized field: the reasoning text, already concatenated. */
  reasoning?: unknown;
  /** The DeepSeek-family spelling, which several compatible servers emit. */
  reasoning_content?: unknown;
  /** OpenRouter's structured form, sent alongside `reasoning` rather than instead of it. */
  reasoning_details?: unknown;
  tool_calls?: {
    index?: number;
    id?: string;
    function?: { name?: string; arguments?: string };
  }[];
};

/** A `reasoning_details` entry, of which only the readable shapes are used. */
type ReasoningDetail = { text?: unknown; summary?: unknown };

/**
 * The reasoning text carried by one delta, or `""` when it carries none.
 *
 * The three spellings are tried in order and the *first* non-empty one wins,
 * because OpenRouter sends `reasoning` and `reasoning_details` in the same
 * delta describing the same tokens — reading both would double the thinking.
 *
 * An entry of `reasoning_details` this decoder does not recognize — notably
 * `reasoning.encrypted`, whose `data` is an opaque vendor blob — contributes no
 * text and is not an error. That is a deliberate departure from the "unknown
 * shapes fail visibly" rule the Anthropic decoder follows: there, an unknown
 * block type means the response shape itself was misread, whereas here the
 * text, tool calls and usage of the turn are all still decoded correctly and
 * only a display-only field is missing. Erroring would throw away a good
 * response every time a server adds a field.
 */
function reasoningText(delta: ChatDelta): string {
  if (typeof delta.reasoning === "string" && delta.reasoning.length > 0) return delta.reasoning;
  if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) {
    return delta.reasoning_content;
  }
  if (!Array.isArray(delta.reasoning_details)) return "";
  return (delta.reasoning_details as ReasoningDetail[])
    .flatMap((entry): string[] => {
      if (entry === null || typeof entry !== "object") return [];
      if (typeof entry.text === "string" && entry.text.length > 0) return [entry.text];
      if (typeof entry.summary === "string" && entry.summary.length > 0) return [entry.summary];
      return [];
    })
    .join("");
}

function json<T>(data: string): T | null {
  try {
    const v: unknown = JSON.parse(data);
    return typeof v === "object" && v !== null ? (v as T) : null;
  } catch {
    return null;
  }
}

/** Folds a custom server's Chat Completions SSE stream into canonical events. */
export async function* decodeCustomChat(
  messages: AsyncGenerator<SseMessage> | AsyncIterable<SseMessage>,
): AsyncGenerator<StreamEvent, void, undefined> {
  let started = false;
  let done = false;
  let stopReason: StopReason = "endTurn";
  let usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  // Indices are assigned in first-seen order, whichever content type appears
  // first — the API can stream a tool call with no accompanying text.
  const toolIndex = new Map<number, number>();
  let nextIndex = 0;
  // One cursor over all three axes: at most one block is open at a time and it
  // closes before the next opens. An Anthropic-shaped egress renders these as
  // content_block_start / content_block_stop pairs and reproduces their order
  // verbatim, so a start arriving while another block is open is malformed on
  // that wire — the official SDK reports every content_block_stop against the
  // most recently started block, so an overlapping pair makes it announce the
  // later block twice and the earlier one never.
  //
  // Reasoning already closed before text or a tool call on this wire; folding
  // all three axes into one cursor extends that to the text/tool pair. Text
  // arriving after a tool call therefore opens a *second* text block rather
  // than reopening the first, matching what a model that returns to thinking
  // mid-turn already did.
  let openKind: "text" | "thinking" | "tool" | undefined;
  let openIndex = 0;

  for await (const msg of messages) {
    if (msg.data === "[DONE]") {
      done = true;
      break;
    }
    const d = json<ChatChunk>(msg.data);
    if (d === null) continue;

    // Not every chunk carries identity — only the first one from a real
    // upstream does. A chunk with neither is pure delta content, so waiting
    // for one avoids emitting a hollow start event ahead of the first block.
    if (!started && (d.id !== undefined || d.model !== undefined)) {
      started = true;
      yield { type: "start", id: String(d.id ?? ""), model: String(d.model ?? "") };
    }

    if (d.usage) {
      // `prompt_tokens` is the whole prompt, hits included; the IR wants the
      // miss remainder so pricing does not charge a hit at the input rate too.
      const details = d.usage.prompt_tokens_details;
      usage = usageFromPromptTotal(
        d.usage.prompt_tokens ?? 0,
        d.usage.completion_tokens ?? 0,
        details?.cached_tokens ?? d.usage.prompt_cache_hit_tokens ?? 0,
        details?.cache_creation_tokens ?? details?.cache_write_tokens ?? 0,
      );
    }

    const choice = d.choices?.[0];
    if (!choice) continue;
    const delta = choice.delta ?? {};

    // Reasoning leads the turn on this wire, and blocks stay strictly
    // sequential — one closes before the next opens. A model that returns to
    // thinking after some text simply opens a second thinking block.
    //
    // Never `signed`: any signature here was minted by another provider over
    // its own request, and replaying it at an Anthropic-shaped egress poisons
    // the conversation. Unsigned is the truthful claim: displayable, not
    // replayable.
    const reasoning = reasoningText(delta);
    if (reasoning.length > 0) {
      if (openKind !== "thinking") {
        if (openKind !== undefined) yield { type: "blockEnd", index: openIndex };
        openKind = "thinking";
        openIndex = nextIndex++;
        yield { type: "blockStart", index: openIndex, block: { type: "thinking" } };
      }
      yield {
        type: "blockDelta",
        index: openIndex,
        delta: { type: "thinking", text: reasoning },
      };
    }

    if (typeof delta.content === "string" && delta.content.length > 0) {
      if (openKind !== "text") {
        if (openKind !== undefined) yield { type: "blockEnd", index: openIndex };
        openKind = "text";
        openIndex = nextIndex++;
        yield { type: "blockStart", index: openIndex, block: { type: "text" } };
      }
      yield {
        type: "blockDelta",
        index: openIndex,
        delta: { type: "text", text: delta.content },
      };
    }

    for (const call of delta.tool_calls ?? []) {
      const wireIndex: number = call.index ?? 0;
      let index = toolIndex.get(wireIndex);
      if (index === undefined) {
        if (openKind !== undefined) yield { type: "blockEnd", index: openIndex };
        index = nextIndex++;
        toolIndex.set(wireIndex, index);
        openKind = "tool";
        openIndex = index;
        yield {
          type: "blockStart",
          index,
          block: {
            type: "toolUse",
            id: String(call.id ?? `call_${wireIndex}`),
            name: String(call.function?.name ?? ""),
          },
        };
      }
      // Argument fragments for one call arrive contiguously on this wire, so a
      // call stays open across the chunks that carry its own arguments and is
      // closed by whatever opens next. A fragment for a call closed earlier is
      // still emitted against its own index rather than reopening the block:
      // both consumers accumulate by index, and splitting one JSON document
      // across two blocks would hand the client arguments it cannot parse.
      const args = call.function?.arguments;
      if (typeof args === "string" && args.length > 0) {
        yield { type: "blockDelta", index, delta: { type: "toolJson", partial: args } };
      }
    }

    if (typeof choice.finish_reason === "string") {
      stopReason = CHAT_FINISH[choice.finish_reason] ?? "endTurn";
    }
  }

  // [DONE] is the transport-level success marker. A finish_reason carries stop
  // metadata but cannot certify that the stream arrived intact.
  if (done) {
    // Only the last block is still open; every earlier one was closed by the
    // block that superseded it.
    if (openKind !== undefined) yield { type: "blockEnd", index: openIndex };
    yield { type: "end", stopReason, usage };
  } else {
    yield {
      type: "error",
      code: "UPSTREAM",
      message: "upstream stream ended before [DONE]",
      retryable: RETRYABLE.UPSTREAM,
    };
  }
}

const RESPONSES_ERROR_CODE: Readonly<Record<string, ErrorCode>> = {
  rate_limit_exceeded: "RATE_LIMIT",
  insufficient_quota: "QUOTA_EXHAUSTED",
  invalid_api_key: "AUTH",
  server_error: "UPSTREAM",
  context_length_exceeded: "BAD_REQUEST",
  content_policy_violation: "CONTENT_FILTER",
};

type ErrorPayload = { code?: string; type?: string; message?: string };

/** The subset of the Responses API's SSE payload shapes this decoder reads. */
type ResponsesEvent = {
  response?: {
    id?: string;
    model?: string;
    status?: string;
    incomplete_details?: { reason?: string };
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      input_tokens_details?: { cached_tokens?: number };
      /** An OpenAI-compatible endpoint may use the chat-completions name. */
      prompt_tokens_details?: { cached_tokens?: number };
    };
    error?: ErrorPayload;
  };
  output_index?: number;
  content_index?: number;
  item?: { type?: string; call_id?: string; name?: string };
  part?: { type?: string };
  delta?: string;
  error?: ErrorPayload;
};

/** Folds a custom server's Responses SSE stream into canonical events. */
export async function* decodeCustomResponses(
  messages: AsyncGenerator<SseMessage> | AsyncIterable<SseMessage>,
): AsyncGenerator<StreamEvent, void, undefined> {
  // Responses addresses blocks by (output_index, content_index); the IR uses a
  // single flat index. Assign IR indices in first-seen order.
  const indices = new Map<string, number>();
  let next = 0;
  const irIndex = (outputIndex: number, contentIndex = 0): number => {
    const key = `${outputIndex}:${contentIndex}`;
    const existing = indices.get(key);
    if (existing !== undefined) return existing;
    const assigned = next++;
    indices.set(key, assigned);
    return assigned;
  };

  let sawToolCall = false;
  let terminal = false;
  // Output indices whose block was opened by `output_item.added` — reasoning
  // and function_call items. A message item is not in here: its block is opened
  // by content_part.added and closed by content_part.done, and both key the
  // same `${output_index}:0` slot, so `indices` alone cannot tell them apart.
  const ownsBlock = new Set<number>();

  for await (const msg of messages) {
    const d = json<ResponsesEvent>(msg.data);
    if (d === null) continue;

    switch (msg.event) {
      case "response.created":
        yield {
          type: "start",
          id: String(d.response?.id ?? ""),
          model: String(d.response?.model ?? ""),
        };
        break;

      case "response.output_item.added": {
        const item = d.item ?? {};
        if (item.type === "reasoning") {
          ownsBlock.add(d.output_index ?? 0);
          yield {
            type: "blockStart",
            index: irIndex(d.output_index ?? 0),
            block: { type: "thinking" },
          };
        } else if (item.type === "function_call") {
          sawToolCall = true;
          ownsBlock.add(d.output_index ?? 0);
          yield {
            type: "blockStart",
            index: irIndex(d.output_index ?? 0),
            block: { type: "toolUse", id: String(item.call_id), name: String(item.name) },
          };
        }
        // A message item emits nothing here; its content_part.added does.
        break;
      }

      case "response.content_part.added":
        if (d.part?.type === "output_text") {
          yield {
            type: "blockStart",
            index: irIndex(d.output_index ?? 0, d.content_index ?? 0),
            block: { type: "text" },
          };
        }
        break;

      case "response.output_text.delta":
        yield {
          type: "blockDelta",
          index: irIndex(d.output_index ?? 0, d.content_index ?? 0),
          delta: { type: "text", text: String(d.delta ?? "") },
        };
        break;

      case "response.reasoning_summary_text.delta":
        yield {
          type: "blockDelta",
          index: irIndex(d.output_index ?? 0),
          delta: { type: "thinking", text: String(d.delta ?? "") },
        };
        break;

      case "response.function_call_arguments.delta":
        yield {
          type: "blockDelta",
          index: irIndex(d.output_index ?? 0),
          delta: { type: "toolJson", partial: String(d.delta ?? "") },
        };
        break;

      case "response.content_part.done":
        yield { type: "blockEnd", index: irIndex(d.output_index ?? 0, d.content_index ?? 0) };
        break;

      case "response.output_item.done": {
        // Only close items that opened their own block. Closing a message item
        // here too would emit a second blockEnd for a block content_part.done
        // already closed — which reaches the client as a duplicate
        // content_block_stop. Deleting also makes a repeated done a no-op.
        const outputIndex = d.output_index ?? 0;
        if (ownsBlock.delete(outputIndex)) {
          yield { type: "blockEnd", index: irIndex(outputIndex) };
        }
        break;
      }

      case "response.completed":
      case "response.incomplete": {
        terminal = true;
        const r = d.response ?? {};
        const reason = r.incomplete_details?.reason;
        let stopReason: StopReason = sawToolCall ? "toolUse" : "endTurn";
        if (reason === "max_output_tokens") stopReason = "maxTokens";
        else if (reason === "content_filter") stopReason = "contentFilter";
        yield {
          type: "end",
          stopReason,
          // `input_tokens` includes the cached part; the IR wants it net.
          usage: usageFromPromptTotal(
            r.usage?.input_tokens ?? 0,
            r.usage?.output_tokens ?? 0,
            r.usage?.input_tokens_details?.cached_tokens ??
              r.usage?.prompt_tokens_details?.cached_tokens ??
              0,
          ),
        };
        break;
      }

      case "response.failed":
      case "error": {
        terminal = true;
        const err = d.response?.error ?? d.error ?? {};
        const code = RESPONSES_ERROR_CODE[String(err.code ?? err.type)] ?? "UPSTREAM";
        yield {
          type: "error",
          code,
          message: String(err.message ?? "upstream error"),
          retryable: RETRYABLE[code],
        };
        break;
      }

      default:
        break;
    }
  }

  if (!terminal) {
    yield {
      type: "error",
      code: "UPSTREAM",
      message: "upstream stream ended before response completion",
      retryable: RETRYABLE.UPSTREAM,
    };
  }
}

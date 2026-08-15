import { RETRYABLE, type StopReason, type StreamEvent, usageFromPromptTotal } from "@omni/ir";
import type { SseMessage } from "../sse.ts";

const FINISH: Readonly<Record<string, StopReason>> = {
  stop: "endTurn",
  length: "maxTokens",
  tool_calls: "toolUse",
  content_filter: "contentFilter",
};

/**
 * The subset of the chat completions SSE payload shapes this decoder reads.
 *
 * Forked from the Kimi decoder, not shared with it: Kilo proxies whatever its
 * upstream vendor reports, so the usage spellings it can emit are the union of
 * several vendors' and will keep diverging from any one of them.
 */
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
 * under. All three are read because Kilo proxies whichever upstream produced
 * the turn, and the spelling follows the upstream rather than the proxy.
 */
type ChatDelta = {
  role?: string;
  content?: string;
  /** OpenRouter's normalized field: the reasoning text, already concatenated. */
  reasoning?: unknown;
  /** The DeepSeek-family spelling, which several proxied vendors still emit. */
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
 * response every time a proxied vendor adds a field.
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

/** SSE payloads are trusted to be JSON; a malformed one is skipped, not fatal. */
function json(data: string): ChatChunk | null {
  try {
    const v: unknown = JSON.parse(data);
    return typeof v === "object" && v !== null ? (v as ChatChunk) : null;
  } catch {
    return null;
  }
}

export async function* decodeKiloChat(
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
  // Reasoning already closed before text or a tool call; folding all three
  // axes into one cursor extends that to the text/tool pair, which this
  // decoder inherited overlapping from the kimi decoder it was forked from.
  // Text arriving after a tool call therefore opens a *second* text block
  // rather than reopening the first, matching what a model that returns to
  // thinking mid-turn already did.
  let openKind: "text" | "thinking" | "tool" | undefined;
  let openIndex = 0;

  for await (const msg of messages) {
    if (msg.data === "[DONE]") {
      done = true;
      break;
    }
    const d = json(msg.data);
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

    // Reasoning leads the turn on this wire, and the blocks are kept strictly
    // sequential — one closes before the next opens — because that is what an
    // Anthropic-shaped egress renders. A model that returns to thinking after
    // some text simply opens a second thinking block.
    //
    // Never `signed`, and no `thinkingSignature` delta is ever emitted even
    // when `reasoning_details` carries a `signature`. That signature was minted
    // by Anthropic over the request *Kilo* made, on Kilo's account. Claiming it
    // here would hand an Anthropic-shaped client a thinking block it replays
    // verbatim on the next turn, and Anthropic rejects it with `Invalid
    // signature in thinking block` — poisoning the conversation from that point
    // on. Unsigned is the truthful claim: displayable, not replayable, which is
    // exactly what the grok decoder reports for the same reason.
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

    const calls = delta.tool_calls ?? [];

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

    for (const call of calls) {
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
      stopReason = FINISH[choice.finish_reason] ?? "endTurn";
    }
  }

  // [DONE] is the transport-level success marker. A finish_reason carries stop
  // metadata but cannot certify that the stream arrived intact, and a proxied
  // upstream has one more hop to be cut off at than a direct one.
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

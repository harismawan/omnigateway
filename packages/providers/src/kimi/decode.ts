import { RETRYABLE, type StopReason, type StreamEvent, usageFromPromptTotal } from "@omni/ir";
import type { SseMessage } from "../sse.ts";

const FINISH: Readonly<Record<string, StopReason>> = {
  stop: "endTurn",
  length: "maxTokens",
  tool_calls: "toolUse",
  content_filter: "contentFilter",
};

/** The subset of the Chat Completions SSE payload shapes this decoder reads. */
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
    delta?: {
      role?: string;
      content?: string;
      tool_calls?: {
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }[];
    };
    finish_reason?: string;
  }[];
};

/** SSE payloads are trusted to be JSON; a malformed one is skipped, not fatal. */
function json(data: string): ChatChunk | null {
  try {
    const v: unknown = JSON.parse(data);
    return typeof v === "object" && v !== null ? (v as ChatChunk) : null;
  } catch {
    return null;
  }
}

export async function* decodeChat(
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
  // At most one block is open at a time, and it closes before the next opens.
  // An Anthropic-shaped egress renders these as content_block_start /
  // content_block_stop pairs and reproduces their order verbatim, so a start
  // arriving while another block is open is malformed on that wire: the
  // official SDK reports every content_block_stop against the most recently
  // started block, so an overlapping pair makes it announce the tool block
  // twice and the text block never.
  //
  // The consequence for content order is that text arriving after a tool call
  // opens a *second* text block rather than reopening the first. That is the
  // truthful reading — the earlier shape silently hoisted trailing text in
  // front of the tool call it followed.
  let openKind: "text" | "tool" | undefined;
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
      stopReason = FINISH[choice.finish_reason] ?? "endTurn";
    }
  }

  // [DONE] is Kimi's transport-level success marker. A finish_reason carries
  // stop metadata but cannot certify that the stream arrived intact.
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

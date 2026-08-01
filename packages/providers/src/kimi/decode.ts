import type { StopReason, StreamEvent } from "@omni/ir";
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
  let textOpen = false;
  let textIndex: number | undefined;
  let ended = false;
  let stopReason: StopReason = "endTurn";
  let usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  // Indices are assigned in first-seen order, whichever content type appears
  // first — the API can stream a tool call with no accompanying text.
  const toolIndex = new Map<number, number>();
  let nextIndex = 0;

  const emitEnd = (): StreamEvent => {
    ended = true;
    return { type: "end", stopReason, usage };
  };

  for await (const msg of messages) {
    if (msg.data === "[DONE]") break;
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
      usage = {
        inputTokens: d.usage.prompt_tokens ?? 0,
        outputTokens: d.usage.completion_tokens ?? 0,
        cacheReadTokens: d.usage.prompt_cache_hit_tokens ?? 0,
        cacheWriteTokens: 0,
      };
    }

    const choice = d.choices?.[0];
    if (!choice) continue;
    const delta = choice.delta ?? {};

    if (typeof delta.content === "string" && delta.content.length > 0) {
      if (!textOpen) {
        textOpen = true;
        textIndex = nextIndex++;
        yield { type: "blockStart", index: textIndex, block: { type: "text" } };
      }
      yield {
        type: "blockDelta",
        index: textIndex ?? 0,
        delta: { type: "text", text: delta.content },
      };
    }

    for (const call of delta.tool_calls ?? []) {
      const wireIndex: number = call.index ?? 0;
      let index = toolIndex.get(wireIndex);
      if (index === undefined) {
        index = nextIndex++;
        toolIndex.set(wireIndex, index);
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
      const args = call.function?.arguments;
      if (typeof args === "string" && args.length > 0) {
        yield { type: "blockDelta", index, delta: { type: "toolJson", partial: args } };
      }
    }

    if (typeof choice.finish_reason === "string") {
      stopReason = FINISH[choice.finish_reason] ?? "endTurn";
      if (textOpen) yield { type: "blockEnd", index: textIndex ?? 0 };
      for (const index of toolIndex.values()) yield { type: "blockEnd", index };
      yield emitEnd();
    }
  }

  // A stream that reaches [DONE] without a finish_reason still needs a terminal
  // event, or collect() would report an unterminated response.
  if (!ended) {
    if (textOpen) yield { type: "blockEnd", index: textIndex ?? 0 };
    for (const index of toolIndex.values()) yield { type: "blockEnd", index };
    yield emitEnd();
  }
}

import type { ErrorCode } from "./errors.ts";
import type { ContentBlock } from "./request.ts";

export type StopReason = "endTurn" | "maxTokens" | "toolUse" | "stopSequence" | "contentFilter";

/**
 * All four counts are required. Cache fields being optional would mean every
 * consumer — the cost calculation in Task 15, the usage rows in Task 19, the
 * aggregates in Task 25 — writes the same `?? 0`, and one that forgets silently
 * bills a cache read at the full input rate.
 */
export type Usage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};

export type ContentBlockStart =
  | { type: "text" }
  | { type: "thinking" }
  | { type: "toolUse"; id: string; name: string };

export type Delta =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "thinkingSignature"; signature: string }
  | { type: "toolJson"; partial: string };

/**
 * Usage rides on `end` rather than being its own event.
 *
 * Providers report totals at different moments — Anthropic splits them across
 * `message_start` and `message_delta`, OpenAI sends one block with the final
 * chunk — so each decoder accumulates and reports once. That gives dispatch a
 * single place to price the request and one guarantee to rely on: a stream
 * that ends has usage.
 */
export type StreamEvent =
  | { type: "start"; id: string; model: string }
  | { type: "blockStart"; index: number; block: ContentBlockStart }
  | { type: "blockDelta"; index: number; delta: Delta }
  | { type: "blockEnd"; index: number }
  | { type: "end"; stopReason: StopReason; usage: Usage }
  | { type: "error"; code: ErrorCode; message: string; retryable: boolean };

export type CollectedResponse = {
  id: string;
  model: string;
  content: ContentBlock[];
  stopReason: StopReason;
  usage: Usage;
};

type Accum =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string; signature?: string }
  | { kind: "toolUse"; id: string; name: string; json: string };

/**
 * Folds a canonical event stream into a single response. The gateway always
 * streams from the upstream, so non-streaming client requests collapse here
 * rather than taking a separate code path.
 */
export function collect(events: Iterable<StreamEvent>): CollectedResponse {
  let id = "";
  let model = "";
  let stopReason: StopReason = "endTurn";
  let usage: Usage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
  const blocks = new Map<number, Accum>();

  for (const ev of events) {
    switch (ev.type) {
      case "start":
        id = ev.id;
        model = ev.model;
        break;
      case "blockStart":
        blocks.set(
          ev.index,
          ev.block.type === "toolUse"
            ? { kind: "toolUse", id: ev.block.id, name: ev.block.name, json: "" }
            : ev.block.type === "thinking"
              ? { kind: "thinking", text: "" }
              : { kind: "text", text: "" },
        );
        break;
      case "blockDelta": {
        const acc = blocks.get(ev.index);
        if (!acc) break;
        if (ev.delta.type === "text" && acc.kind === "text") acc.text += ev.delta.text;
        else if (ev.delta.type === "thinking" && acc.kind === "thinking") acc.text += ev.delta.text;
        else if (ev.delta.type === "thinkingSignature" && acc.kind === "thinking")
          acc.signature = ev.delta.signature;
        else if (ev.delta.type === "toolJson" && acc.kind === "toolUse")
          acc.json += ev.delta.partial;
        break;
      }
      case "end":
        stopReason = ev.stopReason;
        usage = ev.usage;
        break;
      default:
        break;
    }
  }

  const content: ContentBlock[] = [...blocks.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, acc]): ContentBlock => {
      if (acc.kind === "text") return { type: "text", text: acc.text };
      if (acc.kind === "thinking")
        return {
          type: "thinking",
          text: acc.text,
          ...(acc.signature === undefined ? {} : { signature: acc.signature }),
        };
      return { type: "toolUse", id: acc.id, name: acc.name, input: parseJson(acc.json) };
    });

  return { id, model, content, stopReason, usage };
}

/** Tool arguments arrive in fragments; a truncated stream must not throw. */
function parseJson(raw: string): unknown {
  if (raw.trim().length === 0) return {};
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return {};
  }
}

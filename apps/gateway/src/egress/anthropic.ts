import type { CollectedResponse, ErrorCode, StopReason, StreamEvent } from "@omni/ir";
import type { HeadroomByDimension } from "@omni/ratelimit";

export type SseFrame = { event: string; data: string };

const STOP_REASON: Readonly<Record<StopReason, string>> = {
  endTurn: "end_turn",
  maxTokens: "max_tokens",
  stopSequence: "stop_sequence",
  toolUse: "tool_use",
  contentFilter: "refusal",
  // Reported as itself so the client appends the turn and resends it, which is
  // how a paused server tool run continues.
  pauseTurn: "pause_turn",
};

const ERROR_TYPE: Readonly<Record<ErrorCode, string>> = {
  AUTH: "authentication_error",
  RATE_LIMIT: "rate_limit_error",
  QUOTA_EXHAUSTED: "rate_limit_error",
  OVERLOADED: "overloaded_error",
  BAD_REQUEST: "invalid_request_error",
  CONFLICT: "invalid_request_error",
  CONTENT_FILTER: "invalid_request_error",
  CAPABILITY_MISMATCH: "invalid_request_error",
  // Rendered as the upstream rendered it. The gateway names the cause in its
  // own log; rewriting the client's copy would break the rule that a client
  // error mirrors the upstream one.
  FINGERPRINT_REFUSED: "invalid_request_error",
  MODEL_UNAVAILABLE: "not_found_error",
  UPSTREAM: "api_error",
  TIMEOUT: "api_error",
  NETWORK: "api_error",
  NO_CANDIDATES: "overloaded_error",
  ALL_CANDIDATES_FAILED: "api_error",
  INTERNAL: "api_error",
};

const frame = (event: string, data: unknown): SseFrame => ({
  event,
  data: JSON.stringify(data),
});

export async function* anthropicStream(
  events: AsyncGenerator<StreamEvent> | AsyncIterable<StreamEvent>,
  requestId: string,
): AsyncGenerator<SseFrame, void, undefined> {
  let model = "";
  // Blocks dropped on the way out, and the client-facing index of every block
  // that survived. Anthropic numbers content blocks contiguously from zero, so
  // dropping one renumbers the rest rather than leaving a hole where a client
  // expects the next block.
  const suppressed = new Set<number>();
  const outIndex = new Map<number, number>();
  let nextOutIndex = 0;

  for await (const event of events) {
    switch (event.type) {
      case "start":
        model = event.model;
        // Zero tokens, always. The IR carries usage on `end`, and this frame
        // goes out before the upstream has reported any. The real counts arrive
        // in `message_delta` below, which is where a client that cares about
        // totals reads them anyway — the cache fields are here only so the
        // usage object has one shape throughout the stream.
        yield frame("message_start", {
          type: "message_start",
          message: {
            id: requestId,
            type: "message",
            role: "assistant",
            model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: {
              input_tokens: 0,
              output_tokens: 0,
              cache_read_input_tokens: 0,
              cache_creation_input_tokens: 0,
            },
          },
        });
        break;

      case "blockStart": {
        const b = event.block;
        // Unsigned reasoning never reaches an Anthropic-shaped client. The
        // client stores the assistant turn and replays it verbatim on the next
        // one, and a thinking block Anthropic did not sign fails that request
        // with `Invalid \`signature\` in \`thinking\` block` — so a summary
        // from another provider would poison the conversation from here on.
        if (b.type === "thinking" && b.signed !== true) {
          suppressed.add(event.index);
          break;
        }
        const content_block =
          b.type === "text"
            ? { type: "text", text: "" }
            : b.type === "thinking"
              ? { type: "thinking", thinking: "" }
              : b.type === "providerNative"
                ? // Emitted whole: a result block arrives complete in its start
                  // frame, and a client that reconstructs the message from the
                  // stream needs the payload, not a placeholder.
                  { ...b.data, type: b.blockType }
                : { type: "tool_use", id: b.id, name: b.name, input: {} };
        const index = nextOutIndex++;
        outIndex.set(event.index, index);
        yield frame("content_block_start", {
          type: "content_block_start",
          index,
          content_block,
        });
        break;
      }

      case "blockDelta": {
        if (suppressed.has(event.index)) break;
        const d = event.delta;
        // A native block's input streams on the same wire delta as a custom
        // tool's; the two are only kept apart inside the gateway so a native
        // block never becomes a function call.
        const delta =
          d.type === "text"
            ? { type: "text_delta", text: d.text }
            : d.type === "thinking"
              ? { type: "thinking_delta", thinking: d.text }
              : d.type === "thinkingSignature"
                ? { type: "signature_delta", signature: d.signature }
                : d.type === "providerNative"
                  ? { type: d.deltaType, ...d.data }
                  : { type: "input_json_delta", partial_json: d.partial };
        yield frame("content_block_delta", {
          type: "content_block_delta",
          index: outIndex.get(event.index) ?? event.index,
          delta,
        });
        break;
      }

      case "blockEnd":
        if (suppressed.has(event.index)) break;
        yield frame("content_block_stop", {
          type: "content_block_stop",
          index: outIndex.get(event.index) ?? event.index,
        });
        break;

      case "end":
        yield frame("message_delta", {
          type: "message_delta",
          delta: { stop_reason: STOP_REASON[event.stopReason], stop_sequence: null },
          // `input_tokens` is the uncached remainder, not the whole prompt:
          // that is Anthropic's own definition, and the decoder carries the
          // upstream number through unchanged. Recomputing a total here would
          // report a different quantity under the same name.
          usage: {
            input_tokens: event.usage.inputTokens,
            output_tokens: event.usage.outputTokens,
            cache_read_input_tokens: event.usage.cacheReadTokens,
            cache_creation_input_tokens: event.usage.cacheWriteTokens,
          },
        });
        yield frame("message_stop", { type: "message_stop" });
        break;

      case "error":
        yield frame("error", {
          type: "error",
          error: { type: ERROR_TYPE[event.code], message: event.message },
        });
        break;
    }
  }
}

export function anthropicResponse(collected: CollectedResponse, requestId: string): unknown {
  return {
    id: requestId,
    type: "message",
    role: "assistant",
    model: collected.model,
    // Same rule as the stream: a thinking block Anthropic did not sign cannot
    // be replayed, so it is not handed to a client that will replay it.
    content: collected.content
      .filter((b) => b.type !== "thinking" || (b.signature !== undefined && b.signature !== ""))
      .map((b) => {
        switch (b.type) {
          case "text":
            return {
              type: "text",
              text: b.text,
              ...(b.citations === undefined ? {} : { citations: b.citations }),
            };
          case "thinking":
            return { type: "thinking", thinking: b.text, signature: b.signature };
          case "toolUse":
            return { type: "tool_use", id: b.id, name: b.name, input: b.input };
          case "providerNative":
            return { ...b.data, type: b.blockType };
          default:
            return { type: "text", text: "" };
        }
      }),
    stop_reason: STOP_REASON[collected.stopReason],
    stop_sequence: null,
    usage: {
      input_tokens: collected.usage.inputTokens,
      output_tokens: collected.usage.outputTokens,
      cache_read_input_tokens: collected.usage.cacheReadTokens,
      cache_creation_input_tokens: collected.usage.cacheWriteTokens,
    },
  };
}

export function anthropicErrorBody(code: ErrorCode, message: string): unknown {
  return { type: "error", error: { type: ERROR_TYPE[code], message } };
}

/**
 * The dimensions that get headers, on either surface.
 *
 * `spend` and `concurrency` are left out on purpose. Neither vendor defines a
 * header for them, so inventing `anthropic-ratelimit-dollars-remaining` would
 * put a number no client parses into every response.
 */
export const REPORTED_LIMIT_DIMENSIONS = ["requests", "tokens"] as const;

/**
 * An instant in the spelling Anthropic's own headers use: whole seconds, UTC.
 *
 * Rounded up rather than truncated, so the instant named is never one the
 * window is still refusing at.
 */
function rfc3339(at: number): string {
  return `${new Date(Math.ceil(at / 1000) * 1000).toISOString().slice(0, 19)}Z`;
}

/**
 * The rate-limit headers an Anthropic-shaped client already knows how to read.
 *
 * Rendered here beside the error shapes rather than in the route, because this
 * is the file that speaks Anthropic: the same figures go out over
 * `/v1/chat/completions` under different names, in a different order, with the
 * reset expressed as a duration instead of an instant. An SDK that gets the
 * wrong dialect sees no rate-limit headers at all and backs off from nothing.
 *
 * A dimension with no configured limit contributes no headers. There is no
 * "unlimited" to render, and a limit header with no number in it is worse than
 * its absence.
 */
export function anthropicRateLimitHeaders(headroom: HeadroomByDimension): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const dimension of REPORTED_LIMIT_DIMENSIONS) {
    const entry = headroom[dimension];
    if (entry === undefined) continue;
    headers[`anthropic-ratelimit-${dimension}-limit`] = String(entry.limit);
    headers[`anthropic-ratelimit-${dimension}-remaining`] = String(entry.remaining);
    headers[`anthropic-ratelimit-${dimension}-reset`] = rfc3339(entry.resetAt);
  }
  return headers;
}

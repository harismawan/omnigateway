import type { CollectedResponse, ErrorCode, StopReason, StreamEvent } from "@omni/ir";

export type SseFrame = { event: string; data: string };

const STOP_REASON: Readonly<Record<StopReason, string>> = {
  endTurn: "end_turn",
  maxTokens: "max_tokens",
  stopSequence: "stop_sequence",
  toolUse: "tool_use",
  contentFilter: "refusal",
};

const ERROR_TYPE: Readonly<Record<ErrorCode, string>> = {
  AUTH: "authentication_error",
  RATE_LIMIT: "rate_limit_error",
  QUOTA_EXHAUSTED: "rate_limit_error",
  OVERLOADED: "overloaded_error",
  BAD_REQUEST: "invalid_request_error",
  CONTENT_FILTER: "invalid_request_error",
  CAPABILITY_MISMATCH: "invalid_request_error",
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
        const content_block =
          b.type === "text"
            ? { type: "text", text: "" }
            : b.type === "thinking"
              ? { type: "thinking", thinking: "" }
              : { type: "tool_use", id: b.id, name: b.name, input: {} };
        yield frame("content_block_start", {
          type: "content_block_start",
          index: event.index,
          content_block,
        });
        break;
      }

      case "blockDelta": {
        const d = event.delta;
        const delta =
          d.type === "text"
            ? { type: "text_delta", text: d.text }
            : d.type === "thinking"
              ? { type: "thinking_delta", thinking: d.text }
              : d.type === "thinkingSignature"
                ? { type: "signature_delta", signature: d.signature }
                : { type: "input_json_delta", partial_json: d.partial };
        yield frame("content_block_delta", {
          type: "content_block_delta",
          index: event.index,
          delta,
        });
        break;
      }

      case "blockEnd":
        yield frame("content_block_stop", { type: "content_block_stop", index: event.index });
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
    content: collected.content.map((b) => {
      switch (b.type) {
        case "text":
          return { type: "text", text: b.text };
        case "thinking":
          return { type: "thinking", thinking: b.text, signature: b.signature };
        case "toolUse":
          return { type: "tool_use", id: b.id, name: b.name, input: b.input };
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

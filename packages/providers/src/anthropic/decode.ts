import { type ErrorCode, RETRYABLE, type StopReason, type StreamEvent } from "@omni/ir";
import type { SseMessage } from "../sse.ts";

const STOP_REASON: Readonly<Record<string, StopReason>> = {
  end_turn: "endTurn",
  max_tokens: "maxTokens",
  stop_sequence: "stopSequence",
  tool_use: "toolUse",
  refusal: "contentFilter",
};

const ERROR_TYPE: Readonly<Record<string, ErrorCode>> = {
  overloaded_error: "OVERLOADED",
  rate_limit_error: "RATE_LIMIT",
  authentication_error: "AUTH",
  permission_error: "AUTH",
  invalid_request_error: "BAD_REQUEST",
  api_error: "UPSTREAM",
};

/** The subset of Anthropic's SSE payload shapes this decoder reads. */
type AnthropicEvent = {
  message?: {
    id?: string;
    model?: string;
    usage?: {
      input_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
  };
  index?: number;
  content_block?: { type?: string; id?: string; name?: string };
  delta?: {
    type?: string;
    text?: string;
    thinking?: string;
    signature?: string;
    partial_json?: string;
    stop_reason?: string;
  };
  usage?: { input_tokens?: number; output_tokens?: number };
  error?: { type?: string; message?: string };
};

/** SSE payloads are trusted to be JSON; a malformed one is skipped, not fatal. */
function json(data: string): AnthropicEvent | null {
  try {
    const v: unknown = JSON.parse(data);
    return typeof v === "object" && v !== null ? (v as AnthropicEvent) : null;
  } catch {
    return null;
  }
}

export async function* decodeAnthropic(
  messages: AsyncGenerator<SseMessage> | AsyncIterable<SseMessage>,
): AsyncGenerator<StreamEvent, void, undefined> {
  let inputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let outputTokens = 0;
  let stopReason: StopReason = "endTurn";
  let terminal = false;

  for await (const msg of messages) {
    const d = json(msg.data);
    if (d === null) continue;

    switch (msg.event) {
      case "message_start": {
        const m = d.message ?? {};
        inputTokens = m.usage?.input_tokens ?? 0;
        cacheReadTokens = m.usage?.cache_read_input_tokens ?? 0;
        cacheWriteTokens = m.usage?.cache_creation_input_tokens ?? 0;
        yield { type: "start", id: String(m.id ?? ""), model: String(m.model ?? "") };
        break;
      }

      case "content_block_start": {
        const cb = d.content_block ?? {};
        const index: number = d.index ?? 0;
        if (cb.type === "text") yield { type: "blockStart", index, block: { type: "text" } };
        else if (cb.type === "thinking")
          yield { type: "blockStart", index, block: { type: "thinking" } };
        else if (cb.type === "tool_use")
          yield {
            type: "blockStart",
            index,
            block: { type: "toolUse", id: String(cb.id), name: String(cb.name) },
          };
        break;
      }

      case "content_block_delta": {
        const index: number = d.index ?? 0;
        const delta = d.delta ?? {};
        if (delta.type === "text_delta")
          yield { type: "blockDelta", index, delta: { type: "text", text: delta.text ?? "" } };
        else if (delta.type === "thinking_delta")
          yield {
            type: "blockDelta",
            index,
            delta: { type: "thinking", text: delta.thinking ?? "" },
          };
        else if (delta.type === "signature_delta")
          yield {
            type: "blockDelta",
            index,
            delta: { type: "thinkingSignature", signature: delta.signature ?? "" },
          };
        else if (delta.type === "input_json_delta")
          yield {
            type: "blockDelta",
            index,
            delta: { type: "toolJson", partial: delta.partial_json ?? "" },
          };
        break;
      }

      case "content_block_stop":
        yield { type: "blockEnd", index: d.index ?? 0 };
        break;

      case "message_delta": {
        const reason = d.delta?.stop_reason;
        if (typeof reason === "string") stopReason = STOP_REASON[reason] ?? "endTurn";
        inputTokens = d.usage?.input_tokens ?? inputTokens;
        outputTokens = d.usage?.output_tokens ?? outputTokens;
        break;
      }

      case "message_stop":
        terminal = true;
        yield {
          type: "end",
          stopReason,
          usage: { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens },
        };
        break;

      case "error": {
        terminal = true;
        const code = ERROR_TYPE[String(d.error?.type)] ?? "UPSTREAM";
        yield {
          type: "error",
          code,
          message: String(d.error?.message ?? "upstream error"),
          retryable: RETRYABLE[code],
        };
        break;
      }

      default:
        // ping and any future event types are ignored by design.
        break;
    }
  }

  if (!terminal) {
    yield {
      type: "error",
      code: "UPSTREAM",
      message: "upstream stream ended before message_stop",
      retryable: RETRYABLE.UPSTREAM,
    };
  }
}

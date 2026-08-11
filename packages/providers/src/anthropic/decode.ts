import { type ErrorCode, RETRYABLE, type StopReason, type StreamEvent } from "@omni/ir";
import type { SseMessage } from "../sse.ts";
import { ANTHROPIC_NATIVE_BLOCK_TYPES } from "./tools.ts";

const STOP_REASON: Readonly<Record<string, StopReason>> = {
  end_turn: "endTurn",
  max_tokens: "maxTokens",
  stop_sequence: "stopSequence",
  tool_use: "toolUse",
  refusal: "contentFilter",
  // Kept distinct so a client can append the turn and resend it as-is. Folding
  // it into `endTurn` would end a server tool run half-finished.
  pause_turn: "pauseTurn",
};

/**
 * Every SSE event this decoder understands.
 *
 * An event outside this set is surfaced rather than skipped: silence here means
 * a block the client never sees, or a `content_block_stop` with no matching
 * start, and both look like a gateway bug from the outside. The failure names
 * the event so an operator can tell a new upstream feature apart from
 * corruption.
 */
const KNOWN_EVENTS: ReadonlySet<string> = new Set([
  "message_start",
  "content_block_start",
  "content_block_delta",
  "content_block_stop",
  "message_delta",
  "message_stop",
  "error",
  // Heartbeat, carries nothing.
  "ping",
]);

/** Block deltas this decoder maps. Anything else is a protocol change. */
const KNOWN_DELTAS: ReadonlySet<string> = new Set([
  "text_delta",
  "thinking_delta",
  "signature_delta",
  "input_json_delta",
]);

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
      /** Per-TTL split of the line above, which it sums to. */
      cache_creation?: {
        ephemeral_5m_input_tokens?: number;
        ephemeral_1h_input_tokens?: number;
      };
    };
  };
  index?: number;
  /**
   * Read structurally for the three portable shapes and carried whole for the
   * native ones, which is why the extra keys are typed as unknown rather than
   * enumerated — the payload belongs to Anthropic.
   */
  content_block?: { type?: string; id?: string; name?: string } & Record<string, unknown>;
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
  // Left undefined when the upstream reports no breakdown, so a consumer can
  // tell "all one TTL" apart from "not told".
  let cacheWrite5mTokens: number | undefined;
  let cacheWrite1hTokens: number | undefined;
  let outputTokens = 0;
  let stopReason: StopReason = "endTurn";
  let terminal = false;
  // Which open block indexes are Anthropic-native, so an `input_json_delta`
  // fills the right accumulator. A native block's input must never land in a
  // portable `toolUse`, which is what would send it onward as a function call.
  const nativeBlocks = new Set<number>();

  /** A protocol surprise: reported, and the stream ends rather than guessing. */
  const protocolError = (message: string): StreamEvent => ({
    type: "error",
    code: "UPSTREAM",
    message,
    retryable: false,
  });

  for await (const msg of messages) {
    const d = json(msg.data);
    if (d === null) continue;

    if (!KNOWN_EVENTS.has(msg.event)) {
      yield protocolError(`unrecognized Anthropic stream event "${msg.event}"`);
      return;
    }

    switch (msg.event) {
      case "message_start": {
        const m = d.message ?? {};
        inputTokens = m.usage?.input_tokens ?? 0;
        cacheReadTokens = m.usage?.cache_read_input_tokens ?? 0;
        cacheWriteTokens = m.usage?.cache_creation_input_tokens ?? 0;
        cacheWrite5mTokens = m.usage?.cache_creation?.ephemeral_5m_input_tokens;
        cacheWrite1hTokens = m.usage?.cache_creation?.ephemeral_1h_input_tokens;
        yield { type: "start", id: String(m.id ?? ""), model: String(m.model ?? "") };
        break;
      }

      case "content_block_start": {
        const cb = d.content_block ?? {};
        const index: number = d.index ?? 0;
        if (cb.type === "text") yield { type: "blockStart", index, block: { type: "text" } };
        else if (cb.type === "thinking")
          yield { type: "blockStart", index, block: { type: "thinking", signed: true } };
        else if (cb.type === "tool_use")
          yield {
            type: "blockStart",
            index,
            block: { type: "toolUse", id: String(cb.id), name: String(cb.name) },
          };
        else if (cb.type !== undefined && ANTHROPIC_NATIVE_BLOCK_TYPES.has(cb.type)) {
          nativeBlocks.add(index);
          // `type` is dropped from the payload because `blockType` now holds
          // it; the encoder puts it back. Everything else — including a
          // `content` that is an error object rather than results — is kept
          // untouched, so an upstream tool failure stays a successful response
          // carrying a failed result, which is what Anthropic does.
          const { type: _blockType, ...data } = cb;
          yield {
            type: "blockStart",
            index,
            block: { type: "anthropicNative", blockType: cb.type, data },
          };
        } else {
          yield protocolError(`unrecognized Anthropic content block type "${String(cb.type)}"`);
          return;
        }
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
        // A signature delta with nothing in it is skipped rather than defaulted
        // to the empty string: an empty signature is not a missing one, and
        // sending it back is what turns a replay into an upstream 400.
        else if (delta.type === "signature_delta" && (delta.signature ?? "") !== "")
          yield {
            type: "blockDelta",
            index,
            delta: { type: "thinkingSignature", signature: delta.signature ?? "" },
          };
        else if (delta.type === "input_json_delta")
          yield {
            type: "blockDelta",
            index,
            delta: nativeBlocks.has(index)
              ? { type: "anthropicNativeJson", partial: delta.partial_json ?? "" }
              : { type: "toolJson", partial: delta.partial_json ?? "" },
          };
        else if (delta.type === undefined || !KNOWN_DELTAS.has(delta.type)) {
          yield protocolError(`unrecognized Anthropic content block delta "${String(delta.type)}"`);
          return;
        }
        break;
      }

      case "content_block_stop":
        nativeBlocks.delete(d.index ?? 0);
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
          usage: {
            inputTokens,
            outputTokens,
            cacheReadTokens,
            cacheWriteTokens,
            ...(cacheWrite5mTokens === undefined ? {} : { cacheWrite5mTokens }),
            ...(cacheWrite1hTokens === undefined ? {} : { cacheWrite1hTokens }),
          },
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
        // Only `ping` reaches here; anything unrecognized already returned.
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

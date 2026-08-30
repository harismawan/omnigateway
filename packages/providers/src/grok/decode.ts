import {
  type ErrorCode,
  RETRYABLE,
  type StopReason,
  type StreamEvent,
  usageFromPromptTotal,
} from "@omni/ir";
import type { SseMessage } from "../sse.ts";

const ERROR_CODE: Readonly<Record<string, ErrorCode>> = {
  rate_limit_exceeded: "RATE_LIMIT",
  insufficient_quota: "QUOTA_EXHAUSTED",
  invalid_api_key: "AUTH",
  server_error: "UPSTREAM",
  context_length_exceeded: "BAD_REQUEST",
  content_policy_violation: "CONTENT_FILTER",
};

/**
 * Every event this decoder accepts, whether or not it acts on one.
 *
 * No authoritative enumeration of xAI's event set exists — it is assumed to
 * match OpenAI's — which is exactly why anything outside this set ends the
 * stream with an error instead of being skipped. A skipped event is content the
 * client never sees and nothing in the log explains.
 */
const KNOWN_EVENTS: ReadonlySet<string> = new Set([
  "response.created",
  "response.queued",
  "response.in_progress",
  "response.output_item.added",
  "response.output_item.done",
  "response.content_part.added",
  "response.content_part.done",
  "response.output_text.delta",
  "response.output_text.done",
  "response.output_text.annotation.added",
  "response.refusal.delta",
  "response.refusal.done",
  "response.reasoning_summary_part.added",
  "response.reasoning_summary_part.done",
  "response.reasoning_summary_text.delta",
  "response.reasoning_summary_text.done",
  "response.reasoning_text.delta",
  "response.reasoning_text.done",
  "response.function_call_arguments.delta",
  "response.function_call_arguments.done",
  "response.completed",
  "response.incomplete",
  "response.failed",
  "error",
]);

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

function json(data: string): ResponsesEvent | null {
  try {
    const v: unknown = JSON.parse(data);
    return typeof v === "object" && v !== null ? (v as ResponsesEvent) : null;
  } catch {
    return null;
  }
}

export async function* decodeGrokResponses(
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
    // The Responses API terminates on `response.completed`, not on a sentinel,
    // but nothing stops the proxy from closing with the OpenAI-style one. It
    // carries no event name, so `parseSse` labels it "message" and the check
    // below would read a benign close as an unknown event. Skipped, not treated
    // as terminal: only a real completion may end the stream without an error.
    if (msg.data === "[DONE]") continue;

    // Checked before the payload is parsed. The other order lets an unknown
    // event whose data is not JSON fall into the `null` skip and end the stream
    // clean and short — the silent truncation this set exists to prevent.
    if (!KNOWN_EVENTS.has(msg.event)) {
      yield {
        type: "error",
        code: "UPSTREAM",
        message: `unrecognized xAI stream event "${msg.event}"`,
        retryable: false,
      };
      return;
    }

    const d = json(msg.data);
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

      // The request asks for a summary, so that is the expected spelling. The
      // raw form is accepted into the same block because a model that reports
      // only raw reasoning would otherwise think into a block that stays empty.
      case "response.reasoning_summary_text.delta":
      case "response.reasoning_text.delta":
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
        else if (reason !== undefined || r.status === "incomplete") {
          // An unrecognized — or missing — reason on an incomplete response
          // used to fall through to `endTurn`, which is the one wrong answer
          // nobody can notice: a truncated turn reads to the client as a
          // complete reply, and nothing in `request_logs` disagrees. Same rule
          // as an unrecognized chat finish reason: fail visibly, never fold.
          // Keyed on the payload rather than the event name, because the two
          // can arrive crossed — a `response.completed` event carrying
          // `status: "incomplete"` names its reason and is mapped above.
          yield {
            type: "error",
            code: "UPSTREAM",
            message:
              reason === undefined
                ? "xAI reported the response incomplete without a reason"
                : `unrecognized xAI incomplete reason "${String(reason)}"`,
            retryable: false,
          };
          break;
        }
        yield {
          type: "end",
          stopReason,
          // xAI counts cached tokens inside `input_tokens`; the IR wants it net.
          // Leaving them in bills the same tokens at the input rate and again at
          // the cache rate, on every request.
          usage: usageFromPromptTotal(
            r.usage?.input_tokens ?? 0,
            r.usage?.output_tokens ?? 0,
            r.usage?.input_tokens_details?.cached_tokens ?? 0,
          ),
        };
        break;
      }

      case "response.failed":
      case "error": {
        terminal = true;
        const err = d.response?.error ?? d.error ?? {};
        const code = ERROR_CODE[String(err.code ?? err.type)] ?? "UPSTREAM";
        yield {
          type: "error",
          code,
          message: String(err.message ?? "upstream error"),
          retryable: RETRYABLE[code],
        };
        break;
      }

      default:
        // Known, but carrying nothing the IR needs.
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

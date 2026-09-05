import {
  type ErrorCode,
  RETRYABLE,
  type StopReason,
  type StreamEvent,
  usageFromPromptTotal,
} from "@omni/ir";
import type { SseMessage } from "../sse.ts";

/**
 * Antigravity's Cloud Code stream to canonical events.
 *
 * Every frame is a `GenerateContentResponse` wrapped one level down under
 * `response`, which is the `v1internal` envelope rather than anything Gemini's
 * public API does. Frames carry no event name — `alt=sse` emits bare `data:`
 * lines — so unlike the Responses decoders there is no event vocabulary to
 * validate against. What takes its place is the finish reason, which **is**
 * checked exhaustively: an unrecognized one ends the stream with an error
 * rather than folding into `endTurn`, because a truncated turn that reads as a
 * complete reply is the one wrong answer nobody can notice.
 *
 * Gemini does not index its parts. A frame carries `candidates[0].content.parts`
 * and the next frame continues the same logical block, so block identity is
 * tracked here by *kind*: consecutive text parts extend one block, and a change
 * of kind closes the open block and opens the next. That is the whole of the
 * indexing scheme, and it is why a thought part arriving between two text parts
 * produces three blocks rather than two.
 */

/**
 * Google's `finishReason` enum, mapped to what the IR calls the same thing.
 *
 * `MALFORMED_FUNCTION_CALL` is deliberately absent: it is not a way for a turn
 * to end, it is the model failing to emit a call it tried to make, and reporting
 * it as any `StopReason` would hand the client a turn that looks finished. It is
 * classified below as `BAD_REQUEST` instead.
 */
const STOP_REASON: Readonly<Record<string, StopReason>> = {
  STOP: "endTurn",
  MAX_TOKENS: "maxTokens",
  SAFETY: "contentFilter",
  PROHIBITED_CONTENT: "contentFilter",
  SPII: "contentFilter",
  BLOCKLIST: "contentFilter",
  RECITATION: "contentFilter",
};

/** Google's canonical RPC status names, which its errors carry beside a numeric code. */
const ERROR_CODE: Readonly<Record<string, ErrorCode>> = {
  RESOURCE_EXHAUSTED: "RATE_LIMIT",
  UNAUTHENTICATED: "AUTH",
  PERMISSION_DENIED: "AUTH",
  INVALID_ARGUMENT: "BAD_REQUEST",
  FAILED_PRECONDITION: "BAD_REQUEST",
  UNAVAILABLE: "UPSTREAM",
  INTERNAL: "UPSTREAM",
  DEADLINE_EXCEEDED: "TIMEOUT",
};

type Part = {
  text?: unknown;
  thought?: unknown;
  functionCall?: { id?: unknown; name?: unknown; args?: unknown };
};

type ErrorPayload = { code?: unknown; status?: unknown; message?: unknown };

type UsageMetadata = {
  promptTokenCount?: unknown;
  candidatesTokenCount?: unknown;
  /**
   * Reasoning tokens, counted **beside** `candidatesTokenCount` rather than
   * inside it. Omitting them undercounts output on every thinking request —
   * which is most of this provider's catalog — and that number is what
   * `request_logs`, the token rate limits and any operator-set price all read.
   */
  thoughtsTokenCount?: unknown;
  cachedContentTokenCount?: unknown;
};

type Frame = {
  response?: {
    responseId?: unknown;
    modelVersion?: unknown;
    candidates?: Array<{
      content?: { parts?: Part[] };
      finishReason?: unknown;
    }>;
    usageMetadata?: UsageMetadata;
    /** Cloud Code puts an error here as often as at the top level. */
    error?: ErrorPayload;
    /** A prompt refused before any candidate was generated. */
    promptFeedback?: { blockReason?: unknown };
  };
  error?: ErrorPayload;
};

function json(data: string): Frame | null {
  try {
    const value: unknown = JSON.parse(data);
    return typeof value === "object" && value !== null ? (value as Frame) : null;
  } catch {
    return null;
  }
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * `usageMetadata` to the canonical counts.
 *
 * Two corrections, both of which read as arithmetic and are really billing:
 * `cachedContentTokenCount` is counted **inside** `promptTokenCount`, so leaving
 * it there bills the same tokens at the input rate and again at the cache rate;
 * `thoughtsTokenCount` is counted **beside** `candidatesTokenCount`, so omitting
 * it undercounts output on every request that thinks.
 */
function usageOf(meta: UsageMetadata | undefined) {
  return usageFromPromptTotal(
    count(meta?.promptTokenCount),
    count(meta?.candidatesTokenCount) + count(meta?.thoughtsTokenCount),
    count(meta?.cachedContentTokenCount),
  );
}

type OpenBlock = { kind: "text" | "thinking"; index: number } | null;

export async function* decodeAntigravityStream(
  messages: AsyncGenerator<SseMessage> | AsyncIterable<SseMessage>,
): AsyncGenerator<StreamEvent, void, undefined> {
  let started = false;
  let terminal = false;
  let nextIndex = 0;
  let toolCalls = 0;
  let open: OpenBlock = null;

  const closeOpen = function* (): Generator<StreamEvent> {
    if (open === null) return;
    yield { type: "blockEnd", index: open.index };
    open = null;
  };

  for await (const message of messages) {
    if (message.data === "[DONE]") continue;

    const frame = json(message.data);
    if (frame === null) continue;

    // **Both positions, checked before anything else is read.** Cloud Code puts
    // an error at the top level on some paths and under `response` on others,
    // and reading only the first turned a `RESOURCE_EXHAUSTED` into a generic
    // retryable `UPSTREAM` — a real rate limit the breaker never recognised, and
    // a wrapped `UNAUTHENTICATED` that never reached the refresh path.
    const failure = frame.error ?? frame.response?.error;
    if (failure !== undefined) {
      terminal = true;
      yield* closeOpen();
      const status = String(failure.status ?? "");
      const code =
        (Object.hasOwn(ERROR_CODE, status) ? ERROR_CODE[status] : undefined) ?? "UPSTREAM";
      yield {
        type: "error",
        code,
        message: String(failure.message ?? "upstream error"),
        retryable: RETRYABLE[code],
      };
      return;
    }

    const response = frame.response;
    if (response === undefined) continue;

    // A prompt refused before generation carries `promptFeedback` and no
    // candidate at all. Read as a completed turn that was filtered, because that
    // is what it is — the alternative is the stream running out and being
    // reported as a truncation, which sends the client looking for a network
    // fault instead of at its own prompt.
    const blocked = response.promptFeedback?.blockReason;
    if (blocked !== undefined && (response.candidates ?? []).length === 0) {
      terminal = true;
      if (!started) yield { type: "start", id: "", model: "" };
      yield* closeOpen();
      yield { type: "end", stopReason: "contentFilter", usage: usageOf(response.usageMetadata) };
      return;
    }

    if (!started) {
      started = true;
      yield {
        type: "start",
        id: String(response.responseId ?? ""),
        model: String(response.modelVersion ?? ""),
      };
    }

    const candidates = response.candidates ?? [];
    // The canonical event stream has no way to carry two alternatives, and
    // silently keeping the first would drop the other's content *and* its finish
    // reason — so a turn whose terminal reason arrived on candidate 1 would read
    // as a stream that stopped early. Nothing in the IR can ask for more than
    // one; a frame carrying two came from `vendor.antigravity`, and failing
    // visibly is the standing rule for what this decoder cannot represent.
    if (candidates.length > 1) {
      terminal = true;
      yield* closeOpen();
      yield {
        type: "error",
        code: "UPSTREAM",
        message: `Antigravity returned ${candidates.length} candidates, which cannot be represented`,
        retryable: false,
      };
      return;
    }

    const candidate = candidates[0];

    for (const part of candidate?.content?.parts ?? []) {
      const call = part.functionCall;
      if (call !== undefined && typeof call.name === "string") {
        yield* closeOpen();
        const index = nextIndex++;
        // Gemini correlates by name and only sometimes supplies an id, so one is
        // minted when it does not. The id has to survive the round trip — the
        // client echoes it back as a tool result's `toolUseId` — but nothing
        // requires it to be the *upstream's* id, and `wire.ts` recovers the name
        // from history rather than from the id's shape.
        yield {
          type: "blockStart",
          index,
          block: {
            type: "toolUse",
            id: typeof call.id === "string" && call.id.length > 0 ? call.id : `fc_${toolCalls}`,
            name: call.name,
          },
        };
        // Arrives whole rather than as a delta stream: Gemini emits the complete
        // `args` object in one part. One `toolJson` delta carrying all of it is
        // what the IR's incremental shape reduces to in that case.
        yield {
          type: "blockDelta",
          index,
          delta: { type: "toolJson", partial: JSON.stringify(call.args ?? {}) },
        };
        yield { type: "blockEnd", index };
        toolCalls++;
        continue;
      }

      if (typeof part.text !== "string") continue;

      // `thought: true` is how Gemini marks reasoning text. The signature that
      // may travel with it is dropped: the IR has nowhere to keep an opaque
      // provider blob, and `wire.ts` drops thinking on the way back out for the
      // same reason, so replaying an unsigned thought could only be refused.
      const kind = part.thought === true ? "thinking" : "text";
      if (open === null || open.kind !== kind) {
        yield* closeOpen();
        open = { kind, index: nextIndex++ };
        yield { type: "blockStart", index: open.index, block: { type: kind } };
      }
      yield {
        type: "blockDelta",
        index: open.index,
        delta:
          kind === "thinking"
            ? { type: "thinking", text: part.text }
            : { type: "text", text: part.text },
      };
    }

    const finish = candidate?.finishReason;
    if (finish === undefined || finish === null) continue;

    terminal = true;
    yield* closeOpen();

    const raw = String(finish);

    if (raw === "MALFORMED_FUNCTION_CALL") {
      yield {
        type: "error",
        code: "BAD_REQUEST",
        message: "the model emitted a malformed function call",
        retryable: false,
      };
      return;
    }

    const mapped = Object.hasOwn(STOP_REASON, raw) ? STOP_REASON[raw] : undefined;
    if (mapped === undefined) {
      yield {
        type: "error",
        code: "UPSTREAM",
        message: `unrecognized Antigravity finish reason "${raw}"`,
        retryable: false,
      };
      return;
    }

    yield {
      type: "end",
      // A tool call outranks the candidate's own reason. Gemini reports `STOP`
      // on a turn whose only content was a function call, and taking that at
      // face value tells the client the conversation is over while the model is
      // waiting on a tool result.
      stopReason: toolCalls > 0 ? "toolUse" : mapped,
      usage: usageOf(response.usageMetadata),
    };
    return;
  }

  if (!terminal) {
    yield* closeOpen();
    yield {
      type: "error",
      code: "UPSTREAM",
      message: "upstream stream ended before the response finished",
      retryable: RETRYABLE.UPSTREAM,
    };
  }
}

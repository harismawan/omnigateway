import type { CollectedResponse, ErrorCode, StopReason, StreamEvent, Usage } from "@omni/ir";
import { promptTokens } from "@omni/ir";
import type { HeadroomByDimension } from "@omni/ratelimit";
import { REPORTED_LIMIT_DIMENSIONS, type SseFrame } from "./anthropic.ts";

/**
 * Renders usage the way this surface counts it.
 *
 * OpenAI's `prompt_tokens` is the whole prompt with the cached part inside it,
 * which is the opposite of the IR's convention — so the parts are added back
 * and the cached share reported as the subset a client expects to be able to
 * subtract. `cache_creation` has no field here and lands in the total only.
 */
function usageBody(usage: Usage): Record<string, unknown> {
  const prompt = promptTokens(usage);
  return {
    prompt_tokens: prompt,
    completion_tokens: usage.outputTokens,
    total_tokens: prompt + usage.outputTokens,
    prompt_tokens_details: { cached_tokens: usage.cacheReadTokens },
  };
}

const FINISH: Readonly<Record<StopReason, string>> = {
  endTurn: "stop",
  maxTokens: "length",
  stopSequence: "stop",
  toolUse: "tool_calls",
  contentFilter: "content_filter",
  // This surface has no pause: the router keeps Anthropic-native requests off
  // OpenAI targets, so a paused turn cannot reach an OpenAI-shaped client. If
  // one somehow did, `stop` is the reading that does not invent a tool call for
  // the client to answer.
  pauseTurn: "stop",
};

const ERROR_TYPE: Readonly<Record<ErrorCode, { type: string; code: string }>> = {
  AUTH: { type: "invalid_request_error", code: "invalid_api_key" },
  RATE_LIMIT: { type: "rate_limit_error", code: "rate_limit_exceeded" },
  QUOTA_EXHAUSTED: { type: "insufficient_quota", code: "insufficient_quota" },
  OVERLOADED: { type: "server_error", code: "server_error" },
  BAD_REQUEST: { type: "invalid_request_error", code: "invalid_request" },
  CONFLICT: { type: "invalid_request_error", code: "conflict" },
  CONTENT_FILTER: { type: "invalid_request_error", code: "content_policy_violation" },
  CAPABILITY_MISMATCH: { type: "invalid_request_error", code: "invalid_request" },
  MODEL_UNAVAILABLE: { type: "invalid_request_error", code: "model_not_found" },
  UPSTREAM: { type: "server_error", code: "server_error" },
  TIMEOUT: { type: "server_error", code: "timeout" },
  NETWORK: { type: "server_error", code: "server_error" },
  NO_CANDIDATES: { type: "server_error", code: "service_unavailable" },
  ALL_CANDIDATES_FAILED: { type: "server_error", code: "server_error" },
  INTERNAL: { type: "server_error", code: "server_error" },
};

const chunk = (id: string, created: number, model: string, choice: unknown, usage?: unknown) => ({
  id,
  object: "chat.completion.chunk",
  created,
  model,
  choices: [choice],
  ...(usage === undefined ? {} : { usage }),
});

export async function* openaiStream(
  events: AsyncGenerator<StreamEvent> | AsyncIterable<StreamEvent>,
  requestId: string,
  created: number,
): AsyncGenerator<SseFrame, void, undefined> {
  let model = "";
  let roleSent = false;
  let completed = false;
  // Chat Completions numbers tool calls independently of content blocks.
  const toolIndex = new Map<number, number>();

  const emit = (data: unknown): SseFrame => ({ event: "message", data: JSON.stringify(data) });

  for await (const event of events) {
    switch (event.type) {
      case "start":
        model = event.model;
        break;

      case "blockStart": {
        if (event.block.type === "text") {
          if (!roleSent) {
            roleSent = true;
            yield emit(
              chunk(requestId, created, model, {
                index: 0,
                delta: { role: "assistant", content: "" },
                finish_reason: null,
              }),
            );
          }
        } else if (event.block.type === "toolUse") {
          const index = toolIndex.size;
          toolIndex.set(event.index, index);
          const firstRole = roleSent ? {} : { role: "assistant" as const };
          roleSent = true;
          yield emit(
            chunk(requestId, created, model, {
              index: 0,
              delta: {
                ...firstRole,
                tool_calls: [
                  {
                    index,
                    id: event.block.id,
                    type: "function",
                    function: { name: event.block.name, arguments: "" },
                  },
                ],
              },
              finish_reason: null,
            }),
          );
        }
        // Thinking blocks have no representation on this surface.
        break;
      }

      case "blockDelta": {
        const d = event.delta;
        if (d.type === "text") {
          yield emit(
            chunk(requestId, created, model, {
              index: 0,
              delta: { content: d.text },
              finish_reason: null,
            }),
          );
        } else if (d.type === "toolJson") {
          const index = toolIndex.get(event.index) ?? 0;
          yield emit(
            chunk(requestId, created, model, {
              index: 0,
              delta: { tool_calls: [{ index, function: { arguments: d.partial } }] },
              finish_reason: null,
            }),
          );
        }
        break;
      }

      case "blockEnd":
        break;

      case "end":
        completed = true;
        yield emit(
          chunk(
            requestId,
            created,
            model,
            { index: 0, delta: {}, finish_reason: FINISH[event.stopReason] },
            usageBody(event.usage),
          ),
        );
        break;

      case "error": {
        const e = ERROR_TYPE[event.code];
        yield emit({ error: { message: event.message, type: e.type, code: e.code } });
        break;
      }
    }
  }

  if (completed) yield { event: "message", data: "[DONE]" };
}

export function openaiResponse(
  collected: CollectedResponse,
  requestId: string,
  created: number,
): unknown {
  const text = collected.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
  const toolCalls = collected.content.flatMap((b) =>
    b.type === "toolUse"
      ? [
          {
            id: b.id,
            type: "function" as const,
            function: { name: b.name, arguments: JSON.stringify(b.input) },
          },
        ]
      : [],
  );

  return {
    id: requestId,
    object: "chat.completion",
    created,
    model: collected.model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: toolCalls.length > 0 && text.length === 0 ? null : text,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: FINISH[collected.stopReason],
      },
    ],
    usage: usageBody(collected.usage),
  };
}

export function openaiErrorBody(code: ErrorCode, message: string): unknown {
  const e = ERROR_TYPE[code];
  return { error: { message, type: e.type, code: e.code } };
}

/**
 * A wait in OpenAI's own spelling — `4h51m22s`, `6m0s`, `22s`.
 *
 * A duration rather than the instant the Anthropic dialect names, which is the
 * whole reason the two renderers are separate functions and not one with a
 * prefix argument. Whole seconds, rounded up: a client sent back early is a
 * client that gets refused again.
 */
function duration(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours}h${minutes}m${seconds}s`;
  if (minutes > 0) return `${minutes}m${seconds}s`;
  return `${seconds}s`;
}

/**
 * The rate-limit headers an OpenAI-shaped client already knows how to read.
 *
 * The same figures the Anthropic surface sends, under different names, in a
 * different word order, with the reset relative to now instead of absolute. An
 * SDK handed the other dialect sees no rate-limit headers at all and backs off
 * from nothing, so which renderer runs is decided by the surface and nothing
 * else.
 *
 * A dimension with no configured limit contributes no headers, and `spend` and
 * `concurrency` contribute none on either surface — see
 * `REPORTED_LIMIT_DIMENSIONS`.
 */
export function openaiRateLimitHeaders(
  headroom: HeadroomByDimension,
  now: number,
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const dimension of REPORTED_LIMIT_DIMENSIONS) {
    const entry = headroom[dimension];
    if (entry === undefined) continue;
    headers[`x-ratelimit-limit-${dimension}`] = String(entry.limit);
    headers[`x-ratelimit-remaining-${dimension}`] = String(entry.remaining);
    headers[`x-ratelimit-reset-${dimension}`] = duration(entry.resetAt - now);
  }
  return headers;
}

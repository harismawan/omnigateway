import { collect, type ErrorCode, GatewayError, HTTP_STATUS, type StreamEvent } from "@omni/ir";
import { Elysia } from "elysia";
import { apiKeyHeader, authenticateApiKey } from "../auth/apiKey.ts";
import { ApiKeyRateLimiter } from "../auth/rateLimit.ts";
import { type DispatchDeps, dispatch } from "../dispatch/index.ts";
import { anthropicErrorBody, anthropicResponse, anthropicStream } from "../egress/anthropic.ts";
import { openaiErrorBody, openaiResponse, openaiStream } from "../egress/openai.ts";
import { parseAnthropicRequest } from "../ingress/anthropic.ts";
import { parseOpenAIRequest } from "../ingress/openai.ts";
import { finishLog } from "../logging.ts";

export type ProxyDeps = DispatchDeps & {
  requestId: () => string;
  rateLimiter?: ApiKeyRateLimiter;
};

type Surface = "anthropic" | "openai";

const SSE_HEADERS = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache, no-transform",
  connection: "keep-alive",
  "x-accel-buffering": "no",
} as const;

function errorResponse(surface: Surface, code: ErrorCode, message: string): Response {
  const body =
    surface === "anthropic" ? anthropicErrorBody(code, message) : openaiErrorBody(code, message);
  return new Response(JSON.stringify(body), {
    status: HTTP_STATUS[code],
    headers: { "content-type": "application/json" },
  });
}

function asGatewayError(error: unknown): GatewayError {
  if (error instanceof GatewayError) return error;
  return new GatewayError("INTERNAL", error instanceof Error ? error.message : "internal error");
}

/** Serializes SSE frames and drains the stream, logging once it is done. */
function sseResponse(
  frames: AsyncGenerator<{ event: string; data: string }, void, undefined>,
  onDone: () => Promise<void>,
): Response {
  const encoder = new TextEncoder();

  // `pull`'s catch and `cancel` can both fire for the same disconnect (an
  // in-flight read rejects with AbortError at the same moment the stream is
  // cancelled), so the log write is latched to run exactly once regardless
  // of which path gets there first.
  let done: Promise<void> | null = null;
  const runOnce = (): Promise<void> => {
    if (done === null) done = onDone();
    return done;
  };

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await frames.next();
        if (next.done === true) {
          controller.close();
          await runOnce();
          return;
        }
        const { event, data } = next.value;
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${data}\n\n`));
      } catch (error) {
        controller.error(error);
        await runOnce();
      }
    },
    async cancel() {
      // The client hung up. Close the upstream generator so the provider
      // connection is released, then still write the log (exactly once).
      await frames.return(undefined);
      await runOnce();
    },
  });

  return new Response(stream, { headers: SSE_HEADERS });
}

async function handle(
  deps: ProxyDeps,
  rateLimiter: ApiKeyRateLimiter,
  surface: Surface,
  request: Request,
): Promise<Response> {
  const requestId = deps.requestId();
  let keyId: string | null = null;

  try {
    const key = await authenticateApiKey(deps.store, apiKeyHeader(request.headers));
    keyId = key.id;
    rateLimiter.consume(key.id, key.rateLimitPerMin);

    const body: unknown = await request.json();
    const chatRequest =
      surface === "anthropic" ? parseAnthropicRequest(body) : parseOpenAIRequest(body);
    if (key.modelAllowlist !== null && !key.modelAllowlist.includes(chatRequest.model)) {
      throw new GatewayError(
        "AUTH",
        `model "${chatRequest.model}" is not allowed for this API key`,
      );
    }

    const outcome = await dispatch(chatRequest, deps, request.signal);
    // Overrides dispatch's internally generated id with the route-level
    // requestId so the client-visible response id and the log row id match.
    const log = () => finishLog(deps.store, { ...outcome.log(), id: requestId }, keyId);

    if (chatRequest.stream) {
      const frames =
        surface === "anthropic"
          ? anthropicStream(outcome.events, requestId)
          : openaiStream(outcome.events, requestId, Math.floor(deps.now() / 1000));
      return sseResponse(frames, log);
    }

    const events: StreamEvent[] = [];
    for await (const event of outcome.events) events.push(event);
    await log();

    const failure = events.find(
      (e): e is Extract<StreamEvent, { type: "error" }> => e.type === "error",
    );
    if (failure !== undefined) return errorResponse(surface, failure.code, failure.message);

    const collected = collect(events);
    const responseBody =
      surface === "anthropic"
        ? anthropicResponse(collected, requestId)
        : openaiResponse(collected, requestId, Math.floor(deps.now() / 1000));

    return new Response(JSON.stringify(responseBody), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  } catch (error) {
    const gatewayError = asGatewayError(error);
    await finishLog(
      deps.store,
      {
        id: requestId,
        at: deps.now(),
        apiKeyId: keyId,
        requestedModel: "",
        resolvedProvider: null,
        resolvedModel: null,
        credentialId: null,
        attempts: 0,
        status: HTTP_STATUS[gatewayError.code],
        errorCode: gatewayError.code,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        ttftMs: null,
        durationMs: 0,
        costUsd: 0,
        degradations: [],
      },
      keyId,
    );
    return errorResponse(surface, gatewayError.code, gatewayError.message);
  }
}

export function proxyRoutes(deps: ProxyDeps) {
  const rateLimiter = deps.rateLimiter ?? new ApiKeyRateLimiter(deps.now);
  return new Elysia()
    .post("/v1/messages", ({ request }) => handle(deps, rateLimiter, "anthropic", request))
    .post("/v1/chat/completions", ({ request }) => handle(deps, rateLimiter, "openai", request))
    .get("/v1/models", async ({ request }) => {
      try {
        await authenticateApiKey(deps.store, apiKeyHeader(request.headers));
        const models = await deps.store.config.listModels();
        return Response.json({
          object: "list",
          data: models.map((m) => ({
            id: m.id,
            object: "model",
            created: 0,
            owned_by: "omnigateway",
          })),
        });
      } catch (error) {
        const gatewayError = asGatewayError(error);
        return errorResponse("anthropic", gatewayError.code, gatewayError.message);
      }
    })
    .onError(({ error }) => {
      const gatewayError = asGatewayError(error);
      return errorResponse("anthropic", gatewayError.code, gatewayError.message);
    });
}

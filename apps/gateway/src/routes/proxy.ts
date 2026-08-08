import { collect, type ErrorCode, GatewayError, HTTP_STATUS, type StreamEvent } from "@omni/ir";
import { Elysia } from "elysia";
import { apiKeyHeader, authenticateApiKey } from "../auth/apiKey.ts";
import { ApiKeyRateLimiter } from "../auth/rateLimit.ts";
import { type DispatchDeps, dispatch } from "../dispatch/index.ts";
import { createRoutingSnapshotCache } from "../dispatch/snapshotCache.ts";
import { anthropicErrorBody, anthropicResponse, anthropicStream } from "../egress/anthropic.ts";
import { openaiErrorBody, openaiResponse, openaiStream } from "../egress/openai.ts";
import { parseAnthropicRequest } from "../ingress/anthropic.ts";
import { parseOpenAIRequest } from "../ingress/openai.ts";
import { finishLog } from "../logging.ts";

export type ProxyDeps = Omit<DispatchDeps, "snapshots"> & {
  snapshots?: DispatchDeps["snapshots"];
  requestId: () => string;
  rateLimiter?: ApiKeyRateLimiter;
  keepaliveMs?: number;
};

type ResolvedProxyDeps = DispatchDeps &
  Pick<ProxyDeps, "requestId" | "rateLimiter"> & { keepaliveMs: number };

type Surface = "anthropic" | "openai";

/**
 * How long a stream may carry no bytes before a keepalive is written. Upstream
 * silence is normal — a slow first token, a long thinking block — and the
 * providers' own heartbeats are decoded away rather than forwarded, so without
 * this the socket goes completely quiet. Bun closes an idle connection (Elysia
 * defaults `idleTimeout` to 30s), and the client reports that as a response
 * truncated mid-flight. Ten seconds matches Anthropic's own ping cadence and
 * leaves room under any intermediate proxy's read timeout.
 */
const KEEPALIVE_MS = 10_000;

/** Distinguishes "nothing arrived yet" from a frame, without a nullable frame. */
const KEEPALIVE = Symbol("keepalive");

/**
 * Resolves to the pending frame, or to KEEPALIVE if `ms` passes first. The
 * caller keeps the same pending promise across ticks, so a slow frame is
 * awaited once however many keepalives are written while it is in flight.
 */
function withKeepalive<T>(pending: Promise<T>, ms: number): Promise<T | typeof KEEPALIVE> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tick = new Promise<typeof KEEPALIVE>((resolve) => {
    timer = setTimeout(() => resolve(KEEPALIVE), ms);
  });
  return Promise.race([pending, tick]).finally(() => clearTimeout(timer));
}

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
  keepaliveMs: number,
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

  // Held across pulls so a frame that outlives several keepalives is awaited
  // once rather than restarted, which would drop it.
  let inflight: Promise<IteratorResult<{ event: string; data: string }, void>> | null = null;

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        inflight ??= frames.next();
        const next = await withKeepalive(inflight, keepaliveMs);
        if (next === KEEPALIVE) {
          // An SSE comment: legal, ignored by every client parser, and enough
          // traffic to keep the connection from being judged idle.
          controller.enqueue(encoder.encode(": keepalive\n\n"));
          return;
        }
        inflight = null;
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
  deps: ResolvedProxyDeps,
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
      surface === "anthropic"
        ? parseAnthropicRequest(body, request.headers)
        : parseOpenAIRequest(body);
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
      return sseResponse(frames, log, deps.keepaliveMs);
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
  const dispatchDeps: ResolvedProxyDeps = {
    ...deps,
    snapshots: deps.snapshots ?? createRoutingSnapshotCache(deps.store),
    keepaliveMs: deps.keepaliveMs ?? KEEPALIVE_MS,
  };
  return new Elysia()
    .post("/v1/messages", ({ request }) => handle(dispatchDeps, rateLimiter, "anthropic", request))
    .post("/v1/chat/completions", ({ request }) =>
      handle(dispatchDeps, rateLimiter, "openai", request),
    )
    .get("/v1/models", async ({ request }) => {
      try {
        const key = await authenticateApiKey(deps.store, apiKeyHeader(request.headers));
        const models = await deps.store.config.listModels();
        const visibleModels =
          key.modelAllowlist === null
            ? models
            : models.filter((model) => key.modelAllowlist?.includes(model.id));
        return Response.json({
          object: "list",
          data: visibleModels.map((m) => ({
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

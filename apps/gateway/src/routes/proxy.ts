import {
  collect,
  type ErrorCode,
  estimateInputTokens,
  GatewayError,
  HTTP_STATUS,
  type LogFields,
  type Logger,
  noopLogger,
  type StreamEvent,
} from "@omni/ir";
import { Elysia } from "elysia";
import { apiKeyHeader, authenticateApiKey } from "../auth/apiKey.ts";
import { ApiKeyRateLimiter } from "../auth/rateLimit.ts";
import { type DispatchDeps, dispatch } from "../dispatch/index.ts";
import { createRoutingSnapshotCache } from "../dispatch/snapshotCache.ts";
import { anthropicErrorBody, anthropicResponse, anthropicStream } from "../egress/anthropic.ts";
import { openaiErrorBody, openaiResponse, openaiStream } from "../egress/openai.ts";
import { parseAnthropicRequest } from "../ingress/anthropic.ts";
import { parseOpenAIRequest } from "../ingress/openai.ts";
import {
  beginLog,
  finishLog,
  newCompletedRequestLog,
  newPendingRequestLog,
  routeLog,
} from "../logging.ts";
import { modelListBody } from "./models.ts";

export type ProxyDeps = Omit<DispatchDeps, "snapshots"> & {
  snapshots?: DispatchDeps["snapshots"];
  requestId: () => string;
  rateLimiter?: ApiKeyRateLimiter;
  keepaliveMs?: number;
  /**
   * Whether `GET /v1/models` also advertises `claude/<id>` mirrors.
   *
   * Off unless an operator asks for it: an installation whose clients are not
   * Claude Code should not have its catalog doubled.
   */
  discoveryMirrors?: boolean;
};

type ResolvedProxyDeps = DispatchDeps &
  Pick<ProxyDeps, "requestId" | "rateLimiter"> & { keepaliveMs: number; logger: Logger };

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
  onDone: (cancelled: boolean) => Promise<void>,
  keepaliveMs: number,
): Response {
  const encoder = new TextEncoder();

  // `pull`'s catch and `cancel` can both fire for the same disconnect (an
  // in-flight read rejects with AbortError at the same moment the stream is
  // cancelled), so the log write is latched to run exactly once regardless
  // of which path gets there first.
  let done: Promise<void> | null = null;
  const runOnce = (cancelled = false): Promise<void> => {
    if (done === null) done = onDone(cancelled);
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
      await runOnce(true);
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
  const startedAt = deps.now();
  let keyId: string | null = null;
  let requestedModel = "";

  try {
    let key: Awaited<ReturnType<typeof authenticateApiKey>>;
    try {
      key = await authenticateApiKey(deps.store, apiKeyHeader(request.headers));
    } catch (error) {
      if (error instanceof GatewayError && error.code === "AUTH") {
        deps.logger.warn("authentication rejected", {
          requestId,
          surface,
          reason: "invalid credentials",
        });
      }
      throw error;
    }
    keyId = key.id;
    try {
      rateLimiter.consume(key.id, key.rateLimitPerMin);
    } catch (error) {
      if (error instanceof GatewayError && error.code === "RATE_LIMIT") {
        deps.logger.warn("rate limit rejected", {
          requestId,
          surface,
          apiKeyId: key.id,
          code: error.code,
          retryAfterMs: error.retryAfterMs,
        });
      }
      throw error;
    }

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

    requestedModel = chatRequest.model;
    let began = false;
    const outcome = await dispatch(
      chatRequest,
      {
        ...deps,
        async onRoute(target) {
          if (began) {
            await routeLog(deps.store, requestId, target, deps.logger);
            return;
          }
          began = true;
          const log = newPendingRequestLog({
            id: requestId,
            at: startedAt,
            requestedModel,
            resolvedProvider: target.provider,
            resolvedModel: target.model,
            credentialId: target.credentialId,
          });
          await beginLog(deps.store, log, keyId, deps.logger);
        },
      },
      request.signal,
      requestId,
    );
    const log = async (cancelled = false): Promise<void> => {
      const completed = outcome.log();
      const wasCancelled = cancelled || request.signal.aborted;
      if (wasCancelled && completed.status === 0) {
        completed.status = 499;
        completed.errorCode = "interrupted";
        completed.durationMs = deps.now() - startedAt;
      }
      await finishLog(deps.store, completed, keyId, deps.logger);
      const fields: LogFields = {
        requestId,
        surface,
        status: completed.status,
        provider: completed.resolvedProvider ?? undefined,
        model: completed.resolvedModel ?? undefined,
        requestedModel: completed.requestedModel,
        credentialId: completed.credentialId ?? undefined,
        apiKeyId: keyId ?? undefined,
        attempts: completed.attempts,
        code: (completed.errorCode as ErrorCode | "interrupted" | null) ?? undefined,
        stream: chatRequest.stream,
        inputTokens: completed.inputTokens,
        outputTokens: completed.outputTokens,
        cacheReadTokens: completed.cacheReadTokens,
        cacheWriteTokens: completed.cacheWriteTokens,
        costUsd: completed.costUsd,
        ttftMs: completed.ttftMs,
        durationMs: completed.durationMs,
      };
      if (wasCancelled) deps.logger.debug("request cancelled", fields);
      else if (completed.status >= 400) deps.logger.error("request failed", fields);
      else deps.logger.info("request done", fields);
    };

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
    const completed = newCompletedRequestLog(requestId, startedAt, {
      requestedModel,
      status: HTTP_STATUS[gatewayError.code],
      errorCode: gatewayError.code,
      durationMs: deps.now() - startedAt,
    });
    // Completes a pending row if the request got as far as dispatch. The store
    // keeps what beginning it recorded where this log carries nothing.
    await finishLog(deps.store, completed, keyId, deps.logger);
    deps.logger.error("request failed", {
      requestId,
      surface,
      status: completed.status,
      requestedModel,
      apiKeyId: keyId ?? undefined,
      code: gatewayError.code,
      attempts: completed.attempts,
      durationMs: completed.durationMs,
      reason: gatewayError.message,
    });
    return errorResponse(surface, gatewayError.code, gatewayError.message);
  }
}

export function proxyRoutes(deps: ProxyDeps) {
  const rateLimiter = deps.rateLimiter ?? new ApiKeyRateLimiter(deps.now);
  const logger = deps.logger ?? noopLogger;
  const dispatchDeps: ResolvedProxyDeps = {
    ...deps,
    logger,
    snapshots: deps.snapshots ?? createRoutingSnapshotCache(deps.store, logger),
    keepaliveMs: deps.keepaliveMs ?? KEEPALIVE_MS,
  };
  return (
    new Elysia()
      .post("/v1/messages", ({ request }) =>
        handle(dispatchDeps, rateLimiter, "anthropic", request),
      )
      .post("/v1/chat/completions", ({ request }) =>
        handle(dispatchDeps, rateLimiter, "openai", request),
      )
      .get("/v1/models", async ({ request }) => {
        try {
          const key = await authenticateApiKey(deps.store, apiKeyHeader(request.headers));
          // The routing snapshot, not the store: it already holds both halves of
          // the answer, it is invalidated on every routing change, and taking it
          // here means the listing and dispatch cannot disagree about which
          // credentials exist.
          const snapshot = await dispatchDeps.snapshots.get(deps.now());
          const models = [...snapshot.models.values()];
          const visibleModels =
            key.modelAllowlist === null
              ? models
              : models.filter((model) => key.modelAllowlist?.includes(model.id));
          // Credentials decide the answer: an OAuth OpenAI credential is served
          // by Codex, whose window is under a third of the API's.
          return Response.json(
            modelListBody(visibleModels, snapshot.credentials, {
              discoveryMirrors: deps.discoveryMirrors === true,
            }),
          );
        } catch (error) {
          const gatewayError = asGatewayError(error);
          logger.error("model listing failed", {
            status: HTTP_STATUS[gatewayError.code],
            code: gatewayError.code,
            reason: gatewayError.message,
          });
          return errorResponse("anthropic", gatewayError.code, gatewayError.message);
        }
      })
      // Answered from a local estimate rather than from an upstream count.
      //
      // Claude Code paces its own compaction with this, and the alternatives are
      // both worse: 404 leaves the client guessing, and the 501 its own gateway
      // document prescribes sends it to a Haiku `max_tokens: 1` probe — a real
      // request against the operator's pool for every count. An upstream count
      // would also need a credential and have nothing to say about a Kimi target,
      // which is exactly when a client most needs the number.
      .post("/v1/messages/count_tokens", async ({ request }) => {
        try {
          const key = await authenticateApiKey(deps.store, apiKeyHeader(request.headers));
          rateLimiter.consume(key.id, key.rateLimitPerMin);
          const body: unknown = await request.json();
          const chatRequest = parseAnthropicRequest(body, request.headers);
          if (key.modelAllowlist !== null && !key.modelAllowlist.includes(chatRequest.model)) {
            throw new GatewayError(
              "AUTH",
              `model "${chatRequest.model}" is not allowed for this API key`,
            );
          }
          // No request-log row: nothing was dispatched and no tokens were spent,
          // so a row here would be counted by every usage aggregate.
          return Response.json({ input_tokens: estimateInputTokens(chatRequest) });
        } catch (error) {
          const gatewayError = asGatewayError(error);
          logger.warn("token count failed", {
            status: HTTP_STATUS[gatewayError.code],
            code: gatewayError.code,
            reason: gatewayError.message,
          });
          return errorResponse("anthropic", gatewayError.code, gatewayError.message);
        }
      })
      .onError(({ error }) => {
        const gatewayError = asGatewayError(error);
        logger.error("unhandled proxy route error", {
          status: HTTP_STATUS[gatewayError.code],
          code: gatewayError.code,
          reason: gatewayError.message,
        });
        return errorResponse("anthropic", gatewayError.code, gatewayError.message);
      })
  );
}

import { DEFAULT_BODY_CAPTURE_BUDGET_BYTES } from "@omni/control";
import { type Coord, memoryCoord } from "@omni/coord";
import {
  type ChatRequest,
  collect,
  describeError,
  type ErrorCode,
  estimateInputTokens,
  GatewayError,
  HTTP_STATUS,
  type Logger,
  noopLogger,
  type StreamEvent,
} from "@omni/ir";
import {
  builtinPrompts,
  injectPrompts,
  type PromptResolution,
  type ResolvedPrompt,
  resolvePrompts,
} from "@omni/prompts";
import type { PromptAssignment } from "@omni/prompts/catalog";
import type { HeadroomByDimension } from "@omni/ratelimit";
import type { Snapshot } from "@omni/router";
import type { ApiKey, NewRequestLog } from "@omni/store";
import { Elysia } from "elysia";
import { apiKeyHeader, authenticateApiKey } from "../auth/apiKey.ts";
import { ApiKeyRateLimiter, RateLimitExceeded } from "../auth/rateLimit.ts";
import { type CaptureBudget, createCaptureBudget } from "../bodies/budget.ts";
import type { BodyWriterHost } from "../bodies/host.ts";
import { type BodyCollector, createBodyCollector } from "../bodyCapture.ts";
import {
  type DispatchDeps,
  type DispatchOptions,
  type DispatchOutcome,
  dispatch,
} from "../dispatch/index.ts";
import { createLoadRegistry } from "../dispatch/loadRegistry.ts";
import { createRoutingSnapshotCache } from "../dispatch/snapshotCache.ts";
import {
  anthropicErrorBody,
  anthropicRateLimitHeaders,
  anthropicResponse,
  anthropicStream,
} from "../egress/anthropic.ts";
import {
  openaiErrorBody,
  openaiRateLimitHeaders,
  openaiResponse,
  openaiStream,
} from "../egress/openai.ts";
import {
  type ResponsesRender,
  responsesErrorBody,
  responsesRateLimitHeaders,
  responsesResponse,
  responsesStream,
} from "../egress/responses.ts";
import { VerdictCache } from "../guardrail/cache.ts";
import {
  guardrailScreen,
  guardrailThrew,
  judge,
  type ScreenOutcome,
  screenFirst,
} from "../guardrail/judge.ts";
import { parseAnthropicRequest } from "../ingress/anthropic.ts";
import { parseOpenAIRequest } from "../ingress/openai.ts";
import { customToolNames, parseResponsesRequest } from "../ingress/responses.ts";
import { safeToken } from "../ingress/schemas.ts";
import {
  type BodyWriter,
  beginLog,
  finishLog,
  newCompletedRequestLog,
  newPendingRequestLog,
  type PluginEmit,
  reportRejection,
  routeLog,
  type UsageDebit,
} from "../logging.ts";
import type { ConfidentialityCache } from "../smartRouter/cache.ts";
import { checkConfidentiality, smartRouterThrew } from "../smartRouter/check.ts";
import { relabel } from "../smartRouter/relabel.ts";
import type { Invalidator } from "../stream/broadcaster.ts";
import type { Telemetry } from "../telemetry/index.ts";
import type { TraceRecord } from "../telemetry/spans.ts";
import { applyTrace, extractTrace, type TraceContext } from "../trace/extract.ts";
import { modelListBody } from "./models.ts";

export type ProxyDeps = Omit<DispatchDeps, "snapshots" | "loadRegistry" | "coord"> & {
  snapshots?: DispatchDeps["snapshots"];
  loadRegistry?: DispatchDeps["loadRegistry"];
  /** Defaults to one in-memory coordinator for the process, shared by every consumer below. */
  coord?: Coord;
  requestId: () => string;
  /**
   * The id the app's gate already minted for this request, if any — so a
   * request is answered under the same id a quiesce refusal would have named.
   * Absent when the routes are mounted on their own (tests), in which case
   * each handler mints from `requestId`.
   */
  requestIdFor?: (request: Request) => string;
  rateLimiter?: ApiKeyRateLimiter;
  keepaliveMs?: number;
  /**
   * Whether `OMNI_BODY_LOGGING_ALLOWED` was set at boot.
   *
   * The outer of the two keys body capture needs, and the cheapest to ask: a
   * boolean read once from the environment. Off, nothing below it is consulted
   * and the transport is never wrapped, so an installation that never opted in
   * runs exactly the path it ran before capture existed.
   */
  bodyLoggingAllowed?: boolean;
  /**
   * The process-wide ceiling on bytes held for body capture
   * (`OMNI_BODY_CAPTURE_BUDGET_BYTES`), shared by every captured request.
   * Defaults to a budget of its own at the default size, for routes mounted
   * on their own.
   */
  captureBudget?: CaptureBudget;
  bodyWriter?: Pick<BodyWriterHost, "enqueue"> & Partial<Pick<BodyWriterHost, "generation">>;
  /**
   * Announces finished requests to plugin handlers.
   *
   * Threaded to `finishLog` rather than called here, because that function is
   * the one site running at most once per request id — the guarantee a plugin
   * accumulating per-request quantities needs, and the reason the usage debit
   * lives there too.
   */
  emit?: PluginEmit;
  /**
   * Tells the console the log list changed, at each of the three points it does.
   *
   * `beginLog` when the row appears, `routeLog` when failover rewrites its
   * target, `finishLog` when it completes — and only the last of those pairs
   * `res:logs` with `res:usage`, because only then has anything been counted.
   *
   * All three, not just the last, because a pushed topic *replaces* polling: the
   * console refetches `res:logs` on nothing else once the socket is up. An
   * emitter only on completion is what made in-flight requests invisible, and
   * the symptom was silence rather than an error.
   *
   * `finishLog`'s two call sites — the success path and the terminal catch —
   * are mutually exclusive per request, so a finished request still emits one
   * completion pair however it ended.
   */
  broadcaster?: Invalidator;
  telemetry?: Telemetry;
};

type ResolvedProxyDeps = DispatchDeps &
  Pick<
    ProxyDeps,
    | "requestId"
    | "requestIdFor"
    | "rateLimiter"
    | "bodyLoggingAllowed"
    | "bodyWriter"
    | "emit"
    | "broadcaster"
    | "telemetry"
  > & {
    keepaliveMs: number;
    logger: Logger;
    captureBudget: CaptureBudget;
    /** One per process, like the limiter: a verdict is reused across requests. */
    guardrailCache: VerdictCache;
    /** One per process too: a segment's verdict is the same for every key. */
    smartRouterCache: ConfidentialityCache;
  };

type Surface = "anthropic" | "openai" | "responses";

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

/**
 * The same protection for a client that will not wait ten seconds for it.
 *
 * Codex's HTTP client drops a connection that has carried no bytes for about
 * five seconds, so the shared cadence above would lose every request whose
 * first token is slower than that — before a byte of the answer exists, which
 * reads to the operator as a broken gateway rather than a slow model. Four
 * seconds leaves a margin under that limit and still writes nothing a client
 * has to parse: these are SSE comments, not events.
 */
const RESPONSES_KEEPALIVE_MS = 4_000;

/** How long this surface's streams may stay silent. */
function keepaliveFor(surface: Surface, configured: number): number {
  return surface === "responses" ? Math.min(configured, RESPONSES_KEEPALIVE_MS) : configured;
}

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

/**
 * The error body a surface renders, separately from the response around it, so
 * body capture records the same object the client is handed rather than a
 * second construction of it that could drift.
 */
function errorBody(surface: Surface, code: ErrorCode, message: string): unknown {
  if (surface === "anthropic") return anthropicErrorBody(code, message);
  if (surface === "responses") return responsesErrorBody(code, message);
  return openaiErrorBody(code, message);
}

/**
 * The rate-limit headers this surface speaks.
 *
 * Split on the surface for the same reason the error body is: each vendor's SDK
 * parses its own dialect and nothing else, so a client handed the other one
 * sees no rate-limit headers at all and backs off from nothing. `spend` and
 * `concurrency` are absent from both by design.
 */
function rateLimitHeaders(
  surface: Surface,
  headroom: HeadroomByDimension,
  now: number,
): Record<string, string> {
  if (surface === "anthropic") return anthropicRateLimitHeaders(headroom);
  if (surface === "responses") return responsesRateLimitHeaders(headroom, now);
  return openaiRateLimitHeaders(headroom, now);
}

/**
 * `remaining` counted after the request being served, which is what the header
 * means to the client reading it.
 *
 * `Decision.headroom` reports what a window held *before* this request, because
 * that is the state the evaluator judged. Both vendors define `remaining` as
 * what is left once this response is accounted for, so a fresh key limited to
 * 60/min would otherwise advertise 60 on its first response and hand a client
 * that believed it a 429 on the sixtieth.
 *
 * Only `requests` is adjusted, and only once the request was admitted. `tokens`
 * and `spend` debit when the response completes, so this request's cost is
 * genuinely unknown while the head is being written — subtracting anything
 * there would invent a number rather than report one.
 */
function afterThisRequest(headroom: HeadroomByDimension): HeadroomByDimension {
  const requests = headroom.requests;
  if (requests === undefined) return headroom;
  return {
    ...headroom,
    requests: { ...requests, remaining: Math.max(0, requests.remaining - 1) },
  };
}

/**
 * `Retry-After`, in whole seconds, on the refusals that carry a wait.
 *
 * The gap this closes: a 429 already knew how long a client should wait and
 * said so only in the error body, where no SDK looks. Rounded up, because a
 * client sent back early is a client refused twice.
 *
 * The status guard separates two of the three things this codebase calls a rate
 * limit. `retryAfterMs` is also where `providers/http.ts` puts a *provider's*
 * own `Retry-After` — that is the router's business, and forwarding it on a 502
 * or a 503 would hand the client an upstream credential's backoff as though it
 * were their key's ceiling.
 */
function retryAfterHeaders(error: GatewayError): Record<string, string> {
  const ms = error.retryAfterMs;
  if (ms === undefined || HTTP_STATUS[error.code] !== 429) return {};
  return { "retry-after": String(Math.max(0, Math.ceil(ms / 1000))) };
}

function jsonResponse(
  body: unknown,
  status: number,
  headers: Record<string, string> = {},
): Response {
  return serializedResponse(JSON.stringify(body), status, headers);
}

/**
 * A JSON response from text already serialized — so body capture records the
 * exact string the client is sent, stringified once for both.
 */
function serializedResponse(
  json: string,
  status: number,
  headers: Record<string, string> = {},
): Response {
  return new Response(json, {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/**
 * The client's body, read once as text and parsed from that text.
 *
 * Text rather than `request.json()`, because capture keeps what arrived — the
 * raw text, handed to the collector here and to nothing else — and a second
 * read of a consumed body is an error. Refuses exactly what `request.json()`
 * refused, with the same messages: the client sees no difference. The one
 * input the two parsers word differently is the empty body.
 */
async function readJsonBody(request: Request, captured: BodyCollector | null): Promise<unknown> {
  const text = await request.text();
  captured?.captureRequest(text);
  if (text.length === 0) throw new SyntaxError("Unexpected end of JSON input");
  return JSON.parse(text) as unknown;
}

function errorResponse(
  surface: Surface,
  code: ErrorCode,
  message: string,
  headers: Record<string, string> = {},
): Response {
  return jsonResponse(errorBody(surface, code, message), HTTP_STATUS[code], headers);
}

function asGatewayError(error: unknown): GatewayError {
  if (error instanceof GatewayError) return error;
  return new GatewayError("INTERNAL", describeError(error, "internal error"));
}

/** Serializes SSE frames and drains the stream, logging once it is done. */
function sseResponse(
  frames: AsyncGenerator<{ event: string; data: string }, void, undefined>,
  /**
   * `failure` is whatever broke the stream where that was not a hang-up — the
   * generator can throw past every terminal site inside dispatch, and the log
   * would otherwise be written with the status nobody ever assigned.
   */
  onDone: (cancelled: boolean, failure?: unknown) => Promise<void>,
  keepaliveMs: number,
  /**
   * The generator `frames` wraps.
   *
   * Closed explicitly on cancel because closing `frames` is not enough: a
   * generator that never received a `next` skips its body entirely, so its own
   * `for await` — and the close it would propagate — never happens. Without
   * this, a client that disconnects before the first pull leaves whatever
   * dispatch claimed for the request held.
   */
  source: AsyncGenerator<StreamEvent, void, undefined>,
  /**
   * The rate-limit headers, as computed at pre-flight.
   *
   * A stream's head goes out before a token has been counted, so these are the
   * figures the request was admitted against and they are never revised
   * mid-stream — there is nowhere to revise them to once the headers are sent.
   */
  limitHeaders: Record<string, string>,
  /**
   * Given every frame written to the client, in order, when body capture is on.
   *
   * A streaming response has no single rendered body to record, so what the
   * gateway returned *is* this sequence. Keepalive comments are left out: they
   * are transport padding this route emits because provider heartbeats are
   * decoded away, and nothing upstream or downstream of the gateway sent them.
   */
  onFrame?: (frame: string) => void,
): Response {
  const encoder = new TextEncoder();

  // `pull`'s catch and `cancel` can both fire for the same disconnect (an
  // in-flight read rejects with AbortError at the same moment the stream is
  // cancelled), so the log write is latched to run exactly once regardless
  // of which path gets there first.
  let done: Promise<void> | null = null;
  const runOnce = (cancelled = false, failure?: unknown): Promise<void> => {
    if (done === null) done = onDone(cancelled, failure);
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
        onFrame?.(`event: ${event}\ndata: ${data}`);
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${data}\n\n`));
      } catch (error) {
        controller.error(error);
        await runOnce(false, error);
      }
    },
    async cancel() {
      // The client hung up. Close the upstream generator so the provider
      // connection is released, then still write the log (exactly once).
      await frames.return(undefined);
      await source.return(undefined);
      await runOnce(true);
    },
  });

  return new Response(stream, { headers: { ...SSE_HEADERS, ...limitHeaders } });
}

/**
 * Decides whether this request is captured, and builds the collector if it is.
 *
 * Three keys, asked cheapest first and every one of them able to say no on its
 * own:
 *
 * 1. `OMNI_BODY_LOGGING_ALLOWED`, a boolean read at boot. Off, nothing else is
 *    consulted, so a compromised admin session cannot start recording prompts
 *    by flipping a setting.
 * 2. The authenticated key's own opt-out, which a shared installation uses to
 *    serve a client whose payloads must not be retained. It wins over the
 *    setting, and it is asked before anything is read.
 * 3. `settings.bodyLoggingEnabled`, so an operator whose environment already
 *    permits capture can turn it on and off mid-incident without a restart.
 *
 * Null means the transport is never wrapped and nothing is collected, which is
 * exactly the path this route ran before capture existed.
 */
async function bodyCollectorFor(
  deps: ResolvedProxyDeps,
  key: ApiKey,
  requestId: string,
  at: number,
): Promise<BodyCollector | null> {
  if (deps.bodyLoggingAllowed !== true) return null;
  if (key.bodyLoggingOptOut) return null;
  const generation = deps.bodyWriter?.generation?.() ?? 0;
  const { settings } = await deps.snapshots.get(deps.now());
  if (!settings.bodyLoggingEnabled) return null;
  return createBodyCollector({
    generation,
    captureStreamChunks: settings.bodyLoggingCaptureStreamChunks,
    requestId,
    at,
    budget: deps.captureBudget,
    onAbandoned: (reason) => deps.telemetry?.bodiesDropped(reason),
  });
}

/** The response header naming the gateway's id for a request. */
export const REQUEST_ID_HEADER = "x-omni-request-id";

/** One immutable effective list shared by the main dispatch and any local reroute. */
function requestPrompts(snapshot: Snapshot, assignment: PromptAssignment): PromptResolution {
  const active = new Map<string, ResolvedPrompt>(snapshot.prompts);
  for (const prompt of builtinPrompts()) active.set(prompt.id, prompt);
  const resolved = resolvePrompts(snapshot.settings.prompts, assignment, active);
  return Object.freeze({
    prompts: Object.freeze(resolved.prompts.map((prompt) => Object.freeze({ ...prompt }))),
    notes: Object.freeze([...resolved.notes]),
  });
}

async function handle(
  deps: ResolvedProxyDeps,
  rateLimiter: ApiKeyRateLimiter,
  surface: Surface,
  request: Request,
): Promise<Response> {
  const requestId = deps.requestIdFor?.(request) ?? deps.requestId();
  const startedAt = deps.now();
  const trace: TraceRecord | null =
    deps.telemetry?.startRequest(
      requestId,
      startedAt,
      request.headers.get("traceparent"),
      surface,
      deps.rand(),
    ) ?? null;
  let keyId: string | null = null;
  let requestedModel = "";
  // What the caller said this request belongs to, once the body is parsed.
  // Out here so every path that writes the row — begin, completion, the
  // terminal catch — stamps the same context.
  let traced: TraceContext | null = null;
  // Held out here so the terminal catch can complete dispatch's own log rather
  // than a blank one. The completion upsert writes `resolved_*`,
  // `credential_id`, `attempts` and the rtk columns from whatever log it is
  // handed, so a blank one erases the attribution the pending row already held.
  let outcome: Awaited<ReturnType<typeof dispatch>> | null = null;
  let appliedPrompts: { prompts: string[]; notes: string[] } = { prompts: [], notes: [] };
  const retainPrompts = (log: NewRequestLog): void => {
    log.prompts = [...appliedPrompts.prompts];
    for (const note of appliedPrompts.notes) {
      if (!log.degradations.includes(note)) log.degradations.push(note);
    }
  };
  // Null whenever capture is off, which is every request on an installation
  // that never opted in. Both live out here so the terminal catch can record
  // the error body it renders and still write through the same one-shot path.
  let collector: BodyCollector | null = null;
  let writeBodies: BodyWriter | undefined;
  /**
   * Whether the row has already been completed.
   *
   * `usage.append` must run at most once per request id: `rollupLog` adds into
   * `usage_daily` rather than replacing, so a second call bills the same tokens
   * and the same spend twice. The non-streaming path completes the row and then
   * keeps working — rendering a body, serialising it — and anything thrown after
   * that point lands in the terminal catch, which would otherwise complete it
   * again. This used to be survivable only because the catch built a *blank*
   * log, whose nulls and zeros happened to roll up under a different key.
   */
  let logged = false;
  /**
   * The concurrency slot this request holds, once it has one.
   *
   * Out here because the `finally` below is the only site that can free it on
   * every path that ends inside this function, and null until admission so a
   * request refused before it claimed anything cannot free a slot it never had.
   */
  let release: (() => void) | null = null;
  /**
   * Whether the response is a stream this function has already handed back.
   *
   * The trap this exists for: a streaming handler returns as soon as the head
   * is ready and the request goes on running for however long the body takes,
   * so a `finally` here fires when the headers are sent rather than at the end
   * of the request. Freeing the gauge there would count a forty-stream agent
   * loop as nothing in flight. Streams therefore free it from `sseResponse`'s
   * own run-once completion, which is the site that fires on a drained stream,
   * a broken one, and a client that hung up alike.
   */
  let streaming = false;
  /**
   * What the client is told about its own ceilings.
   *
   * Empty until the key is admitted, and empty for a key with no limits — a
   * dimension with no ceiling has no distance from one to report, and
   * `limit: unlimited` is a number no client can parse. Set on the refusal path
   * too, so a 429 carries the same figures a served request would have.
   */
  let headroom: HeadroomByDimension = {};
  /**
   * Rendered against the instant the request arrived, not the instant it is
   * answered.
   *
   * A stream's head goes out at pre-flight and cannot be revised afterwards, so
   * that is the only instant both response kinds share. It also reads the clock
   * exactly zero extra times, which matters because the non-streaming path
   * completes its row before it returns and a read after that point is a read
   * the row cannot account for. The cost is that a slow request over-states the
   * remaining wait by its own duration — the same safe direction every other
   * reset here leans.
   */
  // `release` is non-null exactly when the request claimed a slot, which is the
  // same condition as "this request will be counted". A refusal never was, so
  // it reports the window untouched.
  // Every response this route renders carries the gateway's id for the
  // request, success or failure, streaming or not — the one id the client, the
  // log row and stdout all share.
  const limitHeaders = (): Record<string, string> => ({
    ...rateLimitHeaders(
      surface,
      release === null ? headroom : afterThisRequest(headroom),
      startedAt,
    ),
    [REQUEST_ID_HEADER]: requestId,
  });
  const debit: UsageDebit = (id, model, usage) => {
    rateLimiter.debit(id, model, usage);
  };

  try {
    let key: Awaited<ReturnType<typeof authenticateApiKey>>;
    try {
      // `startedAt`, not a fresh `deps.now()`: this request's rate-limit
      // windows, deadline and usage row are all stamped from it, and a key's
      // expiry is judged on the same instant as everything else it gates.
      key = await authenticateApiKey(
        deps.store,
        apiKeyHeader(request.headers),
        startedAt,
        deps.logger,
      );
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

    const captured = await bodyCollectorFor(deps, key, requestId, startedAt);
    collector = captured;
    if (captured !== null) {
      /**
       * Hands off one request's raw capture without waiting for the writer.
       *
       * Handed to `finishLog`, which is the single site that runs once per
       * request id on both the success and the error path. Successful drains
       * settle in background, bounded to five seconds after completion. On
       * cancellation/timeout, take detaches buffers and live drains discard.
       *
       * `client.request` is the payload as it arrived, before RTK; every
       * `attempts[].request` is what actually went to a provider, after it.
       * `transformRequest` runs inside dispatch, so the two halves are captured
       * on either side of it. That asymmetry is the point of the feature —
       * `request_logs` records which filters ran and not what they removed —
       * and nothing here should try to reconcile them.
       *
       * RTK is one of two reasons the halves differ. The other is the tool-name
       * cloak on the Anthropic OAuth leg: `attempts[].request` holds the
       * renamed tools it sent, while `client.request` holds the names the
       * client chose. Neither is a leak — the originals were always in the
       * client half — but a reader diffing the two should expect it.
       *
       * The row was begun or completed with `body_state = 'pending'`, so this
       * is also what moves it on: `ready` or `omitted` with the pointer row, or
       * `failed`. Parsing, masking, sealing and file I/O belong to the worker;
       * its host publishes the pointer/state transaction on the main connection.
       */
      writeBodies = async (completed) => {
        await captured.settle({
          signal: request.signal,
          timeoutMs: completed.errorCode === "interrupted" ? 0 : 5000,
        });
        const parts = captured.take(
          // The code and status only. Everything a message could add here, the
          // artifact's own bodies already hold in their original form.
          completed.errorCode === null
            ? null
            : { code: completed.errorCode, status: completed.status },
        );
        if (deps.bodyWriter === undefined) {
          deps.captureBudget.release(parts.reservedBytes);
          void deps.store.bodies.fail(requestId).catch(() => {});
        } else {
          deps.bodyWriter.enqueue(parts);
        }
      };
    }

    const body = await readJsonBody(request, captured);
    const chatRequest =
      surface === "anthropic"
        ? parseAnthropicRequest(body, request.headers)
        : surface === "responses"
          ? parseResponsesRequest(body, request.headers)
          : parseOpenAIRequest(body, request.headers);
    traced = extractTrace(request.headers, chatRequest);
    // Which tools the client declared freeform, which only it knows and only
    // the Responses egress needs: the same call renders as `custom_tool_call`
    // or `function_call` depending on it, and a client dispatching one of the
    // two never runs the other. Read from the body rather than the request
    // because IR has one portable shape for both.
    const render = (): ResponsesRender => ({
      requestId,
      created: Math.floor(deps.now() / 1000),
      customToolNames: customToolNames(body),
    });
    if (key.modelAllowlist !== null && !key.modelAllowlist.includes(chatRequest.model)) {
      throw new GatewayError(
        "AUTH",
        `model "${safeToken(chatRequest.model)}" is not allowed for this API key`,
      );
    }

    requestedModel = chatRequest.model;
    // After the parse and the allowlist rather than before, because a model
    // override is judged against the model the request names. One admission
    // claims the key-wide subject and the model's together and gives both back
    // on a refusal, so nothing a refused request claimed outlives it. The cost
    // is accepted: a key over its ceiling sending a malformed body or a
    // disallowed model is told that, more specifically, instead of 429.
    try {
      const admitted = await rateLimiter.admit(key.id, key.limits, requestedModel, requestId);
      release = admitted.release;
      headroom = admitted.headroom;
    } catch (error) {
      // The refusal knows what the client is up against, and it is the only
      // thing that does — nothing downstream re-evaluates the limits.
      if (error instanceof RateLimitExceeded) headroom = error.headroom;
      if (error instanceof GatewayError && error.code === "RATE_LIMIT") {
        deps.logger.warn("rate limit rejected", {
          requestId,
          surface,
          apiKeyId: key.id,
          model: requestedModel,
          code: error.code,
          retryAfterMs: error.retryAfterMs,
        });
      }
      throw error;
    }
    const promptSnapshot = await deps.snapshots.get(deps.now());
    const resolved = requestPrompts(promptSnapshot, key.prompts);
    let began = false;
    // One dispatch closure for the request as sent and for a rerouted copy. The
    // pending row it writes names `requestedModel` — the client's — either way.
    const runWith = (
      dispatchRequest: ChatRequest,
      options: DispatchOptions = {},
    ): Promise<DispatchOutcome> =>
      dispatch(
        dispatchRequest,
        {
          ...deps,
          // Per request, and only when this request is captured. `HttpClient` is
          // a single function type, so capture is a decorator over it: dispatch
          // and every adapter go on calling the transport they were handed, the
          // rule that all outbound provider HTTP goes through `HttpClient` holds,
          // and `nodeHttpClient` never learns this exists. The collector's
          // lifetime is this handler's — there is no registry keyed by request id
          // to leak or to look a request up in.
          ...(captured === null ? {} : { http: captured.wrap(deps.http) }),
          trace,
          onPrompts(state) {
            appliedPrompts = { prompts: [...state.prompts], notes: [...state.notes] };
          },
          async onRoute(target) {
            if (began) {
              await routeLog(deps.store, requestId, target, deps.logger, deps.broadcaster);
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
            log.prompts = [...appliedPrompts.prompts];
            log.degradations = [...appliedPrompts.notes];
            if (traced !== null) applyTrace(log, traced);
            if (captured !== null) log.bodyState = "pending";
            await beginLog(deps.store, log, keyId, deps.logger, deps.broadcaster);
          },
        },
        request.signal,
        requestId,
        { ...options, prompts: resolved.prompts, promptResolutionNotes: resolved.notes },
      );
    const run = (): Promise<DispatchOutcome> => runWith(chatRequest);
    // After admission, so the checks run inside the key's concurrency slot and
    // a refused request still counts as one — refusals are not a free probe. A
    // key with neither smart routing nor a policy takes exactly the path it took
    // before either existed: no classifier call, and dispatch awaited before the
    // head.
    //
    // Screening sees client IR only, but shares this request's settings snapshot.
    const settings = key.smartRouting ? promptSnapshot.settings : null;
    const smartRouting = settings?.smartRouterEnabled === true;
    const policy = key.guardrailPolicy;
    // The classifier calls are never admitted, so their model's override is
    // recorded here or their debit would be skipped — an under-count on any
    // replica sharing that subject's buckets.
    const classifierDebit: UsageDebit = (id, model, usage) => {
      rateLimiter.recordOverride(id, key.limits, model);
      debit(id, model, usage);
    };
    /**
     * Smart routing first, then the guardrail. **A request going local is never
     * judged by `guardrailModel`**: its text was not shown to be public, so the
     * guardrail asks the local classifier instead.
     */
    const screen = async (): Promise<ScreenOutcome> => {
      let reroute: string | null = null;
      let route: "local" | "external" | null = null;
      let guardrailModel: string | null | undefined;
      let guardrailLocalOnly = false;
      let notes: readonly string[] = [];
      if (smartRouting) {
        const decision = await checkConfidentiality(deps, {
          apiKeyId: key.id,
          request: chatRequest,
          signal: request.signal,
          debit: classifierDebit,
          parentRequestId: requestId,
          trace: traced,
        });
        if (decision.kind === "refused" || decision.kind === "cancelled") return decision;
        notes = decision.notes;
        if (decision.kind === "external") {
          route = "external";
          guardrailModel = settings?.guardrailModel ?? null;
        } else {
          route = "local";
          // The classifier the check validated, not this snapshot's: settings
          // may have changed between the two reads.
          guardrailModel = decision.classifier;
          guardrailLocalOnly = true;
          // Already local: dispatched as is, nothing to reroute.
          reroute = decision.model === chatRequest.model ? null : decision.model;
        }
      }
      if (policy !== null) {
        const verdict = guardrailScreen(
          await judge(
            { ...deps, cache: deps.guardrailCache },
            {
              apiKeyId: key.id,
              policy,
              request: chatRequest,
              signal: request.signal,
              debit: classifierDebit,
              parentRequestId: requestId,
              trace: traced,
              ...(guardrailModel === undefined ? {} : { model: guardrailModel }),
              localOnly: guardrailLocalOnly,
            },
          ),
        );
        if (verdict.kind === "cancelled") return verdict;
        notes = [...notes, ...verdict.notes];
        if (verdict.kind === "refused") return { ...verdict, notes };
      }
      return { kind: "proceed", reroute, route, notes };
    };
    const dispatched: DispatchOutcome & { route?: () => "local" | "external" | null } =
      !smartRouting && policy === null
        ? await run()
        : screenFirst({
            screen,
            dispatch: async (reroute, route) => {
              if (route !== "local") return await run();
              // Every request screening sent local — confidential, oversize, or
              // already local and so never classified — is re-checked as
              // local-only on dispatch's own snapshot, so a target added since
              // the check cannot carry it out.
              if (reroute === null) return await runWith(chatRequest, { localOnly: true });
              return relabel(
                await runWith({ ...chatRequest, model: reroute }, { localOnly: true }),
                { clientModel: chatRequest.model, localModel: reroute },
              );
            },
            onThrow: smartRouting ? smartRouterThrew() : guardrailThrew(),
            signal: request.signal,
            requestId,
            startedAt,
            requestedModel,
            now: deps.now,
            logger: deps.logger,
            surface,
          });
    outcome = dispatched;
    const log = async (cancelled = false, failure?: unknown): Promise<void> => {
      const completed = dispatched.log();
      // A screening wrapper can exist before its inner dispatch returns an outcome.
      retainPrompts(completed);
      const wasCancelled = cancelled || request.signal.aborted;
      // The client hung up, so the response in the artifact is whatever had
      // already gone out rather than a whole one. Known here rather than
      // inferred from the capture, because a disconnect is the one truncation
      // the route can state as a fact instead of guessing at from a stream that
      // stopped arriving.
      if (captured !== null && wasCancelled) captured.markTruncated();
      if (wasCancelled && completed.status === 0) {
        completed.status = 499;
        completed.errorCode = "interrupted";
        completed.durationMs = deps.now() - startedAt;
      } else if (!wasCancelled && failure !== undefined) {
        // The stream broke somewhere dispatch does not answer for — a health
        // write, the egress encoder, `onRoute`. That is the gateway's own
        // defect rather than a request being refused, so `reportRejection`
        // prints it at `error`.
        //
        // Reported whatever status the log already carries, but only *assigned*
        // one where nothing did. The two are separate because the two failures
        // here differ: a break before any terminal site leaves `status: 0`,
        // which is neither a success nor a failure and has to be filled in; a
        // break *after* one — the encoder throwing on a stream the client has
        // stopped reading, when dispatch has already recorded the upstream's
        // 200 and its tokens — must keep what actually happened upstream. An
        // earlier version gated the whole branch on `status === 0`, so that
        // second case was recorded as a clean 200 and printed nowhere.
        const gatewayError = asGatewayError(failure);
        if (completed.status === 0) {
          completed.status = HTTP_STATUS[gatewayError.code];
          completed.errorCode = gatewayError.code;
          completed.durationMs = deps.now() - startedAt;
        }
        reportRejection(deps.logger, requestId, completed, gatewayError, surface);
      }
      // The row is the request log. Nothing is printed for a finished request:
      // a terminal line would restate what `request_logs` already holds, more
      // briefly, somewhere nothing can query — and at a volume that buries the
      // lines about the process itself. The console reads those rows; stdout
      // carries what never becomes one. `requestId` is on both, and joins them.
      logged = true;
      if (traced !== null) applyTrace(completed, traced);
      if (captured !== null) completed.bodyState = "pending";
      await finishLog(
        deps.store,
        completed,
        keyId,
        deps.logger,
        writeBodies,
        debit,
        deps.emit,
        deps.broadcaster,
        deps.telemetry,
        trace,
      );
    };

    if (chatRequest.stream) {
      const frames =
        surface === "anthropic"
          ? anthropicStream(dispatched.events, requestId)
          : surface === "responses"
            ? responsesStream(dispatched.events, render())
            : openaiStream(dispatched.events, requestId, Math.floor(deps.now() / 1000));
      // A stream has no rendered body, so what the gateway returned is the
      // frames it wrote, recorded as they go out: a client that hangs up
      // mid-stream leaves whatever had already gone out, which is precisely
      // what the artifact should hold for a request that was cut off.
      const onFrame =
        captured === null ? undefined : (frame: string): void => captured.frame(frame);
      /**
       * The end of a streaming request, wherever it comes from.
       *
       * `sseResponse` latches this to run exactly once whether the stream
       * drained, threw, or was cancelled by a client that hung up, which is
       * precisely the guarantee the gauge needs: a decrement placed beside the
       * debit would never run for the disconnect, and one placed in the
       * `finally` below would run while the stream was still going.
       */
      const finish = async (cancelled = false, failure?: unknown): Promise<void> => {
        // Before the row is written rather than after it. The stream is over
        // either way, and freeing here keeps the instant the gauge falls the
        // instant the request ended, rather than a store write later — which
        // also means a caller that has read the last byte can rely on it.
        //
        // This is the only thing that frees a streaming request's slot, so the
        // gauge is owned entirely by whether the body is consumed. A `Response`
        // that is never read and never cancelled therefore holds its slot until
        // renewal stops at `MAX_RENEWED_MS` and the TTL reclaims it. Bun's
        // server always pulls or cancels, so the case is unreachable in
        // production and reachable from a test calling `app.handle` directly.
        // Deliberately not defended further: a reaper would have to guess when
        // a legitimately slow stream is dead, and guessing wrong frees a slot
        // that is still in use.
        release?.();
        await log(cancelled, failure);
      };
      const response = sseResponse(
        frames,
        finish,
        keepaliveFor(surface, deps.keepaliveMs),
        dispatched.events,
        limitHeaders(),
        onFrame,
      );
      // Only once the response exists. A throw while building it leaves this
      // false, so the `finally` frees the slot that nothing else now will.
      streaming = true;
      return response;
    }

    const events: StreamEvent[] = [];
    for await (const event of dispatched.events) events.push(event);

    const failure = events.find(
      (e): e is Extract<StreamEvent, { type: "error" }> => e.type === "error",
    );
    // Rendered and serialized before the row is completed, not after, so the
    // body capture and the client are handed the same string. A throw from
    // either then lands in the terminal catch with `logged` still false, which
    // completes the row once — the same guarantee the flag gave when rendering
    // came second.
    const responseBody =
      failure !== undefined
        ? errorBody(surface, failure.code, failure.message)
        : surface === "anthropic"
          ? anthropicResponse(collect(events), requestId)
          : surface === "responses"
            ? responsesResponse(collect(events), render())
            : openaiResponse(collect(events), requestId, Math.floor(deps.now() / 1000));
    const responseJson = JSON.stringify(responseBody);
    captured?.captureResponse(responseJson);

    await log();

    // Where a judged request went, on a response that has a head to say it in.
    // A stream's head went out before judging, so it says it in the `model`
    // instead (see `relabel`).
    const route = dispatched.route?.() ?? null;
    return serializedResponse(
      responseJson,
      failure === undefined ? 200 : HTTP_STATUS[failure.code],
      failure === undefined && route !== null
        ? { ...limitHeaders(), "x-omni-route": route }
        : limitHeaders(),
    );
  } catch (error) {
    const gatewayError = asGatewayError(error);
    // A client that hangs up makes the non-streaming drain throw rather than
    // return, so it lands here instead of at `log()` above — where streaming
    // remaps the same event. Without this it reads as a gateway 500.
    //
    // The test is whether this error *is* the hang-up, not whether one is in
    // progress. `request.signal.aborted` is also true for a failure that merely
    // coincided with a disconnect — a store write dying under load while the
    // client's own timeout expires — and filing that as 499 with nothing
    // printed is how an outage comes to read as clients giving up. It also
    // swallowed the model-allowlist rejection this very line exists to record,
    // handing the client a 401 body over a row that claimed 499.
    const cancelled = request.signal.aborted && error === request.signal.reason;
    // Dispatch's log where the request got that far, so completing it keeps the
    // target the pending row recorded instead of overwriting it with nulls.
    const completed =
      outcome?.log() ?? newCompletedRequestLog(requestId, startedAt, { requestedModel, status: 0 });
    retainPrompts(completed);
    completed.status = cancelled ? 499 : HTTP_STATUS[gatewayError.code];
    completed.errorCode = cancelled ? "interrupted" : gatewayError.code;
    completed.durationMs = deps.now() - startedAt;
    if (traced !== null) applyTrace(completed, traced);
    // Pending whether or not routing began the row: a request refused before
    // routing still has a body to write, and its row says so.
    if (collector !== null) completed.bodyState = "pending";
    // Completes a pending row if the request got as far as dispatch. The store
    // keeps what beginning it recorded where this log carries nothing. Skipped
    // where the row is already complete: `completed` is dispatch's own live log
    // once a request got that far, so appending it twice bills its tokens twice.
    const rejection = JSON.stringify(errorBody(surface, gatewayError.code, gatewayError.message));
    if (collector !== null && cancelled) collector.markTruncated();
    // Only where the row is still open. Where it is not, the artifact went with
    // it at the earlier `finishLog`, and writing a second one here would be the
    // duplicate write the `logged` flag exists to prevent.
    if (collector !== null && !logged) collector.captureResponse(rejection);
    if (!logged)
      await finishLog(
        deps.store,
        completed,
        keyId,
        deps.logger,
        writeBodies,
        debit,
        deps.emit,
        deps.broadcaster,
        deps.telemetry,
        trace,
      );
    // Not an access line: this fires only when a request failed outright, which
    // a busy gateway does rarely. It exists because the row cannot hold the
    // reason — `request_logs` has a status and an error code and no room for
    // "model \"x\" is not allowed for this API key" — so without this, the one
    // fact an operator needs is the one nothing recorded. A disconnect is not a
    // failure and is far too common to print; its row is the whole record.
    if (!cancelled) reportRejection(deps.logger, requestId, completed, gatewayError, surface);
    return serializedResponse(rejection, HTTP_STATUS[gatewayError.code], {
      ...limitHeaders(),
      ...retryAfterHeaders(gatewayError),
    });
  } finally {
    // Every path that ends inside this function: a rendered response, a
    // deadline, a rejection before dispatch, a hang-up on the non-streaming
    // drain. A stream is the one request that outlives the return, and it frees
    // itself. The release is idempotent, so the two can never disagree.
    if (!streaming) release?.();
  }
}

export function proxyRoutes(deps: ProxyDeps) {
  const logger = deps.logger ?? noopLogger;
  const coord = deps.coord ?? memoryCoord();
  const rateLimiter =
    deps.rateLimiter ?? new ApiKeyRateLimiter({ store: deps.store, now: deps.now, logger, coord });
  const dispatchDeps: ResolvedProxyDeps = {
    ...deps,
    logger,
    coord,
    snapshots: deps.snapshots ?? createRoutingSnapshotCache(deps.store, logger),
    // One registry for the process. Built here rather than per request, because
    // a fresh registry per request would always read zero and rank as if the
    // gateway were idle.
    loadRegistry: deps.loadRegistry ?? createLoadRegistry(coord),
    keepaliveMs: deps.keepaliveMs ?? KEEPALIVE_MS,
    captureBudget: deps.captureBudget ?? createCaptureBudget(DEFAULT_BODY_CAPTURE_BUDGET_BYTES),
    guardrailCache: new VerdictCache(),
    smartRouterCache: new VerdictCache(),
  };
  return (
    new Elysia()
      .post("/v1/messages", ({ request, server }) => {
        server?.timeout(request, 0);
        return handle(dispatchDeps, rateLimiter, "anthropic", request);
      })
      .post("/v1/responses", ({ request, server }) => {
        server?.timeout(request, 0);
        return handle(dispatchDeps, rateLimiter, "responses", request);
      })
      .post("/v1/chat/completions", ({ request, server }) => {
        server?.timeout(request, 0);
        return handle(dispatchDeps, rateLimiter, "openai", request);
      })
      .get("/v1/models", async ({ request }) => {
        try {
          const key = await authenticateApiKey(
            deps.store,
            apiKeyHeader(request.headers),
            deps.now(),
            logger,
          );
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
          return Response.json(modelListBody(visibleModels, snapshot.credentials));
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
        // Minted first, before authentication, so even a refusal names a
        // request the client can quote. This route writes no row, so the id
        // joins to stdout and the client's own logs, not to `request_logs`.
        const requestId = deps.requestIdFor?.(request) ?? deps.requestId();
        const idHeader = { [REQUEST_ID_HEADER]: requestId };
        try {
          const key = await authenticateApiKey(
            deps.store,
            apiKeyHeader(request.headers),
            deps.now(),
            logger,
          );
          const body: unknown = await request.json();
          const chatRequest = parseAnthropicRequest(body, request.headers);
          if (key.modelAllowlist !== null && !key.modelAllowlist.includes(chatRequest.model)) {
            throw new GatewayError(
              "AUTH",
              `model "${safeToken(chatRequest.model)}" is not allowed for this API key`,
            );
          }
          // After the allowlist, for the reason inference admits there: a
          // model override's `requests` applies to this route too.
          //
          // Minted even though this route writes no row. `consume` logs the
          // fail-open path when a long-window store read times out, and that
          // line is the only record this request leaves anywhere — without an
          // id it names no request and joins to nothing.
          await rateLimiter.consume(key.id, key.limits, chatRequest.model, requestId);
          // Counted against the request the gateway will actually send. This
          // route never dispatches, so it is the one place the ruleset has to
          // be added by hand — a count that omitted it would under-report by
          // the whole prompt on every call while the real request paid for it,
          // and this number is what a client paces its compaction with.
          const snapshot = await dispatchDeps.snapshots.get(deps.now());
          const resolved = requestPrompts(snapshot, key.prompts);
          const counted = injectPrompts(chatRequest, resolved.prompts).request;
          // No request-log row: nothing was dispatched and no tokens were spent,
          // so a row here would be counted by every usage aggregate. That is
          // also why no degradation is recorded for the injection above.
          return Response.json(
            { input_tokens: estimateInputTokens(counted) },
            { headers: idHeader },
          );
        } catch (error) {
          const gatewayError = asGatewayError(error);
          logger.warn("token count failed", {
            status: HTTP_STATUS[gatewayError.code],
            code: gatewayError.code,
            reason: gatewayError.message,
          });
          // No rate-limit dialect here: this route renders no usage headers,
          // but a refusal still says how long to wait rather than saying it
          // only in a body no SDK reads.
          return errorResponse("anthropic", gatewayError.code, gatewayError.message, {
            ...retryAfterHeaders(gatewayError),
            ...idHeader,
          });
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

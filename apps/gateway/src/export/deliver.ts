import {
  DEFAULT_MAX_REQUEST_BYTES,
  elasticsearchConfigSchema,
  elasticsearchSecretSchemas,
  otlpConfigSchema,
  otlpSecretSchema,
  webhookConfigSchema,
  webhookSecretSchema,
} from "@omni/control";
import type { ExportDestination } from "@omni/store/types";
import type { z } from "zod";
import { parseRetryAfter } from "./backoff.ts";
import {
  type BatchEnvelope,
  type BatchLimits,
  MAX_BATCH_BYTES,
  MAX_BATCH_RECORDS,
} from "./batch.ts";
import {
  BULK_CONTENT_TYPE,
  BULK_ENVELOPE,
  bulkPart,
  indexName,
  OTHER_ERROR_TYPE,
  readBulkResponse,
  retryableStatus,
} from "./encoders/elasticsearch.ts";
import {
  OTLP_ENVELOPE,
  OTLP_PATHS,
  type OtlpSignal,
  otlpBody,
  otlpBodyPart,
  otlpPart,
  readOtlpResponse,
} from "./encoders/otlp.ts";
import { sign, WEBHOOK_ENVELOPE, webhookBody, webhookPart } from "./encoders/webhook.ts";
import { type RequestRecord, recordJson } from "./record.ts";

/**
 * One destination's delivery: from its stored row and opened secret to the
 * HTTP request its receiver takes, and from the receiver's answer to what the
 * loop does next. Design: docs/superpowers/specs/2026-10-24-log-export-design.md
 * (*Destination*, *Delivery*).
 *
 * Not `HttpClient`: destinations are not providers (CLAUDE.md boundary 8 is
 * about provider HTTP). The transport is injected; production uses
 * `httpTransport` (`transport.ts`), which never follows a redirect and has a
 * real connect timeout.
 *
 * **What may leave this module as text.** Every error and summary is fixed
 * and gateway-authored — `HTTP <status>`, an Elasticsearch `error.type` (the
 * encoder admits only `[A-Za-z0-9_.]` identifiers), or one of the constants
 * below — because each lands in `last_error`, the console and status
 * messages. Never a receiver body, a header, a URL, the configured index
 * name, a secret, or a thrown error's message.
 */

/** Why a destination is not exported at all, until its configuration changes. */
export const REFUSALS = {
  filter: "filter unreadable",
  config: "config invalid",
  secret: "invalid secret",
  index: "index name refused",
} as const;

export const CONNECT_TIMEOUT_MS = 5_000;
export const REQUEST_TIMEOUT_MS = 20_000;

/** The request a transport sends. `signal` covers the whole exchange, body read included. */
export type TransportInit = {
  method: "POST";
  headers: Record<string, string>;
  body: string | Uint8Array;
  signal: AbortSignal;
  connectTimeoutMs: number;
};

/** The part of a `Response` delivery reads; a fetch `Response` satisfies it. */
export type TransportResponse = {
  status: number;
  headers: { get(name: string): string | null };
  /**
   * The whole body. Rejects with {@link IncompleteResponseError} when the
   * receiver ends it early (connection cut, short `content-length`, broken
   * chunking) and with {@link ResponseTooLargeError} past the transport's
   * bound — never resolves partial text. Never quoted anywhere.
   */
  text(): Promise<string>;
  /**
   * Drains and drops the body. Rejects with {@link IncompleteResponseError}
   * when it was cut short; an over-limit body is simply dropped.
   */
  discard(): Promise<void>;
};

/**
 * Sends one request. Never follows a redirect (a 3xx comes back as itself).
 * Rejects with {@link ConnectTimeoutError} when no connection was made within
 * `connectTimeoutMs`, and with the signal's reason when it aborts.
 */
export type Transport = (url: string, init: TransportInit) => Promise<TransportResponse>;

export class ConnectTimeoutError extends Error {
  constructor() {
    super("connect timeout");
    this.name = "ConnectTimeoutError";
  }
}

/** The receiver ended the response before its body was complete: a transport failure. */
export class IncompleteResponseError extends Error {
  constructor() {
    super("incomplete response");
    this.name = "IncompleteResponseError";
  }
}

/** The response body passed the transport's bound; what was read is not the reply. */
export class ResponseTooLargeError extends Error {
  constructor() {
    super("response too large");
    this.name = "ResponseTooLargeError";
  }
}

/** Thrown by {@link Sender.part} for a row whose index name Elasticsearch would refuse. */
export class IndexRefusedError extends Error {
  constructor() {
    super(REFUSALS.index);
    this.name = "IndexRefusedError";
  }
}

export type Sender = {
  maxRequestBytes?: number;
  rawPart?: (record: RequestRecord, client: { request: string; response: string }) => string;
  bodySegment?: (
    record: RequestRecord,
    part: "request" | "response",
    text: string,
    n: number,
    of: number,
  ) => { sender: Sender; part: string };
  type: ExportDestination["type"];
  url: string;
  /** Lower-case names. Secret values live here and nowhere else. */
  headers: Record<string, string>;
  gzip: boolean;
  envelope: BatchEnvelope;
  limits: BatchLimits;
  /** One record, encoded. Throws {@link IndexRefusedError}, never the encoder's message. */
  part(record: RequestRecord): string;
  body(parts: readonly string[]): string;
  /** Present for a webhook with a signing secret. */
  signingSecret: string | null;
  /** What a 2xx means, given the body text and how many records were sent. */
  accepted(text: string, status: number, sent: number): DeliveryOutcome;
};

export type Prepared = { ok: true; sender: Sender } | { ok: false; error: string };

export type DeliveryOutcome =
  /** `reasons`: the distinct fixed reasons for `dropped`, for {@link droppedSummary}. */
  | { kind: "ok"; status: number; dropped: number; reasons: string[] }
  | { kind: "retry"; status: number | null; error: string; retryAfterMs: number | null }
  | { kind: "failed"; status: number; error: string };

const refuse = (error: string): Prepared => ({ ok: false, error });

function parse<T>(schema: z.ZodType<T>, value: unknown): T | null {
  const result = schema.safeParse(value);
  return result.success ? result.data : null;
}

/** The secret's JSON, or a sentinel when it is not JSON. Never quoted. */
const UNREADABLE = Symbol("unreadable");
function secretJson(text: string | null): unknown {
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return UNREADABLE;
  }
}

function lower(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = Object.create(null);
  for (const [name, value] of Object.entries(headers)) out[name.toLowerCase()] = value;
  return out;
}

function limitsFor(d: ExportDestination): BatchLimits {
  const max = d.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES[d.type];
  return { records: MAX_BATCH_RECORDS, bytes: Math.max(1, Math.min(MAX_BATCH_BYTES, max)) };
}

/**
 * The sender for `d`, or why it is refused. `secretText` is the secret the
 * same one-statement snapshot (`destinationWithSecret`) returned with `d`.
 * Refusals, in order: an unreadable stored filter (the scope of what leaves
 * the installation, so never guessed at); a config its
 * type's schema no longer accepts; a secret that is missing where the config
 * needs one, present where it needs none, or fails its type's strict schema —
 * a destination is never sent with partial credentials.
 */
export function prepare(d: ExportDestination, secretText: string | null): Prepared {
  const result = prepareMetadata(d, secretText);
  if (!result.ok) return result;
  const sender = result.sender;
  sender.maxRequestBytes = d.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES[d.type];
  sender.rawPart = (record, client) => {
    const json = recordJson(record, client);
    if (d.type === "webhook") return json;
    if (d.type === "elasticsearch") return `${sender.part(record).split("\n")[0]}\n${json}\n`;
    return otlpPart(record, "logs", json);
  };
  sender.bodySegment = (record, part, text, n, of) => {
    if (d.type === "webhook")
      return {
        sender: {
          ...sender,
          gzip: false,
          body: (parts) => parts.join(""),
          headers: {
            ...sender.headers,
            "x-omni-request-id": record.id,
            "x-omni-body-part": part,
            "x-omni-body-segment": String(n),
            "x-omni-body-segments": String(of),
          },
        },
        part: text,
      };
    if (d.type === "otlp") return { sender, part: otlpBodyPart(record, part, text, n, of) };
    const config = elasticsearchConfigSchema.parse(d.config);
    return {
      sender,
      part: `${JSON.stringify({ index: { _index: indexName(config.bodyIndex, Date.parse(record.at)), _id: `${record.id}:${part}:${n}` } })}\n${JSON.stringify({ requestId: record.id, apiKeyId: record.apiKey.id, at: record.at, part, segment: n, segments: of, text })}\n`,
    };
  };
  return result;
}

function prepareMetadata(d: ExportDestination, secretText: string | null): Prepared {
  if (d.filterMalformed) return refuse(REFUSALS.filter);
  const secret = secretJson(secretText);
  if (secret === UNREADABLE) return refuse(REFUSALS.secret);
  const limits = limitsFor(d);

  switch (d.type) {
    case "elasticsearch": {
      const config = parse(elasticsearchConfigSchema, d.config);
      if (config === null) return refuse(REFUSALS.config);
      const headers: Record<string, string> = { "content-type": BULK_CONTENT_TYPE };
      if (config.auth === "none") {
        if (secret !== null) return refuse(REFUSALS.secret);
      } else if (config.auth === "apiKey") {
        const s = parse(elasticsearchSecretSchemas.apiKey, secret);
        if (s === null) return refuse(REFUSALS.secret);
        headers.authorization = `ApiKey ${s.apiKey}`;
      } else {
        const s = parse(elasticsearchSecretSchemas.basic, secret);
        if (s === null) return refuse(REFUSALS.secret);
        headers.authorization = `Basic ${Buffer.from(`${s.username}:${s.password}`).toString("base64")}`;
      }
      const indexPattern = config.index;
      return {
        ok: true,
        sender: {
          type: d.type,
          url: `${config.url}/_bulk`,
          headers,
          gzip: true,
          envelope: BULK_ENVELOPE,
          limits,
          part(record) {
            try {
              return bulkPart(record, { indexPattern });
            } catch {
              // The encoder's message quotes the configured name.
              throw new IndexRefusedError();
            }
          },
          body: (parts) => parts.join(""),
          signingSecret: null,
          accepted: (text, status) => bulkOutcome(text, status),
        },
      };
    }
    case "webhook": {
      const config = parse(webhookConfigSchema, d.config);
      if (config === null) return refuse(REFUSALS.config);
      const plain = lower(config.headers);
      let secretHeaders: Record<string, string> = {};
      let signingSecret: string | null = null;
      if (secret !== null) {
        const s = parse(webhookSecretSchema, secret);
        if (s === null) return refuse(REFUSALS.secret);
        secretHeaders = lower(s.headers ?? {});
        signingSecret = s.signingSecret ?? null;
        if (Object.keys(secretHeaders).some((name) => name in plain)) {
          return refuse(REFUSALS.secret);
        }
      }
      return {
        ok: true,
        sender: {
          type: d.type,
          // Exactly as stored: the receiver's path is not ours to rewrite.
          url: config.url,
          headers: { ...plain, ...secretHeaders, "content-type": "application/json" },
          // Opt-in for webhooks per the design; part 1's config has no switch for it.
          gzip: false,
          envelope: WEBHOOK_ENVELOPE,
          limits,
          part: webhookPart,
          body: webhookBody,
          signingSecret,
          accepted: (_text, status) => ({ kind: "ok", status, dropped: 0, reasons: [] }),
        },
      };
    }
    case "otlp": {
      const config = parse(otlpConfigSchema, d.config);
      if (config === null) return refuse(REFUSALS.config);
      let secretHeaders: Record<string, string> = {};
      if (secret !== null) {
        const s = parse(otlpSecretSchema, secret);
        if (s === null) return refuse(REFUSALS.secret);
        secretHeaders = lower(s.headers);
      }
      const signal: OtlpSignal = config.signal;
      return {
        ok: true,
        sender: {
          type: d.type,
          url: `${config.endpoint}${OTLP_PATHS[signal]}`,
          headers: { ...secretHeaders, "content-type": "application/json" },
          gzip: true,
          envelope: OTLP_ENVELOPE[signal],
          limits,
          part: (record) => otlpPart(record, signal),
          body: (parts) => otlpBody(parts, signal),
          signingSecret: null,
          accepted(text, status, sent) {
            const { dropped } = readOtlpResponse(json(text), signal, sent);
            return { kind: "ok", status, dropped, reasons: [] };
          },
        },
      };
    }
  }
}

function json(text: string): unknown {
  if (text.length === 0) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** An error type the receiver named but this gateway does not repeat: summarised by status alone. */
const UNKNOWN_REASON = OTHER_ERROR_TYPE;

function bulkOutcome(text: string, status: number): DeliveryOutcome {
  const outcome = readBulkResponse(json(text), status);
  if (outcome.retry) return { kind: "retry", status, error: `HTTP ${status}`, retryAfterMs: null };
  if (outcome.failure !== null) {
    const { reason } = outcome.failure;
    return {
      kind: "failed",
      status,
      error: reason === UNKNOWN_REASON ? `HTTP ${status}` : `HTTP ${status} ${reason}`,
    };
  }
  return {
    kind: "ok",
    status,
    dropped: outcome.dropped.length,
    reasons: distinctReasons(outcome.dropped.map((item) => item.reason)),
  };
}

function distinctReasons(reasons: readonly string[]): string[] {
  return [...new Set(reasons.filter((r) => r !== UNKNOWN_REASON))];
}

/**
 * `dropped N of M[: reason, …]` for `last_error`, at most three distinct
 * reasons, each a fixed identifier; null when nothing was dropped.
 */
export function droppedSummary(
  dropped: number,
  of: number,
  reasons: readonly string[],
): string | null {
  if (dropped === 0) return null;
  const shown = [...new Set(reasons)].slice(0, 3);
  return `dropped ${dropped} of ${of}${shown.length === 0 ? "" : `: ${shown.join(", ")}`}`;
}

/** The two timer calls the worker makes, injectable so tests run on a fake clock. */
export type Timers = {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
};

export type DeliverDeps = {
  transport: Transport;
  /** The batch deadline and the pass's cancellation; an abort propagates as its reason. */
  signal: AbortSignal;
  timers: Timers;
  /** Wall clock, for the webhook signature's timestamp and `Retry-After` dates. */
  now: () => number;
};

const TIMED_OUT = Symbol("request timeout");

/**
 * Sends one batch and says what the receiver's answer means. Resolves for
 * every receiver outcome, a transport failure included; rejects only when
 * `deps.signal` aborts (with its reason), so the caller tells a deadline or a
 * pause apart from a receiver problem.
 */
export async function deliver(
  sender: Sender,
  parts: readonly string[],
  deps: DeliverDeps,
): Promise<DeliveryOutcome> {
  deps.signal.throwIfAborted();
  const text = sender.body(parts);
  const headers: Record<string, string> = { ...sender.headers };
  if (sender.signingSecret !== null) {
    Object.assign(headers, sign(text, sender.signingSecret, Math.floor(deps.now() / 1000)));
  }
  let body: string | Uint8Array = text;
  if (sender.gzip) {
    body = Bun.gzipSync(new TextEncoder().encode(text));
    headers["content-encoding"] = "gzip";
  }

  const request = new AbortController();
  const onAbort = (): void => request.abort(deps.signal.reason);
  deps.signal.addEventListener("abort", onAbort, { once: true });
  const timer = deps.timers.setTimeout(() => request.abort(TIMED_OUT), REQUEST_TIMEOUT_MS);
  try {
    const response = await deps.transport(sender.url, {
      method: "POST",
      headers,
      body,
      signal: request.signal,
      connectTimeoutMs: CONNECT_TIMEOUT_MS,
    });
    const status = response.status;
    // Every answer is read to its end — a cut connection is a transport
    // failure whatever the status said. Only Elasticsearch and OTLP have a
    // reply that means something; the rest is drained and dropped, so a body
    // past the bound matters only where it would be parsed.
    const parsed = sender.type !== "webhook" && (status < 300 || status >= 400);
    let reply = "";
    try {
      if (parsed) reply = await response.text();
      else await response.discard();
    } catch (error) {
      if (request.signal.aborted) throw error;
      if (error instanceof ResponseTooLargeError) {
        // A reply that cannot be read whole cannot be trusted to say "accepted".
        if (status >= 200 && status <= 299) {
          return { kind: "failed", status, error: `HTTP ${status} response too large` };
        }
        reply = "";
      } else {
        const incomplete = error instanceof IncompleteResponseError;
        return {
          kind: "retry",
          status,
          error: incomplete ? "incomplete response" : "network error",
          retryAfterMs: null,
        };
      }
    }
    // Cut mid-body by the timeout or the caller: not an answer to read.
    if (request.signal.aborted) throw request.signal.reason;
    if (status >= 200 && status <= 299) return sender.accepted(reply, status, parts.length);
    if (retryableStatus(status)) {
      const retryAfter = parseRetryAfter(response.headers.get("retry-after"), deps.now());
      return { kind: "retry", status, error: `HTTP ${status}`, retryAfterMs: retryAfter };
    }
    if (sender.type === "elasticsearch" && status >= 400) {
      return bulkOutcome(reply, status);
    }
    // 3xx (never followed) and every other 4xx: the destination's config is wrong.
    return { kind: "failed", status, error: `HTTP ${status}` };
  } catch (error) {
    if (deps.signal.aborted) throw deps.signal.reason;
    if (request.signal.reason === TIMED_OUT) {
      return { kind: "retry", status: null, error: "timeout", retryAfterMs: null };
    }
    if (error instanceof ConnectTimeoutError) {
      return { kind: "retry", status: null, error: "connect timeout", retryAfterMs: null };
    }
    return { kind: "retry", status: null, error: "network error", retryAfterMs: null };
  } finally {
    deps.timers.clearTimeout(timer);
    deps.signal.removeEventListener("abort", onAbort);
  }
}

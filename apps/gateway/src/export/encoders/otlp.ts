import type { BatchEnvelope } from "../batch.ts";
import { RECORD_SCHEMA, type RequestRecord, recordJson } from "../record.ts";

/**
 * OTLP/HTTP JSON encoding of exported records, as `logs` or `traces`.
 *
 * Separate from the gateway's live operational telemetry
 * (`apps/gateway/src/telemetry/`), which is sampled and lossy: this is one span
 * or log record per completed row, delivered at least once. It shares that
 * encoder's conventions — int64 as decimal strings, `service.name =
 * "omnigateway"` — but none of its types.
 *
 * Attributes: the GenAI semantic-convention names the design lists
 * (`gen_ai.request.model`, `gen_ai.response.model`, `gen_ai.system`,
 * `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, plus
 * `gen_ai.operation.name = "chat"`), the session as `session.id`, and every
 * other record field under `omni.*`. A null field and an empty list are left
 * out, never sent empty. `gen_ai.usage.input_tokens` is the whole prompt —
 * the convention counts cached tokens in it — while `omni.tokens.*` keep the
 * row's disjoint classes.
 *
 * Pure: no I/O, no clock.
 */

export type OtlpSignal = "logs" | "traces";

/** Appended to the destination's base endpoint. */
export const OTLP_PATHS = { logs: "/v1/logs", traces: "/v1/traces" } as const satisfies Record<
  OtlpSignal,
  string
>;

type AnyValue =
  | { stringValue: string }
  | { intValue: string }
  | { doubleValue: number }
  | { boolValue: boolean }
  | { arrayValue: { values: AnyValue[] } };
type KeyValue = { key: string; value: AnyValue };

const SCOPE = { name: "omnigateway.log-export", version: RECORD_SCHEMA };
const RESOURCE = { attributes: [{ key: "service.name", value: { stringValue: "omnigateway" } }] };
const SPAN_KIND_CLIENT = 3;
const STATUS_UNSET = 0;
const STATUS_ERROR = 2;
const SEVERITY_INFO = 9;
const SEVERITY_ERROR = 17;

/**
 * Trace and span id for a request, derived from its id alone: SHA-256 of
 * `omni.request_log/v1:trace:<id>` (first 16 bytes) and of
 * `omni.request_log/v1:span:<id>` (first 8 bytes), hex. A resend after a crash
 * or a failover therefore carries the same ids and a receiver that dedupes on
 * them sees one span, not two. Never the live trace's ids: tracing may have
 * been off or sampled out for that request, and the live trace id came from
 * the caller's `traceparent` when it sent one.
 */
export function exportIds(requestId: string): { traceId: string; spanId: string } {
  return {
    traceId: digest(`${RECORD_SCHEMA}:trace:${requestId}`).slice(0, 32),
    spanId: digest(`${RECORD_SCHEMA}:span:${requestId}`).slice(0, 16),
  };
}

function digest(text: string): string {
  return Bun.CryptoHasher.hash("sha256", text, "hex");
}

function failed(record: RequestRecord): boolean {
  return record.status >= 400 || record.errorCode !== null;
}

function nanos(ms: number): string {
  return String(BigInt(Math.round(ms)) * 1_000_000n);
}

function str(value: string): AnyValue {
  return { stringValue: value };
}

/** An OTLP int64 when the number is whole, else a double — never an invalid `intValue`. */
function num(value: number): AnyValue {
  return Number.isSafeInteger(value) ? { intValue: String(value) } : { doubleValue: value };
}

function list(values: readonly string[]): AnyValue {
  return { arrayValue: { values: values.map(str) } };
}

function attributes(record: RequestRecord): KeyValue[] {
  const out: KeyValue[] = [];
  const put = (key: string, value: AnyValue | null): void => {
    if (value !== null) out.push({ key, value });
  };
  const text = (value: string | null): AnyValue | null => (value === null ? null : str(value));
  const strings = (values: readonly string[]): AnyValue | null =>
    values.length === 0 ? null : list(values);
  const { tokens, rtk } = record;

  put("gen_ai.operation.name", str("chat"));
  put("gen_ai.request.model", str(record.model.requested));
  put("gen_ai.response.model", text(record.model.resolved));
  put("gen_ai.system", text(record.model.provider));
  put("gen_ai.usage.input_tokens", num(tokens.input + tokens.cacheRead + tokens.cacheWrite));
  put("gen_ai.usage.output_tokens", num(tokens.output));
  put("session.id", text(record.session.id));

  put("omni.request.id", str(record.id));
  put("omni.completed_at", text(record.completedAt));
  put("omni.node.id", text(record.nodeId));
  put("omni.api_key.id", text(record.apiKey.id));
  put("omni.api_key.label", text(record.apiKey.label));
  put("omni.credential.id", text(record.credentialId));
  put("omni.status", num(record.status));
  put("omni.error_code", text(record.errorCode));
  put("omni.attempts", num(record.attempts));
  put("omni.tokens.input", num(tokens.input));
  put("omni.tokens.cache_read", num(tokens.cacheRead));
  put("omni.tokens.cache_write", num(tokens.cacheWrite));
  // Always a double, so a receiver's field type does not flip on a zero cost.
  put("omni.cost_usd", { doubleValue: record.costUsd });
  put("omni.ttft_ms", record.ttftMs === null ? null : num(record.ttftMs));
  put("omni.duration_ms", num(record.durationMs));
  put("omni.degradations", strings(record.degradations));
  put("omni.rtk.applied", { boolValue: rtk.applied });
  put("omni.rtk.filter_hits", num(rtk.filterHits));
  put("omni.rtk.original_code_units", num(rtk.originalCodeUnits));
  put("omni.rtk.compressed_code_units", num(rtk.compressedCodeUnits));
  put("omni.rtk.estimated_tokens_saved", num(rtk.estimatedTokensSaved));
  put("omni.rtk.filters", strings(rtk.filters));
  put("omni.turn.id", text(record.session.turn));
  put("omni.agent", text(record.session.agent));
  put("omni.tags", strings(record.tags));
  for (const [key, value] of Object.entries(record.metadata))
    put(`omni.metadata.${key}`, str(value));
  put("omni.client.request_id", text(record.requestIds.client));
  put("omni.upstream.request_id", text(record.requestIds.upstream));
  return out;
}

/** `{operation} {model}`, the GenAI span-name convention. */
function title(record: RequestRecord): string {
  return `chat ${record.model.requested}`;
}

function span(record: RequestRecord): unknown {
  const start = Date.parse(record.at);
  return {
    ...exportIds(record.id),
    name: title(record),
    kind: SPAN_KIND_CLIENT,
    startTimeUnixNano: nanos(start),
    endTimeUnixNano: nanos(start + record.durationMs),
    attributes: attributes(record),
    // The message is the gateway's own error code — closed vocabulary, never upstream text.
    status: !failed(record)
      ? { code: STATUS_UNSET }
      : record.errorCode === null
        ? { code: STATUS_ERROR }
        : { code: STATUS_ERROR, message: record.errorCode },
  };
}

function logRecord(record: RequestRecord): unknown {
  const at = Date.parse(record.at);
  const bad = failed(record);
  return {
    timeUnixNano: nanos(at),
    observedTimeUnixNano: nanos(record.completedAt === null ? at : Date.parse(record.completedAt)),
    severityNumber: bad ? SEVERITY_ERROR : SEVERITY_INFO,
    severityText: bad ? "ERROR" : "INFO",
    body: str(title(record)),
    attributes: attributes(record),
    // The same ids the span would carry, so logs and traces of one request join.
    ...exportIds(record.id),
  };
}

const FRAME: Record<OtlpSignal, { open: string; close: string }> = {
  traces: frame("resourceSpans", "scopeSpans", "spans"),
  logs: frame("resourceLogs", "scopeLogs", "logRecords"),
};

function frame(resource: string, scope: string, items: string): { open: string; close: string } {
  const marker = "\u0000";
  const whole = JSON.stringify({
    [resource]: [{ resource: RESOURCE, [scope]: [{ scope: SCOPE, [items]: [marker] }] }],
  });
  const [open, close] = whole.split(JSON.stringify(marker));
  if (open === undefined || close === undefined) throw new Error("unreachable: OTLP frame");
  return { open, close };
}

/** The body around the items, and the `,` between two of them, per signal. */
export const OTLP_ENVELOPE: Record<OtlpSignal, BatchEnvelope> = {
  traces: envelope("traces"),
  logs: envelope("logs"),
};

function envelope(signal: OtlpSignal): BatchEnvelope {
  const { open, close } = FRAME[signal];
  return { fixedBytes: Buffer.byteLength(open) + Buffer.byteLength(close), separatorBytes: 1 };
}

/** One span or log record, encoded. */
export function otlpPart(record: RequestRecord, signal: OtlpSignal, raw?: string): string {
  const inline = raw ?? (record.body === undefined ? undefined : recordJson(record));
  return JSON.stringify(
    signal === "traces"
      ? span(record)
      : { ...logRecordObject(record), ...(inline ? { body: str(inline) } : {}) },
  );
}

function logRecordObject(record: RequestRecord): Record<string, unknown> {
  return logRecord(record) as Record<string, unknown>;
}

export function otlpBodyPart(
  record: RequestRecord,
  part: string,
  text: string,
  n: number,
  of: number,
): string {
  return JSON.stringify({
    timeUnixNano: nanos(Date.parse(record.at)),
    body: str(text),
    attributes: [
      { key: "omni.request.id", value: str(record.id) },
      { key: "omni.body.part", value: str(part) },
      { key: "omni.body.segment", value: num(n) },
      { key: "omni.body.segments", value: num(of) },
    ],
  });
}

/** The request body from parts already encoded by {@link otlpPart}, as the batcher cut them. */
export function otlpBody(parts: readonly string[], signal: OtlpSignal): string {
  const { open, close } = FRAME[signal];
  return `${open}${parts.join(",")}${close}`;
}

export function encodeOtlp(records: readonly RequestRecord[], signal: OtlpSignal): string {
  return otlpBody(
    records.map((record) => otlpPart(record, signal)),
    signal,
  );
}

const REJECTED: Record<OtlpSignal, string> = {
  traces: "rejectedSpans",
  logs: "rejectedLogRecords",
};

/**
 * How many of `sent` items a 2xx export response says it rejected, from
 * `partialSuccess.rejectedSpans` / `rejectedLogRecords` (int64, so a string or
 * a number). Clamped to `sent`; an unreadable count is 0. `errorMessage` is
 * never read: it is receiver free text and can echo content.
 */
export function readOtlpResponse(
  json: unknown,
  signal: OtlpSignal,
  sent: number,
): { dropped: number } {
  if (!isRecord(json) || !isRecord(json.partialSuccess)) return { dropped: 0 };
  const raw = json.partialSuccess[REJECTED[signal]];
  const count =
    typeof raw === "number" ? raw : typeof raw === "string" && /^\d+$/.test(raw) ? Number(raw) : 0;
  if (!Number.isSafeInteger(count) || count < 0) return { dropped: 0 };
  return { dropped: Math.min(count, sent) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

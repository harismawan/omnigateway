import type { ErrorCode, ProviderId } from "@omni/ir";

export type SpanName =
  | "gateway.request"
  | "dispatch.route"
  | "dispatch.attempt"
  | "provider.http"
  | "stream.commit";

export type SpanAttrs = {
  surface?: "anthropic" | "openai" | "responses" | undefined;
  requested_model?: string | undefined;
  api_key_id?: string | undefined;
  status?: number | undefined;
  code?: ErrorCode | "interrupted" | undefined;
  candidates?: number | undefined;
  chosen_provider?: ProviderId | undefined;
  chosen_model?: string | undefined;
  attempt?: number | undefined;
  provider?: ProviderId | undefined;
  model?: string | undefined;
  credential_id?: string | undefined;
  host?: string | undefined;
  path?: string | undefined;
};

export type OnlySpanAttrs<T> = T & Record<Exclude<keyof T, keyof SpanAttrs>, never>;

export type SpanRecord = {
  id: number;
  parent: number | null;
  name: SpanName;
  startMs: number;
  endMs: number;
  attrs: SpanAttrs;
};

export type Traceparent = { traceId: string; parentSpanId: string; sampled: boolean };
export type TraceRecord = {
  startedAt: number;
  traceId: string;
  parentSpanId: string | null;
  spanIds: string[];
  spans: SpanRecord[];
  activeAttempt: number | null;
  routeSpan: number | null;
  nextId: () => string;
};

const TRACEPARENT = /^[\da-f]{2}-([\da-f]{32})-([\da-f]{16})-([\da-f]{2})(?:-[\da-f]+)*$/i;
const ZERO_TRACE = "0".repeat(32);
const ZERO_SPAN = "0".repeat(16);

export function parseTraceparent(value: string | null): Traceparent | null {
  if (value === null) return null;
  const match = TRACEPARENT.exec(value);
  const traceId = match?.[1]?.toLowerCase();
  const parentSpanId = match?.[2]?.toLowerCase();
  const flags = match?.[3];
  if (traceId === undefined || parentSpanId === undefined || flags === undefined) return null;
  if (traceId === ZERO_TRACE || parentSpanId === ZERO_SPAN) return null;
  return { traceId, parentSpanId, sampled: (Number.parseInt(flags, 16) & 1) === 1 };
}

function randomHex(bytes: number): string {
  const out = new Uint8Array(bytes);
  crypto.getRandomValues(out);
  return [...out].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function createTrace(opts: {
  startedAt: number;
  traceparent: Traceparent | null;
  id?: () => string;
}): TraceRecord {
  const id = opts.id ?? (() => randomHex(8));
  return {
    startedAt: opts.startedAt,
    traceId: opts.traceparent?.traceId ?? `${id()}${id()}`.slice(0, 32),
    parentSpanId: opts.traceparent?.parentSpanId ?? null,
    spanIds: [],
    spans: [],
    activeAttempt: null,
    routeSpan: null,
    nextId: id,
  };
}

export function addSpan<T extends SpanAttrs>(
  trace: TraceRecord,
  name: SpanName,
  parent: number | null,
  startMs: number,
  endMs: number,
  attrs: OnlySpanAttrs<T>,
): number {
  try {
    const id = trace.spans.length;
    trace.spanIds.push(trace.nextId());
    trace.spans.push({ id, parent, name, startMs, endMs, attrs });
    return id;
  } catch {
    return -1;
  }
}

type OtlpAttribute = { key: string; value: { stringValue?: string; intValue?: string } };
type OtlpSpan = {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: OtlpAttribute[];
  status: { code: 0 | 2 };
};

export type OtlpTrace = {
  resourceSpans: [
    { resource: { attributes: OtlpAttribute[] }; scopeSpans: [{ spans: OtlpSpan[] }] },
  ];
};

function otlpAttrs(attrs: SpanAttrs): OtlpAttribute[] {
  const out: OtlpAttribute[] = [];
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined) continue;
    out.push(
      typeof value === "number"
        ? { key, value: { intValue: String(value) } }
        : { key, value: { stringValue: value } },
    );
  }
  return out;
}

export function encodeTrace(trace: TraceRecord, serviceVersion: string): OtlpTrace {
  const spans = trace.spans.map((span): OtlpSpan => {
    const parentSpanId =
      span.parent === null
        ? trace.parentSpanId
        : (trace.spanIds[span.parent] ?? trace.parentSpanId);
    return {
      traceId: trace.traceId,
      spanId: trace.spanIds[span.id] ?? trace.nextId(),
      ...(parentSpanId === null ? {} : { parentSpanId }),
      name: span.name,
      startTimeUnixNano: String(BigInt(Math.round(trace.startedAt + span.startMs)) * 1_000_000n),
      endTimeUnixNano: String(BigInt(Math.round(trace.startedAt + span.endMs)) * 1_000_000n),
      attributes: otlpAttrs(span.attrs),
      status: { code: span.attrs.code === undefined ? 0 : 2 },
    };
  });
  return {
    resourceSpans: [
      {
        resource: {
          attributes: [
            { key: "service.name", value: { stringValue: "omnigateway" } },
            { key: "service.version", value: { stringValue: serviceVersion } },
          ],
        },
        scopeSpans: [{ spans }],
      },
    ],
  };
}

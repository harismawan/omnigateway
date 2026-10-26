import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { requestLog } from "@omni/testkit";
import {
  encodeOtlp,
  exportIds,
  OTLP_ENVELOPE,
  OTLP_PATHS,
  type OtlpSignal,
  otlpBody,
  otlpPart,
  readOtlpResponse,
} from "../../src/export/encoders/otlp.ts";
import { buildRecord } from "../../src/export/record.ts";
import { golden } from "./fixtures/golden.ts";
import { FAILURE, LABEL, NODE, SUCCESS } from "./fixtures/rows.ts";

const records = [
  buildRecord(SUCCESS, { keyLabel: LABEL, nodeId: NODE }),
  buildRecord(FAILURE, { keyLabel: null, nodeId: NODE }),
];

type Attr = { key: string; value: Record<string, unknown> };
type Span = {
  traceId: string;
  spanId: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: Attr[];
  status: { code: number; message?: string };
};

function traces(): { resource: { attributes: Attr[] }; spans: Span[] } {
  const body = JSON.parse(encodeOtlp(records, "traces"));
  const rs = body.resourceSpans[0];
  return { resource: rs.resource, spans: rs.scopeSpans[0].spans };
}

function attrs(list: Attr[]): Record<string, unknown> {
  return Object.fromEntries(list.map((a) => [a.key, a.value]));
}

test("the traces body matches its golden file", async () => {
  await golden("otlp-traces.json", encodeOtlp(records, "traces"));
});

test("the logs body matches its golden file", async () => {
  await golden("otlp-logs.json", encodeOtlp(records, "logs"));
});

test("a span carries the GenAI attributes under their exact semantic-convention names", () => {
  const span = attrs(traces().spans[0]?.attributes ?? []);
  expect(span["gen_ai.request.model"]).toEqual({ stringValue: "smart" });
  expect(span["gen_ai.response.model"]).toEqual({ stringValue: "claude-opus-4-1" });
  expect(span["gen_ai.system"]).toEqual({ stringValue: "anthropic" });
  // Semantic conventions count the whole prompt; the row's `inputTokens` is uncached only.
  expect(span["gen_ai.usage.input_tokens"]).toEqual({ intValue: String(1200 + 50_000 + 800) });
  expect(span["gen_ai.usage.output_tokens"]).toEqual({ intValue: "340" });
  expect(span["session.id"]).toEqual({ stringValue: "ses_8f2c" });
  expect(span["omni.tokens.input"]).toEqual({ intValue: "1200" });
});

test("every attribute that is not a GenAI or session one lives under omni.*", () => {
  const known = new Set([
    "gen_ai.operation.name",
    "gen_ai.request.model",
    "gen_ai.response.model",
    "gen_ai.system",
    "gen_ai.usage.input_tokens",
    "gen_ai.usage.output_tokens",
    "session.id",
  ]);
  for (const signal of ["traces", "logs"] as const) {
    const body = JSON.parse(encodeOtlp(records, signal));
    const list: Attr[][] =
      signal === "traces"
        ? body.resourceSpans[0].scopeSpans[0].spans.map((s: Span) => s.attributes)
        : body.resourceLogs[0].scopeLogs[0].logRecords.map(
            (l: { attributes: Attr[] }) => l.attributes,
          );
    for (const attributes of list) {
      for (const { key } of attributes) {
        expect(known.has(key) || key.startsWith("omni.")).toBe(true);
      }
    }
  }
});

test("a span runs from the row's start for its duration, in nanoseconds", () => {
  const span = traces().spans[0];
  const start = BigInt(SUCCESS.at) * 1_000_000n;
  expect(span?.startTimeUnixNano).toBe(String(start));
  expect(span?.endTimeUnixNano).toBe(String(start + BigInt(SUCCESS.durationMs) * 1_000_000n));
  expect(span?.name).toBe("chat smart");
});

test("a failed row's span is an error named by the gateway's code; a success is unset", () => {
  const [ok, failed] = traces().spans;
  expect(ok?.status).toEqual({ code: 0 });
  expect(failed?.status).toEqual({ code: 2, message: "NO_CANDIDATES" });
});

test("null fields are left out rather than sent empty", () => {
  const failed = attrs(traces().spans[1]?.attributes ?? []);
  expect(failed["gen_ai.response.model"]).toBeUndefined();
  expect(failed["gen_ai.system"]).toBeUndefined();
  expect(failed["session.id"]).toBeUndefined();
  expect(failed["omni.ttft_ms"]).toBeUndefined();
  expect(Object.keys(failed).some((key) => key.startsWith("omni.metadata."))).toBe(false);
});

test("the resource names the service as omnigateway", () => {
  for (const signal of ["traces", "logs"] as const) {
    const body = JSON.parse(encodeOtlp(records, signal));
    const resource =
      signal === "traces" ? body.resourceSpans[0].resource : body.resourceLogs[0].resource;
    expect(resource.attributes).toEqual([
      { key: "service.name", value: { stringValue: "omnigateway" } },
    ]);
  }
});

test("span and trace ids are derived from the request id, so a resend is the same span", () => {
  const ids = exportIds(SUCCESS.id);
  const digest = (label: string) =>
    createHash("sha256").update(`omni.request_log/v1:${label}:${SUCCESS.id}`).digest("hex");
  expect(ids).toEqual({
    traceId: digest("trace").slice(0, 32),
    spanId: digest("span").slice(0, 16),
  });
  expect(traces().spans[0]).toMatchObject(ids);
  expect(exportIds(FAILURE.id)).not.toEqual(ids);
  // Rebuilt from scratch, as a resend after a crash would be.
  const again = JSON.parse(encodeOtlp([buildRecord(SUCCESS, { keyLabel: LABEL })], "traces"));
  expect(again.resourceSpans[0].scopeSpans[0].spans[0]).toMatchObject(ids);
});

test("a log record joins its span by the same ids and is an error for a failed row", () => {
  const body = JSON.parse(encodeOtlp(records, "logs"));
  const [ok, failed] = body.resourceLogs[0].scopeLogs[0].logRecords;
  expect(ok).toMatchObject({ ...exportIds(SUCCESS.id), severityNumber: 9, severityText: "INFO" });
  expect(failed).toMatchObject({ severityNumber: 17, severityText: "ERROR" });
  expect(ok.timeUnixNano).toBe(String(BigInt(SUCCESS.at) * 1_000_000n));
});

test("value types follow the OTLP JSON mapping: int64 as strings, arrays, doubles, bools", () => {
  const span = attrs(traces().spans[0]?.attributes ?? []);
  expect(span["omni.cost_usd"]).toEqual({ doubleValue: 0.081234 });
  expect(span["omni.rtk.applied"]).toEqual({ boolValue: true });
  expect(span["omni.tags"]).toEqual({
    arrayValue: { values: [{ stringValue: "team:core" }, { stringValue: "ci" }] },
  });
  expect(span["omni.metadata.__proto__"]).toEqual({ stringValue: "kept" });
  const zero = attrs(
    JSON.parse(
      encodeOtlp([buildRecord(requestLog({ id: "r", costUsd: 0 }), { keyLabel: null })], "traces"),
    ).resourceSpans[0].scopeSpans[0].spans[0].attributes,
  );
  expect(zero["omni.cost_usd"]).toEqual({ doubleValue: 0 });
});

test("the body is its parts joined inside the declared envelope", () => {
  for (const signal of ["traces", "logs"] satisfies OtlpSignal[]) {
    const parts = records.map((record) => otlpPart(record, signal));
    expect(otlpBody(parts, signal)).toBe(encodeOtlp(records, signal));
    expect(Buffer.byteLength(otlpBody([], signal))).toBe(OTLP_ENVELOPE[signal].fixedBytes);
    expect(OTLP_ENVELOPE[signal].separatorBytes).toBe(1);
  }
  expect(OTLP_PATHS).toEqual({ logs: "/v1/logs", traces: "/v1/traces" });
});

test("partialSuccess rejections are a dropped count; its message is never read", () => {
  expect(readOtlpResponse({}, "traces", 10)).toEqual({ dropped: 0 });
  expect(readOtlpResponse(null, "logs", 10)).toEqual({ dropped: 0 });
  expect(readOtlpResponse({ partialSuccess: {} }, "logs", 10)).toEqual({ dropped: 0 });
  expect(
    readOtlpResponse(
      { partialSuccess: { rejectedSpans: "3", errorMessage: "bad span: <content>" } },
      "traces",
      10,
    ),
  ).toEqual({ dropped: 3 });
  expect(readOtlpResponse({ partialSuccess: { rejectedLogRecords: 2 } }, "logs", 10)).toEqual({
    dropped: 2,
  });
  // The other signal's counter is not this signal's.
  expect(readOtlpResponse({ partialSuccess: { rejectedSpans: 2 } }, "logs", 10)).toEqual({
    dropped: 0,
  });
  // A receiver cannot reject more than it was sent, nor a negative or fractional count.
  expect(readOtlpResponse({ partialSuccess: { rejectedSpans: "99" } }, "traces", 10)).toEqual({
    dropped: 10,
  });
  for (const bad of [-1, 1.5, "x", "-2", true]) {
    expect(readOtlpResponse({ partialSuccess: { rejectedSpans: bad } }, "traces", 10)).toEqual({
      dropped: 0,
    });
  }
});

import { expect, test } from "bun:test";
import { DEFAULT_INDEX_PATTERN } from "@omni/control/exportIndex";
import { requestLog } from "@omni/testkit";
import {
  BULK_ENVELOPE,
  bulkPart,
  ES_ERROR_TYPES,
  encodeBulk,
  indexName,
  readBulkResponse,
} from "../../src/export/encoders/elasticsearch.ts";
import { buildRecord } from "../../src/export/record.ts";
import { golden } from "./fixtures/golden.ts";
import { FAILURE, LABEL, NODE, SUCCESS } from "./fixtures/rows.ts";

const records = [
  buildRecord(SUCCESS, { keyLabel: LABEL, nodeId: NODE }),
  buildRecord(FAILURE, { keyLabel: null, nodeId: NODE }),
];
const opts = { indexPattern: DEFAULT_INDEX_PATTERN };

test("the bulk body matches its golden file", async () => {
  await golden("elasticsearch-bulk.ndjson", encodeBulk(records, opts));
});

test("each action names the request id as _id and the row's UTC start day as _index", () => {
  const lines = encodeBulk(records, opts).split("\n");
  expect(DEFAULT_INDEX_PATTERN).toBe("omni-logs-{yyyy.MM.dd}");
  // SUCCESS starts 23:59:59 UTC on the 24th and completes on the 25th: the
  // index follows `at`, in UTC, never the completion or the host's zone.
  expect(JSON.parse(lines[0] ?? "")).toEqual({
    index: { _index: "omni-logs-2026.10.24", _id: SUCCESS.id },
  });
  expect(JSON.parse(lines[1] ?? "")).toEqual(records[0]);
  expect(JSON.parse(lines[2] ?? "")).toEqual({
    index: { _index: "omni-logs-2026.10.25", _id: FAILURE.id },
  });
  expect(lines).toHaveLength(5);
  expect(lines.at(-1)).toBe("");
});

test("the body is its parts concatenated, with no envelope, ending in one newline", () => {
  const body = encodeBulk(records, opts);
  expect(body).toBe(records.map((record) => bulkPart(record, opts)).join(""));
  expect(BULK_ENVELOPE).toEqual({ fixedBytes: 0, separatorBytes: 0 });
  expect(body.endsWith("}\n")).toBe(true);
  expect(body.endsWith("\n\n")).toBe(false);
  expect(encodeBulk([], opts)).toBe("");
});

test("an index pattern keeps everything outside the date token verbatim", () => {
  const at = Date.UTC(2026, 0, 5, 1, 2, 3);
  expect(indexName("omni-logs-{yyyy.MM.dd}", at)).toBe("omni-logs-2026.01.05");
  expect(indexName("team-a-{yyyy.MM.dd}-v2", at)).toBe("team-a-2026.01.05-v2");
  expect(indexName("static-index", at)).toBe("static-index");
  expect(indexName("{yyyy.MM.dd}-{yyyy.MM.dd}", at)).toBe("2026.01.05-2026.01.05");
  expect(indexName("logs-{yyyy}", at)).toBe("logs-{yyyy}");
});

test("an index name Elasticsearch would refuse is refused before sending", () => {
  // A refused name comes back as a per-item 400 on every document, which reads
  // as "drop the batch": the destination would discard everything it sends.
  expect(() => indexName("Omni-{yyyy.MM.dd}", 0)).toThrow(/lowercase/);
  expect(() =>
    encodeBulk([buildRecord(requestLog({ id: "r" }), { keyLabel: null })], {
      indexPattern: "LOGS",
    }),
  ).toThrow(/lowercase/);
  // The name rule itself is `@omni/control`'s, tested there; here, that the
  // encoder applies it after expansion.
  expect(() => indexName("a b-{yyyy.MM.dd}", 0)).toThrow(/cannot contain/);
  expect(() => indexName(`${"a".repeat(246)}{yyyy.MM.dd}`, 0)).toThrow(/255 bytes/);
  expect(indexName(`${"a".repeat(245)}{yyyy.MM.dd}`, 0)).toHaveLength(255);
});

test("errors:false commits everything without reading items", () => {
  expect(readBulkResponse({ errors: false, items: "not even read" }, 200)).toEqual({
    retry: false,
    dropped: [],
    failure: null,
  });
});

test("a retryable item status anywhere fails the whole batch for retry", () => {
  for (const status of [429, 500, 503]) {
    const out = readBulkResponse(
      {
        errors: true,
        items: [
          { index: { _id: "a", status: 201 } },
          { index: { _id: "b", status: 400, error: { type: "mapper_parsing_exception" } } },
          { index: { _id: "c", status, error: { type: "es_rejected_execution_exception" } } },
        ],
      },
      200,
    );
    expect(out).toEqual({ retry: true, dropped: [], failure: null });
  }
});

test("non-retryable item errors are dropped by error.type and the batch commits", () => {
  const out = readBulkResponse(
    {
      errors: true,
      items: [
        { index: { _id: "a", status: 200 } },
        {
          index: {
            _id: "b",
            status: 400,
            error: {
              type: "mapper_parsing_exception",
              reason: "failed to parse field [metadata.ticket] value [sk-secret-echoed-back]",
            },
          },
        },
        { index: { _id: "c", status: 409, error: { type: "version_conflict_engine_exception" } } },
      ],
    },
    200,
  );
  expect(out).toEqual({
    retry: false,
    dropped: [
      { id: "b", status: 400, reason: "mapper_parsing_exception" },
      { id: "c", status: 409, reason: "version_conflict_engine_exception" },
    ],
    failure: null,
  });
  // The receiver's free text can echo document content; it never survives.
  expect(JSON.stringify(out)).not.toContain("secret");
});

test("an item error with no usable type is dropped as other, never echoed", () => {
  const out = readBulkResponse(
    {
      errors: true,
      items: [
        { index: { status: 400, error: "bare string reason" } },
        { index: { _id: "a", status: 400, error: { type: "has spaces: and text" } } },
        { index: { _id: 7, status: 400, error: { type: "x".repeat(200) } } },
      ],
    },
    200,
  );
  expect(out).toEqual({
    retry: false,
    dropped: [
      { id: null, status: 400, reason: "other" },
      { id: "a", status: 400, reason: "other" },
      { id: null, status: 400, reason: "other" },
    ],
    failure: null,
  });
});

test("a top-level retryable status asks for a retry whatever the body says", () => {
  for (const status of [408, 429, 500, 502, 503]) {
    expect(readBulkResponse({ errors: false }, status)).toEqual({
      retry: true,
      dropped: [],
      failure: null,
    });
  }
});

test("a top-level hard status is a failure named by error.type and status only", () => {
  expect(
    readBulkResponse(
      {
        error: { type: "security_exception", reason: "unable to authenticate user [x]" },
        status: 401,
      },
      401,
    ),
  ).toEqual({ retry: false, dropped: [], failure: { status: 401, reason: "security_exception" } });
  expect(readBulkResponse("<html>Forbidden</html>", 403)).toEqual({
    retry: false,
    dropped: [],
    failure: { status: 403, reason: "other" },
  });
});

test("a success status with an unreadable body is a failure, never a silent commit", () => {
  for (const json of [
    null,
    "text",
    [],
    {},
    { errors: true },
    { errors: true, items: {} },
    { errors: true, items: [42] },
    { errors: true, items: [{ index: { _id: "a" } }] },
    { errors: true, items: [{ create: { _id: "a", status: 201 } }] },
  ]) {
    expect(readBulkResponse(json, 200)).toEqual({
      retry: false,
      dropped: [],
      failure: { status: 200, reason: "unreadable-bulk-response" },
    });
  }
});

test("an identifier-shaped error.type outside the known set is never echoed: top level and per item", () => {
  const canary = "SECRET_CANARY_123";
  const top = readBulkResponse({ error: { type: canary } }, 401);
  expect(top).toEqual({ retry: false, dropped: [], failure: { status: 401, reason: "other" } });
  const items = readBulkResponse(
    { errors: true, items: [{ index: { _id: "a", status: 400, error: { type: canary } } }] },
    200,
  );
  expect(items).toEqual({
    retry: false,
    dropped: [{ id: "a", status: 400, reason: "other" }],
    failure: null,
  });
  expect(JSON.stringify([top, items])).not.toContain(canary);
});

test("the recognised error types are a closed, documented set", () => {
  expect([...ES_ERROR_TYPES].sort()).toEqual([
    "circuit_breaking_exception",
    "cluster_block_exception",
    "document_parsing_exception",
    "es_rejected_execution_exception",
    "illegal_argument_exception",
    "index_not_found_exception",
    "mapper_parsing_exception",
    "security_exception",
    "strict_dynamic_mapping_exception",
    "version_conflict_engine_exception",
  ]);
  for (const type of ES_ERROR_TYPES) {
    expect(readBulkResponse({ error: { type } }, 400).failure?.reason).toBe(type);
  }
});

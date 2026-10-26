import { expect, test } from "bun:test";
import { requestLog } from "@omni/testkit";
import { buildRecord, RECORD_SCHEMA } from "../../src/export/record.ts";
import { golden } from "./fixtures/golden.ts";
import { FAILURE, LABEL, NODE, SUCCESS } from "./fixtures/rows.ts";

test("the record of a full row matches its golden file, key order included", async () => {
  await golden(
    "record-success.json",
    JSON.stringify(buildRecord(SUCCESS, { keyLabel: LABEL, nodeId: NODE })),
  );
});

test("a row with every nullable field null keeps the same shape, nulls in place", async () => {
  await golden("record-failure.json", JSON.stringify(buildRecord(FAILURE, { keyLabel: null })));
});

test("the record carries the schema name and never a body or prompts field", () => {
  const record = buildRecord(SUCCESS, { keyLabel: LABEL });
  expect(RECORD_SCHEMA).toBe("omni.request_log/v1");
  expect(record.schema).toBe(RECORD_SCHEMA);
  expect(Object.keys(record)).not.toContain("body");
  expect(Object.keys(record)).not.toContain("prompts");
});

test("a key label is never attached to a row with no key", () => {
  const record = buildRecord(FAILURE, { keyLabel: "stale label" });
  expect(record.apiKey).toEqual({ id: null, label: null });
});

test("metadata keys are sorted so both backends' JSON column orders give one record", () => {
  const a = requestLog({ id: "r", traceMetadata: { b: "2", a: "1" } });
  const b = requestLog({ id: "r", traceMetadata: { a: "1", b: "2" } });
  expect(JSON.stringify(buildRecord(a, { keyLabel: null }))).toBe(
    JSON.stringify(buildRecord(b, { keyLabel: null })),
  );
  expect(Object.keys(buildRecord(a, { keyLabel: null }).metadata)).toEqual(["a", "b"]);
});

test("a `__proto__` metadata key is ordinary data in the record and its JSON", () => {
  const record = buildRecord(SUCCESS, { keyLabel: null });
  expect(Object.hasOwn(record.metadata, "__proto__")).toBe(true);
  const parsed = JSON.parse(JSON.stringify(record));
  expect(Object.getOwnPropertyDescriptor(parsed.metadata, "__proto__")?.value).toBe("kept");
});

test("the record shares no array or object with the row it was built from", () => {
  const row = requestLog({
    id: "r",
    tags: ["t"],
    degradations: ["d"],
    rtkFilters: ["grep"],
    traceMetadata: {},
  });
  const record = buildRecord(row, { keyLabel: null });
  row.tags.push("later");
  row.degradations.push("later");
  row.rtkFilters.push("git-diff");
  row.traceMetadata.k = "later";
  expect(record.tags).toEqual(["t"]);
  expect(record.degradations).toEqual(["d"]);
  expect(record.rtk.filters).toEqual(["grep"]);
  expect(record.metadata).toEqual({});
});

test("an absent node id is null, not missing, so every record has one shape", () => {
  const record = buildRecord(FAILURE, { keyLabel: null });
  expect(record.nodeId).toBeNull();
  expect(Object.keys(record)).toEqual(
    Object.keys(buildRecord(SUCCESS, { keyLabel: LABEL, nodeId: NODE })),
  );
});

test("instants are ISO UTC with milliseconds; a row not yet stamped completes null", () => {
  const record = buildRecord(SUCCESS, { keyLabel: null });
  expect(record.at).toBe("2026-10-24T23:59:59.120Z");
  expect(record.completedAt).toBe("2026-10-25T00:00:01.470Z");
  expect(
    buildRecord(requestLog({ id: "r", completedAt: null }), { keyLabel: null }).completedAt,
  ).toBeNull();
});

test("the same row builds byte-identical JSON every time", () => {
  const ctx = { keyLabel: LABEL, nodeId: NODE };
  expect(JSON.stringify(buildRecord(SUCCESS, ctx))).toBe(JSON.stringify(buildRecord(SUCCESS, ctx)));
});

import { expect, test } from "bun:test";
import { cutBatches, MAX_BATCH_BYTES, MAX_BATCH_RECORDS } from "../../src/export/batch.ts";

const NONE = { fixedBytes: 0, separatorBytes: 0 };

test("the caps are 500 records and 5 MiB", () => {
  expect(MAX_BATCH_RECORDS).toBe(500);
  expect(MAX_BATCH_BYTES).toBe(5 * 1024 * 1024);
});

test("records are cut at 500 whatever their size, in order", () => {
  const parts = Array.from({ length: 1201 }, (_, i) => String(i));
  const batches = [...cutBatches(parts, NONE)];
  expect(batches.map((b) => b.length)).toEqual([500, 500, 201]);
  expect(batches.flat()).toEqual(parts);
});

test("bytes are counted as UTF-8, envelope and separators included, up to the cap exactly", () => {
  // "é" is two UTF-8 bytes but one UTF-16 unit: a `.length` count would fit three here.
  const envelope = { fixedBytes: 4, separatorBytes: 1 };
  const limits = { records: 500, bytes: 4 + 4 + 1 + 4 };
  expect([...cutBatches(["éé", "éé", "éé"], envelope, limits)]).toEqual([["éé", "éé"], ["éé"]]);
  expect([...cutBatches(["éé", "éé"], envelope, { records: 500, bytes: 12 })]).toEqual([
    ["éé"],
    ["éé"],
  ]);
});

test("a single record over the byte cap goes alone in its own batch", () => {
  const limits = { records: 500, bytes: 10 };
  expect([...cutBatches(["a", "x".repeat(50), "b"], NONE, limits)]).toEqual([
    ["a"],
    ["x".repeat(50)],
    ["b"],
  ]);
});

test("the default byte cap is 5 MiB", () => {
  const half = "x".repeat(MAX_BATCH_BYTES / 2);
  expect([...cutBatches([half, half, "y"], NONE)].map((b) => b.length)).toEqual([2, 1]);
  const envelope = { fixedBytes: 1, separatorBytes: 0 };
  expect([...cutBatches([half, half], envelope)].map((b) => b.length)).toEqual([1, 1]);
});

test("nothing in, nothing out; and batches are produced lazily", () => {
  expect([...cutBatches([], NONE)]).toEqual([]);
  let pulled = 0;
  function* source(): Generator<string> {
    for (let i = 0; ; i++) {
      pulled++;
      yield String(i);
    }
  }
  const first = cutBatches(source(), NONE).next();
  expect(first.value).toHaveLength(500);
  // A full batch is handed over without reading ahead.
  expect(pulled).toBe(500);
});

test("limits that cannot hold a batch are a caller bug", () => {
  for (const limits of [
    { records: 0, bytes: 10 },
    { records: 1.5, bytes: 10 },
    { records: 10, bytes: 0 },
  ]) {
    expect(() => [...cutBatches(["a"], NONE, limits)]).toThrow();
  }
});

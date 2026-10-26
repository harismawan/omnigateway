import { expect, test } from "bun:test";
import {
  type BatchCut,
  cutBatches,
  MAX_BATCH_BYTES,
  MAX_BATCH_RECORDS,
  OVERSIZED_REASON,
} from "../../src/export/batch.ts";

const NONE = { fixedBytes: 0, separatorBytes: 0 };

/** Batches only, as part lists. */
function batches(cuts: Iterable<BatchCut>): string[][] {
  return [...cuts].flatMap((cut) => (cut.kind === "batch" ? [cut.parts] : []));
}

test("the caps are 500 records and 5 MiB", () => {
  expect(MAX_BATCH_RECORDS).toBe(500);
  expect(MAX_BATCH_BYTES).toBe(5 * 1024 * 1024);
});

test("records are cut at 500 whatever their size, in order, with their input positions", () => {
  const parts = Array.from({ length: 1201 }, (_, i) => String(i));
  const cuts = [...cutBatches(parts, NONE)];
  expect(cuts.map((cut) => (cut.kind === "batch" ? [cut.start, cut.parts.length] : null))).toEqual([
    [0, 500],
    [500, 500],
    [1000, 201],
  ]);
  expect(batches(cuts).flat()).toEqual(parts);
});

test("bytes are counted as UTF-8, envelope and separators included, up to the cap exactly", () => {
  // "é" is two UTF-8 bytes but one UTF-16 unit: a `.length` count would fit three here.
  const envelope = { fixedBytes: 4, separatorBytes: 1 };
  const limits = { records: 500, bytes: 4 + 4 + 1 + 4 };
  expect(batches(cutBatches(["éé", "éé", "éé"], envelope, limits))).toEqual([["éé", "éé"], ["éé"]]);
  expect(batches(cutBatches(["éé", "éé"], envelope, { records: 500, bytes: 12 }))).toEqual([
    ["éé"],
    ["éé"],
  ]);
});

test("a record that cannot fit even alone is yielded as oversized, in place, never batched", () => {
  const envelope = { fixedBytes: 2, separatorBytes: 1 };
  const limits = { records: 500, bytes: 10 };
  // 8 bytes fits alone with the envelope (exactly 10); 9 does not.
  const cuts = [...cutBatches(["a", "b", "x".repeat(9), "y".repeat(8), "c"], envelope, limits)];
  expect(cuts).toEqual([
    { kind: "batch", start: 0, parts: ["a", "b"] },
    { kind: "oversized", index: 2, bytes: 9, reason: OVERSIZED_REASON },
    { kind: "batch", start: 3, parts: ["y".repeat(8)] },
    { kind: "batch", start: 4, parts: ["c"] },
  ]);
  expect(OVERSIZED_REASON).toBe("record-too-large");
});

test("no yielded batch ever exceeds the default 5 MiB, at one byte over", () => {
  const over = "x".repeat(MAX_BATCH_BYTES + 1);
  const cuts = [...cutBatches(["a", over, "b"], NONE)];
  expect(cuts).toEqual([
    { kind: "batch", start: 0, parts: ["a"] },
    { kind: "oversized", index: 1, bytes: MAX_BATCH_BYTES + 1, reason: OVERSIZED_REASON },
    { kind: "batch", start: 2, parts: ["b"] },
  ]);
  // With an envelope, a part of exactly the cap no longer fits alone either.
  const exact = "x".repeat(MAX_BATCH_BYTES);
  expect([...cutBatches([exact], { fixedBytes: 1, separatorBytes: 0 })]).toEqual([
    { kind: "oversized", index: 0, bytes: MAX_BATCH_BYTES, reason: OVERSIZED_REASON },
  ]);
  expect([...cutBatches([exact], NONE)]).toEqual([{ kind: "batch", start: 0, parts: [exact] }]);
});

test("over many mixes of sizes, every batch fits both caps and nothing is lost or reordered", () => {
  const envelope = { fixedBytes: 3, separatorBytes: 1 };
  const limits = { records: 7, bytes: 40 };
  let seed = 1;
  const next = (): number => {
    seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
    return seed;
  };
  for (let round = 0; round < 200; round++) {
    const parts = Array.from({ length: next() % 30 }, (_, i) => `${i}`.padEnd(next() % 45, "é"));
    const seen: number[] = [];
    for (const cut of cutBatches(parts, envelope, limits)) {
      if (cut.kind === "oversized") {
        expect(envelope.fixedBytes + cut.bytes).toBeGreaterThan(limits.bytes);
        seen.push(cut.index);
        continue;
      }
      const encoded =
        envelope.fixedBytes +
        cut.parts.reduce((n, p) => n + Buffer.byteLength(p), 0) +
        envelope.separatorBytes * (cut.parts.length - 1);
      expect(encoded).toBeLessThanOrEqual(limits.bytes);
      expect(cut.parts.length).toBeLessThanOrEqual(limits.records);
      expect(cut.parts).toEqual(parts.slice(cut.start, cut.start + cut.parts.length));
      for (let i = 0; i < cut.parts.length; i++) seen.push(cut.start + i);
    }
    expect(seen).toEqual(parts.map((_, i) => i));
  }
});

test("the default byte cap is 5 MiB", () => {
  const half = "x".repeat(MAX_BATCH_BYTES / 2);
  expect(batches(cutBatches([half, half, "y"], NONE)).map((b) => b.length)).toEqual([2, 1]);
  const envelope = { fixedBytes: 1, separatorBytes: 0 };
  expect(batches(cutBatches([half, half], envelope)).map((b) => b.length)).toEqual([1, 1]);
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
  const first = cutBatches(source(), NONE).next().value;
  expect(first?.kind === "batch" ? first.parts : []).toHaveLength(500);
  // A full batch is handed over without reading ahead.
  expect(pulled).toBe(500);
});

test("limits that cannot hold a batch are a caller bug", () => {
  for (const limits of [
    { records: 0, bytes: 10 },
    { records: 1.5, bytes: 10 },
    { records: 10, bytes: 0 },
  ]) {
    expect(() => [...cutBatches(["a"], NONE, limits)]).toThrow(RangeError);
  }
});

test("limits may tighten the design caps but never raise them", () => {
  expect(() => [...cutBatches(["a"], NONE, { records: MAX_BATCH_RECORDS + 1, bytes: 10 })]).toThrow(
    /500/,
  );
  expect(() => [...cutBatches(["a"], NONE, { records: 10, bytes: MAX_BATCH_BYTES + 1 })]).toThrow(
    /5242880/,
  );
  // Exactly at both caps is the default, and allowed.
  const parts = Array.from({ length: MAX_BATCH_RECORDS + 1 }, () => "a");
  expect(
    batches(cutBatches(parts, NONE, { records: MAX_BATCH_RECORDS, bytes: MAX_BATCH_BYTES })).map(
      (b) => b.length,
    ),
  ).toEqual([500, 1]);
});

test("an envelope that is not whole non-negative bytes is a caller bug", () => {
  for (const envelope of [
    { fixedBytes: -1, separatorBytes: 0 },
    { fixedBytes: 0, separatorBytes: 0.5 },
  ]) {
    expect(() => [...cutBatches(["a"], envelope)]).toThrow(RangeError);
  }
});

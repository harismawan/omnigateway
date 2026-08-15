import { expect, test } from "bun:test";
import type { Store, UsageBucket } from "@omni/store";
import { memoryStore, requestLog } from "@omni/testkit";
import { logLimit, queryUsage } from "../src/usage.ts";

const HOUR = 3_600_000;
const NOW = 1_700_000_000_000;

async function seeded(): Promise<Store> {
  const store = await memoryStore();
  await store.usage.append(requestLog({ id: "r1", at: NOW - 2 * HOUR, outputTokens: 10 }));
  await store.usage.append(requestLog({ id: "r2", at: NOW - HOUR, outputTokens: 20 }));
  return store;
}

async function rowsOf(
  store: Store,
  input: Parameters<typeof queryUsage>[1] = {},
): Promise<UsageBucket[]> {
  return queryUsage({ store, now: () => NOW }, { groupBy: "hour", ...input });
}

test("an absent span covers everything up to now", async () => {
  const rows = await rowsOf(await seeded());

  expect(rows.map((row) => row.outputTokens)).toEqual([20, 10]);
});

test("an empty upper bound reads as absent rather than as the epoch", async () => {
  // `?until=` is what a form or a hand-built query string produces, and
  // `Number("")` is 0 — so an unguarded upper bound clamps the span to the
  // epoch and answers "no usage" where the operator asked for all of it.
  const rows = await rowsOf(await seeded(), { until: "" });

  expect(rows.map((row) => row.outputTokens)).toEqual([20, 10]);
});

test("an empty lower bound reads as absent", async () => {
  const rows = await rowsOf(await seeded(), { since: "" });

  expect(rows.map((row) => row.outputTokens)).toEqual([20, 10]);
});

test("whitespace is treated the same way as an empty param", async () => {
  const rows = await rowsOf(await seeded(), { since: "  ", until: "\t" });

  expect(rows.map((row) => row.outputTokens)).toEqual([20, 10]);
});

test("a literal zero is a bound, not an absent param", async () => {
  // The whole point of the blank guard is that it distinguishes "nothing was
  // sent" from "the epoch was sent". A guard that swallowed `"0"` would answer
  // this query with everything.
  const rows = await rowsOf(await seeded(), { until: "0" });

  expect(rows).toEqual([]);
});

test("the strings a query string produces still bound the span", async () => {
  const store = await seeded();

  const upper = await rowsOf(store, { until: String(NOW - 2 * HOUR) });
  expect(upper.map((row) => row.outputTokens)).toEqual([10]);

  const lower = await rowsOf(store, { since: String(NOW - HOUR) });
  expect(lower.map((row) => row.outputTokens)).toEqual([20]);
});

test("a string that is not a number falls back to the open bound", async () => {
  const store = await seeded();

  // Only epoch milliseconds are understood here; a date the operator typed is
  // unusable rather than fatal, and the span stays open.
  expect((await rowsOf(store, { until: "yesterday" })).map((row) => row.outputTokens)).toEqual([
    20, 10,
  ]);
  expect((await rowsOf(store, { since: "yesterday" })).map((row) => row.outputTokens)).toEqual([
    20, 10,
  ]);
});

test("an empty page size reads as absent rather than as zero", async () => {
  // `Number("")` is 0 here too. The clamp floors it at one, so `?limit=` would
  // answer a page of one row instead of the default page.
  expect(logLimit("")).toBe(logLimit(undefined));
  expect(logLimit("   ")).toBe(logLimit(undefined));
  // A zero the caller actually sent still clamps, as any out-of-range value does.
  expect(logLimit("0")).toBe(1);
});

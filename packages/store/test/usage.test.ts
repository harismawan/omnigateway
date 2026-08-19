import { expect, test } from "bun:test";
import { RTK_FILTER_IDS } from "@omni/rtk/catalog";
import { deriveKey } from "../src/encryption.ts";
import { openDb } from "../src/sqlite/db.ts";
import { backfillDaily, backfillRtkUsage, startOfLocalDay } from "../src/sqlite/rollup.ts";
import { createStore } from "../src/sqlite/store.ts";
import type { RequestLog, Store } from "../src/types.ts";

const DAY_MS = 86_400_000;

async function store(): Promise<Store> {
  return createStore({
    path: ":memory:",
    encryptionKey: await deriveKey("test-secret-value-for-unit-tests"),
  });
}

function log(patch: Partial<RequestLog> & { id: string; at: number }): RequestLog {
  return {
    state: "done",
    apiKeyId: "k1",
    requestedModel: "fast",
    resolvedProvider: "anthropic",
    resolvedModel: "claude-opus-4",
    credentialId: "c1",
    attempts: 1,
    status: 200,
    errorCode: null,
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 20,
    cacheWriteTokens: 10,
    ttftMs: 300,
    durationMs: 1200,
    costUsd: 0.005,
    degradations: [],
    rtkApplied: false,
    rtkFilterHits: 0,
    rtkOriginalCodeUnits: 0,
    rtkCompressedCodeUnits: 0,
    rtkEstimatedTokensSaved: 0,
    rtkFilters: [],
    ...patch,
  };
}

/** Noon, so a test's arithmetic never straddles a local midnight by accident. */
function noon(daysAgo: number): number {
  return startOfLocalDay(Date.now() - daysAgo * DAY_MS) + 12 * 3_600_000;
}

test("request logs round-trip RTK aggregate metrics", async () => {
  const s = await store();
  await s.usage.append(
    log({
      id: "rtk",
      at: noon(0),
      rtkApplied: true,
      rtkFilterHits: 2,
      rtkOriginalCodeUnits: 2_000,
      rtkCompressedCodeUnits: 700,
      rtkEstimatedTokensSaved: 325,
      rtkFilters: ["test-output", "deduplicate-log"],
    }),
  );
  expect((await s.usage.recent(1))[0]).toMatchObject({
    rtkApplied: true,
    rtkFilterHits: 2,
    rtkFilters: ["test-output", "deduplicate-log"],
  });
  s.close();
});

test("every catalog filter ID round-trips while invalid values are excluded", async () => {
  const s = await store();
  await s.usage.append(log({ id: "catalog", at: noon(0), rtkFilters: [...RTK_FILTER_IDS] }));
  expect((await s.usage.recent(1))[0]?.rtkFilters).toEqual([...RTK_FILTER_IDS]);
  s.close();
});

test("appending a log rolls it into the day it happened on", async () => {
  const s = await store();
  await s.usage.append(log({ id: "r1", at: noon(0) }));
  await s.usage.append(log({ id: "r2", at: noon(0) + 60_000, status: 500 }));
  await s.usage.append(log({ id: "r3", at: noon(1) }));

  const days = await s.usage.aggregate({ since: noon(3), grain: "daily", groupBy: "day" });
  const today = days.find((row) => row.key === String(startOfLocalDay(noon(0))));
  expect(today?.requests).toBe(2);
  expect(today?.errors).toBe(1);
  expect(today?.inputTokens).toBe(200);
  expect(today?.cacheReadTokens).toBe(40);
  expect(today?.rtkSavedTokens).toBe(0);
  expect(today?.rtkAppliedRequests).toBe(0);
  expect(today?.durationMsSum).toBe(2400);
  expect(days.find((row) => row.key === String(startOfLocalDay(noon(1))))?.requests).toBe(1);
  s.close();
});

test("usage aggregates RTK savings and applied request counts", async () => {
  const s = await store();
  await s.usage.append(
    log({
      id: "rtk-1",
      at: noon(0),
      rtkApplied: true,
      rtkEstimatedTokensSaved: 325,
    }),
  );
  await s.usage.append(
    log({
      id: "rtk-2",
      at: noon(0),
      rtkApplied: true,
      rtkEstimatedTokensSaved: 75,
    }),
  );
  await s.usage.append(log({ id: "plain", at: noon(0) }));

  for (const grain of ["raw", "daily"] as const) {
    const [bucket] = await s.usage.aggregate({ since: noon(2), grain, groupBy: "provider" });
    expect(bucket?.rtkSavedTokens).toBe(400);
    expect(bucket?.rtkAppliedRequests).toBe(2);
  }
  s.close();
});

test("the rollup outlives the raw logs it summarizes", async () => {
  const s = await store();
  await s.usage.append(log({ id: "r1", at: noon(200) }));

  expect(await s.usage.prune(Date.now() - 30 * DAY_MS)).toBe(1);
  expect(await s.usage.recent(10)).toHaveLength(0);

  const days = await s.usage.aggregate({ since: noon(365), grain: "daily", groupBy: "day" });
  expect(days).toHaveLength(1);
  expect(days[0]?.requests).toBe(1);
  s.close();
});

test("pruneDaily drops rollup rows past its own, longer horizon", async () => {
  const s = await store();
  await s.usage.append(log({ id: "old", at: noon(401) }));
  await s.usage.append(log({ id: "new", at: noon(1) }));

  expect(await s.usage.pruneDaily(Date.now() - 400 * DAY_MS)).toBe(1);
  const days = await s.usage.aggregate({ since: noon(500), grain: "daily", groupBy: "day" });
  expect(days).toHaveLength(1);
  expect(days[0]?.key).toBe(String(startOfLocalDay(noon(1))));
  s.close();
});

test("a daily window includes the whole of its first, partial day", async () => {
  const s = await store();
  const at = startOfLocalDay(Date.now()) + 3_600_000;
  await s.usage.append(log({ id: "r1", at }));

  // Asking from mid-morning still reports the request logged at 01:00.
  const days = await s.usage.aggregate({
    since: at + 8 * 3_600_000,
    grain: "daily",
    groupBy: "day",
  });
  expect(days[0]?.requests).toBe(1);
  s.close();
});

test("both grains group by provider and by the model the client asked for", async () => {
  const s = await store();
  await s.usage.append(log({ id: "r1", at: noon(0) }));
  await s.usage.append(
    log({
      id: "r2",
      at: noon(0),
      resolvedProvider: "openai",
      resolvedModel: "gpt-5",
      requestedModel: "cheap",
    }),
  );

  for (const grain of ["raw", "daily"] as const) {
    const providers = await s.usage.aggregate({ since: noon(2), grain, groupBy: "provider" });
    expect(providers.map((row) => row.key).sort()).toEqual(["anthropic", "openai"]);

    const requested = await s.usage.aggregate({
      since: noon(2),
      grain,
      groupBy: "requestedModel",
    });
    expect(requested.map((row) => row.key).sort()).toEqual(["cheap", "fast"]);
  }
  s.close();
});

test("splitBy yields one bucket per pair, which is what stacks a time series", async () => {
  const s = await store();
  await s.usage.append(log({ id: "r1", at: noon(0) }));
  await s.usage.append(log({ id: "r2", at: noon(0), resolvedProvider: "openai" }));
  await s.usage.append(log({ id: "r3", at: noon(1) }));

  const rows = await s.usage.aggregate({
    since: noon(3),
    grain: "daily",
    groupBy: "day",
    splitBy: "provider",
  });
  const today = String(startOfLocalDay(noon(0)));
  expect(rows.filter((row) => row.key === today)).toHaveLength(2);
  expect(rows.find((row) => row.key === today && row.split === "openai")?.requests).toBe(1);
  expect(rows.every((row) => row.split !== undefined)).toBe(true);
  s.close();
});

test("a request with no credential or key is bucketed, not dropped", async () => {
  const s = await store();
  await s.usage.append(
    log({
      id: "r1",
      at: noon(0),
      apiKeyId: null,
      credentialId: null,
      resolvedProvider: null,
      resolvedModel: null,
      status: 401,
    }),
  );

  const keys = await s.usage.aggregate({ since: noon(2), grain: "daily", groupBy: "apiKey" });
  expect(keys).toEqual([expect.objectContaining({ key: "unknown", requests: 1, errors: 1 })]);
  s.close();
});

test("a grain cannot be asked for a dimension it does not carry", async () => {
  const s = await store();
  await expect(s.usage.aggregate({ since: 0, grain: "daily", groupBy: "hour" })).rejects.toThrow(
    "cannot group by hour",
  );
  await expect(s.usage.aggregate({ since: 0, grain: "raw", groupBy: "day" })).rejects.toThrow(
    "cannot group by day",
  );
  s.close();
});

test("a begun request is visible in the log but absent from usage", async () => {
  const s = await store();
  await s.usage.begin(log({ id: "r1", at: noon(0), state: "pending" }));

  const [row] = await s.usage.recent(10);
  expect(row?.state).toBe("pending");

  // Neither grain counts a request that has not finished: its zeros are
  // placeholders, and counting one would drag every mean toward zero.
  for (const grain of ["raw", "daily"] as const) {
    expect(await s.usage.aggregate({ since: noon(2), grain, groupBy: "provider" })).toEqual([]);
  }
  s.close();
});

test("routing a begun request fills its target without completing or rolling it up", async () => {
  const s = await store();
  await s.usage.begin(log({ id: "r1", at: noon(0), state: "pending" }));

  await s.usage.route("r1", {
    provider: "anthropic",
    model: "claude-opus-4",
    credentialId: "c1",
  });

  const [row] = await s.usage.recent(10);
  expect(row).toMatchObject({
    state: "pending",
    resolvedProvider: "anthropic",
    resolvedModel: "claude-opus-4",
    credentialId: "c1",
  });
  expect(await s.usage.aggregate({ since: noon(2), grain: "daily", groupBy: "day" })).toEqual([]);
  s.close();
});

test("completing a begun request updates the row in place and rolls it up once", async () => {
  const s = await store();
  await s.usage.begin(log({ id: "r1", at: noon(0), state: "pending" }));
  await s.usage.append(log({ id: "r1", at: noon(0) }));

  const rows = await s.usage.recent(10);
  expect(rows).toHaveLength(1);
  expect(rows[0]?.state).toBe("done");
  expect(rows[0]?.status).toBe(200);

  const days = await s.usage.aggregate({ since: noon(2), grain: "daily", groupBy: "day" });
  expect(days).toHaveLength(1);
  expect(days[0]?.requests).toBe(1);
  expect(days[0]?.inputTokens).toBe(100);
  s.close();
});

test("completion keeps the start time, so a finishing row does not jump the log", async () => {
  const s = await store();
  const startedAt = noon(0);
  await s.usage.begin(log({ id: "r1", at: startedAt, state: "pending" }));
  await s.usage.append(log({ id: "r1", at: startedAt + 90_000 }));

  expect((await s.usage.recent(10))[0]?.at).toBe(startedAt);
  s.close();
});

test("a blank completing log does not erase what beginning the request recorded", async () => {
  const s = await store();
  // What the route's terminal catch synthesizes when dispatch throws outright.
  await s.usage.begin(log({ id: "r1", at: noon(0), state: "pending" }));
  await s.usage.append(
    log({
      id: "r1",
      at: noon(0),
      requestedModel: "",
      apiKeyId: null,
      resolvedProvider: null,
      resolvedModel: null,
      credentialId: null,
      attempts: 0,
      status: 500,
      errorCode: "UPSTREAM",
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      ttftMs: null,
      durationMs: 0,
      costUsd: 0,
    }),
  );

  const [row] = await s.usage.recent(10);
  expect(row?.requestedModel).toBe("fast");
  expect(row?.apiKeyId).toBe("k1");
  expect(row?.status).toBe(500);
  expect(row?.errorCode).toBe("UPSTREAM");

  // And the rollup describes the row as stored, not the blank that completed it.
  const models = await s.usage.aggregate({
    since: noon(2),
    grain: "daily",
    groupBy: "requestedModel",
  });
  expect(models).toEqual([expect.objectContaining({ key: "fast", requests: 1, errors: 1 })]);
  s.close();
});

test("a request that never began completes exactly as it always did", async () => {
  const s = await store();
  await s.usage.append(log({ id: "r1", at: noon(0), status: 401, errorCode: "AUTH" }));

  const rows = await s.usage.recent(10);
  expect(rows).toHaveLength(1);
  expect(rows[0]?.state).toBe("done");

  const days = await s.usage.aggregate({ since: noon(2), grain: "daily", groupBy: "day" });
  expect(days[0]?.requests).toBe(1);
  expect(days[0]?.errors).toBe(1);
  s.close();
});

test("sweepPending retires rows the last process left behind", async () => {
  const s = await store();
  await s.usage.begin(log({ id: "r1", at: noon(0), state: "pending" }));
  await s.usage.append(log({ id: "r2", at: noon(0) }));

  expect(await s.usage.sweepPending()).toBe(1);
  expect(await s.usage.sweepPending()).toBe(0);

  const rows = await s.usage.recent(10);
  expect(rows.every((row) => row.state === "done")).toBe(true);
  const swept = rows.find((row) => row.id === "r1");
  expect(swept?.status).toBe(499);
  expect(swept?.errorCode).toBe("interrupted");
  // Nobody knows when the process died, so no duration is claimed.
  expect(swept?.durationMs).toBe(0);
  // The completed request keeps its own outcome.
  expect(rows.find((row) => row.id === "r2")?.status).toBe(200);

  // A swept row reaches the rollup, so the year view still counts the request.
  const days = await s.usage.aggregate({ since: noon(2), grain: "daily", groupBy: "day" });
  expect(days[0]?.requests).toBe(2);
  expect(days[0]?.errors).toBe(1);
  s.close();
});

test("the RTK migration backfills saved tokens without recounting usage", () => {
  const db = openDb(":memory:");
  const at = startOfLocalDay(Date.now()) + 3_600_000;
  db.run(
    `INSERT INTO request_logs
       (id, at, api_key_id, requested_model, resolved_provider, resolved_model, credential_id,
        attempts, status, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
        duration_ms, cost_usd, degradations, rtk_applied, rtk_estimated_tokens_saved)
     VALUES ('rtk',?,'k1','fast','anthropic','claude-opus-4','c1',1,200,10,5,0,0,100,0.01,'[]',1,325)`,
    [at],
  );
  db.run("DELETE FROM usage_daily");
  expect(backfillDaily(db)).toBe(1);

  backfillRtkUsage(db);
  const row = db
    .query<
      {
        requests: number;
        input_tokens: number;
        rtk_saved_tokens: number;
        rtk_applied_requests: number;
      },
      []
    >(
      `SELECT requests, input_tokens, rtk_saved_tokens, rtk_applied_requests
         FROM usage_daily`,
    )
    .get();
  expect(row).toEqual({
    requests: 1,
    input_tokens: 10,
    rtk_saved_tokens: 325,
    rtk_applied_requests: 1,
  });
  db.close();
});

test("the migration seeds the rollup from logs already on disk", () => {
  const db = openDb(":memory:");
  const at = startOfLocalDay(Date.now()) + 3_600_000;
  for (const [id, status] of [
    ["r1", 200],
    ["r2", 200],
    ["r3", 500],
  ] as const) {
    db.run(
      `INSERT INTO request_logs
         (id, at, api_key_id, requested_model, resolved_provider, resolved_model, credential_id,
          attempts, status, error_code, input_tokens, output_tokens, cache_read_tokens,
          cache_write_tokens, ttft_ms, duration_ms, cost_usd, degradations)
       VALUES (?,?,'k1','fast','anthropic','claude-opus-4','c1',1,?,NULL,10,5,0,0,NULL,100,0.01,'[]')`,
      [id, at, status],
    );
  }
  db.run("DELETE FROM usage_daily");

  expect(backfillDaily(db)).toBe(1);
  const row = db
    .query<{ day: number; requests: number; errors: number; input_tokens: number }, []>(
      "SELECT day, requests, errors, input_tokens FROM usage_daily",
    )
    .get();
  expect(row?.day).toBe(startOfLocalDay(at));
  expect(row?.requests).toBe(3);
  expect(row?.errors).toBe(1);
  expect(row?.input_tokens).toBe(30);
  db.close();
});

/**
 * The pending-row filter, seeded so an unfiltered implementation fails loudly
 * rather than by a margin.
 *
 * A pending row's tokens and cost are placeholder zeros in production, which is
 * exactly why an unfiltered sum is invisible under normal data. These carry
 * absurd metrics instead, so a `sumSince` that forgets `state = 'done'` reports
 * a number nobody could mistake for a real one.
 */
test("sumSince excludes pending rows, whose metrics are placeholders and not measurements", async () => {
  const s = await store();
  const now = Date.now();
  await s.usage.append(
    log({ id: "done", at: now - 1_000, inputTokens: 1, outputTokens: 2, costUsd: 0.5 }),
  );
  await s.usage.begin(
    log({
      id: "flying",
      at: now - 500,
      state: "pending",
      inputTokens: 999_999,
      outputTokens: 888_888,
      cacheReadTokens: 777_777,
      cacheWriteTokens: 666_666,
      costUsd: 4_242.42,
    }),
  );

  const sums = await s.usage.sumSince("k1", now - 60_000);
  expect(sums).toEqual({ requests: 1, tokens: 33, costUsd: 0.5 });
  s.close();
});

test("sumSince adds all four token columns, which are disjoint classes", async () => {
  // `Usage.inputTokens` is uncached input, and cache reads and writes are priced
  // once each, so summing the four double-counts nothing.
  const s = await store();
  const now = Date.now();
  await s.usage.append(
    log({
      id: "r1",
      at: now - 1_000,
      inputTokens: 1,
      outputTokens: 20,
      cacheReadTokens: 300,
      cacheWriteTokens: 4_000,
      costUsd: 0.25,
    }),
  );
  await s.usage.append(
    log({
      id: "r2",
      at: now - 900,
      inputTokens: 50_000,
      outputTokens: 600_000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0.75,
    }),
  );

  const sums = await s.usage.sumSince("k1", now - 60_000);
  expect(sums.tokens).toBe(4_321 + 650_000);
  expect(sums.requests).toBe(2);
  expect(sums.costUsd).toBeCloseTo(1.0, 10);
  s.close();
});

test("sumSince is bounded below by its instant and above by nothing", async () => {
  const s = await store();
  const now = Date.now();
  await s.usage.append(log({ id: "stale", at: now - 120_000 }));
  await s.usage.append(log({ id: "edge", at: now - 60_000 }));
  await s.usage.append(log({ id: "fresh", at: now - 1 }));

  // Inclusive at the lower bound, so a window is `[since, ∞)` and a row landing
  // exactly on the boundary is counted once rather than lost between two reads.
  expect((await s.usage.sumSince("k1", now - 60_000)).requests).toBe(2);
  expect((await s.usage.sumSince("k1", now - 59_999)).requests).toBe(1);
  s.close();
});

/**
 * The instant a sliding window actually frees a slot, which is the whole reason
 * this query exists: `now + windowMs` is what every other path reports, and on a
 * weekly window that is a `Retry-After` of seven days for a key that regains a
 * slot in an hour.
 */
test("oldestSince reports the oldest retained row, which is when the window next frees a slot", async () => {
  const s = await store();
  const now = Date.now();
  // Written out of order, so an implementation reading the first row rather than
  // the minimum answers with the wrong one.
  await s.usage.append(log({ id: "middle", at: now - 20_000 }));
  await s.usage.append(log({ id: "oldest", at: now - 50_000 }));
  await s.usage.append(log({ id: "newest", at: now - 1_000 }));

  expect(await s.usage.oldestSince("k1", now - 60_000)).toBe(now - 50_000);
  // The window moved past the oldest two, so the answer moves with it.
  expect(await s.usage.oldestSince("k1", now - 30_000)).toBe(now - 20_000);
  s.close();
});

/**
 * Same filter as `sumSince`, and load-bearing for a different reason. A request
 * admitted a moment ago is the newest row there is, but it is also the one whose
 * `at` a broken query would most often return — reporting that the window frees
 * nothing for a whole window, which is the overstatement this query replaces.
 */
test("oldestSince excludes pending rows, which are admissions rather than measurements", async () => {
  const s = await store();
  const now = Date.now();
  await s.usage.append(log({ id: "done", at: now - 10_000 }));
  await s.usage.begin(log({ id: "flying", at: now - 90_000, state: "pending" }));

  expect(await s.usage.oldestSince("k1", now - 120_000)).toBe(now - 10_000);
  s.close();
});

test("oldestSince is null where the key has nothing in the window, and counts one key only", async () => {
  const s = await store();
  const now = Date.now();
  await s.usage.append(log({ id: "stale", at: now - 120_000 }));
  await s.usage.append(log({ id: "theirs", at: now - 1_000, apiKeyId: "k2" }));

  // Nothing retained is null, not zero: zero is an instant in 1970 and would be
  // read as a window that freed a slot fifty-six years ago.
  expect(await s.usage.oldestSince("k1", now - 60_000)).toBeNull();
  expect(await s.usage.oldestSince("nobody", 0)).toBeNull();
  // Inclusive at the lower bound, matching `sumSince`, so the row the sum counts
  // is the row this reports.
  expect(await s.usage.oldestSince("k1", now - 120_000)).toBe(now - 120_000);
  expect(await s.usage.oldestSince("k2", 0)).toBe(now - 1_000);
  s.close();
});

/**
 * Correctness-adjacent rather than an optimisation: without a composite index
 * leading with the key, a weekly lookup for one key scans every row in the week
 * for every key on the install.
 */
test("oldestSince is served by idx_request_logs_key_at", async () => {
  const db = openDb(":memory:");
  const plan = db
    .query<{ detail: string }, [string, number]>(
      `EXPLAIN QUERY PLAN
       SELECT MIN(at) FROM request_logs
        WHERE api_key_id = ? AND state = 'done' AND at >= ?`,
    )
    .all("k1", 0)
    .map((row) => row.detail)
    .join(" ");
  expect(plan).toContain("idx_request_logs_key_at");
  db.close();
});

test("sumSince counts one key only, and an unknown key is zero rather than everything", async () => {
  const s = await store();
  const now = Date.now();
  await s.usage.append(log({ id: "mine", at: now - 1_000, apiKeyId: "k1" }));
  await s.usage.append(log({ id: "theirs", at: now - 1_000, apiKeyId: "k2", costUsd: 9.99 }));
  await s.usage.append(log({ id: "anonymous", at: now - 1_000, apiKeyId: null }));

  expect((await s.usage.sumSince("k1", 0)).requests).toBe(1);
  expect((await s.usage.sumSince("k2", 0)).costUsd).toBeCloseTo(9.99, 10);
  expect(await s.usage.sumSince("nobody", 0)).toEqual({ requests: 0, tokens: 0, costUsd: 0 });
  s.close();
});

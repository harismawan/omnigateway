import type { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { openDb } from "../src/sqlite/db.ts";
import { HOUR_MS } from "../src/sqlite/rollup.ts";
import { createUsageRepo } from "../src/sqlite/usage.ts";
import type { RequestLog, UsageRepo, UsageSums } from "../src/types.ts";

/** An hour boundary well clear of the epoch, so no arithmetic here is negative. */
const H0 = 480_000 * HOUR_MS;

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

function repo(): { db: Database; usage: UsageRepo } {
  const db = openDb(":memory:");
  return { db, usage: createUsageRepo(db, "node-test") };
}

/**
 * The implementation `sumSince` replaced: one range scan over `request_logs`.
 *
 * Kept verbatim as the oracle. The whole feature is the claim that a rollup read
 * and this scan cannot disagree, so the scan has to still be here to disagree
 * with.
 */
function directSum(db: Database, apiKeyId: string, since: number): UsageSums {
  const row = db
    .query<{ requests: number; tokens: number; cost_usd: number }, [string, number]>(
      `SELECT COUNT(*) AS requests,
              COALESCE(SUM(input_tokens + output_tokens
                           + cache_read_tokens + cache_write_tokens), 0) AS tokens,
              COALESCE(SUM(cost_usd), 0) AS cost_usd
         FROM request_logs
        WHERE api_key_id = ? AND state = 'done' AND at >= ?`,
    )
    .get(apiKeyId, since);
  return { requests: row?.requests ?? 0, tokens: row?.tokens ?? 0, costUsd: row?.cost_usd ?? 0 };
}

/** Deterministic, because a property test that cannot be replayed is a rumour. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function seed(usage: UsageRepo, ats: readonly number[]): Promise<void> {
  const rng = random(7);
  let index = 0;
  for (const at of ats) {
    index += 1;
    await usage.append(
      log({
        id: `r${index}`,
        at,
        inputTokens: Math.floor(rng() * 1000),
        outputTokens: Math.floor(rng() * 400),
        cacheReadTokens: Math.floor(rng() * 5000),
        cacheWriteTokens: Math.floor(rng() * 90),
        costUsd: Math.floor(rng() * 10_000) / 100_000,
      }),
    );
  }
}

/**
 * Every distribution below is seeded through `append`, which is the only way a
 * bucket is written on a live install. A test that seeded rows with raw SQL and
 * then rebuilt would be checking the rebuild against itself.
 */
const DISTRIBUTIONS: ReadonlyArray<{ name: string; ats: readonly number[] }> = [
  { name: "one hour", ats: Array.from({ length: 40 }, (_, i) => H0 + i * 90_000) },
  {
    name: "a week and a half, evenly",
    ats: Array.from({ length: 250 }, (_, i) => H0 + i * (HOUR_MS + 137_000)),
  },
  {
    // Every row on or beside a bucket edge, which is where an off-by-one in the
    // bucket arithmetic or the partial scan has somewhere to hide.
    name: "clustered on bucket edges",
    ats: Array.from({ length: 60 }, (_, i) => {
      const hour = H0 + Math.floor(i / 3) * HOUR_MS;
      return [hour - 1, hour, hour + 1][i % 3] ?? hour;
    }),
  },
  {
    name: "random over three days",
    ats: (() => {
      const rng = random(99);
      return Array.from({ length: 300 }, () => H0 + Math.floor(rng() * 72 * HOUR_MS));
    })(),
  },
  { name: "nothing at all", ats: [] },
];

/**
 * The anchor. If a rollup read and a direct scan ever disagree, every long
 * window is silently wrong and nothing else in this file matters.
 *
 * The instants tested are the ones an off-by-one lives at: exactly on a bucket
 * edge, one millisecond either side of one, and mid-hour, plus a window
 * beginning before the first row and one beginning after the last.
 */
for (const distribution of DISTRIBUTIONS) {
  test(`the rollup read equals a direct scan: ${distribution.name}`, async () => {
    const { db, usage } = repo();
    await seed(usage, distribution.ats);

    const instants: number[] = [0, H0 - HOUR_MS, H0 + 400 * HOUR_MS];
    for (let hour = 0; hour <= 260; hour++) {
      const edge = H0 + hour * HOUR_MS;
      instants.push(edge - 1, edge, edge + 1, edge + HOUR_MS / 2, edge + HOUR_MS - 1);
    }

    for (const since of instants) {
      const rolled = await usage.sumSince("k1", since);
      const scanned = directSum(db, "k1", since);
      expect({ since, ...rolled, costUsd: 0 }).toEqual({ since, ...scanned, costUsd: 0 });
      // Cost is the one REAL column: the rollup accumulates it a request at a
      // time and the scan adds a window at once, so they agree to within the
      // float addition being non-associative and not beyond it.
      expect(rolled.costUsd).toBeCloseTo(scanned.costUsd, 10);
    }
    db.close();
  });
}

/**
 * The partial hour, at the millisecond.
 *
 * A window is `[since, ∞)` and bucket edges have nothing to do with `since`, so
 * the hour holding the instant is summed from rows rather than from its bucket.
 * Getting this wrong by one row is a limit that admits or refuses one request
 * too many, which nothing else would ever report.
 */
test("a row one millisecond inside the window counts, and one millisecond outside does not", async () => {
  const { db, usage } = repo();
  const since = H0 + 30 * 60_000;
  await seed(usage, [since - 1, since, since + 1]);

  expect((await usage.sumSince("k1", since)).requests).toBe(2);
  expect((await usage.sumSince("k1", since + 1)).requests).toBe(1);
  expect((await usage.sumSince("k1", since + 2)).requests).toBe(0);
  expect((await usage.sumSince("k1", since - 1)).requests).toBe(3);
  db.close();
});

/**
 * The other edge in the same read: where the partial hour stops and the whole
 * buckets start. A partial scan that ran past its hour double-counts the first
 * whole bucket; a whole-bucket sum that reached down one bucket too far
 * double-counts the partial hour.
 */
test("the partial hour and the whole buckets meet exactly at the bucket edge", async () => {
  const { db, usage } = repo();
  const edge = H0 + HOUR_MS;
  await seed(usage, [edge - 1, edge, edge + 1, edge + HOUR_MS]);

  // Mid-way through the first hour: one row from the partial hour, three from
  // the buckets after it, and no row counted in both.
  expect((await usage.sumSince("k1", H0 + HOUR_MS / 2)).requests).toBe(4);
  // Exactly on the edge: the partial hour is now the second one, which holds
  // `edge` and `edge + 1`.
  expect((await usage.sumSince("k1", edge)).requests).toBe(3);
  expect((await usage.sumSince("k1", edge + 1)).requests).toBe(2);
  db.close();
});

/**
 * One pending row in each half of the read, because the two halves filter
 * separately: the partial hour carries `state = 'done'` in its own scan, and the
 * whole buckets carry it by never having been written for a row that had not
 * finished.
 */
test("a pending row is in neither the bucket nor the partial hour", async () => {
  const { db, usage } = repo();
  const since = H0 + 10 * HOUR_MS + 40 * 60_000;
  const inside = H0 + 12 * HOUR_MS;
  // Absurd metrics rather than the production placeholder zeros, so an
  // unfiltered implementation reports a number nobody could misread as real.
  const placeholder = {
    state: "pending" as const,
    inputTokens: 999_999,
    outputTokens: 888_888,
    cacheReadTokens: 777_777,
    cacheWriteTokens: 666_666,
    costUsd: 4_242.42,
  };
  await usage.append(log({ id: "done-edge", at: since + 1 }));
  await usage.begin(log({ id: "flying-edge", at: since + 2, ...placeholder }));
  await usage.append(log({ id: "done-whole", at: inside }));
  await usage.begin(log({ id: "flying-whole", at: inside + 1, ...placeholder }));

  const sums = await usage.sumSince("k1", since);
  expect(sums.requests).toBe(2);
  expect(sums.tokens).toBe(180 * 2);
  expect((await usage.auditRollup()).ok).toBe(true);
  db.close();
});

/**
 * `begin` writes no bucket and `append` writes exactly one, which is how the
 * rollup inherits the at-most-once-per-request-id guarantee `append` already
 * carries rather than needing a second one.
 *
 * A second `append` for the same id double-counts, and is asserted here doing
 * it: `usage_daily` has always behaved that way, `CLAUDE.md` says so, and a
 * rollup that quietly did something else would be the one of the two nobody
 * was watching.
 */
test("append writes one bucket per request id, exactly where the daily rollup is written", async () => {
  const { db, usage } = repo();
  const at = H0 + 3 * HOUR_MS;
  const requests = () =>
    db.query<{ n: number }, []>("SELECT COALESCE(SUM(requests), 0) AS n FROM usage_rollup").get()
      ?.n ?? 0;
  const daily = () =>
    db.query<{ n: number }, []>("SELECT COALESCE(SUM(requests), 0) AS n FROM usage_daily").get()
      ?.n ?? 0;

  await usage.begin(log({ id: "r1", at, state: "pending" }));
  expect(requests()).toBe(0);

  await usage.append(log({ id: "r1", at }));
  expect(requests()).toBe(1);
  expect(daily()).toBe(1);

  // Two, absolutely, in both tables. Asserting only that the two agree passes
  // at `1 === 1` as readily as at `2 === 2`, which is exactly the case where the
  // hourly bucket had stopped being written beside the daily row.
  await usage.append(log({ id: "r1", at }));
  expect(requests()).toBe(2);
  expect(daily()).toBe(2);
  db.close();
});

test("an anonymous request has no key to count against and no bucket", async () => {
  const { db, usage } = repo();
  await usage.append(log({ id: "anon", at: H0, apiKeyId: null }));
  expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM usage_rollup").get()?.n).toBe(0);
  expect((await usage.auditRollup()).ok).toBe(true);
  db.close();
});

/**
 * The property that lets the rollup be depended on at all: it is derived, so a
 * disagreement is repairable rather than unresolvable.
 *
 * The damage here is what a restore brings in — a table that does not match the
 * rows beside it — and the rebuild is what a restore runs on the way out.
 */
test("a rebuild reproduces the same totals as the rows it derives from", async () => {
  const { db, usage } = repo();
  await seed(
    usage,
    Array.from({ length: 120 }, (_, i) => H0 + i * (HOUR_MS + 61_000)),
  );
  const before = await usage.sumSince("k1", H0);

  // The orphan first and on its own: a bucket the rollup holds for an hour the
  // log has no rows in is the shape a missing prune leaves behind, and it is the
  // one damage the truth-side comparison cannot see — every row it joins from is
  // a row that exists. Beside the two damages below it is invisible, because
  // either of those already fails the same assertion.
  db.run("INSERT INTO usage_rollup (api_key_id, hour, requests) VALUES ('k1', 1, 5)");
  expect(await usage.auditRollup()).toEqual({ buckets: 120, mismatched: 1, ok: false });

  // And the rest of what a restored file's rollup can be wrong by, at once: a
  // bucket that is gone and one that over-counts.
  db.run("DELETE FROM usage_rollup WHERE hour = ?", [Math.floor(H0 / HOUR_MS)]);
  db.run("UPDATE usage_rollup SET requests = requests + 17, cost_usd = cost_usd + 3");
  const damaged = await usage.auditRollup();
  expect(damaged.ok).toBe(false);
  expect(damaged.mismatched).toBeGreaterThan(0);

  await usage.rebuildRollup();

  const after = await usage.sumSince("k1", H0);
  expect(after.requests).toBe(before.requests);
  expect(after.tokens).toBe(before.tokens);
  expect(after.costUsd).toBeCloseTo(before.costUsd, 10);
  expect(after).toEqual({ ...directSum(db, "k1", H0), costUsd: after.costUsd });
  expect(await usage.auditRollup()).toEqual({ buckets: 120, mismatched: 0, ok: true });
  db.close();
});

/**
 * The same filter, in the statement that seeds the table rather than the one
 * that reads it.
 *
 * The pending rows are two hours in, so the window's whole-bucket half is what
 * answers for them: a test that left them in the partial hour would be judging
 * the edge scan's filter a second time and never touching the rebuild's.
 */
/**
 * A bucket can be wrong without being the wrong shape. The count is the cheapest
 * thing to compare and the least likely to be wrong on its own: a rollup that
 * drifted on tokens or cost would pass a check that only counted rows, and
 * tokens and spend are two of the three dimensions enforced from it.
 */
test("the audit compares every counter, within a float's tolerance on cost", async () => {
  const { db, usage } = repo();
  await usage.append(log({ id: "r1", at: H0 }));
  await usage.append(log({ id: "r2", at: H0 + HOUR_MS }));
  expect(await usage.auditRollup()).toEqual({ buckets: 2, mismatched: 0, ok: true });

  db.run("UPDATE usage_rollup SET input_tokens = input_tokens + 1 WHERE hour = ?", [
    Math.floor(H0 / HOUR_MS),
  ]);
  expect(await usage.auditRollup()).toEqual({ buckets: 2, mismatched: 1, ok: false });
  await usage.rebuildRollup();

  db.run("UPDATE usage_rollup SET cost_usd = cost_usd + 0.5");
  expect(await usage.auditRollup()).toEqual({ buckets: 2, mismatched: 2, ok: false });
  await usage.rebuildRollup();

  // The one column the two sides add in a different order, so agreement is to
  // within IEEE addition and not to the bit.
  db.run("UPDATE usage_rollup SET cost_usd = cost_usd + 1e-15");
  expect((await usage.auditRollup()).ok).toBe(true);
  db.close();
});

/**
 * Nothing validates `RequestLog.at`, and SQLite's `/` is integer division only
 * when both operands are integers.
 *
 * With a fractional `at` the write path buckets at `hourOf` — an integer — while
 * a bare `at / 3600000` computes a REAL an eyelash above it. Two consequences,
 * both silent: `doctor` reports a mismatch against a rollup that is correct, and
 * a rebuild writes a REAL primary key that no later integer-hour write ever
 * merges with, so that key double-counts from then on. The bucket is asserted
 * for its type rather than only its value, because `480000` and
 * `480000.0000001389` compare unequal but print alike in a failure message.
 */
test("a fractional timestamp buckets the same way on both sides of the rollup", async () => {
  const { db, usage } = repo();
  const fractional = H0 + 0.5;
  await usage.append(log({ id: "r1", at: fractional }));
  const written = await usage.sumSince("k1", H0);

  expect(await usage.auditRollup()).toEqual({ buckets: 1, mismatched: 0, ok: true });

  await usage.rebuildRollup();
  expect(await usage.sumSince("k1", H0)).toEqual(written);
  expect(await usage.auditRollup()).toEqual({ buckets: 1, mismatched: 0, ok: true });

  const hours = db.query<{ hour: number }, []>("SELECT hour FROM usage_rollup").all();
  expect(hours).toEqual([{ hour: Math.floor(H0 / HOUR_MS) }]);
  expect(Number.isInteger(hours[0]?.hour)).toBe(true);

  // And a later integer-hour write lands in the bucket the rebuild wrote rather
  // than beside it, which is the shape the double-count took.
  await usage.append(log({ id: "r2", at: H0 + 1_000 }));
  expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM usage_rollup").get()?.n).toBe(1);
  expect((await usage.sumSince("k1", H0)).requests).toBe(2);
  db.close();
});

test("a rebuild leaves out pending rows, as the write path does", async () => {
  const { db, usage } = repo();
  const inside = H0 + 2 * HOUR_MS;
  await usage.append(log({ id: "done", at: inside }));
  await usage.begin(log({ id: "flying", at: inside + 1, state: "pending", inputTokens: 999_999 }));

  await usage.rebuildRollup();
  expect(await usage.sumSince("k1", H0)).toEqual({ requests: 1, tokens: 180, costUsd: 0.005 });
  expect(await usage.auditRollup()).toEqual({ buckets: 1, mismatched: 0, ok: true });
  db.close();
});

/**
 * Retention applies to the derived counters too, or a key is judged against
 * hours whose rows are gone and `doctor` reports a disagreement on every
 * install that prunes.
 */
test("pruning rows prunes the buckets that summarized them, boundary hour included", async () => {
  const { db, usage } = repo();
  const cut = H0 + 5 * HOUR_MS + 20 * 60_000;
  await seed(usage, [
    H0,
    H0 + HOUR_MS,
    // Either side of the cut inside the one hour it falls in.
    cut - 1,
    cut,
    cut + 1,
    H0 + 9 * HOUR_MS,
  ]);

  expect(await usage.prune(cut)).toBe(3);
  expect(await usage.auditRollup()).toEqual({ buckets: 2, mismatched: 0, ok: true });
  expect((await usage.sumSince("k1", 0)).requests).toBe(3);
  expect((await usage.sumSince("k1", cut)).requests).toBe(3);
  db.close();
});

/**
 * That the read does not grow with the rows is asserted as a fact about where
 * the number comes from, not as a duration: a timing assertion in CI measures
 * the machine.
 *
 * Rows inside the window are added and removed behind the rollup's back. A read
 * that scanned them would move; this one does not, because whole hours are
 * answered by ~168 buckets whatever each one summarizes. Only the boundary hour
 * is read from rows, and only ever one hour of them.
 */
test("whole hours are answered from buckets, so the read is flat in the rows behind them", async () => {
  const { db, usage } = repo();
  const week = 168;
  await seed(
    usage,
    Array.from({ length: week }, (_, i) => H0 + i * HOUR_MS + 90_000),
  );
  const since = H0 + 30 * 60_000;
  const before = await usage.sumSince("k1", since);

  // Ten thousand rows into an hour wholly inside the window, with no bucket
  // written for them. A read that scanned `request_logs` would find them.
  const at = H0 + 40 * HOUR_MS;
  db.transaction(() => {
    for (let i = 0; i < 10_000; i++) {
      db.run(
        `INSERT INTO request_logs (id, state, at, api_key_id, requested_model, attempts, status,
                                   input_tokens, output_tokens, cache_read_tokens,
                                   cache_write_tokens, duration_ms, cost_usd, degradations)
         VALUES (?, 'done', ?, 'k1', 'fast', 1, 200, 7, 0, 0, 0, 1, 0.5, '[]')`,
        [`bulk${i}`, at + i],
      );
    }
  })();
  expect(await usage.sumSince("k1", since)).toEqual(before);

  // The same rows in the boundary hour do move it, because that hour is the one
  // the rollup cannot answer for.
  await usage.append(log({ id: "edge", at: since + 1 }));
  expect((await usage.sumSince("k1", since)).requests).toBe(before.requests + 1);

  // And the work each read does is bounded by the two sets above: one bucket per
  // hour of the window, plus one hour of one key's rows.
  const buckets =
    db
      .query<{ n: number }, [number]>(
        "SELECT COUNT(*) AS n FROM usage_rollup WHERE api_key_id = 'k1' AND hour > ?",
      )
      .get(Math.floor(since / HOUR_MS))?.n ?? 0;
  expect(buckets).toBeLessThanOrEqual(week);
  db.close();
});

test("both reads are served by an index rather than a scan", async () => {
  const db = openDb(":memory:");
  const plan = (sql: string): string =>
    db
      .query<{ detail: string }, [string, number]>(`EXPLAIN QUERY PLAN ${sql}`)
      .all("k1", 0)
      .map((row) => row.detail)
      .join(" ");

  expect(
    plan("SELECT SUM(requests) FROM usage_rollup WHERE api_key_id = ? AND hour > ?"),
  ).toContain("USING PRIMARY KEY");
  expect(
    plan(
      `SELECT COUNT(*) FROM request_logs
        WHERE api_key_id = ? AND state = 'done' AND at >= ? AND at < 1`,
    ),
  ).toContain("idx_request_logs_key_at");
  db.close();
});

test("buckets belong to one key, and an unknown key reads as zero rather than everything", async () => {
  const { db, usage } = repo();
  await usage.append(log({ id: "mine", at: H0 }));
  await usage.append(log({ id: "theirs", at: H0, apiKeyId: "k2", costUsd: 9.99 }));

  expect((await usage.sumSince("k1", 0)).requests).toBe(1);
  expect((await usage.sumSince("k2", 0)).costUsd).toBeCloseTo(9.99, 10);
  expect(await usage.sumSince("nobody", 0)).toEqual({ requests: 0, tokens: 0, costUsd: 0 });
  db.close();
});

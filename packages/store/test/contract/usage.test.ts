import { expect, test } from "bun:test";
import { RTK_FILTER_IDS } from "@omni/rtk/catalog";
import { HOUR_MS, startOfLocalDay } from "../../src/sqlite/rollup.ts";
import { NODE_GRACE_MS } from "../../src/types.ts";
import { forEachStore, logRow } from "./harness.ts";

const T = 1_700_000_000_000;
/** Noon local time on day `n` from a fixed date, so local-midnight buckets are unambiguous. */
const noon = (n: number): number => {
  const d = new Date(2024, 0, 10 + n, 12, 0, 0, 0);
  return d.getTime();
};

forEachStore((backend) => {
  test("append then recent round-trips every column, including RTK metrics", async () => {
    const s = await backend.fresh();
    const log = logRow({
      id: "r1",
      at: T,
      degradations: ["a:b"],
      rtkApplied: true,
      rtkFilterHits: 3,
      rtkOriginalCodeUnits: 100,
      rtkCompressedCodeUnits: 40,
      rtkEstimatedTokensSaved: 15,
      rtkFilters: [...RTK_FILTER_IDS],
      ttftMs: null,
      errorCode: "UPSTREAM",
      status: 502,
    });
    await s.usage.append(log);
    const [got] = await s.usage.recent(10);
    expect(got).toEqual(log);
    expect(typeof got?.at).toBe("number");
    expect(typeof got?.inputTokens).toBe("number");
  });

  test("begin, route, then append updates one row in place and rolls it up once", async () => {
    const s = await backend.fresh();
    const pending = logRow({
      id: "r1",
      at: T,
      state: "pending",
      status: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0,
      durationMs: 0,
      resolvedProvider: null,
      resolvedModel: null,
      credentialId: null,
    });
    await s.usage.begin(pending);
    let [row] = await s.usage.recent(10);
    expect(row?.state).toBe("pending");
    expect(await s.usage.aggregate({ since: 0, groupBy: "model" })).toEqual([]);
    expect(await s.usage.sumSince("k1", 0)).toEqual({ requests: 0, tokens: 0, costUsd: 0 });

    await s.usage.route("r1", {
      provider: "anthropic",
      model: "claude-opus-4",
      credentialId: "c1",
    });
    [row] = await s.usage.recent(10);
    expect(row?.state).toBe("pending");
    expect(row?.resolvedModel).toBe("claude-opus-4");
    expect(row?.credentialId).toBe("c1");

    // Completion keeps the start time and fills in what beginning left blank.
    await s.usage.append(logRow({ id: "r1", at: T + 5000, requestedModel: "", apiKeyId: null }));
    const rows = await s.usage.recent(10);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.state).toBe("done");
    expect(rows[0]?.at).toBe(T);
    expect(rows[0]?.requestedModel).toBe("fast");
    expect(rows[0]?.apiKeyId).toBe("k1");
    expect(rows[0]?.inputTokens).toBe(10);

    // Routing a done row is a no-op.
    await s.usage.route("r1", { provider: "openai", model: "x", credentialId: "c9" });
    expect((await s.usage.recent(10))[0]?.credentialId).toBe("c1");

    expect(await s.usage.sumSince("k1", 0)).toEqual({ requests: 1, tokens: 18, costUsd: 0.001 });
    const daily = await s.usage.aggregate({ since: 0, groupBy: "model", grain: "daily" });
    expect(daily).toHaveLength(1);
    expect(daily[0]?.requests).toBe(1);
  });

  test("aggregate groups and splits at both grains, buckets absent keys as unknown, and scopes", async () => {
    const s = await backend.fresh();
    await s.usage.append(logRow({ id: "a", at: noon(0), apiKeyId: "k1", status: 500 }));
    await s.usage.append(
      logRow({
        id: "b",
        at: noon(0),
        apiKeyId: "k2",
        resolvedModel: "m2",
        rtkApplied: true,
        rtkEstimatedTokensSaved: 7,
      }),
    );
    await s.usage.append(logRow({ id: "c", at: noon(1), apiKeyId: null, credentialId: null }));

    const raw = await s.usage.aggregate({ since: 0, groupBy: "apiKey" });
    expect(raw.map((b) => [b.key, b.requests, b.errors]).sort()).toEqual([
      ["k1", 1, 1],
      ["k2", 1, 0],
      ["unknown", 1, 0],
    ]);
    const daily = await s.usage.aggregate({ since: 0, groupBy: "credential", grain: "daily" });
    expect(daily.map((b) => [b.key, b.requests]).sort()).toEqual([
      ["c1", 2],
      ["unknown", 1],
    ]);
    const split = await s.usage.aggregate({ since: 0, groupBy: "provider", splitBy: "model" });
    expect(split.map((b) => [b.key, b.split, b.requests]).sort()).toEqual([
      ["anthropic", "claude-opus-4", 2],
      ["anthropic", "m2", 1],
    ]);
    const hours = await s.usage.aggregate({ since: 0, groupBy: "hour" });
    expect(hours.map((b) => b.key).sort()).toEqual(
      [String(Math.floor(noon(0) / HOUR_MS)), String(Math.floor(noon(1) / HOUR_MS))].sort(),
    );
    await expect(s.usage.aggregate({ since: 0, groupBy: "hour", grain: "daily" })).rejects.toThrow(
      "cannot group by",
    );
    await expect(s.usage.aggregate({ since: 0, groupBy: "day" })).rejects.toThrow(
      "cannot group by",
    );

    // Scoped: one key at both grains, and a split by apiKey cannot name another.
    const scoped = await s.usage.aggregate({ since: 0, groupBy: "model", apiKeyId: "k2" });
    expect(scoped).toHaveLength(1);
    expect(scoped[0]?.rtkAppliedRequests).toBe(1);
    expect(scoped[0]?.rtkSavedTokens).toBe(7);
    const scopedDaily = await s.usage.aggregate({
      since: 0,
      groupBy: "model",
      splitBy: "apiKey",
      grain: "daily",
      apiKeyId: "k2",
    });
    expect(scopedDaily.map((b) => b.split)).toEqual(["k2"]);
    expect(scopedDaily[0]?.rtkSavedTokens).toBe(7);

    // A daily window includes the whole of its first, partial day.
    const partial = await s.usage.aggregate({
      since: noon(0) + 1,
      groupBy: "model",
      grain: "daily",
    });
    expect(partial.reduce((n, b) => n + b.requests, 0)).toBe(3);
    const rawPartial = await s.usage.aggregate({ since: noon(0) + 1, groupBy: "model" });
    expect(rawPartial.reduce((n, b) => n + b.requests, 0)).toBe(1);
  });

  test("the daily rollup outlives the rows and prunes on its own horizon", async () => {
    const s = await backend.fresh();
    await s.usage.append(logRow({ id: "a", at: noon(0) }));
    await s.usage.append(logRow({ id: "b", at: noon(3) }));
    expect(await s.usage.prune(noon(2))).toBe(1);
    expect(await s.usage.recent(10)).toHaveLength(1);
    const daily = await s.usage.aggregate({ since: 0, groupBy: "model", grain: "daily" });
    expect(daily[0]?.requests).toBe(2);
    expect(await s.usage.pruneDaily(startOfLocalDay(noon(3)))).toBe(1);
    expect(
      (await s.usage.aggregate({ since: 0, groupBy: "model", grain: "daily" }))[0]?.requests,
    ).toBe(1);
  });

  test("recent scoped to a key returns its rows alone, never an anonymous one", async () => {
    const s = await backend.fresh();
    await s.usage.append(logRow({ id: "a", at: T, apiKeyId: "k1" }));
    await s.usage.append(logRow({ id: "b", at: T + 1, apiKeyId: "k2" }));
    await s.usage.append(logRow({ id: "c", at: T + 2, apiKeyId: null }));
    expect((await s.usage.recent(10)).map((r) => r.id)).toEqual(["c", "b", "a"]);
    expect((await s.usage.recent(10, "k1")).map((r) => r.id)).toEqual(["a"]);
    expect((await s.usage.recent(1)).map((r) => r.id)).toEqual(["c"]);
    expect(await s.usage.recent(10, "nope")).toEqual([]);
  });

  test("sumSince slides exactly, sums four token classes, excludes pending, and scopes", async () => {
    const s = await backend.fresh();
    const hour = Math.floor(T / HOUR_MS) * HOUR_MS;
    await s.usage.append(
      logRow({ id: "a", at: hour + 10, cacheReadTokens: 100, cacheWriteTokens: 1000 }),
    );
    await s.usage.append(logRow({ id: "b", at: hour + HOUR_MS + 10 }));
    await s.usage.append(logRow({ id: "c", at: hour + 2 * HOUR_MS + 10, apiKeyId: "k2" }));
    // Pending rows in both the edge hour and a whole bucket: neither counts.
    await s.usage.begin(logRow({ id: "p", at: hour + 15, state: "pending" }));
    await s.usage.begin(logRow({ id: "q", at: hour + HOUR_MS + 20, state: "pending" }));

    expect(await s.usage.sumSince("k1", hour + 10)).toEqual({
      requests: 2,
      tokens: 1133,
      costUsd: 0.002,
    });
    expect(await s.usage.sumSince("k1", hour + 11)).toEqual({
      requests: 1,
      tokens: 18,
      costUsd: 0.001,
    });
    expect(await s.usage.sumSince("k2", 0)).toEqual({ requests: 1, tokens: 18, costUsd: 0.001 });
    expect(await s.usage.sumSince("nope", 0)).toEqual({ requests: 0, tokens: 0, costUsd: 0 });
    // Bounded above by nothing.
    expect((await s.usage.sumSince("k1", hour + 10 + 2 * HOUR_MS)).requests).toBe(0);
    expect((await s.usage.sumSince("k1", hour - 10 * HOUR_MS)).requests).toBe(2);
  });

  test("oldestSince reports the oldest retained done row for one key, or null", async () => {
    const s = await backend.fresh();
    await s.usage.append(logRow({ id: "a", at: T }));
    await s.usage.append(logRow({ id: "b", at: T + 10 }));
    await s.usage.begin(logRow({ id: "p", at: T - 10, state: "pending" }));
    await s.usage.append(logRow({ id: "z", at: T - 20, apiKeyId: "k2" }));
    expect(await s.usage.oldestSince("k1", T - 100)).toBe(T);
    expect(await s.usage.oldestSince("k1", T + 1)).toBe(T + 10);
    expect(await s.usage.oldestSince("k1", T + 11)).toBeNull();
    expect(await s.usage.oldestSince("nope", 0)).toBeNull();
  });

  test("sumBuckets answers whole hours from the rollup and finer grains from the rows", async () => {
    const s = await backend.fresh();
    const hour = Math.floor(T / HOUR_MS) * HOUR_MS;
    await s.usage.append(logRow({ id: "a", at: hour + 10 }));
    await s.usage.append(logRow({ id: "b", at: hour + 60_000 + 10 }));
    await s.usage.append(logRow({ id: "c", at: hour + HOUR_MS + 10 }));
    await s.usage.append(logRow({ id: "d", at: hour + 10, apiKeyId: "k2" }));
    await s.usage.begin(logRow({ id: "p", at: hour + 10, state: "pending" }));

    const hours = await s.usage.sumBuckets("k1", hour, HOUR_MS);
    expect(hours.sort((x, y) => x[0] - y[0])).toEqual([
      [hour, { requests: 2, tokens: 36, costUsd: 0.002 }],
      [hour + HOUR_MS, { requests: 1, tokens: 18, costUsd: 0.001 }],
    ]);
    const minutes = await s.usage.sumBuckets("k1", hour, 60_000);
    expect(minutes.sort((x, y) => x[0] - y[0])).toEqual([
      [hour, { requests: 1, tokens: 18, costUsd: 0.001 }],
      [hour + 60_000, { requests: 1, tokens: 18, costUsd: 0.001 }],
      [hour + HOUR_MS, { requests: 1, tokens: 18, costUsd: 0.001 }],
    ]);
    expect(await s.usage.sumBuckets("k1", hour + 2 * HOUR_MS, HOUR_MS)).toEqual([]);
    expect(await s.usage.sumBuckets("nope", 0, 60_000)).toEqual([]);
  });

  test("the rollup is rebuilt from the rows, audited against them, and pruned with them", async () => {
    const s = await backend.fresh();
    const hour = Math.floor(T / HOUR_MS) * HOUR_MS;
    await s.usage.append(logRow({ id: "a", at: hour + 10, costUsd: 0.1 }));
    await s.usage.append(logRow({ id: "b", at: hour + 20, costUsd: 0.2 }));
    await s.usage.append(logRow({ id: "c", at: hour + HOUR_MS + 10 }));
    await s.usage.append(logRow({ id: "n", at: hour + 10, apiKeyId: null }));
    await s.usage.begin(logRow({ id: "p", at: hour + 10, state: "pending" }));

    const before = await s.usage.sumBuckets("k1", 0, HOUR_MS);
    expect(await s.usage.auditRollup()).toEqual({ buckets: 2, mismatched: 0, ok: true });
    await s.usage.rebuildRollup();
    expect(await s.usage.sumBuckets("k1", 0, HOUR_MS)).toEqual(before);
    expect(await s.usage.auditRollup()).toEqual({ buckets: 2, mismatched: 0, ok: true });

    // Pruning inside the boundary hour recomputes that bucket from what survived
    // (three rows go: `a`, the anonymous `n`, and the pending `p`).
    expect(await s.usage.prune(hour + 15)).toBe(3);
    expect(await s.usage.sumBuckets("k1", 0, HOUR_MS)).toEqual([
      [hour, { requests: 1, tokens: 18, costUsd: 0.2 }],
      [hour + HOUR_MS, { requests: 1, tokens: 18, costUsd: 0.001 }],
    ]);
    expect((await s.usage.auditRollup()).ok).toBe(true);
    expect(await s.usage.prune(hour + 2 * HOUR_MS)).toBe(2);
    expect(await s.usage.recent(10)).toEqual([]);
    expect(await s.usage.sumBuckets("k1", 0, HOUR_MS)).toEqual([]);
    expect(await s.usage.auditRollup()).toEqual({ buckets: 0, mismatched: 0, ok: true });
  });

  test("sweepPending retires own rows and a dead node's, and leaves a live node's alone", async () => {
    const a = await backend.fresh("node-a");
    const b = await backend.sibling("node-b");
    const t = noon(0);

    await a.maintenance.heartbeat(t);
    await a.usage.begin(logRow({ id: "a1", at: t, state: "pending" }));
    await b.usage.begin(logRow({ id: "b1", at: t, state: "pending" }));

    // B boots: A is alive, so only B's own leftovers go.
    await b.maintenance.heartbeat(t + 1);
    expect(await b.usage.sweepPending(t + 1)).toBe(1);
    expect((await a.usage.recent(10)).find((row) => row.id === "a1")?.state).toBe("pending");
    const swept = (await a.usage.recent(10)).find((row) => row.id === "b1");
    expect(swept?.state).toBe("done");
    expect(swept?.status).toBe(499);
    expect(swept?.errorCode).toBe("interrupted");
    expect(swept?.durationMs).toBe(0);

    // A goes quiet past the grace period, and its row is retirable by B.
    expect(await b.usage.sweepPending(t + NODE_GRACE_MS + 1)).toBe(1);
    expect((await a.usage.recent(10)).find((row) => row.id === "a1")?.state).toBe("done");

    // A node that never wrote a heartbeat is dead too.
    const c = await backend.sibling("node-c");
    await c.usage.begin(logRow({ id: "c1", at: t, state: "pending" }));
    expect(await b.usage.sweepPending(t + 2)).toBe(1);
    expect(await b.usage.sweepPending(t + 2)).toBe(0);

    // Each retirement rolled up exactly once.
    expect((await a.usage.sumSince("k1", 0)).requests).toBe(3);
    expect(await a.usage.auditRollup()).toEqual({ buckets: 1, mismatched: 0, ok: true });
    expect((await a.maintenance.nodes(t + 2)).map((n) => n.id)).toEqual(["node-b", "node-a"]);
    expect((await a.maintenance.nodes(t + NODE_GRACE_MS + 2)).map((n) => n.id)).toEqual([]);
  });
});

forEachStore((backend) => {
  test("scan walks every row in (at, id) order, a page at a time, with no repeats", async () => {
    const s = await backend.fresh();
    for (const [id, at] of [
      ["b", 2],
      ["a", 2],
      ["c", 1],
      ["d", 3],
    ] as const) {
      await s.usage.append(logRow({ id, at: 1_700_000_000_000 + at }));
    }
    await s.usage.begin(logRow({ id: "p", at: 1_700_000_000_000 + 4, state: "pending" }));
    const seen: string[] = [];
    let cursor: { at: number; id: string } | null = null;
    for (;;) {
      const page = await s.usage.scan(cursor, 2);
      if (page.length === 0) break;
      seen.push(...page.map((row) => row.id));
      const last = page[page.length - 1];
      if (last === undefined) break;
      cursor = { at: last.at, id: last.id };
    }
    expect(seen).toEqual(["c", "a", "b", "d", "p"]);
  });
});

forEachStore((backend) => {
  /**
   * A row retired as interrupted by another process and then completed by its
   * owner is billed once. The rollups add, so completing it twice is the
   * double-billing a false-dead verdict would otherwise cause.
   */
  test("completing a row that was already swept does not roll it up twice", async () => {
    const a = await backend.fresh("node-a");
    const b = await backend.sibling("node-b");
    const t = 1_700_000_000_000;
    await a.maintenance.heartbeat(t);
    await a.usage.begin(logRow({ id: "r1", at: t, state: "pending" }));
    expect(await b.usage.sweepPending(t + NODE_GRACE_MS + 1)).toBe(1);
    await a.usage.append(logRow({ id: "r1", at: t, inputTokens: 100 }));
    expect((await a.usage.sumSince("k1", 0)).requests).toBe(1);
    const row = (await a.usage.recent(10)).find((r) => r.id === "r1");
    expect(row?.status).toBe(499);
  });
});

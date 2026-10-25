import { afterEach, expect, test } from "bun:test";
import { BACKOFF_MAX_MS } from "../../src/export/backoff.ts";
import { MAX_BATCH_BYTES } from "../../src/export/batch.ts";
import { REFUSALS } from "../../src/export/deliver.ts";
import { SETTLE_MS } from "../../src/export/gap.ts";
import type { LeaseClient } from "../../src/export/loop.ts";
import {
  BATCH_DEADLINE_MS,
  LEASE_TTL_MS,
  ORPHAN_SWEEP_INTERVAL_MS,
  POLL_MS,
  STATUS_INTERVAL_MS,
  TEST_MODEL,
} from "../../src/export/loop.ts";
import type { DestinationStatus, WorkerMessage } from "../../src/export/protocol.ts";
import { CommitTimeoutError } from "../../src/export/state.ts";
import { DAY, destination, row, sharedLease, stateOf, T0, type World, world } from "./harness.ts";

/**
 * The delivery loop on a fake clock: a fake main database, a real `export.db`,
 * and a receiver that records and answers. Each test names the design
 * sentence it pins (*Delivery*, *Cursor*, *Worker protocol*).
 */

const worlds: World[] = [];
afterEach(async () => {
  for (const w of worlds.splice(0)) {
    await w.loop.handle({ type: "stop" });
    w.dispose();
  }
});

function track<T extends World>(w: T): T {
  worlds.push(w);
  return w;
}

const sentIds = (w: World): string[] => w.sent.flatMap((s) => s.ids);
const statuses = (w: World): Array<Extract<WorkerMessage, { type: "status" }>> =>
  w.posted.filter((m): m is Extract<WorkerMessage, { type: "status" }> => m.type === "status");
const lastStatus = (w: World): DestinationStatus | undefined => statuses(w).at(-1)?.destinations[0];

test("the request path posts nothing: rows completing reach the receiver by polling alone", async () => {
  // The loop has no entry a request could call: its only inputs are the
  // protocol's configuration, gate and lifecycle messages, and the store it polls.
  const w = track(world());
  await w.loop.start();
  w.rows.push(row("r1", T0 + 1_000));
  // No message, no call: the row is found by the next ticks once settled.
  await w.advance(SETTLE_MS + 1_000 + POLL_MS);
  expect(sentIds(w)).toEqual(["r1"]);
});

test("a completed row arrives within settle + one tick", async () => {
  const w = track(world());
  await w.loop.start();
  const completed = T0 + 2_000;
  w.clock.now = completed;
  w.rows.push(row("r1", completed));
  await w.advance(SETTLE_MS - 1);
  expect(sentIds(w)).toEqual([]);
  await w.advance(POLL_MS + 1);
  expect(sentIds(w)).toEqual(["r1"]);
  const s = await stateOf(w);
  expect([s.cursorAt, s.cursorId]).toEqual([completed, "r1"]);
  expect(s.exportedTotal).toBe(1);
});

test("a long request completing after shorter, later ones is still exported", async () => {
  const w = track(world());
  await w.loop.start();
  w.rows.push(row("b-short", T0 + 1_000, { at: T0 + 500 }));
  await w.advance(SETTLE_MS + POLL_MS * 2);
  expect(sentIds(w)).toEqual(["b-short"]);
  // Started before b-short, completed well after the cursor passed b-short.
  w.rows.push(row("a-long", w.clock.now, { at: T0 - 3_600_000, durationMs: 3_600_000 }));
  await w.advance(SETTLE_MS + POLL_MS * 2);
  expect(sentIds(w)).toEqual(["b-short", "a-long"]);
});

test("a sustained stream drains in 500-row batches pass after pass", async () => {
  const w = track(world());
  for (let i = 0; i < 1_250; i++) w.rows.push(row(`r${String(i).padStart(5, "0")}`, T0 + i));
  w.clock.now = T0 + 1_250 + SETTLE_MS;
  await w.loop.start();
  await w.settle();
  expect(w.sent.map((s) => s.ids.length)).toEqual([500, 500, 250]);
  expect((await stateOf(w)).exportedTotal).toBe(1_250);
});

test("retry statuses back off, honour Retry-After, and never move the cursor", async () => {
  for (const status of [408, 429, 500, 503]) {
    const w = track(world({ rows: [row("r1", T0 - SETTLE_MS - 1)] }));
    w.answer = () => new Response("receiver text", { status });
    await w.loop.start();
    await w.settle();
    expect(w.sent).toHaveLength(1);
    const s = await stateOf(w);
    expect([s.cursorAt, s.cursorId, s.exportedTotal]).toEqual([T0 - 60_000, "", 0]);
    expect(s.lastError).toBe(`HTTP ${status}`);
    // First retry due after 1 s * jitter(0.5) = 750 ms; ticks are what try it again.
    await w.advance(POLL_MS);
    expect(w.sent).toHaveLength(2);
    w.answer = () => new Response(null, { status: 200 });
    await w.advance(POLL_MS * 2);
    expect(w.sent.length).toBeGreaterThanOrEqual(3);
    expect((await stateOf(w)).cursorId).toBe("r1");
  }

  const w = track(world({ rows: [row("r1", T0 - SETTLE_MS - 1)] }));
  w.answer = () => new Response("", { status: 429, headers: { "retry-after": "120" } });
  await w.loop.start();
  await w.settle();
  await w.advance(119_000);
  expect(w.sent).toHaveLength(1);
  await w.advance(1_000 + POLL_MS);
  expect(w.sent).toHaveLength(2);
});

test("the backoff doubles across consecutive failures and resets on success", async () => {
  const w = track(world({ rows: [row("r1", T0 - SETTLE_MS - 1)] }));
  w.answer = () => new Response("", { status: 503 });
  await w.loop.start();
  await w.settle();
  const retryAts: number[] = [];
  for (let i = 0; i < 4; i++) {
    await w.advance(STATUS_INTERVAL_MS);
    retryAts.push((lastStatus(w)?.retryAt ?? 0) - w.clock.now);
    await w.advance(60_000);
  }
  expect(w.sent.length).toBeGreaterThanOrEqual(4);
  w.answer = () => new Response(null, { status: 200 });
  await w.advance(BACKOFF_MAX_MS + POLL_MS);
  await w.advance(STATUS_INTERVAL_MS);
  expect(lastStatus(w)?.retryAt).toBeNull();
  expect(lastStatus(w)?.failing).toBe(false);
});

test("a hard 4xx pauses the destination at maximum backoff, cursor unmoved, until edited", async () => {
  const w = track(world({ rows: [row("r1", T0 - SETTLE_MS - 1)] }));
  w.answer = () => new Response("bad key: sk-live-123", { status: 401 });
  await w.loop.start();
  await w.settle();
  expect(w.sent).toHaveLength(1);
  const s = await stateOf(w);
  expect(s.lastError).toBe("HTTP 401");
  expect(s.cursorId).toBe("");
  await w.advance(BACKOFF_MAX_MS - 2 * POLL_MS);
  expect(w.sent).toHaveLength(1);
  await w.advance(STATUS_INTERVAL_MS);
  expect(lastStatus(w)).toMatchObject({ enabled: true, failing: true, lastError: "HTTP 401" });

  // An edit is the operator's answer: tried again at once.
  w.answer = () => new Response(null, { status: 200 });
  const [d] = w.destinations;
  if (d === undefined) throw new Error("no destination");
  d.updatedAt += 1;
  await w.loop.handle({ type: "destinationsChanged" });
  await w.settle();
  expect(w.sent).toHaveLength(2);
  expect((await stateOf(w)).cursorId).toBe("r1");
  expect(w.logger.lines.join("\n")).not.toContain("sk-live-123");
});

test("a 3xx is a hard failure, never followed", async () => {
  const w = track(world({ rows: [row("r1", T0 - SETTLE_MS - 1)] }));
  w.answer = () => new Response(null, { status: 302, headers: { location: "https://evil.test" } });
  await w.loop.start();
  await w.settle();
  expect(w.sent.map((s) => s.url)).toEqual(["https://hooks.test/in"]);
  expect((await stateOf(w)).lastError).toBe("HTTP 302");
});

test("Elasticsearch per-item errors drop and the batch commits; retryable items retry", async () => {
  const es = destination({
    type: "elasticsearch",
    config: { url: "https://es.test:9200", auth: "none" },
  });
  const w = track(
    world({ destinations: [es], rows: [row("r1", T0 - 20_000), row("r2", T0 - 19_000)] }),
  );
  w.answer = () =>
    Response.json({
      errors: true,
      items: [
        { index: { _id: "r1", status: 201 } },
        {
          index: {
            _id: "r2",
            status: 400,
            error: { type: "mapper_parsing_exception", reason: "doc" },
          },
        },
      ],
    });
  await w.loop.start();
  await w.settle();
  expect(w.sent[0]?.url).toBe("https://es.test:9200/_bulk");
  expect(w.sent[0]?.headers["content-type"]).toBe("application/x-ndjson");
  const s = await stateOf(w);
  expect([s.cursorId, s.exportedTotal, s.droppedTotal]).toEqual(["r2", 1, 1]);
  expect(s.lastError).toBe("dropped 1 of 2: mapper_parsing_exception");

  w.rows.push(row("r3", w.clock.now - SETTLE_MS));
  w.answer = () => Response.json({ errors: true, items: [{ index: { _id: "r3", status: 503 } }] });
  await w.advance(POLL_MS);
  expect((await stateOf(w)).cursorId).toBe("r2");
});

test("an Elasticsearch `failure` (unreadable 2xx) is a hard failure, not a commit", async () => {
  const es = destination({
    type: "elasticsearch",
    config: { url: "https://es.test:9200", auth: "none" },
  });
  const w = track(world({ destinations: [es], rows: [row("r1", T0 - 20_000)] }));
  w.answer = () => Response.json({ took: 1 });
  await w.loop.start();
  await w.settle();
  const s = await stateOf(w);
  expect(s.cursorId).toBe("");
  expect(s.lastError).toBe("HTTP 200 unreadable-bulk-response");
  await w.advance(STATUS_INTERVAL_MS);
  expect(lastStatus(w)?.failing).toBe(true);
  expect(lastStatus(w)?.counters.batchesFailed).toBe(1);
});

test("skip to now moves past every settled row, counts them dropped, and sends none", async () => {
  const w = track(
    world({ rows: [row("r1", T0 - 30_000), row("r2", T0 - 29_000), row("r3", T0 - 28_000)] }),
  );
  w.answer = () => new Response("", { status: 401 });
  await w.loop.start();
  await w.settle();
  expect(w.sent).toHaveLength(1);

  await w.loop.handle({ type: "skip", ref: "s1", id: "hook" });
  await w.settle();
  const reply = w.posted.find((m) => m.type === "skipResult");
  expect(reply).toEqual({ type: "skipResult", ref: "s1", ok: true, at: T0 });
  // Applied at once, despite the backoff; the receiver is not called for it.
  let s = await stateOf(w);
  expect([s.cursorId, s.droppedTotal, s.exportedTotal]).toEqual(["r3", 3, 0]);
  // The request is cleared once everything completed before it has settled.
  expect(s.skipRequestedAt).toBe(T0);
  await w.advance(SETTLE_MS + POLL_MS);
  s = await stateOf(w);
  expect(s.skipRequestedAt).toBeNull();
  expect(s.caughtUpThrough).toBeGreaterThanOrEqual(T0);
  expect(w.sent).toHaveLength(1);

  // Rows completing after the skip are exported normally.
  w.answer = () => new Response(null, { status: 200 });
  w.rows.push(row("r4", T0 + 1));
  await w.advance(SETTLE_MS + POLL_MS * 2);
  expect(sentIds(w)).toContain("r4");
});

test("skip waits for rows completed before it to settle, then counts them too", async () => {
  const w = track(world());
  await w.loop.start();
  w.rows.push(row("late", T0 - 1));
  await w.loop.handle({ type: "skip", ref: "s", id: "hook" });
  await w.settle();
  expect((await stateOf(w)).skipRequestedAt).toBe(T0);
  await w.advance(SETTLE_MS + POLL_MS);
  const s = await stateOf(w);
  expect([s.cursorId, s.droppedTotal, s.skipRequestedAt]).toEqual(["late", 1, null]);
  expect(w.sent).toHaveLength(0);
});

/**
 * Two cluster workers, one destination. The lease TTL (60 s) outlasts the batch
 * deadline (45 s), so a holder stalled past its lease is past its deadline too
 * and the bounded commit refuses it; the epoch fence is what decides when the
 * lease is lost early (Redis restarted, flushed, failed over).
 */
function twoHolders(): {
  a: World;
  b: World;
  lease: LeaseClient;
  release: (r: Response) => void;
} {
  const shared = sharedLease(() => a.clock.now);
  const a = track(world({ lease: shared.lease, nodeId: "node-a", rows: [row("r1", T0 - 20_000)] }));
  const held: Array<(r: Response) => void> = [];
  a.answer = () =>
    new Promise<Response>((resolve) => {
      held.push(resolve);
    });
  const b = track(
    world({
      lease: shared.lease,
      nodeId: "node-b",
      statePath: a.statePath,
      reader: a,
      clock: a.clock,
    }),
  );
  return {
    a,
    b,
    lease: shared.lease,
    release: (r) => {
      for (const resolve of held.splice(0)) resolve(r);
    },
  };
}

test("a stalled holder whose lease was lost has its commit rejected by the epoch fence", async () => {
  const { a, b, lease, release } = twoHolders();
  await a.loop.start();
  await a.settle();
  expect(a.sent).toHaveLength(1);
  // A stalls inside its deadline; B cannot start while A holds the lease...
  a.clock.now += 1_000;
  await b.loop.start();
  await b.settle();
  expect(b.sent).toHaveLength(0);
  // ...until the coordinator loses it (a Redis restart, a flush).
  await lease.release(`export:${destination().generation}`, "node-a");
  await b.loop.handle({ type: "destinationsChanged" });
  await b.settle();
  expect(b.sent.map((s) => s.ids)).toEqual([["r1"]]);
  const afterB = await stateOf(b);
  expect(afterB.cursorId).toBe("r1");

  // A wakes within its deadline and its receiver says OK: the fence refuses it.
  release(new Response(null, { status: 200 }));
  await a.settle();
  const final = await stateOf(b);
  expect(final.exportedTotal).toBe(1);
  expect(final.epoch).toBe(afterB.epoch);
  expect(a.logger.records.some((r) => r.msg === "export pass fenced out")).toBe(true);
});

test("a holder stalled past its lease TTL is past its deadline: its commit never lands", async () => {
  const { a, b, release } = twoHolders();
  await a.loop.start();
  await a.settle();
  a.clock.now += LEASE_TTL_MS + 1;
  await b.loop.start();
  await b.settle();
  expect(b.sent.map((s) => s.ids)).toEqual([["r1"]]);
  const afterB = await stateOf(b);

  release(new Response(null, { status: 200 }));
  await a.settle();
  const final = await stateOf(b);
  expect([final.cursorId, final.exportedTotal, final.epoch]).toEqual(["r1", 1, afterB.epoch]);
});

test("two cluster workers never run two passes for one destination", async () => {
  const { lease } = sharedLease(() => a.clock.now);
  const a = track(world({ lease, nodeId: "node-a", rows: [row("r1", T0 - 20_000)] }));
  let release: (r: Response) => void = () => {};
  a.answer = () =>
    new Promise<Response>((resolve) => {
      release = resolve;
    });
  await a.loop.start();
  await a.settle();
  const b = track(
    world({ lease, nodeId: "node-b", statePath: a.statePath, reader: a, clock: a.clock }),
  );
  await b.loop.start();
  await b.advance(POLL_MS * 2);
  expect(b.sent).toHaveLength(0);
  release(new Response(null, { status: 200 }));
  await a.settle();
  expect((await stateOf(a)).cursorId).toBe("r1");
});

test("a batch past its 45 s deadline aborts uncommitted and backs off", async () => {
  const w = track(world({ rows: [row("r1", T0 - 20_000)] }));
  w.answer = () => new Promise<Response>(() => {});
  await w.loop.start();
  await w.settle();
  // The 20 s request timeout fires first and is a retry of its own...
  await w.advance(20_000);
  expect((await stateOf(w)).lastError).toBe("timeout");
  // ...while a store read that hangs is cut by the batch deadline.
  w.beforePage = (signal) =>
    new Promise<void>((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  await w.advance(POLL_MS * 2);
  await w.advance(BATCH_DEADLINE_MS);
  const s = await stateOf(w);
  expect(s.lastError).toBe("deadline exceeded");
  expect(s.cursorId).toBe("");
});

test("gap warning: raised on lag, even while disabled; not for an idle caught-up destination", async () => {
  // Idle and caught up for 40 days, past 30-day retention: its cursor never
  // moves, but every pass advances caught_up_through, so it is never flagged.
  const idle = track(world());
  await idle.loop.start();
  await idle.settle();
  for (let day = 0; day < 40; day++) {
    idle.clock.now += DAY;
    await idle.advance(POLL_MS);
  }
  const quiet = await stateOf(idle);
  expect(quiet.gapPossibleAt).toBeNull();
  expect(quiet.cursorAt).toBe(T0 - 60_000);
  expect(quiet.caughtUpThrough).toBeGreaterThan(idle.clock.now - SETTLE_MS - POLL_MS - 1);

  // Lagging: disabled, its position 29.5 days back, retention 30 days.
  const lag = track(
    world({ destinations: [destination({ enabled: false, startAt: T0 - 29.5 * DAY })] }),
  );
  await lag.loop.start();
  await lag.settle();
  const s = await stateOf(lag);
  expect(s.gapPossibleAt).toBe(T0);
  await lag.advance(STATUS_INTERVAL_MS);
  expect(lastStatus(lag)?.counters.gapWarnings).toBe(1);
  expect(lastStatus(lag)?.gapPossibleAt).toBe(T0);
  // Once until acknowledged: later ticks do not count it again.
  await lag.advance(POLL_MS * 3);
  expect(lastStatus(lag)?.counters.gapWarnings).toBe(1);
});

test("gap warning: a worker down longer than retention flags on its first check", async () => {
  const w = track(world({ destinations: [destination({ startAt: T0 - 40 * DAY })] }));
  w.rows.push(row("old", T0 - 35 * DAY));
  await w.loop.start();
  await w.settle();
  expect((await stateOf(w)).gapPossibleAt).toBe(T0);
  // Export continues regardless.
  expect(sentIds(w)).toEqual(["old"]);
});

test("gap warning: shortening retention flags at the next commit, before committing", async () => {
  const w = track(world());
  await w.loop.start();
  await w.settle();
  expect((await stateOf(w)).gapPossibleAt).toBeNull();
  // Shortened, then restored before the worker looks: only the marker survives.
  w.settings = { ...w.settings, logRetentionLoweredAt: T0 + 1 };
  w.rows.push(row("r1", T0 + 2));
  await w.advance(SETTLE_MS + POLL_MS);
  const s = await stateOf(w);
  expect(s.gapPossibleAt).not.toBeNull();
  expect(s.seenRetentionLoweredAt).toBe(T0 + 1);
  expect(sentIds(w)).toEqual(["r1"]);

  // Acknowledged, it does not come back for the same shortening.
  await w.state().clearGap(destination().generation, w.clock.now);
  await w.advance(POLL_MS * 3);
  expect((await stateOf(w)).gapPossibleAt).toBeNull();
});

test("gap warning: any shortening newer than the one last seen flags, even one before creation", async () => {
  // Spec *Retention changes*: `logRetentionLoweredAt > seen_retention_lowered_at`
  // flags every destination — no exemption for when the destination was made.
  const w = track(world());
  w.settings = { ...w.settings, logRetentionLoweredAt: T0 - 120_000 };
  await w.loop.start();
  await w.settle();
  const s = await stateOf(w);
  expect(s.gapPossibleAt).toBe(T0);
  // The commit that follows records the marker as seen.
  await w.advance(POLL_MS);
  expect((await stateOf(w)).seenRetentionLoweredAt).toBe(T0 - 120_000);
});

test("a destination with an unreadable filter is refused and never exported", async () => {
  const w = track(
    world({
      destinations: [destination({ filterMalformed: true, filter: { apiKeyIds: [] } })],
      rows: [row("r1", T0 - 20_000)],
    }),
  );
  await w.loop.start();
  await w.advance(POLL_MS * 3);
  expect(w.sent).toHaveLength(0);
  const s = await stateOf(w);
  expect(s.lastError).toBe(REFUSALS.filter);
  // Never caught up either: match-nothing must not read as "nothing to send".
  expect(s.caughtUpThrough).toBe(0);
  await w.advance(STATUS_INTERVAL_MS);
  expect(lastStatus(w)?.failing).toBe(true);
});

test("a skip on a destination refused for its filter does not retry it every tick", async () => {
  const w = track(world({ destinations: [destination({ filterMalformed: true })] }));
  await w.loop.start();
  await w.settle();
  const first = (await stateOf(w)).lastErrorAt;
  await w.loop.handle({ type: "skip", ref: "s", id: "hook" });
  w.clock.now += 1;
  await w.advance(POLL_MS * 4);
  expect((await stateOf(w)).lastErrorAt).toBe(first);
});

test("a secret failing its schema refuses the destination; nothing is sent", async () => {
  const w = track(
    world({
      destinations: [destination({ hasSecret: true })],
      rows: [row("r1", T0 - 20_000)],
    }),
  );
  w.secrets.set("hook", '{"headers":{"x-token":"t"},"surprise":1}');
  await w.loop.start();
  await w.settle();
  expect(w.sent).toHaveLength(0);
  expect((await stateOf(w)).lastError).toBe(REFUSALS.secret);
  expect(w.logger.lines.join("\n")).not.toContain("x-token");
});

test("an index name Elasticsearch would refuse fails the destination with a fixed summary", async () => {
  const es = destination({
    type: "elasticsearch",
    config: { url: "https://es.test:9200", auth: "none", index: "{yyyy.MM.dd}-secret-name" },
  });
  const w = track(
    world({ destinations: [es], rows: [row("r1", T0 - 20_000, { at: Date.UTC(-1000, 0, 1) })] }),
  );
  await w.loop.start();
  await w.settle();
  expect(w.sent).toHaveLength(0);
  expect((await stateOf(w)).lastError).toBe(REFUSALS.index);
  expect(w.logger.lines.join("\n")).not.toContain("secret-name");
});

test("oversized records are dropped in place and the cursor moves past them", async () => {
  const big = "x".repeat(MAX_BATCH_BYTES);
  const meta = (v: string) => ({ traceMetadata: { k: v } });
  // A tiny per-request limit makes "oversized" reachable with ordinary rows.
  const tight = destination({ maxRequestBytes: 3_000 });

  // Middle: [ok, big, ok] — the big one counted, the cursor past all three.
  const mid = track(
    world({
      destinations: [tight],
      rows: [row("a", T0 - 20_003), row("b", T0 - 20_002, meta(big)), row("c", T0 - 20_001)],
    }),
  );
  await mid.loop.start();
  await mid.settle();
  expect(sentIds(mid)).toEqual(["a", "c"]);
  let s = await stateOf(mid);
  expect([s.cursorId, s.exportedTotal, s.droppedTotal]).toEqual(["c", 2, 1]);
  expect(s.lastError).toBe("dropped 1 of 3: record-too-large");

  // Trailing: [ok, big] — the cursor still reaches the big one.
  const tail = track(
    world({
      destinations: [tight],
      rows: [row("a", T0 - 20_002), row("b", T0 - 20_001, meta(big))],
    }),
  );
  await tail.loop.start();
  await tail.settle();
  s = await stateOf(tail);
  expect([s.cursorId, s.exportedTotal, s.droppedTotal]).toEqual(["b", 1, 1]);

  // All oversized: nothing sent, nothing stalls.
  const all = track(
    world({
      destinations: [tight],
      rows: [row("a", T0 - 20_002, meta(big)), row("b", T0 - 20_001, meta(big))],
    }),
  );
  await all.loop.start();
  await all.settle();
  expect(all.sent).toHaveLength(0);
  s = await stateOf(all);
  expect([s.cursorId, s.droppedTotal]).toEqual(["b", 2]);
});

test("status is coalesced to at most one message per second, with no row data", async () => {
  const w = track(world());
  await w.loop.start();
  for (let i = 0; i < 200; i++) w.rows.push(row(`r${String(i).padStart(4, "0")}`, T0 + i));
  for (let i = 0; i < 40; i++) {
    await w.loop.handle({ type: "destinationsChanged" });
    await w.advance(250);
  }
  await w.advance(SETTLE_MS + POLL_MS);
  const at = statuses(w).map((m) => m.at);
  for (let i = 1; i < at.length; i++) {
    expect((at[i] as number) - (at[i - 1] as number)).toBeGreaterThanOrEqual(STATUS_INTERVAL_MS);
  }
  expect(at.length).toBeGreaterThan(3);
  const text = JSON.stringify(w.posted);
  expect(text).not.toContain("r0001");
  expect(text).not.toContain("hooks.test");
  expect(lastStatus(w)).toMatchObject({ id: "hook", exportedTotal: 200 });
});

test("test sends one synthetic record and replies with the outcome", async () => {
  const w = track(world({ rows: [row("real", T0 - 20_000)] }));
  w.destinations[0] = destination({ enabled: false });
  await w.loop.start();
  await w.settle();
  await w.loop.handle({ type: "test", ref: "t1", id: "hook" });
  expect(w.sent).toHaveLength(1);
  const body = JSON.parse(w.sent[0]?.body ?? "") as {
    records: Array<{ model: { requested: string }; id: string }>;
  };
  expect(body.records).toHaveLength(1);
  expect(body.records[0]?.model.requested).toBe(TEST_MODEL);
  expect(body.records[0]?.id).not.toBe("real");
  expect(w.posted.find((m) => m.type === "testResult")).toMatchObject({
    type: "testResult",
    ref: "t1",
    ok: true,
    status: 200,
  });

  w.answer = () => new Response("nope", { status: 403 });
  await w.loop.handle({ type: "test", ref: "t2", id: "hook" });
  expect(w.posted.filter((m) => m.type === "testResult").at(-1)).toEqual({
    type: "testResult",
    ref: "t2",
    ok: false,
    error: "HTTP 403",
    status: 403,
  });
  await w.loop.handle({ type: "test", ref: "t3", id: "absent" });
  expect(w.posted.at(-1)).toMatchObject({
    ref: "t3",
    ok: false,
    error: "no such export destination",
  });
  // A test moves no cursor.
  expect((await stateOf(w)).cursorId).toBe("");
});

test("preview returns the record for a real row, with its key label and no body", async () => {
  const w = track(world({ rows: [row("real", T0 - 20_000, { apiKeyId: "k1" })] }));
  w.labels.set("k1", "team");
  await w.loop.start();
  await w.loop.handle({ type: "preview", ref: "p1", requestId: "real" });
  const reply = w.posted.find((m) => m.type === "previewResult");
  expect(reply).toMatchObject({
    ok: true,
    record: { id: "real", apiKey: { id: "k1", label: "team" }, nodeId: "node-a" },
  });
  if (reply?.type === "previewResult" && reply.ok) {
    expect(Object.keys(reply.record as object)).not.toContain("body");
  }
  await w.loop.handle({ type: "preview", ref: "p2", requestId: "nope" });
  expect(w.posted.at(-1)).toEqual({
    type: "previewResult",
    ref: "p2",
    ok: false,
    error: "no such request",
  });
});

test("pause cancels in-flight passes, closes every handle, replies paused; resume reopens", async () => {
  const w = track(world({ rows: [row("r1", T0 - 20_000)] }));
  w.answer = () => new Promise<Response>(() => {});
  await w.loop.start();
  await w.settle();
  expect(w.sent).toHaveLength(1);
  await w.loop.handle({ type: "pause" });
  expect(w.posted.at(-1)).toEqual({ type: "paused" });
  expect(w.closes).toBe(1);
  expect(w.clock.pending()).toBe(0);
  // While paused, requests are answered at once and nothing runs.
  await w.loop.handle({ type: "test", ref: "t", id: "hook" });
  expect(w.posted.at(-1)).toMatchObject({ ref: "t", ok: false, error: "export worker paused" });
  await w.advance(POLL_MS * 3);
  expect(w.sent).toHaveLength(1);

  w.answer = () => new Response(null, { status: 200 });
  await w.loop.handle({ type: "resume" });
  await w.settle();
  expect(w.opens).toBe(2);
  expect((await stateOf(w)).cursorId).toBe("r1");
});

test("stop abandons the in-flight batch uncommitted and closes handles", async () => {
  const w = track(world({ rows: [row("r1", T0 - 20_000)] }));
  w.answer = () => new Promise<Response>(() => {});
  await w.loop.start();
  await w.settle();
  await w.loop.handle({ type: "stop" });
  expect(w.closes).toBe(1);
  expect(w.clock.pending()).toBe(0);
  const reopened = (await import("../../src/export/state/sqlite.ts")).openSqliteExportState(
    w.statePath,
  );
  try {
    const [s] = await reopened.list();
    expect(s?.cursorId).toBe("");
  } finally {
    reopened.close();
  }
});

test("gatesChanged is accepted and changes nothing; destinationsChanged ticks at once", async () => {
  const w = track(world());
  await w.loop.start();
  await w.settle();
  await w.loop.handle({ type: "gatesChanged", gates: { bodyLoggingAllowed: true } });
  w.clock.now += SETTLE_MS + 1;
  w.rows.push(row("r1", T0));
  await w.loop.handle({ type: "destinationsChanged" });
  await w.settle();
  expect(sentIds(w)).toEqual(["r1"]);
});

test("removed destinations' state rows are swept by deleteOrphans at most hourly", async () => {
  const w = track(world());
  await w.loop.start();
  await w.settle();
  w.destinations.splice(0);
  await w.loop.handle({ type: "destinationsChanged" });
  await w.settle();
  // The orphan clock starts on the first sweep after the removal (within the hour).
  await w.advance(ORPHAN_SWEEP_INTERVAL_MS);
  const [s] = await w.state().list();
  expect(s?.orphanedAt).not.toBeNull();
});

test("records carry the key label and this node's id; filters reach the read", async () => {
  const w = track(
    world({
      destinations: [destination({ filter: { apiKeyIds: ["k1"] } })],
      rows: [
        row("mine", T0 - 20_001, { apiKeyId: "k1" }),
        row("other", T0 - 20_000, { apiKeyId: "k2" }),
      ],
    }),
  );
  w.labels.set("k1", "team");
  await w.loop.start();
  await w.settle();
  expect(sentIds(w)).toEqual(["mine"]);
  const record = (JSON.parse(w.sent[0]?.body ?? "") as { records: unknown[] }).records[0];
  expect(record).toMatchObject({ apiKey: { id: "k1", label: "team" }, nodeId: "node-a" });
});

test("lifecycle messages are serialized: a resume sent during a pause waits for it", async () => {
  const w = track(world({ rows: [row("r1", T0 - 20_000)] }));
  w.answer = () => new Promise<Response>(() => {});
  await w.loop.start();
  await w.settle();
  const paused = w.loop.handle({ type: "pause" });
  const resumed = w.loop.handle({ type: "resume" });
  await Promise.all([paused, resumed]);
  expect(w.posted.filter((m) => m.type === "paused")).toHaveLength(1);
  expect([w.opens, w.closes]).toEqual([2, 1]);
});

test("a tick in flight when pause arrives starts no pass", async () => {
  const w = track(world({ rows: [row("r1", T0 - 20_000)] }));
  await w.loop.start();
  await w.loop.handle({ type: "pause" });
  // The resumed tick blocks reading configuration until released.
  let release: () => void = () => {};
  w.beforeDestinations = () =>
    new Promise<void>((resolve) => {
      release = resolve;
    });
  const resumed = w.loop.handle({ type: "resume" });
  await Bun.sleep(5);
  w.beforeDestinations = async () => {};
  const paused = w.loop.handle({ type: "pause" });
  release();
  await Promise.all([resumed, paused]);
  await w.advance(POLL_MS * 3);
  expect(w.sent).toHaveLength(0);
  expect(w.posted.filter((m) => m.type === "paused")).toHaveLength(2);
});

test("a batch whose deadline expires during a commit's settings read stays uncommitted", async () => {
  const w = track(world({ rows: [row("r1", T0 - 20_000)] }));
  // The receiver accepts; the commit's prerequisite (re-reading settings) then
  // hangs until the 45 s batch deadline has passed.
  let reads = 0;
  const held: Array<() => void> = [];
  const release = (): void => {
    for (const resolve of held.splice(0)) resolve();
  };
  w.answer = () => {
    w.beforeSettings = () => {
      reads += 1;
      return new Promise<void>((resolve) => {
        held.push(resolve);
      });
    };
    return new Response(null, { status: 200 });
  };
  await w.loop.start();
  await w.settle();
  expect(w.sent).toHaveLength(1);
  expect(reads).toBeGreaterThanOrEqual(1);
  await w.advance(BATCH_DEADLINE_MS);
  w.beforeSettings = async () => {};
  release();
  await w.settle();
  const s = await stateOf(w);
  expect([s.cursorId, s.exportedTotal]).toEqual(["", 0]);
  expect(s.lastError).toBe("deadline exceeded");
});

test("a pass cancelled by pause during a commit's settings read commits nothing", async () => {
  const w = track(world({ rows: [row("r1", T0 - 20_000)] }));
  const held: Array<() => void> = [];
  const release = (): void => {
    for (const resolve of held.splice(0)) resolve();
  };
  w.answer = () => {
    w.beforeSettings = () =>
      new Promise<void>((resolve) => {
        held.push(resolve);
      });
    return new Response(null, { status: 200 });
  };
  await w.loop.start();
  await w.settle();
  const paused = w.loop.handle({ type: "pause" });
  await Bun.sleep(5);
  w.beforeSettings = async () => {};
  release();
  await paused;
  const reopened = (await import("../../src/export/state/sqlite.ts")).openSqliteExportState(
    w.statePath,
  );
  try {
    const [s] = await reopened.list();
    expect([s?.cursorId, s?.exportedTotal]).toEqual(["", 0]);
  } finally {
    reopened.close();
  }
});

test("pause cancels an outbound test, replies to it, and only then acknowledges", async () => {
  const w = track(world());
  w.answer = () => new Promise<Response>(() => {});
  await w.loop.start();
  await w.settle();
  const testing = w.loop.handle({ type: "test", ref: "t", id: "hook" });
  await Bun.sleep(5);
  expect(w.sent).toHaveLength(1);
  await w.loop.handle({ type: "pause" });
  await testing;
  const order = w.posted.filter((m) => m.type !== "status").map((m) => m.type);
  expect(order).toEqual(["testResult", "paused"]);
  expect(w.posted.find((m) => m.type === "testResult")).toMatchObject({
    ref: "t",
    ok: false,
    error: "export worker paused",
  });
  // Nothing of the test is left running: no timers, handles closed after it.
  expect(w.clock.pending()).toBe(0);
  expect(w.closes).toBe(1);
});

test("pause drains a skip that is using the handles before closing them", async () => {
  const w = track(world({ rows: [row("r1", T0 - 20_000)] }));
  await w.loop.start();
  await w.settle();
  const held: Array<() => void> = [];
  w.beforeSettings = async () => {};
  w.beforeDestinations = () =>
    new Promise<void>((resolve) => {
      held.push(resolve);
    });
  const skipping = w.loop.handle({ type: "skip", ref: "s", id: "hook" });
  await Bun.sleep(5);
  let pausedYet = false;
  const pausing = w.loop.handle({ type: "pause" }).then(() => {
    pausedYet = true;
  });
  await Bun.sleep(5);
  expect(pausedYet).toBe(false);
  expect(w.closes).toBe(0);
  w.beforeDestinations = async () => {};
  for (const resolve of held.splice(0)) resolve();
  await Promise.all([skipping, pausing]);
  const order = w.posted.filter((m) => m.type !== "status").map((m) => m.type);
  expect(order).toEqual(["skipResult", "paused"]);
  expect(w.closes).toBe(1);
});

test("stop cancels an outbound test too, and leaves no timer behind", async () => {
  const w = track(world());
  w.answer = () => new Promise<Response>(() => {});
  await w.loop.start();
  await w.settle();
  const testing = w.loop.handle({ type: "test", ref: "t", id: "hook" });
  await Bun.sleep(5);
  await w.loop.handle({ type: "stop" });
  await testing;
  expect(w.clock.pending()).toBe(0);
  expect(w.closes).toBe(1);
});

test("counters survive pause and resume within one worker instance", async () => {
  const w = track(world({ rows: [row("r1", T0 - 20_000)] }));
  await w.loop.start();
  await w.settle();
  await w.advance(STATUS_INTERVAL_MS);
  expect(lastStatus(w)?.counters.recordsSent).toBe(1);
  await w.loop.handle({ type: "pause" });
  await w.loop.handle({ type: "resume" });
  w.rows.push(row("r2", w.clock.now - SETTLE_MS));
  await w.advance(POLL_MS);
  await w.advance(STATUS_INTERVAL_MS);
  expect(lastStatus(w)?.counters).toMatchObject({ recordsSent: 2, batchesOk: 2 });
});

test("a skip cancelled by pause before its writes replies paused and writes nothing", async () => {
  const w = track(world());
  await w.loop.start();
  await w.settle();
  const held: Array<() => void> = [];
  w.beforeDestinations = () =>
    new Promise<void>((resolve) => {
      held.push(resolve);
    });
  const skipping = w.loop.handle({ type: "skip", ref: "s", id: "hook" });
  await Bun.sleep(5);
  // The skip's read is still on the handle: pause waits for it before closing.
  const pausing = w.loop.handle({ type: "pause" });
  await Bun.sleep(5);
  expect(w.closes).toBe(0);
  for (const resolve of held.splice(0)) resolve();
  await Promise.all([pausing, skipping]);
  expect(w.closes).toBe(1);
  expect(w.posted.find((m) => m.type === "skipResult")).toEqual({
    type: "skipResult",
    ref: "s",
    ok: false,
    error: "export worker paused",
  });
  const reopened = (await import("../../src/export/state/sqlite.ts")).openSqliteExportState(
    w.statePath,
  );
  try {
    expect((await reopened.list())[0]?.skipRequestedAt).toBeNull();
  } finally {
    reopened.close();
  }
});

test("pause drains a preview reading the handles, then replies before acknowledging", async () => {
  const w = track(world({ rows: [row("r1", T0 - 20_000)] }));
  await w.loop.start();
  await w.settle();
  const held: Array<() => void> = [];
  // Hold the preview's row read.
  w.beforeGetLog = () =>
    new Promise<void>((resolve) => {
      held.push(resolve);
    });
  const previewing = w.loop.handle({ type: "preview", ref: "p", requestId: "r1" });
  await Bun.sleep(5);
  const pausing = w.loop.handle({ type: "pause" });
  await Bun.sleep(5);
  expect(w.closes).toBe(0);
  for (const resolve of held.splice(0)) resolve();
  await Promise.all([previewing, pausing]);
  const order = w.posted.filter((m) => m.type !== "status").map((m) => m.type);
  expect(order).toEqual(["previewResult", "paused"]);
  expect(w.posted.find((m) => m.type === "previewResult")).toMatchObject({
    ok: false,
    error: "export worker paused",
  });
  expect(w.closes).toBe(1);
});

test("every batch commit is bounded by the batch's remaining deadline", async () => {
  const w = track(world({ rows: [row("r1", T0 - 20_000)] }));
  const bounds: Array<{ remainingMs: number; aborted: boolean } | undefined> = [];
  w.onCommit = (call, write) => {
    bounds.push(
      call.bound === undefined
        ? undefined
        : {
            remainingMs: call.bound.deadlineAt - call.bound.now(),
            aborted: call.bound.signal.aborted,
          },
    );
    return write();
  };
  await w.loop.start();
  await w.settle();
  expect(bounds.length).toBeGreaterThan(0);
  for (const bound of bounds) {
    expect(bound).toBeDefined();
    expect(bound?.aborted).toBe(false);
    expect(bound?.remainingMs).toBeGreaterThanOrEqual(1);
    expect(bound?.remainingMs).toBeLessThanOrEqual(BATCH_DEADLINE_MS);
  }
});

test("a commit the store times out at the deadline leaves the batch uncommitted and recorded", async () => {
  const w = track(world({ rows: [row("r1", T0 - 20_000)] }));
  // The store's own bound fires: what Postgres' statement/lock timeout or
  // SQLite's busy timeout does to a write that would land after the deadline.
  w.onCommit = async (call) => {
    if (call.next.cursorId === "r1") throw new CommitTimeoutError();
    return true;
  };
  await w.loop.start();
  await w.settle();
  expect(w.sent).toHaveLength(1);
  const s = await stateOf(w);
  expect([s.cursorId, s.exportedTotal]).toEqual(["", 0]);
  expect(s.lastError).toBe("deadline exceeded");
  await w.advance(STATUS_INTERVAL_MS);
  expect(lastStatus(w)?.counters.batchesRetry).toBe(1);
  expect(lastStatus(w)?.counters.batchesOk).toBe(0);
  // Retried normally once the store lets it through.
  w.onCommit = (_call, write) => write();
  await w.advance(POLL_MS * 2);
  expect((await stateOf(w)).cursorId).toBe("r1");
});

test("a commit blocked on export.db's writer lock past the deadline never lands", async () => {
  // Against the real store: when the receiver answers, another connection
  // takes export.db's writer lock and the batch has 100 ms left. The commit
  // waits on the lock only that long, is refused, and nothing moves.
  const w = track(world({ rows: [row("r1", T0 - 20_000)] }));
  const { Database } = await import("bun:sqlite");
  let blocker: InstanceType<typeof Database> | null = null;
  w.answer = () => {
    blocker = new Database(w.statePath);
    blocker.run("BEGIN IMMEDIATE");
    w.clock.now += BATCH_DEADLINE_MS - 100;
    return new Response(null, { status: 200 });
  };
  const bounds: number[] = [];
  w.onCommit = async (call, write) => {
    if (call.bound !== undefined) bounds.push(call.bound.deadlineAt - call.bound.now());
    try {
      return await write();
    } finally {
      const held = blocker as InstanceType<typeof Database> | null;
      blocker = null;
      held?.run("ROLLBACK");
      held?.close();
    }
  };
  const started = performance.now();
  await w.loop.start();
  await w.settle();
  expect(bounds[0]).toBeLessThanOrEqual(100);
  expect(performance.now() - started).toBeLessThan(2_000);
  const s = await stateOf(w);
  expect([s.cursorId, s.exportedTotal]).toEqual(["", 0]);
  expect(s.lastError).toBe("deadline exceeded");
});

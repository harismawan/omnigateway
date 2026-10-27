import type { Logger } from "@omni/ir";
import type { ExportReader } from "@omni/store/exportReader";
import type { ExportDestination, RequestLog, Settings } from "@omni/store/types";
import { BACKOFF_MAX_MS, retryDelay } from "./backoff.ts";
import { cutBatches, MAX_BATCH_RECORDS, OVERSIZED_REASON } from "./batch.ts";
import {
  bodyCuts,
  createBodyAttacher,
  DEFAULT_BODY_BUDGET_BYTES,
  requestBytes,
} from "./body/attach.ts";
import {
  type DeliveryOutcome,
  deliver,
  droppedSummary,
  IndexRefusedError,
  prepare,
  REFUSALS,
  type Sender,
  type Timers,
  type Transport,
} from "./deliver.ts";
import { effectivePosition, type GapReason, gapReason, SETTLE_MS } from "./gap.ts";
import type {
  BodyGates,
  DestinationCounters,
  DestinationStatus,
  MainMessage,
  TestResult,
  WorkerMessage,
} from "./protocol.ts";
import { REPLY_ERRORS } from "./protocol.ts";
import { buildRecord } from "./record.ts";
import { CommitTimeoutError, type ExportState, type ExportStateStore } from "./state.ts";

/**
 * The export worker's delivery loop: everything the worker does, with every
 * effect injected so a test drives it on a fake clock. `worker.ts` is only the
 * Bun `Worker` entry that opens real handles and relays messages. Design:
 * docs/superpowers/specs/2026-10-24-log-export-design.md (*Delivery*,
 * *Cursor*, *Asynchrony* → Worker protocol, *Restore and import*).
 *
 * **Shape.** A tick every {@link POLL_MS} (and at once on
 * `destinationsChanged`) re-reads configuration, checks every destination for
 * a possible gap — disabled and backing-off ones included — and starts a pass
 * for each enabled destination that has none running and whose backoff has
 * expired. Destinations run concurrently; each has at most one pass.
 *
 * **A pass** takes the lease `export:<generation>` (cluster mode only), claims
 * the state row's next epoch, and sends batches back to back until nothing
 * settled remains or {@link PASS_MS} elapse. Before every batch it renews the
 * lease (a failed renewal ends the pass), reads the settle clock, and checks
 * for a gap against the committed position. Each batch — read, encode, send,
 * commit — runs under a {@link BATCH_DEADLINE_MS} deadline from that renewal,
 * shorter than the lease TTL, through one `AbortSignal` reaching the store
 * read, the encoder loop and the request — and into the commit itself, which
 * the state store bounds to the time left (`CommitBound`), so a write the
 * database has not completed by the deadline never takes effect. Every commit
 * is also fenced by the epoch: a `false` means another holder took over, and
 * the pass stops without writing anything else. The two guard different
 * things — the deadline a slow holder, the fence a superseded one.
 *
 * **Failures.** Retryable answers (transport error, timeout, 408, 429, 5xx)
 * end the pass with the cursor where it was and the next attempt backed off
 * (`backoff.ts`); no retry ever sleeps while the lease is held. Other 4xx,
 * any 3xx, and a refused configuration wait the maximum backoff — the
 * destination stays enabled — until its configuration changes or the
 * operator skips to now. Receiver-dropped records (Elasticsearch per-item
 * errors, OTLP `partialSuccess`) and records too large for one request are
 * counted as dropped and the batch commits past them.
 *
 * **Text.** Nothing here logs or stores a record, a URL, a header, a secret
 * or a receiver's words: `last_error` and log `reason`s are the fixed
 * summaries `deliver.ts` produces.
 */

export const POLL_MS = 5_000;
export const PASS_MS = 30_000;
export const BATCH_DEADLINE_MS = 45_000;
export const LEASE_TTL_MS = 60_000;
/**
 * How much of the lease is not trusted: the lease counts as lost this long
 * before its TTL, so a holder near expiry stops before another node, whose
 * clock may run ahead, can take it. Still leaves 55 s, past the 45 s batch.
 */
export const LEASE_SAFETY_MS = 5_000;
export const STATUS_INTERVAL_MS = 1_000;
export const ORPHAN_SWEEP_INTERVAL_MS = 60 * 60 * 1000;
/** How long `stop` waits for in-flight passes to unwind before closing handles regardless. */
export const STOP_BUDGET_MS = 4_000;

/** The coordinator's lease surface (`Coord["lease"]`), or null on one node. */
export type LeaseClient = {
  acquire(name: string, holderId: string, ttlMs: number): Promise<boolean>;
  release(name: string, holderId: string): Promise<void>;
};

/** Everything the loop opens, opened together and closed together. */
export type Handles = {
  reader: ExportReader;
  state: ExportStateStore;
  lease: LeaseClient | null;
  close(): void | Promise<void>;
};

export type LoopDeps = {
  exportBodiesAllowed?: boolean;
  bodyBudgetBytes?: number;
  gates?: BodyGates;
  /** Opens fresh handles: at start and on every `resume`. */
  open(): Promise<Handles>;
  transport: Transport;
  /** Wall clock, epoch ms: pass length, backoff, operator-facing instants. */
  now(): number;
  timers: Timers;
  random(): number;
  post(message: WorkerMessage): void;
  logger: Logger;
  /** Lease holder id, and `nodeId` on every record. */
  nodeId: string;
};

export type ExportLoop = {
  /** Opens handles and runs the first tick. */
  start(): Promise<void>;
  /** One main → worker message. Resolves once it is handled (`stop`: once everything is closed). */
  handle(message: MainMessage): Promise<void>;
  /** Resolves when no tick and no pass is in flight. */
  idle(): Promise<void>;
};

type Runtime = {
  bodyLimit?: number;
  destination: ExportDestination;
  running: Promise<void> | null;
  controller: AbortController | null;
  /**
   * Consecutive retryable failures this pass knows of, seeded from the shared
   * row at claim. The schedule itself (`retry_at`, `failing`) lives in the
   * shared state alone, so every node reads the same one.
   */
  failures: number;
  /** The largest retention marker this worker already flagged a gap for. */
  loweredFlagged: number;
  counters: DestinationCounters;
};

/** Why a pass was cancelled. Identity, not message, is what is compared. */
const CANCELLED = {
  pause: new Error("export paused"),
  stop: new Error("export stopped"),
  removed: new Error("destination removed or disabled"),
  changed: new Error("destination configuration changed"),
};
const DEADLINE = new Error("batch deadline");
const LEASE_LOST = new Error("lease expired");

const DEADLINE_SUMMARY = "deadline exceeded";
const INTERNAL_SUMMARY = "internal error";

/** One batch's cancellation and the instant its 45 s deadline falls. */
type Batch = { signal: AbortSignal; deadlineAt: number };

type CommitNext = {
  cursorAt: number;
  cursorId: string;
  caughtUpThrough?: number;
  exportedDelta?: number;
  droppedDelta?: number;
  lastSuccessAt?: number;
};

/**
 * `work`, or the signal's reason as soon as it aborts — whichever first. The
 * work itself is not stopped (a store read cannot be), only no longer awaited.
 */
function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

const zeroCounters = (): DestinationCounters => ({
  recordsSent: 0,
  recordsDropped: 0,
  batchesOk: 0,
  batchesRetry: 0,
  batchesFailed: 0,
  gapWarnings: 0,
});

export function createExportLoop(deps: LoopDeps): ExportLoop {
  const attacher = createBodyAttacher(deps.bodyBudgetBytes ?? DEFAULT_BODY_BUDGET_BYTES);
  let gates = deps.gates ?? { bodyLoggingAllowed: false, bodyLoggingEnabled: false };
  const { logger, nodeId, timers } = deps;
  let phase: "idle" | "running" | "paused" | "stopped" = "idle";
  let handles: Handles | null = null;
  const runtimes = new Map<string, Runtime>();
  let destinations: ExportDestination[] = [];
  /** Database clock minus wall clock, as last measured: status lag without a query per second. */
  let clockOffset = 0;

  let tickTimer: unknown = null;
  let ticking: Promise<void> | null = null;
  let tickAgain = false;
  let lastOrphanSweep = Number.NEGATIVE_INFINITY;

  let statusTimer: unknown = null;
  let lastStatusAt = Number.NEGATIVE_INFINITY;

  /**
   * `test`, `preview` and `skip` in flight: each uses the handles, so pause
   * and stop cancel them (an outbound test is aborted) and wait for them to
   * reply before closing anything.
   */
  const operations = new Set<{ done: Promise<void>; controller: AbortController }>();

  /**
   * Handle work a cancelled caller stopped waiting for (`guard`): a store read
   * cannot be interrupted, so pause and stop wait for it to finish before
   * closing the handle it runs on.
   */
  const abandoned = new Set<Promise<unknown>>();
  const guard = <T>(work: Promise<T>, signal: AbortSignal): Promise<T> => {
    const settled = work.then(
      () => {},
      () => {},
    );
    abandoned.add(settled);
    void settled.finally(() => abandoned.delete(settled));
    return abortable(work, signal);
  };

  // --- status ------------------------------------------------------------

  function requestStatus(): void {
    if (statusTimer !== null || phase !== "running") return;
    const wait = Math.max(0, lastStatusAt + STATUS_INTERVAL_MS - deps.now());
    statusTimer = timers.setTimeout(() => {
      statusTimer = null;
      lastStatusAt = deps.now();
      void emitStatus();
    }, wait);
  }

  async function emitStatus(): Promise<void> {
    const h = handles;
    if (h === null || phase !== "running") return;
    try {
      const states = new Map((await h.state.list()).map((s) => [s.generation, s]));
      const dbNow = deps.now() + clockOffset;
      deps.post({
        type: "status",
        at: deps.now(),
        destinations: destinations.map((d) => statusOf(d, states.get(d.generation), dbNow)),
      });
    } catch {
      logger.warn("export status unreadable", { reason: INTERNAL_SUMMARY });
    }
  }

  function statusOf(
    d: ExportDestination,
    s: ExportState | undefined,
    dbNow: number,
  ): DestinationStatus {
    const rt = runtimes.get(d.generation);
    return {
      id: d.id,
      generation: d.generation,
      type: d.type,
      enabled: d.enabled,
      lagMs: s === undefined ? null : Math.max(0, dbNow - effectivePosition(s)),
      lastSuccessAt: s?.lastSuccessAt ?? null,
      lastError: s?.lastError ?? null,
      lastErrorAt: s?.lastErrorAt ?? null,
      exportedTotal: s?.exportedTotal ?? 0,
      droppedTotal: s?.droppedTotal ?? 0,
      gapPossibleAt: s?.gapPossibleAt ?? null,
      skipRequestedAt: s?.skipRequestedAt ?? null,
      // The shared schedule: every node reports the same backoff.
      ...scheduleOf(d, s),
      counters: { ...(rt?.counters ?? zeroCounters()) },
    };
  }

  // --- gap ---------------------------------------------------------------

  /**
   * Flags the destination when `position` is within a day of the prune
   * horizon or retention was shortened since it last committed. The flag is
   * set once until acknowledged; the counter moves only when this call set it.
   */
  async function checkGap(
    h: Handles,
    rt: Runtime,
    position: { cursorAt: number; caughtUpThrough: number; seenRetentionLoweredAt: number },
    settings: Settings,
    dbNow: number,
  ): Promise<void> {
    const seen = Math.max(position.seenRetentionLoweredAt, rt.loweredFlagged);
    const reason = gapReason({ ...position, seenRetentionLoweredAt: seen }, settings, dbNow);
    if (reason === null) return;
    if (reason === "retention-lowered") rt.loweredFlagged = settings.logRetentionLoweredAt;
    await flag(h, rt, reason);
  }

  async function flag(h: Handles, rt: Runtime, reason: GapReason): Promise<void> {
    if (await h.state.flagGap(rt.destination.generation, deps.now())) {
      rt.counters.gapWarnings += 1;
      logger.warn("export gap possible", { reason });
      requestStatus();
    }
  }

  // --- tick --------------------------------------------------------------

  function scheduleTick(ms: number): void {
    if (phase !== "running") return;
    if (tickTimer !== null) timers.clearTimeout(tickTimer);
    tickTimer = timers.setTimeout(() => {
      tickTimer = null;
      void tick();
    }, ms);
  }

  /** One tick, or a rerun right after the one in flight. */
  function tick(): Promise<void> {
    if (ticking !== null) {
      tickAgain = true;
      return ticking;
    }
    ticking = (async () => {
      do {
        tickAgain = false;
        try {
          await tickOnce();
        } catch {
          logger.warn("export tick failed", { reason: INTERNAL_SUMMARY });
        }
      } while (tickAgain && phase === "running");
    })().finally(() => {
      ticking = null;
      scheduleTick(POLL_MS);
    });
    return ticking;
  }

  async function tickOnce(): Promise<void> {
    const h = handles;
    if (h === null || phase !== "running") return;
    const list = await h.reader.destinations();
    const settings = await h.reader.settings();
    const dbNow = await readClock(h);
    let states = new Map((await h.state.list()).map((s) => [s.generation, s]));
    let ensured = false;
    for (const d of list) {
      if (!states.has(d.generation)) {
        await h.state.ensure(d.generation, d.startAt);
        ensured = true;
      }
    }
    if (ensured) states = new Map((await h.state.list()).map((s) => [s.generation, s]));
    if (phase !== "running") return;

    destinations = list;
    sync(list);

    for (const d of list) {
      const rt = runtimes.get(d.generation);
      const s = states.get(d.generation);
      if (rt === undefined || s === undefined) continue;
      await checkGap(h, rt, s, settings, dbNow);
    }

    // A pause or stop may have landed during the awaits above; no pass after it.
    if (phase !== "running") return;
    for (const d of list) {
      const rt = runtimes.get(d.generation);
      if (rt === undefined || !d.enabled || rt.running !== null) continue;
      // *Skip to now* is the operator's answer to a failing destination: it
      // does not wait out the backoff — except where the skip cannot apply,
      // an unreadable filter, which is refused before anything is read.
      const s = states.get(d.generation);
      const skipPending = (s?.skipRequestedAt ?? null) !== null;
      if (!due(d, s, dbNow) && !(skipPending && !d.filterMalformed)) continue;
      startPass(h, rt);
    }

    if (deps.now() - lastOrphanSweep >= ORPHAN_SWEEP_INTERVAL_MS) {
      lastOrphanSweep = deps.now();
      const removed = await h.state.deleteOrphans(
        list.map((d) => d.generation),
        deps.now(),
      );
      if (removed > 0) logger.info("export state rows removed", { count: removed });
    }
    requestStatus();
  }

  /** Runtimes follow the configuration: new ones made, removed ones cancelled, edits reset backoff. */
  function sync(list: ExportDestination[]): void {
    const live = new Set(list.map((d) => d.generation));
    for (const [generation, rt] of runtimes) {
      if (live.has(generation)) continue;
      rt.controller?.abort(CANCELLED.removed);
      runtimes.delete(generation);
    }
    for (const d of list) {
      const rt = runtimes.get(d.generation);
      if (rt === undefined) {
        runtimes.set(d.generation, {
          destination: d,
          running: null,
          controller: null,
          failures: 0,
          loweredFlagged: 0,
          counters: zeroCounters(),
        });
        continue;
      }
      if (rt.destination.revision !== d.revision) {
        delete rt.bodyLimit;
        // A change is told by the database's revision, never by `updatedAt`:
        // two edits in one millisecond, or from replicas with skewed clocks,
        // still differ. A pass still running holds the old snapshot — its
        // config, filter and secret — so it is cancelled; the next tick starts
        // one from a fresh snapshot. Cancelling aborts the request in flight
        // and stops any commit not yet authorised, so a batch the receiver
        // accepted after the edit is sent again under the new configuration
        // (at-least-once); only a commit already authorised may land.
        rt.failures = 0;
        rt.controller?.abort(CANCELLED.changed);
      }
      rt.destination = d;
      if (!d.enabled) rt.controller?.abort(CANCELLED.removed);
    }
  }

  /**
   * The shared clock, as last measured: the database's on Postgres. Retry
   * instants are written and compared on it, so nodes with skewed clocks
   * agree on when a destination is due.
   */
  function sharedNow(): number {
    return deps.now() + clockOffset;
  }

  async function readClock(h: Handles): Promise<number> {
    const dbNow = await h.reader.now();
    clockOffset = dbNow - deps.now();
    return dbNow;
  }

  // --- pass --------------------------------------------------------------

  function startPass(h: Handles, rt: Runtime): void {
    const controller = new AbortController();
    rt.controller = controller;
    rt.running = runPass(h, rt, controller.signal)
      .catch(() => {
        logger.warn("export pass failed", { reason: INTERNAL_SUMMARY });
      })
      .finally(() => {
        rt.running = null;
        rt.controller = null;
        requestStatus();
      });
  }

  /**
   * The lease, held across the pass. Everything done under it before a batch
   * — the snapshot read, `ensure`, `claim` — is bounded by the lease itself:
   * a timer aborts the pass at the TTL measured from the acquire, so work that
   * would outlive the lease sends nothing. Each batch renews it first (see
   * `pass`), and its 45 s deadline is measured from that renewal.
   */
  async function runPass(h: Handles, rt: Runtime, signal: AbortSignal): Promise<void> {
    const name = `export:${rt.destination.generation}`;
    // The TTL runs from when the lease was *asked for*, not from when the
    // answer arrived: an answer delayed past it describes a lease another
    // node may already hold, so the pass ends there — no ensure, no claim,
    // no send — and lets go of whatever it may still hold.
    const asked = deps.now();
    if (h.lease !== null) {
      if (!(await h.lease.acquire(name, nodeId, LEASE_TTL_MS))) return;
      if (deps.now() - asked >= LEASE_TTL_MS - LEASE_SAFETY_MS) {
        logger.info("export lease answered too late", { reason: "lease expired" });
        await h.lease.release(name, nodeId).catch(() => {});
        return;
      }
    }
    const lease = new AbortController();
    let timer: unknown = null;
    // When the lease was last confirmed: before the call that confirmed it.
    let heldSince = asked;
    const arm = (from: number): void => {
      if (h.lease === null) return;
      heldSince = from;
      if (timer !== null) timers.clearTimeout(timer);
      timer = timers.setTimeout(
        () => lease.abort(LEASE_LOST),
        Math.max(0, LEASE_TTL_MS - LEASE_SAFETY_MS - (deps.now() - from)),
      );
    };
    arm(heldSince);
    /**
     * Lost once the TTL has run out since the last confirmation, whether the
     * timer fired or the loop was stalled past it: a lapsed lease re-acquired
     * by its old holder may have been someone else's in between, so it does
     * not count as renewed.
     */
    const lapsed = (): boolean =>
      lease.signal.aborted || deps.now() - heldSince >= LEASE_TTL_MS - LEASE_SAFETY_MS;
    const renew = async (): Promise<boolean> => {
      if (h.lease === null) return true;
      if (lapsed()) {
        lease.abort(LEASE_LOST);
        return false;
      }
      const asked = deps.now();
      const held = await h.lease.acquire(name, nodeId, LEASE_TTL_MS);
      if (!held || lapsed()) return false;
      arm(asked);
      return true;
    };
    try {
      await pass(h, rt, AbortSignal.any([signal, lease.signal]), renew);
    } finally {
      if (timer !== null) timers.clearTimeout(timer);
      if (h.lease !== null) {
        await h.lease.release(name, nodeId).catch(() => {});
      }
    }
  }

  async function pass(
    h: Handles,
    rt: Runtime,
    signal: AbortSignal,
    renew: () => Promise<boolean>,
  ): Promise<void> {
    const generation = rt.destination.generation;
    // The pass's whole configuration — config, filter, enabled, secret — is
    // one snapshot, read by one statement, and bound to the generation and
    // `revision` the tick saw: a row that changed since is not this pass's
    // to send (the next tick's sync cancels and restarts it), and a config is
    // never paired with a secret from another version of the row.
    const snapshot = await guard(h.reader.destinationWithSecret(rt.destination.id), signal);
    if (signal.aborted) return;
    if (
      snapshot === null ||
      snapshot.destination.generation !== generation ||
      snapshot.destination.revision !== rt.destination.revision ||
      !snapshot.destination.enabled
    ) {
      return;
    }
    const d = snapshot.destination;
    await guard(h.state.ensure(generation, d.startAt), signal);
    const claimed = await guard(h.state.claim(generation), signal);
    if (claimed === null || signal.aborted) return;
    // Another node may have failed between this node's tick and its claim:
    // its schedule binds this pass too, unless a skip overrides it.
    if (claimed.skipRequestedAt === null && !due(d, claimed, sharedNow())) return;
    rt.failures = current(d, claimed) ? claimed.failures : 0;
    const epoch = claimed.epoch;
    const position = {
      cursorAt: claimed.cursorAt,
      cursorId: claimed.cursorId,
      caughtUpThrough: claimed.caughtUpThrough,
      seenRetentionLoweredAt: claimed.seenRetentionLoweredAt,
    };
    let skipAt = claimed.skipRequestedAt;
    // The filter is the scope of what leaves the installation: an unreadable
    // one reads as match-nothing, which would look caught up, so it is
    // refused here, before any read, rather than discovered by a send.
    if (d.filterMalformed) {
      await hardFailure(h, rt, epoch, REFUSALS.filter, null, true);
      return;
    }
    /** Prepared after a pending skip is applied: a skip needs no working receiver. */
    let sender: Sender | null = null;

    /**
     * Re-reads the retention marker, flags a shortening first, then commits
     * fenced — unless `batch` has aborted by then. The epoch fence stops a
     * stale holder, not an expired deadline, so the deadline is checked here,
     * against every await before the write and immediately before it.
     */
    const commit = async (next: CommitNext, batch: Batch): Promise<boolean> => {
      const settings = await guard(h.reader.settings(), batch.signal);
      const lowered = settings.logRetentionLoweredAt;
      if (lowered > Math.max(position.seenRetentionLoweredAt, rt.loweredFlagged)) {
        rt.loweredFlagged = lowered;
        await guard(flag(h, rt, "retention-lowered"), batch.signal);
      }
      const seen = Math.max(lowered, position.seenRetentionLoweredAt);
      batch.signal.throwIfAborted();
      // The write itself is bounded by the store to the time left: a commit
      // the database has not completed by the deadline does not take effect.
      // Not raced here — a write the database did complete is committed, and
      // the loop must know it to keep its position honest.
      const ok = await h.state.commit(
        generation,
        epoch,
        { ...next, seenRetentionLoweredAt: seen },
        { signal: batch.signal, deadlineAt: batch.deadlineAt, now: deps.now },
      );
      if (!ok) {
        logger.info("export pass fenced out", { reason: "another holder claimed the cursor" });
        return false;
      }
      position.cursorAt = next.cursorAt;
      position.cursorId = next.cursorId;
      position.caughtUpThrough = Math.max(position.caughtUpThrough, next.caughtUpThrough ?? 0);
      position.seenRetentionLoweredAt = seen;
      requestStatus();
      return true;
    };

    const started = deps.now();
    while (!signal.aborted && deps.now() - started < PASS_MS) {
      // Renewed immediately before every batch, the first included: the
      // batch's deadline below starts from here, and the lease outlasts it.
      if (!(await renew()) || signal.aborted) return;

      const deadline = new AbortController();
      const timer = timers.setTimeout(() => deadline.abort(DEADLINE), BATCH_DEADLINE_MS);
      const batchSignal = AbortSignal.any([signal, deadline.signal]);
      const batch: Batch = { signal: batchSignal, deadlineAt: deps.now() + BATCH_DEADLINE_MS };
      try {
        const dbNow = await guard(readClock(h), batchSignal);
        const settings = await guard(h.reader.settings(), batchSignal);
        await guard(checkGap(h, rt, position, settings, dbNow), batchSignal);
        const settled = dbNow - SETTLE_MS;
        const after = { completedAt: position.cursorAt, id: position.cursorId };

        if (skipAt !== null) {
          // *Skip to now*: move past every row completed by the request, unsent, counted.
          const bound = Math.min(settled, skipAt);
          const rows = await h.reader.exportPage({
            after,
            settledBefore: bound,
            limit: MAX_BATCH_RECORDS,
            filter: d.filter,
            signal: batchSignal,
          });
          const last = rows.at(-1);
          if (last !== undefined) {
            const ok = await commit({ ...cursorOf(last), droppedDelta: rows.length }, batch);
            if (!ok) return;
            rt.counters.recordsDropped += rows.length;
            continue;
          }
          if (bound < skipAt) return; // the skip's last rows are not settled yet
          const done = { ...cursorOfPosition(position), caughtUpThrough: skipAt };
          if (!(await commit(done, batch))) return;
          await h.state.clearSkip(generation, skipAt);
          skipAt = null;
          // The operator's action on a failing destination: try it again now.
          succeeded(rt);
          continue;
        }

        if (sender === null) {
          const prepared = prepare(d, snapshot.secret);
          if (!prepared.ok) {
            await hardFailure(h, rt, epoch, prepared.error, null, true);
            return;
          }
          sender = prepared.sender;
        }
        const rows = await h.reader.exportPage({
          after,
          settledBefore: settled,
          limit: MAX_BATCH_RECORDS,
          filter: d.filter,
          signal: batchSignal,
        });
        if (rows.length === 0) {
          await commit({ ...cursorOfPosition(position), caughtUpThrough: settled }, batch);
          return;
        }
        const outcome = await sendRows(h, rt, epoch, sender, rows, batch, commit);
        if (outcome === "stop") return;
        if (outcome !== "continue") {
          await settle(h, rt, epoch, outcome);
          return;
        }
      } catch (error) {
        if (signal.aborted) return;
        if (error === DEADLINE || deadline.signal.aborted || error instanceof CommitTimeoutError) {
          await retryable(h, rt, epoch, DEADLINE_SUMMARY, null, null);
          return;
        }
        if (error instanceof IndexRefusedError) {
          await hardFailure(h, rt, epoch, REFUSALS.index, null, true);
          return;
        }
        logger.warn("export batch failed", { reason: INTERNAL_SUMMARY });
        await retryable(h, rt, epoch, INTERNAL_SUMMARY, null, null);
        return;
      } finally {
        timers.clearTimeout(timer);
      }
    }
  }

  /**
   * Encodes `rows`, cuts them into requests and sends each, committing after
   * every accepted one. A record too large for any request is dropped in
   * place and the cursor moves past it with the next commit — or with a
   * commit of its own when nothing follows it.
   */
  async function sendRows(
    h: Handles,
    rt: Runtime,
    epoch: number,
    sender: Sender,
    rows: RequestLog[],
    batch: Batch,
    commit: (next: CommitNext, batch: Batch) => Promise<boolean>,
    metadataOnly = false,
  ): Promise<"continue" | "stop" | Exclude<DeliveryOutcome, { kind: "ok" }>> {
    if (
      rt.destination.includeBodies &&
      !metadataOnly &&
      deps.exportBodiesAllowed &&
      !(rt.destination.type === "otlp" && rt.destination.config.signal === "traces")
    ) {
      return sendBodyRows(h, rt, epoch, sender, rows, batch, commit);
    }
    const signal = batch.signal;
    const labels = await guard(h.reader.keyLabels(), signal);
    const parts: string[] = [];
    for (const row of rows) {
      signal.throwIfAborted();
      const keyLabel = row.apiKeyId === null ? null : (labels.get(row.apiKeyId) ?? null);
      parts.push(sender.part(buildRecord(row, { keyLabel, nodeId })));
    }

    let pending: { drops: number; through: RequestLog | null } = { drops: 0, through: null };
    const reasons: string[] = [];
    let dropped = 0;
    for (const cut of cutBatches(parts, sender.envelope, sender.limits)) {
      if (cut.kind === "oversized") {
        pending = { drops: pending.drops + 1, through: rows[cut.index] ?? pending.through };
        continue;
      }
      const outcome = await deliver(sender, cut.parts, {
        transport: deps.transport,
        signal,
        timers,
        now: deps.now,
        beforeSend: () => checkDeadline(batch),
      });
      if (outcome.kind !== "ok") return outcome;
      const last = rows[cut.start + cut.parts.length - 1];
      if (last === undefined) throw new Error("unreachable: batch past its rows");
      const ok = await commit(
        {
          ...cursorOf(last),
          exportedDelta: cut.parts.length - outcome.dropped,
          droppedDelta: outcome.dropped + pending.drops,
          lastSuccessAt: deps.now(),
        },
        batch,
      );
      if (!ok) return "stop";
      if (pending.drops > 0) reasons.push(OVERSIZED_REASON);
      reasons.push(...outcome.reasons);
      dropped += outcome.dropped + pending.drops;
      rt.counters.batchesOk += 1;
      rt.counters.recordsSent += cut.parts.length - outcome.dropped;
      rt.counters.recordsDropped += outcome.dropped + pending.drops;
      pending = { drops: 0, through: null };
      succeeded(rt);
    }
    if (pending.through !== null) {
      // Trailing (or only) oversized records: nothing to send, but the cursor moves past them.
      const past = { ...cursorOf(pending.through), droppedDelta: pending.drops };
      if (!(await commit(past, batch))) {
        return "stop";
      }
      reasons.push(OVERSIZED_REASON);
      dropped += pending.drops;
      rt.counters.recordsDropped += pending.drops;
    }
    // Drops are summarised in `last_error`; the batches carrying them have committed.
    const summary = droppedSummary(dropped, rows.length, reasons);
    if (summary !== null) {
      await h.state.recordError(rt.destination.generation, epoch, summary, deps.now());
    }
    return "continue";
  }

  async function bodyAllowed(h: Handles, row: RequestLog, signal: AbortSignal): Promise<boolean> {
    if (!gates.bodyLoggingAllowed || !deps.exportBodiesAllowed || row.apiKeyId === null)
      return false;
    const settings = await guard(h.reader.settings(), signal);
    if (!settings.bodyLoggingEnabled) return false;
    return !(await guard(h.reader.keyBodyOptOut(row.apiKeyId), signal));
  }

  async function sendBodyRows(
    h: Handles,
    rt: Runtime,
    epoch: number,
    sender: Sender,
    rows: RequestLog[],
    batch: Batch,
    commit: (next: CommitNext, batch: Batch) => Promise<boolean>,
  ): Promise<"continue" | "stop" | Exclude<DeliveryOutcome, { kind: "ok" }>> {
    const signal = batch.signal;
    const labels = await guard(h.reader.keyLabels(), signal);
    const metadataRows: RequestLog[] = [];
    const flush = async () => {
      if (!metadataRows.length) return "continue" as const;
      const outcome = await sendRows(h, rt, epoch, sender, metadataRows, batch, commit, true);
      metadataRows.length = 0;
      return outcome;
    };
    let droppedRecords = 0;
    const dropReasons: string[] = [];
    const dropOversized = async (row: RequestLog) => {
      if (!(await commit({ ...cursorOf(row), droppedDelta: 1 }, batch))) return false;
      rt.counters.recordsDropped++;
      droppedRecords++;
      dropReasons.push(OVERSIZED_REASON);
      await h.state.recordError(
        rt.destination.generation,
        epoch,
        droppedSummary(droppedRecords, rows.length, dropReasons) ?? OVERSIZED_REASON,
        deps.now(),
      );
      return true;
    };
    for (const row of rows) {
      signal.throwIfAborted();
      const allowed = await bodyAllowed(h, row, signal);
      if (!allowed) {
        metadataRows.push(row);
        continue;
      }
      const flushed = await flush();
      if (flushed !== "continue") return flushed;
      if (allowed && row.bodyState === "pending" && sharedNow() - (row.completedAt ?? 0) < 60_000)
        return "stop";
      const record = buildRecord(row, {
        keyLabel: row.apiKeyId === null ? null : (labels.get(row.apiKeyId) ?? null),
        nodeId,
      });
      const attached = allowed
        ? await attacher.attach(h.reader, row, record, sender, signal)
        : { record, release() {}, client: undefined };
      try {
        if (allowed && row.bodyState === "pending")
          rt.counters.bodiesLate = (rt.counters.bodiesLate ?? 0) + 1;
        if (record.body?.reason === "export budget")
          rt.counters.bodiesBudget = (rt.counters.bodiesBudget ?? 0) + 1;
        let cap = rt.bodyLimit ?? sender.maxRequestBytes ?? sender.limits.bytes;
        let halved = rt.bodyLimit !== undefined;
        for (;;) {
          if (allowed && !(await bodyAllowed(h, row, signal))) return "stop";
          // Fresh configuration is checked immediately before every HTTP send,
          // not only on the next poll/message. Never pair its secret with the
          // old sender; a changed revision cancels this snapshot instead.
          const current = await guard(h.reader.destinationWithSecret(rt.destination.id), signal);
          if (
            !current ||
            current.destination.generation !== rt.destination.generation ||
            current.destination.revision !== rt.destination.revision ||
            !current.destination.enabled
          )
            return "stop";
          if (!(await bodyAllowed(h, row, signal))) return "stop";
          const client = attached.client;
          const inline =
            client && sender.rawPart ? sender.rawPart(record, client) : sender.part(record);
          let outcome: DeliveryOutcome;
          let anyDropped = false;
          if (requestBytes(sender, inline) <= cap) {
            outcome = await deliver(sender, [inline], {
              transport: deps.transport,
              signal,
              timers,
              now: deps.now,
              beforeSend: () => checkDeadline(batch),
            });
          } else if (client && sender.bodySegment) {
            // Refuse impossible metadata caps before building segment slices.
            // This also avoids an unbounded count of tiny slices for a cap of1.
            const base = {
              ...record,
              body: { state: record.body?.state ?? "included", parts: { request: 1, response: 1 } },
            };
            if (requestBytes(sender, sender.part(base)) > cap) {
              if (!(await dropOversized(row))) return "stop";
              break;
            }
            const request = bodyCuts(sender, record, "request", client.request, cap);
            const response = bodyCuts(sender, record, "response", client.response, cap);
            record.body = {
              state: record.body?.state ?? "included",
              parts: { request: request.length, response: response.length },
            };
            const metadata = sender.part(record);
            if (requestBytes(sender, metadata) > cap) {
              if (!(await dropOversized(row))) return "stop";
              break;
            }
            outcome = await deliver(sender, [metadata], {
              transport: deps.transport,
              signal,
              timers,
              now: deps.now,
              beforeSend: () => checkDeadline(batch),
            });
            if (outcome.kind === "ok") {
              anyDropped = outcome.dropped > 0;
              dropReasons.push(...outcome.reasons);
              outer: for (const [part, cuts] of [
                ["request", request],
                ["response", response],
              ] as const) {
                for (let n = 0; n < cuts.length; n++) {
                  signal.throwIfAborted();
                  if (!(await bodyAllowed(h, row, signal))) return "stop";
                  const current = await guard(
                    h.reader.destinationWithSecret(rt.destination.id),
                    signal,
                  );
                  if (
                    !current ||
                    current.destination.generation !== rt.destination.generation ||
                    current.destination.revision !== rt.destination.revision ||
                    !current.destination.enabled
                  )
                    return "stop";
                  if (!(await bodyAllowed(h, row, signal))) return "stop";
                  const encoded = sender.bodySegment(record, part, cuts[n] ?? "", n, cuts.length);
                  outcome = await deliver(encoded.sender, [encoded.part], {
                    transport: deps.transport,
                    signal,
                    timers,
                    now: deps.now,
                    beforeSend: () => checkDeadline(batch),
                  });
                  if (outcome.kind === "ok") {
                    anyDropped ||= outcome.dropped > 0;
                    dropReasons.push(...outcome.reasons);
                  }
                  if (outcome.kind !== "ok") break outer;
                }
              }
            }
          } else {
            if (!(await dropOversized(row))) return "stop";
            break;
          }
          if (outcome.status === 413 && !halved) {
            halved = true;
            cap = Math.max(1, Math.floor(cap / 2));
            rt.bodyLimit = cap;
            logger.warn("export request limit halved", { reason: "HTTP 413" });
            continue;
          }
          if (outcome.kind !== "ok") return outcome;
          signal.throwIfAborted();
          if (
            !(await commit(
              {
                ...cursorOf(row),
                exportedDelta: anyDropped || outcome.dropped ? 0 : 1,
                droppedDelta: anyDropped || outcome.dropped ? 1 : 0,
                lastSuccessAt: deps.now(),
              },
              batch,
            ))
          )
            return "stop";
          rt.counters.recordsSent += anyDropped || outcome.dropped ? 0 : 1;
          rt.counters.recordsDropped += anyDropped || outcome.dropped ? 1 : 0;
          rt.counters.batchesOk++;
          if (anyDropped || outcome.dropped) {
            droppedRecords++;
            dropReasons.push(...outcome.reasons);
            await h.state.recordError(
              rt.destination.generation,
              epoch,
              droppedSummary(droppedRecords, rows.length, dropReasons) ?? "record dropped",
              deps.now(),
            );
          }
          succeeded(rt);
          break;
        }
      } finally {
        attached.release();
      }
    }
    return flush();
  }

  function checkDeadline(batch: Batch): void {
    batch.signal.throwIfAborted();
    if (deps.now() >= batch.deadlineAt) throw DEADLINE;
  }

  function succeeded(rt: Runtime): void {
    rt.failures = 0;
  }

  async function settle(
    h: Handles,
    rt: Runtime,
    epoch: number,
    outcome: Exclude<DeliveryOutcome, { kind: "ok" }>,
  ): Promise<void> {
    if (outcome.kind === "retry") {
      await retryable(h, rt, epoch, outcome.error, outcome.status, outcome.retryAfterMs);
    } else {
      await hardFailure(h, rt, epoch, outcome.error, outcome.status, false);
    }
  }

  async function retryable(
    h: Handles,
    rt: Runtime,
    epoch: number,
    error: string,
    status: number | null,
    retryAfterMs: number | null,
  ): Promise<void> {
    rt.failures += 1;
    const retryAt = sharedNow() + retryDelay(rt.failures, retryAfterMs, deps.random);
    rt.counters.batchesRetry += 1;
    logger.debug("export batch will be retried", {
      ...(status === null ? {} : { status }),
      retryable: true,
      reason: error,
    });
    await h.state.recordError(rt.destination.generation, epoch, error, deps.now(), {
      retryAt,
      forRevision: rt.destination.revision,
      failing: false,
      failures: rt.failures,
    });
  }

  async function hardFailure(
    h: Handles,
    rt: Runtime,
    epoch: number,
    error: string,
    status: number | null,
    refused: boolean,
  ): Promise<void> {
    rt.failures = 0;
    const retryAt = sharedNow() + BACKOFF_MAX_MS;
    if (!refused) rt.counters.batchesFailed += 1;
    logger.warn(refused ? "export destination refused" : "export destination failing", {
      ...(status === null ? {} : { status }),
      retryable: false,
      reason: error,
    });
    await h.state.recordError(rt.destination.generation, epoch, error, deps.now(), {
      retryAt,
      forRevision: rt.destination.revision,
      failing: true,
      failures: 0,
    });
  }

  // --- messages ----------------------------------------------------------

  async function find(h: Handles, id: string): Promise<ExportDestination | null> {
    return (await h.reader.destinations()).find((d) => d.id === id) ?? null;
  }

  async function runTest(ref: string, id: string, cancel: AbortSignal): Promise<TestResult> {
    const fail = (error: string, status: number | null = null): TestResult => ({
      type: "testResult",
      ref,
      ok: false,
      error,
      status,
    });
    const h = handles;
    if (h === null || phase !== "running") return fail(REPLY_ERRORS.paused);
    // Config and secret from one read: the test goes where its credential belongs.
    const snapshot = await guard(h.reader.destinationWithSecret(id), cancel);
    if (snapshot === null) return fail(REPLY_ERRORS.noDestination);
    const prepared = prepare(snapshot.destination, snapshot.secret);
    if (!prepared.ok) return fail(prepared.error);
    const at = deps.now();
    let part: string;
    try {
      part = prepared.sender.part(buildRecord(syntheticLog(at), { keyLabel: null, nodeId }));
    } catch {
      return fail(REFUSALS.index);
    }
    const deadline = new AbortController();
    const timer = timers.setTimeout(() => deadline.abort(DEADLINE), BATCH_DEADLINE_MS);
    try {
      const outcome = await deliver(prepared.sender, [part], {
        transport: deps.transport,
        signal: AbortSignal.any([cancel, deadline.signal]),
        timers,
        now: deps.now,
      });
      if (outcome.kind !== "ok") return fail(outcome.error, outcome.status);
      if (outcome.dropped > 0) {
        return fail(droppedSummary(1, 1, outcome.reasons) ?? "dropped", outcome.status);
      }
      return {
        type: "testResult",
        ref,
        ok: true,
        status: outcome.status,
        latencyMs: deps.now() - at,
      };
    } catch {
      return fail(cancel.aborted ? REPLY_ERRORS.paused : DEADLINE_SUMMARY);
    } finally {
      timers.clearTimeout(timer);
    }
  }

  async function runPreview(
    ref: string,
    requestId: string,
    cancel: AbortSignal,
  ): Promise<WorkerMessage> {
    const h = handles;
    if (h === null || phase !== "running") {
      return { type: "previewResult", ref, ok: false, error: REPLY_ERRORS.paused };
    }
    const row = await guard(h.reader.getLog(requestId), cancel);
    if (row === null) {
      return { type: "previewResult", ref, ok: false, error: REPLY_ERRORS.noRequest };
    }
    const labels = await guard(h.reader.keyLabels(), cancel);
    const keyLabel = row.apiKeyId === null ? null : (labels.get(row.apiKeyId) ?? null);
    return { type: "previewResult", ref, ok: true, record: buildRecord(row, { keyLabel, nodeId }) };
  }

  async function runSkip(ref: string, id: string, cancel: AbortSignal): Promise<WorkerMessage> {
    const h = handles;
    if (h === null || phase !== "running") {
      return { type: "skipResult", ref, ok: false, error: REPLY_ERRORS.paused };
    }
    const d = await guard(find(h, id), cancel);
    if (d === null)
      return { type: "skipResult", ref, ok: false, error: REPLY_ERRORS.noDestination };
    const at = await guard(readClock(h), cancel);
    // Cancelled before the writes, or not at all: a skip the main thread was
    // told landed did land, and one it was told was refused did not.
    cancel.throwIfAborted();
    await h.state.ensure(d.generation, d.startAt);
    await h.state.requestSkip(d.generation, at);
    void tick();
    return { type: "skipResult", ref, ok: true, at };
  }

  async function runAckGap(
    ref: string,
    id: string,
    seenAt: number,
    cancel: AbortSignal,
  ): Promise<WorkerMessage> {
    const h = handles;
    if (h === null || phase !== "running") {
      return { type: "ackGapResult", ref, ok: false, error: REPLY_ERRORS.paused };
    }
    const d = await guard(find(h, id), cancel);
    if (d === null) {
      return { type: "ackGapResult", ref, ok: false, error: REPLY_ERRORS.noDestination };
    }
    cancel.throwIfAborted();
    const cleared = await h.state.clearGap(d.generation, seenAt);
    if (cleared) requestStatus();
    return { type: "ackGapResult", ref, ok: true, cleared };
  }

  /**
   * Cancels every pass and every test/preview/skip, and waits for all of them
   * to unwind — at most `budgetMs` when given (stop) — so no handle is closed
   * under work still using it and every request has had its reply.
   */
  async function cancelAll(reason: Error, budgetMs: number | null): Promise<void> {
    if (tickTimer !== null) timers.clearTimeout(tickTimer);
    tickTimer = null;
    if (statusTimer !== null) timers.clearTimeout(statusTimer);
    statusTimer = null;
    for (const rt of runtimes.values()) rt.controller?.abort(reason);
    for (const op of operations) op.controller.abort(reason);
    const settled = idle();
    if (budgetMs === null) {
      await settled;
      return;
    }
    let timer: unknown = null;
    await Promise.race([
      settled,
      new Promise<void>((resolve) => {
        timer = timers.setTimeout(resolve, budgetMs);
      }),
    ]);
    timers.clearTimeout(timer);
  }

  async function closeHandles(): Promise<void> {
    const h = handles;
    handles = null;
    if (h === null) return;
    try {
      await h.close();
    } catch {
      logger.warn("export handles did not close cleanly", { reason: INTERNAL_SUMMARY });
    }
  }

  /**
   * Runs one request against the handles as a tracked operation and posts its
   * reply — always exactly one. Cancelled by pause or stop, it replies
   * `paused` (or what it had); the lifecycle step waits for that reply.
   */
  function reply(
    work: (cancel: AbortSignal) => Promise<WorkerMessage>,
    fallback: WorkerMessage,
    cancelled: WorkerMessage,
  ): Promise<void> {
    const controller = new AbortController();
    const op = { controller, done: Promise.resolve() };
    op.done = (async () => {
      try {
        deps.post(await work(controller.signal));
      } catch {
        if (controller.signal.aborted) {
          deps.post(cancelled);
        } else {
          logger.warn("export request failed", { reason: INTERNAL_SUMMARY });
          deps.post(fallback);
        }
      } finally {
        operations.delete(op);
      }
    })();
    operations.add(op);
    return op.done;
  }

  async function idle(): Promise<void> {
    for (;;) {
      const pending = [
        ticking,
        ...[...runtimes.values()].map((rt) => rt.running),
        ...[...operations].map((op) => op.done),
        ...abandoned,
      ].filter((p): p is Promise<unknown> => p !== null);
      if (pending.length === 0) return;
      await Promise.allSettled(pending);
    }
  }

  /**
   * Fresh handles and a tick. Runtimes — counters, backoff — are kept: they
   * belong to this worker instance, which a pause does not end. Only a new
   * worker starts its counters at zero.
   */
  async function open(): Promise<void> {
    handles = await deps.open();
    phase = "running";
    await tick();
  }

  /**
   * `pause`, `resume` and `stop` run one at a time, in arrival order: a
   * `resume` posted while a pause is still closing handles must not open new
   * ones underneath it, and `paused` must mean "closed now".
   */
  let lifecycle: Promise<void> = Promise.resolve();
  const inOrder = (work: () => Promise<void>): Promise<void> => {
    const next = lifecycle.then(work, work);
    lifecycle = next.catch(() => {});
    return next;
  };

  return {
    start: () => inOrder(open),

    async handle(message) {
      if (message.type === "pause" || message.type === "resume" || message.type === "stop") {
        await inOrder(() => lifecycleStep(message.type));
        return;
      }
      // Everything else sees the lifecycle as posted before it: a `test` sent
      // right after `resume` runs on the reopened handles, not against "paused".
      await lifecycle;
      switch (message.type) {
        case "destinationsChanged":
          if (phase === "running") await tick();
          return;
        case "gatesChanged":
          gates = message.gates;
          for (const rt of runtimes.values())
            if (rt.destination.includeBodies) rt.controller?.abort(CANCELLED.changed);
          return;
        case "test":
          await reply(
            (cancel) => runTest(message.ref, message.id, cancel),
            testFailure(message.ref, REPLY_ERRORS.internal),
            testFailure(message.ref, REPLY_ERRORS.paused),
          );
          return;
        case "preview": {
          const failed = (error: string): WorkerMessage => ({
            type: "previewResult",
            ref: message.ref,
            ok: false,
            error,
          });
          await reply(
            (cancel) => runPreview(message.ref, message.requestId, cancel),
            failed(REPLY_ERRORS.internal),
            failed(REPLY_ERRORS.paused),
          );
          return;
        }
        case "skip": {
          const failed = (error: string): WorkerMessage => ({
            type: "skipResult",
            ref: message.ref,
            ok: false,
            error,
          });
          await reply(
            (cancel) => runSkip(message.ref, message.id, cancel),
            failed(REPLY_ERRORS.internal),
            failed(REPLY_ERRORS.paused),
          );
          return;
        }
        case "ackGap": {
          const failed = (error: string): WorkerMessage => ({
            type: "ackGapResult",
            ref: message.ref,
            ok: false,
            error,
          });
          await reply(
            (cancel) => runAckGap(message.ref, message.id, message.seenAt, cancel),
            failed(REPLY_ERRORS.internal),
            failed(REPLY_ERRORS.paused),
          );
          return;
        }
      }
    },

    idle,
  };

  async function lifecycleStep(type: "pause" | "resume" | "stop"): Promise<void> {
    switch (type) {
      case "pause":
        if (phase === "running") {
          phase = "paused";
          await cancelAll(CANCELLED.pause, null);
          await closeHandles();
        }
        if (phase === "paused") deps.post({ type: "paused" });
        return;
      case "resume":
        if (phase !== "paused") return;
        await open();
        return;
      case "stop":
        if (phase === "stopped") return;
        phase = "stopped";
        await cancelAll(CANCELLED.stop, STOP_BUDGET_MS);
        await closeHandles();
        return;
    }
  }
}

/**
 * Whether a shared retry schedule still applies to `d`: it was written for
 * this version of the destination. An edit since — a different database
 * `revision`, compared for equality, never a clock — is the operator's answer
 * to the failure, so the schedule no longer binds.
 */
function current(
  d: ExportDestination,
  s: Pick<ExportState, "retryAt" | "retryForRevision">,
): boolean {
  return s.retryAt !== null && (s.retryForRevision === null || d.revision === s.retryForRevision);
}

/** Whether `d` may start a pass at shared instant `now`, by the shared schedule alone. */
function due(
  d: ExportDestination,
  s: Pick<ExportState, "retryAt" | "retryForRevision"> | undefined,
  now: number,
): boolean {
  if (s === undefined || !current(d, s)) return true;
  return now >= (s.retryAt as number);
}

/** The schedule as status reports it: what binds `d` now, from shared state. */
function scheduleOf(
  d: ExportDestination,
  s: ExportState | undefined,
): { retryAt: number | null; failing: boolean } {
  if (s === undefined || !current(d, s)) return { retryAt: null, failing: false };
  return { retryAt: s.retryAt, failing: s.failing };
}

function testFailure(ref: string, error: string): TestResult {
  return { type: "testResult", ref, ok: false, error, status: null };
}

function cursorOf(row: RequestLog): { cursorAt: number; cursorId: string } {
  if (row.completedAt === null) throw new Error("unreachable: exported row without completedAt");
  return { cursorAt: row.completedAt, cursorId: row.id };
}

function cursorOfPosition(p: { cursorAt: number; cursorId: string }): {
  cursorAt: number;
  cursorId: string;
} {
  return { cursorAt: p.cursorAt, cursorId: p.cursorId };
}

/** The record *Send test* sends: obviously synthetic, carrying nothing from any request. */
export const TEST_MODEL = "omni-export-test";

function syntheticLog(at: number): RequestLog {
  return {
    id: `omni-export-test-${crypto.randomUUID()}`,
    state: "done",
    at,
    apiKeyId: null,
    requestedModel: TEST_MODEL,
    resolvedProvider: null,
    resolvedModel: null,
    credentialId: null,
    attempts: 0,
    status: 200,
    errorCode: null,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    ttftMs: null,
    durationMs: 0,
    costUsd: 0,
    degradations: [],
    rtkApplied: false,
    rtkFilterHits: 0,
    rtkOriginalCodeUnits: 0,
    rtkCompressedCodeUnits: 0,
    rtkEstimatedTokensSaved: 0,
    rtkFilters: [],
    sessionId: null,
    turnId: null,
    agent: null,
    tags: [],
    traceMetadata: {},
    clientRequestId: null,
    upstreamRequestId: null,
    completedAt: at,
    bodyState: null,
  };
}

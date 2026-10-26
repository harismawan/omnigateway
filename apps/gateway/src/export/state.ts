/**
 * The export worker's runtime state: one row per destination **generation**,
 * written by the worker alone. Design:
 * docs/superpowers/specs/2026-10-24-log-export-design.md (*Destination*,
 * *Delivery* → lease and fencing, *Cursor*).
 *
 * Two impls behind one interface, because the state cannot live in one place
 * on both backends: SQLite keeps it in its own `export.db` beside the main
 * file (`state/sqlite.ts`) — the worker holds only a read-only handle on the
 * main file, so a write there would move `data_version` and take the writer
 * lock inference waits on — and Postgres in the main database's
 * `export_state` table, which carries no `bump_config_version` trigger
 * (`state/postgres.ts`). The contract both meet is
 * `apps/gateway/test/export/state.test.ts`.
 *
 * **The fence.** `claim` increments `epoch` and hands the new value to the
 * pass as its token. `commit` and `recordError` write only while the row's
 * epoch still equals that token; zero rows touched (`false`) means another
 * holder has claimed since, and the caller stops without writing anything
 * else. A commit also never moves `(cursor_at, cursor_id)` backwards, even
 * under a matching token — a stale batch re-sent by the current holder is
 * at-least-once, never a rewind. `caught_up_through` and
 * `seen_retention_lowered_at` only grow. Counters are deltas, added in the
 * same statement.
 *
 * The flags — `flagGap`, `requestSkip`, `clearSkip`, `clearGap` — are not
 * fenced: each is a single conditional write whose outcome does not depend on
 * who holds the pass.
 *
 * No wall-clock reads: every instant is the caller's `now`/`at`.
 */

/** Orphaned state rows are kept this long, so restoring a recent snapshot reclaims its cursor. */
export const ORPHAN_KEEP_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Stored `last_error` is cut to this many UTF-16 code units. Callers pass a
 * short, fixed, gateway-authored summary (never a receiver body); the bound is
 * defence in depth, not formatting.
 */
export const LAST_ERROR_MAX_CHARS = 200;

export type ExportState = {
  generation: string;
  cursorAt: number;
  cursorId: string;
  epoch: number;
  lastSuccessAt: number | null;
  lastError: string | null;
  lastErrorAt: number | null;
  exportedTotal: number;
  droppedTotal: number;
  /** Settle bound of the last pass that found nothing ahead; `0` until one has. */
  caughtUpThrough: number;
  /** `Settings.logRetentionLoweredAt` as of the last commit; `0` until one has. */
  seenRetentionLoweredAt: number;
  gapPossibleAt: number | null;
  skipRequestedAt: number | null;
  /** When `deleteOrphans` first found no live destination for this generation. */
  orphanedAt: number | null;
  /**
   * The destination's shared retry schedule, written with the failure that
   * set it and cleared by the next commit, so every cluster node honours one
   * backoff and one `Retry-After`: no node starts a pass before `retryAt`.
   * `retryForRevision` is the destination's database `revision` when it was
   * set — any edit since (a different revision; never a clock comparison,
   * which a replica's skew could invert) is the operator's answer and retries
   * at once, as does a pending skip.
   */
  retryAt: number | null;
  retryForRevision: number | null;
  /** The last attempt was a hard failure or a refusal (until a success). */
  failing: boolean;
  /** Consecutive retryable failures, for the doubling backoff. */
  failures: number;
};

/** The retry schedule a failure writes (see {@link ExportState.retryAt}). */
export type RetrySchedule = {
  retryAt: number;
  forRevision: number;
  failing: boolean;
  failures: number;
};

/** What a successful batch (or an idle, caught-up pass) commits. */
export type ExportCommit = {
  cursorAt: number;
  cursorId: string;
  /** Omitted keeps the stored value; a smaller one never lowers it. */
  caughtUpThrough?: number;
  /** Required: the design writes it with every cursor or `caught_up_through` commit. */
  seenRetentionLoweredAt: number;
  exportedDelta?: number;
  droppedDelta?: number;
  /** Omitted keeps the stored value. */
  lastSuccessAt?: number;
};

/**
 * The deadline a commit must land within, as an **absolute** instant on the
 * caller's clock — never a precomputed duration, which every await before the
 * write would silently stretch. The epoch fence stops a stale holder; it does
 * not stop a write that lands after the batch's own deadline, so the store
 * bounds the write itself: a commit that has not completed in the database by
 * `deadlineAt` (or by the time `signal` aborts) fails with
 * {@link CommitTimeoutError} and changes nothing.
 *
 * Postgres (`state/postgres.ts`): connection acquisition is raced against the
 * deadline (a connection that arrives late is handed back unused); before
 * each statement — `BEGIN`, one setup, the fenced `UPDATE`, `COMMIT` — the
 * signal is checked and the time left recomputed; the setup sets
 * `statement_timeout` and `lock_timeout` to that time for the transaction; an
 * abort cancels the statement in flight, and the transaction rolls back.
 * SQLite (`state/sqlite.ts`): the wait for the writer lock is bounded to the
 * time left, and the signal is checked immediately before the synchronous
 * write.
 *
 * Residual, by design: a `COMMIT` already sent to the server when the
 * deadline passes may complete there. Then the write is committed though the
 * caller hears of it late — the rows were accepted by the receiver, so that is
 * at-least-once, not a loss.
 */
export type CommitBound = { signal: AbortSignal; deadlineAt: number; now: () => number };

/** A bounded commit that did not land in time; nothing was written. */
export class CommitTimeoutError extends Error {
  constructor() {
    super("commit deadline exceeded");
    this.name = "CommitTimeoutError";
  }
}

/**
 * Whole milliseconds left on `bound`, at least 1; throws
 * {@link CommitTimeoutError} when the signal has aborted or none is left.
 * Called afresh before every statement.
 */
export function remainingMs(bound: CommitBound): number {
  const left = Math.floor(bound.deadlineAt - bound.now());
  if (bound.signal.aborted || !(left >= 1)) throw new CommitTimeoutError();
  return left;
}

export interface ExportStateStore {
  /** Inserts the row at cursor `(startAt, '')` when absent; never touches an existing one. */
  ensure(generation: string, startAt: number): Promise<void>;
  /** Takes the next epoch; `null` when the row does not exist. */
  claim(generation: string): Promise<ExportState | null>;
  /**
   * `false` (nothing written) when fenced out, the row is gone, or the cursor
   * would go back. With `bound`, rejects with {@link CommitTimeoutError} when
   * the write cannot land within it — and then nothing was written either.
   */
  commit(
    generation: string,
    epoch: number,
    next: ExportCommit,
    bound?: CommitBound,
  ): Promise<boolean>;
  /**
   * Fenced like `commit`; `message` is bounded to {@link LAST_ERROR_MAX_CHARS}.
   * With `schedule`, the failure's retry schedule is written in the same
   * statement; without, the stored schedule is kept (a drop summary written
   * after a successful commit).
   */
  recordError(
    generation: string,
    epoch: number,
    message: string,
    at: number,
    schedule?: RetrySchedule,
  ): Promise<boolean>;
  /** Sets `gap_possible_at` once, until cleared; `true` only when this call set it. */
  flagGap(generation: string, at: number): Promise<boolean>;
  /** The operator's acknowledgement of the flag raised at `seenAt` or earlier; a later one survives. */
  clearGap(generation: string, seenAt: number): Promise<boolean>;
  /** Records *Skip to now*; a later request is kept over an earlier one. */
  requestSkip(generation: string, at: number): Promise<boolean>;
  /** Clears the request applied (the `at` read); a newer request survives. */
  clearSkip(generation: string, at: number): Promise<boolean>;
  /** Every row, in generation order. At most a handful: destinations are capped at 10. */
  list(): Promise<ExportState[]>;
  /**
   * Starts the orphan clock on every row not in `liveGenerations`, stops it on
   * every row that is, and deletes rows orphaned for at least `keepMs`.
   * Returns how many were deleted.
   */
  deleteOrphans(liveGenerations: readonly string[], now: number, keepMs?: number): Promise<number>;
  /** Idempotent. Releases what this store opened; a pool passed in stays the caller's. */
  close(): void;
}

/** `message` cut to the bound, never leaving half a surrogate pair at the cut. */
export function boundMessage(message: string): string {
  if (message.length <= LAST_ERROR_MAX_CHARS) return message;
  const cut = message.slice(0, LAST_ERROR_MAX_CHARS);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

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

export interface ExportStateStore {
  /** Inserts the row at cursor `(startAt, '')` when absent; never touches an existing one. */
  ensure(generation: string, startAt: number): Promise<void>;
  /** Takes the next epoch; `null` when the row does not exist. */
  claim(generation: string): Promise<ExportState | null>;
  /** `false` (nothing written) when fenced out, the row is gone, or the cursor would go back. */
  commit(generation: string, epoch: number, next: ExportCommit): Promise<boolean>;
  /** Fenced like `commit`; `message` is bounded to {@link LAST_ERROR_MAX_CHARS}. */
  recordError(generation: string, epoch: number, message: string, at: number): Promise<boolean>;
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

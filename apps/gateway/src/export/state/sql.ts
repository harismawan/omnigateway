import type { ExportCommit, ExportState } from "../state.ts";

/**
 * The state store's statements, shared by both impls so the fence cannot
 * differ between them: the predicate *is* the contract. A dialect supplies
 * how the n-th (1-based) parameter is spelled, its two-argument maximum, and
 * how a JSON array parameter becomes a set of strings.
 *
 * The monotonic guard is a row-value comparison, the same spelling as the
 * export cursor's keyset (`packages/store/src/exportPage.ts`), so on Postgres
 * `cursor_id` compares under the same collation as the read it resumes.
 */
export type Dialect = {
  p(n: number): string;
  greatest: "max" | "GREATEST";
  /** A subquery yielding each string of the JSON-array parameter `param`. */
  jsonSet(param: string): string;
  /** The boolean false literal. */
  false: "0" | "FALSE";
};

const COLUMNS = `generation, cursor_at, cursor_id, epoch, last_success_at, last_error,
  last_error_at, exported_total, dropped_total, caught_up_through,
  seen_retention_lowered_at, gap_possible_at, skip_requested_at, orphaned_at,
  retry_at, retry_for_updated_at, failing, failures`;

export function statements(d: Dialect) {
  const { p } = d;
  const max = (column: string, param: string): string => `${d.greatest}(${column}, ${param})`;
  return {
    ensure: `INSERT INTO export_state (generation, cursor_at, cursor_id)
      VALUES (${p(1)}, ${p(2)}, '') ON CONFLICT (generation) DO NOTHING`,
    claim: `UPDATE export_state SET epoch = epoch + 1 WHERE generation = ${p(1)}
      RETURNING ${COLUMNS}`,
    commit: `UPDATE export_state SET
        cursor_at = ${p(3)},
        cursor_id = ${p(4)},
        caught_up_through = ${max("caught_up_through", p(5))},
        seen_retention_lowered_at = ${max("seen_retention_lowered_at", p(6))},
        exported_total = exported_total + ${p(7)},
        dropped_total = dropped_total + ${p(8)},
        last_success_at = COALESCE(${p(9)}, last_success_at),
        retry_at = NULL,
        retry_for_updated_at = NULL,
        failing = ${d.false},
        failures = 0
      WHERE generation = ${p(1)} AND epoch = ${p(2)}
        AND (cursor_at, cursor_id) <= (${p(3)}, ${p(4)})`,
    recordError: `UPDATE export_state SET last_error = ${p(3)}, last_error_at = ${p(4)}
      WHERE generation = ${p(1)} AND epoch = ${p(2)}`,
    recordFailure: `UPDATE export_state SET last_error = ${p(3)}, last_error_at = ${p(4)},
        retry_at = ${p(5)}, retry_for_updated_at = ${p(6)}, failing = ${p(7)}, failures = ${p(8)}
      WHERE generation = ${p(1)} AND epoch = ${p(2)}`,
    flagGap: `UPDATE export_state SET gap_possible_at = ${p(2)}
      WHERE generation = ${p(1)} AND gap_possible_at IS NULL`,
    clearGap: `UPDATE export_state SET gap_possible_at = NULL
      WHERE generation = ${p(1)} AND gap_possible_at <= ${p(2)}`,
    requestSkip: `UPDATE export_state SET skip_requested_at = ${p(2)}
      WHERE generation = ${p(1)} AND (skip_requested_at IS NULL OR skip_requested_at < ${p(2)})`,
    clearSkip: `UPDATE export_state SET skip_requested_at = NULL
      WHERE generation = ${p(1)} AND skip_requested_at <= ${p(2)}`,
    list: `SELECT ${COLUMNS} FROM export_state ORDER BY generation`,
    // The orphan clock, in three steps run in one transaction. Live rows lose
    // it; newly orphaned rows start it at `now`; rows whose clock is old
    // enough go. Starting and stopping it are idempotent, so two cluster
    // workers sweeping at once agree.
    unorphan: `UPDATE export_state SET orphaned_at = NULL
      WHERE orphaned_at IS NOT NULL AND generation IN ${d.jsonSet(p(1))}`,
    orphan: `UPDATE export_state SET orphaned_at = ${p(2)}
      WHERE orphaned_at IS NULL AND generation NOT IN ${d.jsonSet(p(1))}`,
    deleteOrphans: `DELETE FROM export_state
      WHERE orphaned_at IS NOT NULL AND orphaned_at <= ${p(2)}
        AND generation NOT IN ${d.jsonSet(p(1))}`,
  };
}

/** `commit`'s parameters, positionally, after `generation` and `epoch`. */
export function commitValues(next: ExportCommit): Array<string | number | null> {
  const exported = next.exportedDelta ?? 0;
  const dropped = next.droppedDelta ?? 0;
  // Counters only ever grow; a negative or fractional delta is a caller bug.
  for (const delta of [exported, dropped]) {
    if (!Number.isSafeInteger(delta) || delta < 0) {
      throw new RangeError("export counter deltas must be non-negative integers");
    }
  }
  return [
    next.cursorAt,
    next.cursorId,
    // The column only grows, so an omitted value is the floor.
    next.caughtUpThrough ?? 0,
    next.seenRetentionLoweredAt,
    exported,
    dropped,
    next.lastSuccessAt ?? null,
  ];
}

/** A row as either driver returns it: Postgres hands `BIGINT` back as a string. */
export type StateRow = {
  generation: string;
  cursor_at: number | string;
  cursor_id: string;
  epoch: number | string;
  last_success_at: number | string | null;
  last_error: string | null;
  last_error_at: number | string | null;
  exported_total: number | string;
  dropped_total: number | string;
  caught_up_through: number | string;
  seen_retention_lowered_at: number | string;
  gap_possible_at: number | string | null;
  skip_requested_at: number | string | null;
  orphaned_at: number | string | null;
  retry_at: number | string | null;
  retry_for_updated_at: number | string | null;
  failing: number | boolean;
  failures: number | string;
};

const orNull = (v: number | string | null): number | null => (v === null ? null : Number(v));

export function readState(row: StateRow): ExportState {
  return {
    generation: row.generation,
    cursorAt: Number(row.cursor_at),
    cursorId: row.cursor_id,
    epoch: Number(row.epoch),
    lastSuccessAt: orNull(row.last_success_at),
    lastError: row.last_error,
    lastErrorAt: orNull(row.last_error_at),
    exportedTotal: Number(row.exported_total),
    droppedTotal: Number(row.dropped_total),
    caughtUpThrough: Number(row.caught_up_through),
    seenRetentionLoweredAt: Number(row.seen_retention_lowered_at),
    gapPossibleAt: orNull(row.gap_possible_at),
    skipRequestedAt: orNull(row.skip_requested_at),
    orphanedAt: orNull(row.orphaned_at),
    retryAt: orNull(row.retry_at),
    retryForUpdatedAt: orNull(row.retry_for_updated_at),
    failing: row.failing === true || row.failing === 1,
    failures: Number(row.failures),
  };
}

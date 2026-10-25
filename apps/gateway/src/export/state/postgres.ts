import type { ReservedSQL, SQL } from "bun";
import {
  boundMessage,
  type CommitBound,
  CommitTimeoutError,
  type ExportStateStore,
  ORPHAN_KEEP_MS,
  remainingMs,
} from "../state.ts";
import { commitValues, readState, type StateRow, statements } from "./sql.ts";

/**
 * Postgres export state: the main database's `export_state` table, created by
 * `packages/store/src/postgres/migrations/010_log_export.sql` with **no**
 * `bump_config_version` trigger, so these writes never invalidate a replica's
 * routing snapshot. This module never migrates and never opens a pool: the
 * worker passes its own small one (2 connections) and closes it itself.
 *
 * Each operation is one statement, so `claim`'s `epoch + 1` and `commit`'s
 * fenced update are atomic under Postgres's row lock without an explicit
 * transaction — two replicas claiming at once get two epochs, and the later
 * one's commit is the only one that lands.
 */
const Q = statements({
  p: (n) => `$${n}`,
  greatest: "GREATEST",
  jsonSet: (param) => `(SELECT jsonb_array_elements_text(${param}::jsonb))`,
});

type Rows<T> = T[] & { count: number };

/** `57014` query_canceled (statement_timeout or a cancel), `55P03` lock_not_available (lock_timeout). */
const TIMEOUT_CODES = new Set(["57014", "55P03"]);

function cancelledByTimeout(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const { errno, code } = error as { errno?: unknown; code?: unknown };
  return TIMEOUT_CODES.has(String(errno)) || TIMEOUT_CODES.has(String(code));
}

/** A failure of a bounded commit, as the caller sees it: past the deadline, it was the deadline. */
function timeoutOr(error: unknown, bound: CommitBound): unknown {
  if (error instanceof CommitTimeoutError || cancelledByTimeout(error)) {
    return new CommitTimeoutError();
  }
  if (bound.signal.aborted || bound.deadlineAt - bound.now() < 1) return new CommitTimeoutError();
  return error;
}

/** The statements of a bounded commit, in order; what {@link PostgresStateHooks} observes. */
export type CommitStep = "begin" | "setup" | "update" | "commit";

/**
 * A test seam, and only that; production passes none. `beforeStatement` runs
 * after a step's first deadline check, so a test can move the deadline at an
 * exact point; `sent` reports each statement actually sent, after the last
 * check — what a test asserts "no UPDATE was issued" against.
 */
export type PostgresStateHooks = {
  beforeStatement?(step: CommitStep): Promise<void>;
  sent?(step: CommitStep): void;
};

/** Both timeouts, for this transaction only, in one round trip; `$1` is whole ms. */
const SETUP = `SELECT set_config('statement_timeout', $1, true),
                      set_config('lock_timeout', $1, true)`;

/**
 * A connection from the pool, or {@link CommitTimeoutError} if the deadline
 * comes first. A connection that arrives after that is released at once,
 * unused — so a late acquisition can never carry a write.
 */
/**
 * The wait is a real timer for `deadlineAt − now()` measured once here; the
 * signal (the loop's batch deadline, on the same clock) ends it as well.
 */
function acquire(sql: SQL, bound: CommitBound): Promise<ReservedSQL> {
  const ms = remainingMs(bound);
  const reserved = sql.reserve();
  return new Promise<ReservedSQL>((resolve, reject) => {
    let settled = false;
    const expire = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      bound.signal.removeEventListener("abort", expire);
      reject(new CommitTimeoutError());
    };
    const timer = setTimeout(expire, ms);
    bound.signal.addEventListener("abort", expire, { once: true });
    reserved.then(
      (conn) => {
        if (settled) {
          conn.release();
          return;
        }
        settled = true;
        clearTimeout(timer);
        bound.signal.removeEventListener("abort", expire);
        resolve(conn);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        bound.signal.removeEventListener("abort", expire);
        reject(error);
      },
    );
  });
}

export function createPostgresExportState(
  sql: SQL,
  hooks: PostgresStateHooks = {},
): ExportStateStore {
  const changed = async (statement: string, args: unknown[]): Promise<boolean> =>
    (await sql.unsafe<Rows<unknown>>(statement, args)).count > 0;

  /**
   * The fenced UPDATE under {@link CommitBound}: see its doc for the design.
   * Each statement is preceded by a fresh deadline check (signal, and time
   * left recomputed from `deadlineAt`) and runs with the signal wired to
   * Bun SQL's `Query.cancel()`, which sends a cancel request for a statement
   * in flight (verified on Bun 1.4.4: a blocked `pg_sleep` ends with 57014 at
   * once). Any failure inside rolls back; the connection goes back to the pool
   * only after the rollback, and is closed rather than reused if that fails.
   */
  async function boundedCommit(values: unknown[], bound: CommitBound): Promise<boolean> {
    const conn = await acquire(sql, bound);
    const step = async <T>(name: CommitStep, text: string, args: unknown[] = []): Promise<T> => {
      remainingMs(bound);
      await hooks.beforeStatement?.(name);
      remainingMs(bound);
      const query = conn.unsafe<T>(text, args);
      hooks.sent?.(name);
      const cancel = (): void => {
        query.cancel();
      };
      bound.signal.addEventListener("abort", cancel, { once: true });
      try {
        return await query;
      } finally {
        bound.signal.removeEventListener("abort", cancel);
      }
    };
    let open = false;
    let closed = false;
    try {
      await step("begin", "BEGIN");
      open = true;
      await step("setup", SETUP, [String(remainingMs(bound))]);
      const updated = await step<Rows<unknown>>("update", Q.commit, values);
      // Authorised only now: past this point the COMMIT is on the wire, and a
      // deadline passing while it is there is the one accepted residual.
      await step("commit", "COMMIT");
      open = false;
      return updated.count > 0;
    } catch (error) {
      if (open) {
        try {
          await conn.unsafe("ROLLBACK");
        } catch {
          // A connection that cannot roll back is not handed to anyone else.
          closed = true;
          await conn.close().catch(() => {});
          throw timeoutOr(error, bound);
        }
      }
      throw timeoutOr(error, bound);
    } finally {
      if (!closed) conn.release();
    }
  }

  return {
    async ensure(generation, startAt) {
      await sql.unsafe(Q.ensure, [generation, startAt]);
    },
    async claim(generation) {
      const row = (await sql.unsafe<Rows<StateRow>>(Q.claim, [generation]))[0];
      return row === undefined ? null : readState(row);
    },
    async commit(generation, epoch, next, bound) {
      const values = [generation, epoch, ...commitValues(next)];
      if (bound === undefined) return changed(Q.commit, values);
      return boundedCommit(values, bound);
    },
    recordError: (generation, epoch, message, at) =>
      changed(Q.recordError, [generation, epoch, boundMessage(message), at]),
    flagGap: (generation, at) => changed(Q.flagGap, [generation, at]),
    clearGap: (generation, seenAt) => changed(Q.clearGap, [generation, seenAt]),
    requestSkip: (generation, at) => changed(Q.requestSkip, [generation, at]),
    clearSkip: (generation, at) => changed(Q.clearSkip, [generation, at]),
    async list() {
      return (await sql.unsafe<Rows<StateRow>>(Q.list)).map(readState);
    },
    async deleteOrphans(liveGenerations, now, keepMs = ORPHAN_KEEP_MS) {
      // The array itself, as `bodies.ts` and `credentials.ts` bind theirs: a
      // pre-stringified one reaches `::jsonb` as a JSON string scalar.
      const live = [...liveGenerations];
      return sql.begin(async (tx) => {
        await tx.unsafe(Q.unorphan, [live]);
        await tx.unsafe(Q.orphan, [live, now]);
        return (await tx.unsafe<Rows<unknown>>(Q.deleteOrphans, [live, now - keepMs])).count;
      });
    },
    close() {
      // The pool is the caller's; nothing here to release.
    },
  };
}

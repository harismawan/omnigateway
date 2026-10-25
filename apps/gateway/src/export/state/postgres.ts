import type { SQL } from "bun";
import {
  boundMessage,
  boundMs,
  CommitTimeoutError,
  type ExportStateStore,
  ORPHAN_KEEP_MS,
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

/** `57014` query_canceled (statement_timeout), `55P03` lock_not_available (lock_timeout). */
const TIMEOUT_CODES = new Set(["57014", "55P03"]);

function cancelledByTimeout(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const { errno, code } = error as { errno?: unknown; code?: unknown };
  return TIMEOUT_CODES.has(String(errno)) || TIMEOUT_CODES.has(String(code));
}

export function createPostgresExportState(sql: SQL): ExportStateStore {
  const changed = async (statement: string, args: unknown[]): Promise<boolean> =>
    (await sql.unsafe<Rows<unknown>>(statement, args)).count > 0;

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
      const ms = boundMs(bound);
      if (ms === null) throw new CommitTimeoutError();
      try {
        return await sql.begin(async (tx) => {
          // Checked once a connection is held: the wait for one is not bounded here.
          if (bound.signal.aborted) throw new CommitTimeoutError();
          // Integers formatted here, never interpolated text: SET takes no parameters.
          await tx.unsafe(`SET LOCAL statement_timeout = ${ms}`);
          await tx.unsafe(`SET LOCAL lock_timeout = ${ms}`);
          return (await tx.unsafe<Rows<unknown>>(Q.commit, values)).count > 0;
        });
      } catch (error) {
        if (error instanceof CommitTimeoutError || cancelledByTimeout(error)) {
          throw new CommitTimeoutError();
        }
        throw error;
      }
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

import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/sqlite/db.ts";

/**
 * The connection pragmas, pinned because two of them are performance and
 * durability contracts that nothing else would notice losing.
 *
 * `synchronous` is the one worth the file. It defaults to FULL, which fsyncs
 * the WAL on every commit — measured at 2,177µs against 16.4µs at NORMAL for
 * one credential-health write, and a request commits three or four times.
 * `bun:sqlite` is synchronous, so that cost is event-loop time, not per-request
 * latency. A revert to the default would show up as nothing but a slow gateway.
 *
 * On a file database, and deliberately not `:memory:`: an in-memory database
 * cannot take WAL, so the journal-mode assertion would pass vacuously there.
 */
test("opens with WAL, synchronous NORMAL, and foreign keys on", () => {
  const root = mkdtempSync(join(tmpdir(), "omni-pragmas-"));
  const db = openDb(join(root, "omni.db"));

  try {
    expect(db.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get()?.journal_mode).toBe(
      "wal",
    );
    // 2 is FULL — the default this repository deliberately does not take — and
    // 0 is OFF, which gives up the crash safety NORMAL keeps.
    expect(db.query<{ synchronous: number }, []>("PRAGMA synchronous").get()?.synchronous).toBe(1);
    expect(db.query<{ foreign_keys: number }, []>("PRAGMA foreign_keys").get()?.foreign_keys).toBe(
      1,
    );
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

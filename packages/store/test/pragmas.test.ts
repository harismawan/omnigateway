import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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

/**
 * Every write-mode connection is opened by `openDb`, checked in the source.
 *
 * `journal_mode` persists in the database file but `synchronous` does not, so a
 * handle opened past `openDb` would still report WAL — read back off disk — and
 * silently revert to the FULL default. The test above calls `openDb` directly
 * and would not notice; `reopen()` after a database swap builds a fresh handle,
 * which is exactly where such a connection would appear.
 *
 * Structural rather than behavioural because `synchronous` is per-connection
 * and the `Store` surface exposes no way to read a pragma back through it. Same
 * shape as `swap.test.ts`, which reads the forwarder's source for the same kind
 * of reason: the property is about the code, and no call proves it.
 */
test("opens every writable connection through openDb", () => {
  const storeSrc = readFileSync(new URL("../src/sqlite/store.ts", import.meta.url), "utf8");
  // `reopen()` calls `open()`, so pinning `open` covers the swap path too.
  expect(storeSrc).toContain("const db = openDb(opts.path);");

  const sources = ["../src/sqlite/db.ts", "../src/sqlite/store.ts", "../src/sqlite/maintenance.ts"];
  const openers: string[] = [];
  for (const rel of sources) {
    const text = readFileSync(new URL(rel, import.meta.url), "utf8");
    for (const line of text.split("\n")) {
      if (line.includes("new Database(")) openers.push(`${rel}: ${line.trim()}`);
    }
  }

  // Two, and only one of them can write. A third — or a second writable one —
  // means a connection that never took the pragmas above.
  expect(openers).toHaveLength(2);
  expect(openers.filter((line) => line.includes("readonly: true"))).toHaveLength(1);
  expect(openers.filter((line) => line.includes("create: true"))).toHaveLength(1);
});

import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { openDb } from "../src/sqlite/db.ts";
import { createKeyRepo } from "../src/sqlite/keys.ts";
import init001 from "../src/sqlite/migrations/001_init.sql" with { type: "text" };
import usageDaily002 from "../src/sqlite/migrations/002_usage_daily.sql" with { type: "text" };
import quotaSnapshot003 from "../src/sqlite/migrations/003_quota_snapshot.sql" with {
  type: "text",
};
import requestState004 from "../src/sqlite/migrations/004_request_state.sql" with { type: "text" };
import rtkMetrics005 from "../src/sqlite/migrations/005_rtk_metrics.sql" with { type: "text" };
import rtkUsage006 from "../src/sqlite/migrations/006_rtk_usage.sql" with { type: "text" };
import quotaSamples007 from "../src/sqlite/migrations/007_quota_samples.sql" with { type: "text" };
import bodyLogging008 from "../src/sqlite/migrations/008_body_logging.sql" with { type: "text" };

type TableRow = { name: string };

/**
 * A database as it stood before migration 9, so the backfill can be watched
 * running rather than inferred from a schema that has already moved.
 *
 * The `after` hooks on migrations 2 and 6 are skipped: both roll up
 * `request_logs`, and this database has none until the caller seeds it.
 */
function legacyDb(path: string): void {
  const db = new Database(path, { create: true });
  const sql = [
    init001,
    usageDaily002,
    quotaSnapshot003,
    requestState004,
    rtkMetrics005,
    rtkUsage006,
    quotaSamples007,
    bodyLogging008,
  ];
  db.run(
    "CREATE TABLE IF NOT EXISTS migrations (id INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)",
  );
  sql.forEach((text, index) => {
    db.run(text);
    db.run("INSERT INTO migrations (id, applied_at) VALUES (?, 0)", [index + 1]);
  });
  db.close();
}

test("openDb applies migrations and records them", () => {
  const db = openDb(":memory:");
  const tables = db
    .query<TableRow, []>("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()
    .map((r) => r.name);
  for (const t of [
    "api_keys",
    "credential_health",
    "credentials",
    "migrations",
    "quota_samples",
    "quota_windows",
    "request_bodies",
    "request_logs",
    "settings",
    "usage_daily",
    "usage_rollup",
    "virtual_models",
  ]) {
    expect(tables).toContain(t);
  }
  const applied = db.query<{ id: number }, []>("SELECT id FROM migrations").all();
  expect(applied.map((row) => row.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  const columns = db
    .query<{ name: string }, []>("PRAGMA table_info(request_logs)")
    .all()
    .map((row) => row.name);
  expect(columns).toContain("rtk_applied");
  expect(columns).toContain("rtk_filters");
  const dailyColumns = db
    .query<{ name: string }, []>("PRAGMA table_info(usage_daily)")
    .all()
    .map((row) => row.name);
  expect(dailyColumns).toContain("rtk_saved_tokens");
  expect(dailyColumns).toContain("rtk_applied_requests");
  const keyColumns = db
    .query<{ name: string }, []>("PRAGMA table_info(api_keys)")
    .all()
    .map((row) => row.name);
  expect(keyColumns).toContain("body_logging_opt_out");
  expect(keyColumns).toContain("limits");
  // Anything still reading it breaks at compile time, which is the intent.
  expect(keyColumns).not.toContain("rate_limit_per_min");
  db.close();
});

/**
 * Every value the old column could hold, because it could hold anything.
 *
 * `rate_limit_per_min` was `INTEGER` with no `CHECK`, and the new schema is
 * `z.number().int().positive()` — so `0`, `-5` and `1.5` are all values a
 * hand-edited install can be sitting on and none of them is a limit the reader
 * accepts. `'sixty'` is the fourth, and the one a range test alone lets through:
 * INTEGER affinity is a preference rather than a constraint, so the string is
 * stored as TEXT, and TEXT sorts above every number so `> 0` is true of it. A
 * backfill guarded only on the range writes `{"requests":{"1m":"sixty"}}`, which
 * `parseLimitConfig` refuses. Ordered by id, which is the order the assertions
 * below read in.
 */
const LEGACY_KEYS = `
  INSERT INTO api_keys (id, label, prefix, hash, model_allowlist, rate_limit_per_min, created_at)
  VALUES ('fractional', 'f', 'sk-omni-eeee', 'h5', NULL, 1.5, 0),
         ('limited',    'l', 'sk-omni-aaaa', 'h1', NULL, 60,  0),
         ('negative',   'n', 'sk-omni-dddd', 'h4', NULL, -5,  0),
         ('textual',    't', 'sk-omni-ffff', 'h6', NULL, 'sixty', 0),
         ('unlimited',  'u', 'sk-omni-bbbb', 'h2', NULL, NULL, 0),
         ('zero',       'z', 'sk-omni-cccc', 'h3', NULL, 0,   0)`;

test("migration 9 backfills a per-minute limit into the requests matrix", () => {
  const path = `/tmp/omni-test-${crypto.randomUUID()}.db`;
  legacyDb(path);

  const legacy = new Database(path);
  legacy.run(LEGACY_KEYS);
  legacy.close();

  const db = openDb(path);
  const rows = db
    .query<{ id: string; limits: string }, []>("SELECT id, limits FROM api_keys ORDER BY id")
    .all();
  expect(rows).toEqual([
    // Not a ceiling the reader would take, so it is not carried over. It bounded
    // nothing before the upgrade either — a value no code path could enforce —
    // so `{}` loses nothing and keeps the key serving.
    { id: "fractional", limits: "{}" },
    { id: "limited", limits: '{"requests":{"1m":60}}' },
    { id: "negative", limits: "{}" },
    // The one a bare `> 0` admits, because SQLite sorts TEXT above every
    // number. Carried over it would be `{"requests":{"1m":"sixty"}}`, which is
    // not a limit at all — it is an unreadable key.
    { id: "textual", limits: "{}" },
    // Not `{"requests":{"1m":null}}`. An absent key and an explicit null both
    // mean unlimited, and the empty object is the shape every new key starts at.
    { id: "unlimited", limits: "{}" },
    { id: "zero", limits: "{}" },
  ]);
  db.close();
});

/**
 * The property the backfill exists to preserve, stated as the reader sees it.
 *
 * A migrated row that `parseLimitConfig` refuses is `limits: null`, and a null
 * there is not a cosmetic defect: `authenticateApiKey` answers `INTERNAL` for
 * it, so every `/v1` request that key makes fails until an operator hand-edits
 * SQL. An upgrade that bricks a key is worse than an upgrade that drops a
 * ceiling which was never enforceable, so every row must come out readable.
 */
test("migration 9 leaves every upgraded key readable, whatever the old column held", async () => {
  const path = `/tmp/omni-test-${crypto.randomUUID()}.db`;
  legacyDb(path);

  const legacy = new Database(path);
  legacy.run(LEGACY_KEYS);
  legacy.close();

  const db = openDb(path);
  const keys = await createKeyRepo(db).list();
  expect(keys.map((key) => key.id).sort()).toEqual([
    "fractional",
    "limited",
    "negative",
    "textual",
    "unlimited",
    "zero",
  ]);
  for (const key of keys) {
    expect({ id: key.id, limits: key.limits }).toEqual({
      id: key.id,
      limits: key.id === "limited" ? { requests: { "1m": 60 } } : {},
    });
  }
  db.close();
});

test("migration 9 indexes request logs by key first, so a per-key window scan starts at the key", () => {
  const db = openDb(":memory:");
  // Composite order is the whole point: `(at DESC, api_key_id)` would not let a
  // weekly sum for one key start at that key, and would scan every row in the
  // week for every key on the install.
  const columns = db
    .query<{ seqno: number; name: string }, []>("PRAGMA index_info(idx_request_logs_key_at)")
    .all()
    .map((row) => row.name);
  expect(columns).toEqual(["api_key_id", "at"]);

  // Not an optimisation, so it has to be the plan the planner actually picks.
  const plan = db
    .query<{ detail: string }, [string, number]>(
      `EXPLAIN QUERY PLAN
       SELECT COUNT(*) FROM request_logs WHERE api_key_id = ? AND state = 'done' AND at >= ?`,
    )
    .all("k1", 0)
    .map((row) => row.detail)
    .join(" ");
  expect(plan).toContain("idx_request_logs_key_at");
  db.close();
});

test("migration 8 gives request_bodies its time index and no cascade", () => {
  const db = openDb(":memory:");
  const indexes = db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='request_bodies'",
    )
    .all()
    .map((row) => row.name);
  expect(indexes).toContain("idx_request_bodies_at");

  // No foreign key to `request_logs`, deliberately. A cascade only fires while
  // the `foreign_keys` pragma is on, and a pragma silently off would turn expiry
  // of a prompt corpus into indefinite retention of one.
  const keys = db.query<{ table: string }, []>("PRAGMA foreign_key_list(request_bodies)").all();
  expect(keys).toEqual([]);
  db.close();
});

test("openDb is idempotent across reopen", () => {
  const path = `/tmp/omni-test-${crypto.randomUUID()}.db`;
  openDb(path).close();
  const db = openDb(path);
  expect(db.query<{ id: number }, []>("SELECT id FROM migrations").all()).toHaveLength(10);
  db.close();
});

test("WAL mode is enabled", () => {
  const path = `/tmp/omni-test-${crypto.randomUUID()}.db`;
  const db = openDb(path);
  const mode = db.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get();
  expect(mode?.journal_mode).toBe("wal");
  db.close();
});

test("foreign keys cascade from credentials to health", () => {
  const db = openDb(":memory:");
  db.run(
    `INSERT INTO credentials (id, provider, label, auth_type, enabled, tier, weight, created_at, updated_at)
     VALUES ('c1', 'anthropic', 'test', 'oauth', 1, 1, 1.0, 0, 0)`,
  );
  db.run(
    "INSERT INTO credential_health (credential_id, model, breaker_state) VALUES ('c1','m','closed')",
  );
  db.run("DELETE FROM credentials WHERE id = 'c1'");
  const left = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM credential_health").get();
  expect(left?.n).toBe(0);
  db.close();
});

test("migration 4 backfills existing request logs as finished", () => {
  const db = openDb(":memory:");
  // A row written by a build that predates the column would have been left
  // pending by a nullable default, and swept to `interrupted` on the next boot.
  db.run(
    `INSERT INTO request_logs (id, at, requested_model, attempts, status, input_tokens,
                               output_tokens, cache_read_tokens, cache_write_tokens,
                               duration_ms, cost_usd, degradations)
     VALUES ('r1', 0, 'm', 1, 200, 0, 0, 0, 0, 1, 0, '[]')`,
  );
  const row = db.query<{ state: string }, []>("SELECT state FROM request_logs").get();
  expect(row?.state).toBe("done");
  db.close();
});

test("migration 3 adds the snapshot columns to a database created before it", () => {
  const path = `/tmp/omni-test-${crypto.randomUUID()}.db`;
  const first = openDb(path);
  first.close();

  const db = openDb(path);
  const quotaColumns = db
    .query<{ name: string }, []>("PRAGMA table_info(quota_windows)")
    .all()
    .map((r) => r.name);
  expect(quotaColumns).toContain("resets_at");
  expect(quotaColumns).toContain("observed_at");
  // Migration 7 widens the same table, so a database created before either one
  // has to arrive with both columns.
  expect(quotaColumns).toContain("window_ms");

  const credentialColumns = db
    .query<{ name: string }, []>("PRAGMA table_info(credentials)")
    .all()
    .map((r) => r.name);
  expect(credentialColumns).toContain("disabled_reason");
  expect(credentialColumns).toContain("disabled_at");
  db.close();
});

import { expect, test } from "bun:test";
import { openDb } from "../src/sqlite/db.ts";

type TableRow = { name: string };

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
    "request_logs",
    "settings",
    "usage_daily",
    "virtual_models",
  ]) {
    expect(tables).toContain(t);
  }
  const applied = db.query<{ id: number }, []>("SELECT id FROM migrations").all();
  expect(applied.map((row) => row.id)).toEqual([1, 2, 3, 4, 5, 6, 7]);
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
  db.close();
});

test("openDb is idempotent across reopen", () => {
  const path = `/tmp/omni-test-${crypto.randomUUID()}.db`;
  openDb(path).close();
  const db = openDb(path);
  expect(db.query<{ id: number }, []>("SELECT id FROM migrations").all()).toHaveLength(7);
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

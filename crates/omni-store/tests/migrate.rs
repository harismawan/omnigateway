//! Migrations: the ledger, the pragmas, the statement splitter, and parity with
//! `openDb` from every partial state TS could have left a database in.

mod common;

use common::{bun_available, bun_script, ts};
use omni_store::SqliteStore;
use omni_store::migrate::{self, LATEST_MIGRATION, MIGRATIONS};
use rusqlite::Connection;
use rusqlite::types::ValueRef;
use std::path::Path;

const ALL_TABLES: [&str; 15] = [
    "api_keys",
    "credential_health",
    "credentials",
    "migrations",
    "nodes",
    "plugin_migrations",
    "quota_samples",
    "quota_windows",
    "request_bodies",
    "request_logs",
    "settings",
    "usage_daily",
    "usage_rollup",
    "virtual_models",
    "sqlite_master",
];

fn ledger(conn: &Connection) -> Vec<i64> {
    let mut stmt = conn
        .prepare("SELECT id FROM migrations ORDER BY id")
        .expect("prepare");
    stmt.query_map([], |r| r.get(0))
        .expect("query")
        .collect::<Result<_, _>>()
        .expect("rows")
}

fn schema(path: &Path) -> Vec<(String, String, Option<String>)> {
    let conn = Connection::open(path).expect("open");
    let mut stmt = conn
        .prepare("SELECT type, name, sql FROM sqlite_master ORDER BY type, name")
        .expect("prepare");
    stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .expect("query")
        .collect::<Result<_, _>>()
        .expect("rows")
}

/// Every user table's rows, typed, in a stable order. `migrations.applied_at`
/// is a wall-clock time and is the one column left out.
fn contents(path: &Path) -> Vec<(String, Vec<Vec<String>>)> {
    let conn = Connection::open(path).expect("open");
    let mut out = Vec::new();
    for table in ALL_TABLES {
        if table == "sqlite_master" {
            continue;
        }
        let select = if table == "migrations" {
            "SELECT id FROM migrations".to_owned()
        } else {
            format!("SELECT * FROM {table}")
        };
        let mut stmt = conn.prepare(&select).expect("prepare");
        let width = stmt.column_count();
        let mut rows: Vec<Vec<String>> = stmt
            .query_map([], |r| {
                (0..width)
                    .map(|i| {
                        Ok(match r.get_ref(i)? {
                            ValueRef::Null => "null".to_owned(),
                            ValueRef::Integer(v) => format!("i:{v}"),
                            ValueRef::Real(v) => format!("r:{v:?}"),
                            ValueRef::Text(t) => format!("t:{}", String::from_utf8_lossy(t)),
                            ValueRef::Blob(b) => format!("b:{b:?}"),
                        })
                    })
                    .collect()
            })
            .expect("query")
            .collect::<Result<_, _>>()
            .expect("rows");
        rows.sort();
        out.push((table.to_owned(), rows));
    }
    out
}

#[test]
fn fresh_database_gets_every_migration_and_the_ts_pragmas() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("fresh.db");
    let store = SqliteStore::open(&path, 0).expect("open");
    let conn = store.connection();
    assert_eq!(ledger(conn), (1..=20).collect::<Vec<i64>>());
    assert_eq!(LATEST_MIGRATION, 20);
    assert_eq!(MIGRATIONS.len(), 20);

    let journal: String = conn
        .query_row("PRAGMA journal_mode", [], |r| r.get(0))
        .expect("journal_mode");
    assert_eq!(journal, "wal");
    let sync: i64 = conn
        .query_row("PRAGMA synchronous", [], |r| r.get(0))
        .expect("synchronous");
    assert_eq!(sync, 1, "NORMAL");
    let fk: i64 = conn
        .query_row("PRAGMA foreign_keys", [], |r| r.get(0))
        .expect("foreign_keys");
    assert_eq!(fk, 1);
    let busy: i64 = conn
        .query_row("PRAGMA busy_timeout", [], |r| r.get(0))
        .expect("busy_timeout");
    assert_eq!(busy, 5000);

    // Reopening applies nothing new and keeps the ledger.
    drop(store);
    let again = SqliteStore::open(&path, 0).expect("reopen");
    assert_eq!(ledger(again.connection()), (1..=20).collect::<Vec<i64>>());
}

#[test]
fn a_failing_statement_rolls_back_its_whole_migration() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("broken.db");
    {
        // A database at migration 8 whose api_keys already has `limits`: 009's
        // ADD COLUMN fails, and the migration must not be recorded.
        let conn = Connection::open(&path).expect("open");
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS migrations (id INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)",
        )
        .expect("ledger");
        for m in &MIGRATIONS[..8] {
            conn.execute_batch(m.sql).expect("legacy sql");
            conn.execute("INSERT INTO migrations VALUES (?, 0)", [m.id])
                .expect("ledger row");
        }
        conn.execute_batch("ALTER TABLE api_keys ADD COLUMN limits TEXT")
            .expect("sabotage");
    }
    let err = SqliteStore::open(&path, 0).expect_err("009 must fail");
    assert!(err.to_string().contains("migration 9"), "{err}");
    let conn = Connection::open(&path).expect("open");
    assert_eq!(ledger(&conn), (1..=8).collect::<Vec<i64>>());
    let has_rate: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM pragma_table_info('api_keys') WHERE name = 'rate_limit_per_min'",
            [],
            |r| r.get(0),
        )
        .expect("table_info");
    assert_eq!(has_rate, 1, "009's UPDATE and DROP rolled back with it");
}

#[test]
fn statement_splitter_matches_the_ts_splitter() {
    let mut inputs: Vec<String> = MIGRATIONS.iter().map(|m| m.sql.to_owned()).collect();
    inputs.extend(
        [
            "",
            "SELECT 1",
            "SELECT 1;",
            "SELECT 1;  \t\nSELECT 2 ;\n\n-- comment;\n  -- indented comment\nSELECT 3;x",
            "SELECT ';' ;\nSELECT 4;\r\nSELECT 5",
            "\u{a0}-- nbsp comment\n\u{feff}-- bom comment\n\u{85}-- nel is not JS whitespace\nSELECT 6;",
            "SELECT 7;\u{2028}SELECT 8;\t",
            "  \u{3000}SELECT 9 \u{3000};\n",
        ]
        .map(str::to_owned),
    );
    for input in &inputs {
        let rust = migrate::statements(input);
        assert!(rust.iter().all(|s| !s.is_empty()));
        if input == "SELECT 1;  \t\nSELECT 2 ;\n\n-- comment;\n  -- indented comment\nSELECT 3;x" {
            assert_eq!(rust, ["SELECT 1", "SELECT 2", "SELECT 3;x"]);
        }
    }
    if !bun_available("statement_splitter_matches_the_ts_splitter") {
        return;
    }
    let dir = tempfile::tempdir().expect("tempdir");
    // The body of `statements` in packages/store/src/sqlite/db.ts, which is not
    // exported; copied verbatim so the two splitters run on identical input.
    let script = r#"
function statements(sql) {
  return sql
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n")
    .split(/;[ \t]*(?:\n|$)/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
const inputs = JSON.parse(await Bun.stdin.text());
console.log(JSON.stringify(inputs.map(statements)));
"#;
    let stdin = serde_json::to_string(&inputs).expect("inputs");
    let ts_out: Vec<Vec<String>> =
        serde_json::from_str(&bun_script(dir.path(), script, &stdin)).expect("ts json");
    for (input, expected) in inputs.iter().zip(ts_out) {
        assert_eq!(migrate::statements(input), expected, "input {input:?}");
    }
}

/// Builds a database as TS left it at migration `upto` — every file applied
/// whole, as `legacyDb` in `packages/store/test/migrations.test.ts` does, with
/// the `after` hooks skipped — then seeds rows the backfills will see.
fn legacy(path: &Path, upto: usize, offset: i64) {
    let conn = Connection::open(path).expect("open");
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS migrations (id INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)",
    )
    .expect("ledger");
    for m in &MIGRATIONS[..upto] {
        conn.execute_batch(m.sql).expect("legacy sql");
        conn.execute("INSERT INTO migrations VALUES (?, 0)", [m.id])
            .expect("ledger row");
    }
    if upto == 0 {
        return;
    }
    let column = |table: &str, name: &str| -> bool {
        conn.query_row(
            &format!("SELECT COUNT(*) FROM pragma_table_info('{table}') WHERE name = ?"),
            [name],
            |r| r.get::<_, i64>(0),
        )
        .expect("table_info")
            == 1
    };
    // Instants either side of a day boundary at +07:00 and at -05:30, a
    // fractional `at`, nulls in every nullable key column, and failures.
    let day = 86_400_000_i64;
    let base = 1_794_000_000_000_i64 / day * day;
    struct Log {
        id: &'static str,
        at: f64,
        key: Option<&'static str>,
        requested: &'static str,
        route: Option<(&'static str, &'static str, &'static str)>,
        status: i64,
        tokens: (i64, i64),
        cost: f64,
    }
    #[allow(clippy::cast_precision_loss)]
    let at = |ms: i64| ms as f64;
    let claude = Some(("anthropic", "claude", "c1"));
    let gpt = Some(("openai", "gpt", "c2"));
    let logs = [
        Log {
            id: "a",
            at: at(base - 7 * 3_600_000 - 1),
            key: Some("k1"),
            requested: "m",
            route: claude,
            status: 200,
            tokens: (10, 5),
            cost: 0.25,
        },
        Log {
            id: "b",
            at: at(base - 7 * 3_600_000),
            key: Some("k1"),
            requested: "m",
            route: claude,
            status: 200,
            tokens: (11, 6),
            cost: 0.1,
        },
        Log {
            id: "c",
            at: at(base - 7 * 3_600_000) + 0.5,
            key: Some("k1"),
            requested: "m",
            route: claude,
            status: 400,
            tokens: (0, 0),
            cost: 0.0,
        },
        Log {
            id: "d",
            at: at(base + 5 * 3_600_000 + 1_800_000),
            key: None,
            requested: "m2",
            route: None,
            status: 500,
            tokens: (0, 0),
            cost: 0.0,
        },
        Log {
            id: "e",
            at: at(base + 5 * 3_600_000 + 1_799_999),
            key: Some("k2"),
            requested: "m2",
            route: gpt,
            status: 200,
            tokens: (3, 4),
            cost: 0.3,
        },
        Log {
            id: "f",
            at: at(base + 3 * day),
            key: Some("k2"),
            requested: "m2",
            route: gpt,
            status: 200,
            tokens: (7, 8),
            cost: 0.7,
        },
        Log {
            id: "g",
            at: at(base + 3 * day + 1),
            key: Some("k2"),
            requested: "m2",
            route: gpt,
            status: 200,
            tokens: (1, 1),
            cost: 0.1,
        },
    ];
    for (i, log) in (0_i64..).zip(&logs) {
        conn.execute(
            "INSERT INTO request_logs (id, at, api_key_id, requested_model, resolved_provider,
               resolved_model, credential_id, status, input_tokens, output_tokens,
               cache_read_tokens, cache_write_tokens, duration_ms, cost_usd)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            rusqlite::params![
                log.id,
                // As `bun:sqlite` binds a JS number: whole as INTEGER.
                if log.at.fract() == 0.0 {
                    #[allow(clippy::cast_possible_truncation)]
                    rusqlite::types::Value::Integer(log.at as i64)
                } else {
                    rusqlite::types::Value::Real(log.at)
                },
                log.key,
                log.requested,
                log.route.map(|r| r.0),
                log.route.map(|r| r.1),
                log.route.map(|r| r.2),
                log.status,
                log.tokens.0,
                log.tokens.1,
                i,
                i * 2,
                100 + i,
                log.cost
            ],
        )
        .expect("seed log");
    }
    if column("request_logs", "state") {
        conn.execute(
            "UPDATE request_logs SET state = 'pending' WHERE id = 'g'",
            [],
        )
        .expect("pending");
    }
    if column("request_logs", "rtk_applied") {
        conn.execute_batch(
            "UPDATE request_logs SET rtk_applied = 1, rtk_estimated_tokens_saved = 40 WHERE id IN ('a','b','f');
             UPDATE request_logs SET rtk_estimated_tokens_saved = 3 WHERE id = 'e';",
        )
        .expect("rtk");
    }
    // A database past 2 and before 6 carries daily rows the RTK backfill
    // must find, as if 2's backfill had run. Positive instants only, so SQL's
    // integer division is the floor.
    if column("usage_daily", "day") && !column("usage_daily", "rtk_saved_tokens") {
        conn.execute(
            "INSERT INTO usage_daily (day, provider, credential_id, requested_model,
               resolved_model, api_key_id, requests)
             SELECT (CAST(at AS INTEGER) + ?1) / 86400000 * 86400000 - ?1,
                    COALESCE(resolved_provider, ''), COALESCE(credential_id, ''),
                    requested_model, COALESCE(resolved_model, ''), COALESCE(api_key_id, ''),
                    COUNT(*)
               FROM request_logs GROUP BY 1, 2, 3, 4, 5, 6",
            [offset * 60_000],
        )
        .expect("seed daily");
    }
    if column("api_keys", "rate_limit_per_min") {
        for (id, rate) in [
            ("k1", rusqlite::types::Value::Integer(60)),
            ("k2", rusqlite::types::Value::Integer(0)),
            ("k3", rusqlite::types::Value::Real(1.5)),
            ("k4", rusqlite::types::Value::Null),
        ] {
            conn.execute(
                "INSERT INTO api_keys (id, label, prefix, hash, created_at, rate_limit_per_min)
                 VALUES (?, 'l', 'p', ?, 1, ?)",
                rusqlite::params![id, format!("h-{id}"), rate],
            )
            .expect("seed key");
        }
    }
}

#[test]
fn every_partial_state_finishes_exactly_as_ts_would() {
    let dir = tempfile::tempdir().expect("tempdir");
    let bun = bun_available("every_partial_state_finishes_exactly_as_ts_would");
    let fresh = dir.path().join("fresh.db");
    SqliteStore::open(&fresh, 0).expect("fresh");
    let fresh_schema = schema(&fresh);

    let mut ts_jobs = Vec::new();
    for upto in 0..=MIGRATIONS.len() {
        for offset in [420_i64, -330] {
            let rust = dir.path().join(format!("rust-{upto}-{offset}.db"));
            legacy(&rust, upto, offset);
            if bun {
                let ts_path = dir.path().join(format!("ts-{upto}-{offset}.db"));
                std::fs::copy(&rust, &ts_path).expect("copy");
                ts_jobs.push(serde_json::json!({ "path": ts_path, "offset": offset }));
            }
            let store = SqliteStore::open(&rust, offset)
                .unwrap_or_else(|e| panic!("rust from {upto}: {e}"));
            assert_eq!(ledger(store.connection()), (1..=20).collect::<Vec<i64>>());
            drop(store);
            assert_eq!(
                schema(&rust),
                fresh_schema,
                "schema after finishing from {upto}"
            );
        }
    }
    if !bun {
        return;
    }
    let script = format!(
        r#"
import {{ openDb }} from "{}";
for (const job of JSON.parse(await Bun.stdin.text())) openDb(job.path, job.offset).close();
console.log("[]");
"#,
        ts("packages/store/src/sqlite/db.ts")
    );
    bun_script(
        dir.path(),
        &script,
        &serde_json::to_string(&ts_jobs).expect("jobs"),
    );
    for upto in 0..=MIGRATIONS.len() {
        for offset in [420_i64, -330] {
            let rust = dir.path().join(format!("rust-{upto}-{offset}.db"));
            let ts_path = dir.path().join(format!("ts-{upto}-{offset}.db"));
            assert_eq!(schema(&rust), schema(&ts_path), "schema from {upto}");
            assert_eq!(
                contents(&rust),
                contents(&ts_path),
                "rows from {upto} at offset {offset}"
            );
        }
    }
    // The fixture must actually exercise the backfills it claims to.
    let from_one = contents(&dir.path().join("rust-1-420.db"));
    let daily = from_one
        .iter()
        .find(|(t, _)| t == "usage_daily")
        .expect("usage_daily");
    assert!(daily.1.len() >= 4, "{daily:?}");
    let rollup = from_one
        .iter()
        .find(|(t, _)| t == "usage_rollup")
        .expect("usage_rollup");
    assert!(!rollup.1.is_empty());
    let from_five = contents(&dir.path().join("rust-5--330.db"));
    let daily = &from_five
        .iter()
        .find(|(t, _)| t == "usage_daily")
        .expect("usage_daily")
        .1;
    assert!(
        daily.iter().any(|row| row.iter().any(|c| c == "i:80")),
        "rtk backfill wrote the two 40-token savings into one row: {daily:?}"
    );
}

#[test]
fn a_database_from_a_newer_build_keeps_its_unknown_migrations() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("newer.db");
    SqliteStore::open(&path, 0).expect("open");
    {
        let conn = Connection::open(&path).expect("open");
        conn.execute("INSERT INTO migrations VALUES (21, 0)", [])
            .expect("future row");
    }
    let store = SqliteStore::open(&path, 0).expect("reopen");
    assert_eq!(ledger(store.connection()), (1..=21).collect::<Vec<i64>>());
}

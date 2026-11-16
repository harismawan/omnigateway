//! Identical seeded files, frozen repositories versus Rust, typed cells and counts.
#![allow(clippy::unwrap_used)]
use omni_store::{SqliteStore, maintenance};
use rusqlite::types::ValueRef;
use serde_json::{Value, json};

fn dump(c: &rusqlite::Connection) -> Value {
    let mut out = serde_json::Map::new();
    for table in [
        "request_logs",
        "usage_rollup",
        "usage_daily",
        "quota_samples",
        "nodes",
    ] {
        let mut q = c
            .prepare(&format!("SELECT * FROM {table} ORDER BY 1, 2"))
            .unwrap();
        let cols = q.column_count();
        let rows = q
            .query_map([], |r| {
                Ok((0..cols)
                    .map(|i| match r.get_ref(i).unwrap() {
                        ValueRef::Null => json!(["null"]),
                        ValueRef::Integer(v) => json!(["number", v]),
                        ValueRef::Real(v) if v.fract() == 0.0 => json!(["number", v as i64]),
                        ValueRef::Real(v) => json!(["number", v]),
                        ValueRef::Text(v) => json!(["string", String::from_utf8_lossy(v)]),
                        ValueRef::Blob(v) => json!(["blob", v]),
                    })
                    .collect::<Vec<_>>())
            })
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        out.insert(table.into(), json!(rows));
    }
    Value::Object(out)
}

#[test]
fn frozen_pruning_and_heartbeat_match_at_boundaries_and_empty_tables() {
    let dir = tempfile::tempdir().unwrap();
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .unwrap();
    let script = dir.path().join("reference.ts");
    std::fs::write(&script, format!(r#"
import {{ Database }} from 'bun:sqlite';
import {{ createUsageRepo }} from '{root}/packages/store/src/sqlite/usage.ts';
import {{ createMaintenanceRepo }} from '{root}/packages/store/src/sqlite/maintenance.ts';
import {{ createCredentialRepo }} from '{root}/packages/store/src/sqlite/credentials.ts';
const db = new Database(process.argv[2]);
const h = Number(process.argv[3]);
const usage = createUsageRepo(db, 'mine', 0);
const maintenance = createMaintenanceRepo(db, 'mine');
// Quota pruning does not consult the key.
const credentials = createCredentialRepo(db, null as any);
await maintenance.heartbeat(h);
const counts = [await usage.prune(h), await usage.pruneDaily(h), await credentials.pruneQuotaSamples(h)];
const tables = {{}};
for (const t of ['request_logs','usage_rollup','usage_daily','quota_samples','nodes']) {{
 tables[t] = db.query(`SELECT * FROM ${{t}} ORDER BY 1, 2`).values().map(row => row.map(v => v === null ? ['null'] : [typeof v, v]));
}}
console.log(JSON.stringify({{counts, tables}}));
db.close();
"#, root = root.display())).unwrap();
    for horizon in [0_i64, 3_600_017, 1_794_000_000_000] {
        for populated in [false, true] {
            let a = dir.path().join("rust.db");
            let b = dir.path().join("ts.db");
            let store = SqliteStore::open(&a, 0).unwrap();
            let c = store.connection();
            c.execute_batch("DELETE FROM request_logs; DELETE FROM usage_rollup; DELETE FROM usage_daily; DELETE FROM quota_samples; DELETE FROM nodes;").unwrap();
            if populated {
                for (i, at) in [horizon - 1, horizon, horizon + 1].iter().enumerate() {
                    c.execute("INSERT INTO request_logs(id,at,api_key_id,requested_model,status,duration_ms,state,input_tokens) VALUES(?,?,?,'model',200,1,'done',?)", rusqlite::params![format!("r{i}"), at, "k", i as i64 + 1]).unwrap();
                    c.execute(
                        "INSERT INTO nodes(id,seen_at) VALUES (?,?)",
                        rusqlite::params![format!("n{i}"), horizon - 86_400_000 + i as i64 - 1],
                    )
                    .unwrap();
                }
                omni_store::rollup::rebuild_rollup(c).unwrap();
                for at in [horizon - 1, horizon, horizon + 1] {
                    c.execute("INSERT INTO usage_daily(day) VALUES (?)", [at])
                        .unwrap();
                }
                // No credentials are needed for the retention query; disable FK only for this seed.
                c.execute_batch("PRAGMA foreign_keys=OFF").unwrap();
                for at in [horizon - 1, horizon, horizon + 1] {
                    c.execute("INSERT INTO quota_samples(credential_id,window_type,observed_at,used) VALUES ('c','fiveHour',?,1)", [at]).unwrap();
                }
                c.execute_batch("PRAGMA foreign_keys=ON").unwrap();
            }
            c.execute_batch(&format!("VACUUM INTO '{}'", b.display()))
                .unwrap();
            maintenance::heartbeat(c, "mine", horizon).unwrap();
            let counts = [
                maintenance::prune(c, horizon as f64).unwrap(),
                maintenance::prune_daily(c, horizon as f64).unwrap(),
                maintenance::prune_quota_samples(c, horizon as f64).unwrap(),
            ];
            let output = std::process::Command::new("bun")
                .args(["--no-env-file"])
                .arg(&script)
                .arg(&b)
                .arg(horizon.to_string())
                .current_dir(&root)
                .env_clear()
                .env("PATH", std::env::var("PATH").unwrap())
                .env("HOME", dir.path())
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            let expected: Value = serde_json::from_slice(&output.stdout).unwrap();
            assert_eq!(
                json!({"counts":counts,"tables":dump(c)}),
                expected,
                "horizon={horizon}, populated={populated}"
            );
            drop(store);
            std::fs::remove_file(&b).unwrap();
        }
    }
}

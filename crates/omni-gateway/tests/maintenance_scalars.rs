#![allow(clippy::unwrap_used)]
use omni_store::{SqliteStore, maintenance};
use rusqlite::params;
use serde_json::{Value, json};
fn dump(c: &rusqlite::Connection) -> Value {
    let mut out = serde_json::Map::new();
    for t in [
        "request_logs",
        "usage_rollup",
        "usage_daily",
        "quota_samples",
        "request_bodies",
        "nodes",
    ] {
        let mut q = c
            .prepare(&format!("SELECT * FROM {t} ORDER BY 1,2"))
            .unwrap();
        let n = q.column_count();
        let rows = q
            .query_map([], |r| {
                Ok((0..n)
                    .map(|i| match r.get_ref(i).unwrap() {
                        rusqlite::types::ValueRef::Null => json!(["null"]),
                        rusqlite::types::ValueRef::Integer(v) => json!(["number", v]),
                        rusqlite::types::ValueRef::Real(v) if v.fract() == 0.0 => {
                            json!(["number", v as i64])
                        }
                        rusqlite::types::ValueRef::Real(v) => json!(["number", v]),
                        rusqlite::types::ValueRef::Text(v) => {
                            json!(["string", String::from_utf8_lossy(v)])
                        }
                        rusqlite::types::ValueRef::Blob(v) => json!(["blob", v]),
                    })
                    .collect::<Vec<_>>())
            })
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        out.insert(t.into(), json!(rows));
    }
    Value::Object(out)
}
fn files(p: &std::path::Path) -> Vec<String> {
    let mut v = std::fs::read_dir(p)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect::<Vec<_>>();
    v.sort();
    v
}
#[test]
fn random_differential() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .unwrap();
    let evidence = std::path::Path::new("/tmp/opencode/a11/r1-harness");
    let script = evidence.join("oracle.ts");
    std::fs::write(&script,format!(r#"
import {{ Database }} from 'bun:sqlite';
import {{ createUsageRepo }} from '{r}/packages/store/src/sqlite/usage.ts';
import {{ createMaintenanceRepo }} from '{r}/packages/store/src/sqlite/maintenance.ts';
import {{ createCredentialRepo }} from '{r}/packages/store/src/sqlite/credentials.ts';
import {{ createConfigRepo }} from '{r}/packages/store/src/sqlite/config.ts';
import {{ createBodyRepo }} from '{r}/packages/store/src/sqlite/bodies.ts';
import {{ pruneLogs }} from '{r}/apps/gateway/src/maintenance.ts';
const db=new Database(process.argv[2]);const now=Number(process.argv[3]);
await createMaintenanceRepo(db,'mine').heartbeat(now);
let counts;try {{const x=await pruneLogs({{config:createConfigRepo(db),usage:createUsageRepo(db,'mine',0),credentials:createCredentialRepo(db,null as any),bodies:createBodyRepo(db,null as any,process.argv[4])}} as any,now);counts=[x.raw,x.daily,x.quotaSamples,x.bodies+x.bodiesOverCap+x.bodyOrphans]}}catch(e){{counts='ERROR'}}
const tables={{}};for(const t of ['request_logs','usage_rollup','usage_daily','quota_samples','request_bodies','nodes'])tables[t]=db.query(`SELECT * FROM ${{t}} ORDER BY 1,2`).values().map(row=>row.map(v=>v===null?['null']:[typeof v,v]));
console.log(JSON.stringify({{counts,tables}}));db.close();
"#,r=root.display())).unwrap();
    let now = 1_794_000_000_000_i64;
    let variants = vec![
        json!({}),
        json!({"logRetentionDays":0}),
        json!({"logRetentionDays":0.5}),
        json!({"logRetentionDays":1,"bodyRetentionDays":0}),
        json!({"logRetentionDays":2,"bodyRetentionDays":0.5}),
        json!({"logRetentionDays":null}),
        json!({"logRetentionDays":"1"}),
        json!({"logRetentionDays":"oops"}),
        json!({"logRetentionDays":false}),
        json!({"logRetentionDays":true}),
        json!({"logRetentionDays":" 0x1 "}),
        json!({"logRetentionDays":"Infinity"}),
        json!({"logRetentionDays":"-Infinity"}),
        json!({"logRetentionDays":"  "}),
        json!({"logRetentionDays":"0.000000001"}),
        json!({"logRetentionDays":1,"bodyRetentionDays":"oops"}),
    ];
    let mut report = Vec::new();
    for seed in [11011_u64, 22022] {
        let mut rng = seed;
        let mut mismatch = 0;
        let mut valid_mismatch = 0;
        for case in 0..200 {
            let d = tempfile::tempdir_in(evidence).unwrap();
            let a = d.path().join("a");
            let b = d.path().join("b");
            std::fs::create_dir(&a).unwrap();
            std::fs::create_dir(&b).unwrap();
            let sa = SqliteStore::open(a.join("db"), 0).unwrap();
            let c = sa.connection();
            let variant = &variants[case % variants.len()];
            c.execute(
                "INSERT OR REPLACE INTO settings(key,value) VALUES ('settings',?)",
                [variant.to_string()],
            )
            .unwrap();
            let raw = match case % 10 {
                0 => 30.0,
                1 => 0.0,
                2 => 0.5,
                3 => 1.0,
                4 => 2.0,
                5 | 8 => 0.0,
                6 | 9 => 1.0,
                _ => 30.0,
            };
            let h = now - (raw * 86_400_000.0) as i64;
            for i in 0..24 {
                rng = rng.wrapping_mul(6364136223846793005).wrapping_add(1);
                let at = [
                    h - 1,
                    h,
                    h + 1,
                    now - 86_400_001,
                    now - 86_400_000,
                    now - 86_399_999,
                    now - 31 * 86_400_000,
                ][(rng as usize) % 7];
                c.execute("INSERT INTO request_logs(id,at,api_key_id,requested_model,status,duration_ms,state,input_tokens,cost_usd) VALUES (?,?,'k','m',200,1,?,?,?)",params![format!("r{i}"),at,if rng%3==0{"pending"}else{"done"},(rng%100) as i64,(rng%10) as f64/10.0]).unwrap();
                c.execute(
                    "INSERT INTO request_bodies(request_id,at,rel_path) VALUES(?,?,?)",
                    params![format!("r{i}"), at, format!("r{i}.enc")],
                )
                .unwrap();
            }
            omni_store::rollup::rebuild_rollup(c).unwrap();
            for (i, delta) in [-1_i64, 0, 1].into_iter().enumerate() {
                c.execute(
                    "INSERT INTO usage_daily(day) VALUES (?)",
                    [now - 400 * 86_400_000 + delta],
                )
                .unwrap();
                c.execute(
                    "INSERT INTO nodes(id,seen_at) VALUES(?,?)",
                    params![format!("n{i}"), now - 86_400_000 + delta],
                )
                .unwrap();
                c.execute(
                    "INSERT INTO nodes(id,seen_at) VALUES(?,?)",
                    params![format!("live{i}"), now - 60_000 + delta],
                )
                .unwrap();
            }
            c.execute_batch("PRAGMA foreign_keys=OFF").unwrap();
            for delta in [-1_i64, 0, 1] {
                c.execute("INSERT INTO quota_samples(credential_id,window_type,observed_at,used) VALUES('c','fiveHour',?,1)",[h+delta]).unwrap();
            }
            c.execute_batch(&format!("VACUUM INTO '{}'", b.join("db").display()))
                .unwrap();
            for p in [&a, &b] {
                let f = p.join("request_bodies");
                std::fs::create_dir(&f).unwrap();
                for i in 0..24 {
                    std::fs::write(f.join(format!("r{i}.enc")), b"x").unwrap();
                }
                std::fs::write(f.join("orphan.enc"), b"x").unwrap();
            }
            maintenance::heartbeat(c, "mine", now).unwrap();
            let counts = omni_gateway::maintenance::prune_logs(&a.join("db"), 0, now)
                .map(|x| json!(x))
                .unwrap_or(json!("ERROR"));
            let o = std::process::Command::new("bun")
                .arg("--no-env-file")
                .arg(&script)
                .arg(b.join("db"))
                .arg(now.to_string())
                .arg(b.join("request_bodies"))
                .env_clear()
                .env("PATH", std::env::var("PATH").unwrap())
                .env("HOME", d.path())
                .current_dir(&root)
                .output()
                .unwrap();
            assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
            let ts: Value = serde_json::from_slice(&o.stdout).unwrap();
            let rust = json!({"counts":counts,"tables":dump(c)});
            if rust != ts || files(&a.join("request_bodies")) != files(&b.join("request_bodies")) {
                mismatch += 1;
                if case % 10 < 5 {
                    valid_mismatch += 1;
                }
                if case < 10 {
                    std::fs::write(
                        evidence.join(format!("mismatch-{seed}-{case}.json")),
                        serde_json::to_vec_pretty(&json!({"settings":variant,"rust":rust,"ts":ts}))
                            .unwrap(),
                    )
                    .unwrap();
                }
            }
        }
        assert_eq!(mismatch, 0, "seed {seed}");
        report.push(json!({"seed":seed,"cases":200,"mismatches":mismatch,"valid_mismatches":valid_mismatch}));
    }
    std::fs::write(
        evidence.join("random-results.json"),
        serde_json::to_vec_pretty(&report).unwrap(),
    )
    .unwrap();
    println!("{}", json!(report));
}

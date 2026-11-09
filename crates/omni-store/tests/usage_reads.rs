//! The rate-limit seed reads against `store.usage.sumBuckets` and
//! `oldestSince` in `packages/store/src/sqlite/usage.ts`, on the same file.

mod common;

use common::{bun_available, bun_script};
use omni_store::SqliteStore;
use omni_store::usage::{done_stamps, seed_rows, sum_buckets};
use rusqlite::params;
use serde_json::{Value, json};

const T0: i64 = 1_794_000_000_000;
const HOUR: i64 = 3_600_000;

fn seed(store: &SqliteStore) {
    let c = store.connection();
    let rows: &[(&str, &str, i64, &str, i64, f64)] = &[
        ("r1", "k1", T0 - 3 * HOUR - 17, "fast", 40, 0.5),
        ("r2", "k1", T0 - 3 * HOUR + 59_999, "opus", 7, 0.25),
        ("r3", "k1", T0 - HOUR, "fast", 100, 1.0),
        ("r4", "k1", T0 - 6 * HOUR, "opus", 3, 0.0),
        ("r5", "k1", T0 - 1, "opus", 9, 2.5),
        ("r6", "k2", T0 - 10, "fast", 1000, 9.0),
        ("p1", "k1", T0 - 5, "fast", 0, 0.0),
    ];
    for (id, key, at, model, tokens, cost) in rows {
        let state = if id.starts_with('p') {
            "pending"
        } else {
            "done"
        };
        c.execute(
            "INSERT INTO request_logs (id, at, api_key_id, requested_model, status, duration_ms,
               input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, state)
             VALUES (?,?,?,?,200,1,?,1,2,3,?,?)",
            params![id, at, key, model, tokens, cost, state],
        )
        .expect("row");
    }
    omni_store::rollup::rebuild_rollup(c).expect("rollup");
}

#[test]
fn seed_reads_equal_the_ts_store() {
    if !bun_available("seed_reads_equal_the_ts_store") {
        return;
    }
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("omni.db");
    let store = SqliteStore::open(&path, 0).expect("open");
    seed(&store);

    let since = [T0 - 5 * HOUR, T0 - 7 * 24 * HOUR, T0 - 3 * HOUR];
    let grains = [60_000, HOUR];
    let models: [Option<&str>; 3] = [None, Some("opus"), Some("fast")];
    let mut cases = Vec::new();
    for s in since {
        for g in grains {
            for m in models {
                cases.push(json!([s, g, m]));
            }
        }
    }
    let script = format!(
        r#"
import {{ createStore }} from "{root}/packages/store/src/index.ts";
import {{ deriveKey }} from "{root}/packages/store/src/encryption.ts";
const store = await createStore({{ path: process.argv[2], encryptionKey: await deriveKey("usage-reads-key-0123456"), dayOffsetMinutes: 0 }});
const cases = JSON.parse(await Bun.stdin.text());
const out = [];
for (const [since, grain, model] of cases) {{
  const buckets = await store.usage.sumBuckets("k1", since, grain, model ?? undefined);
  const oldest = await store.usage.oldestSince("k1", since, model ?? undefined);
  out.push({{ buckets: buckets.sort((a, b) => a[0] - b[0]), oldest }});
}}
store.close();
console.log(JSON.stringify(out));
"#,
        root = common::repo_root().display()
    );
    let file = dir.path().join("reads.ts");
    std::fs::write(&file, &script).expect("script");
    let out = std::process::Command::new("bun")
        .arg(&file)
        .arg(&path)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .and_then(|mut child| {
            use std::io::Write as _;
            child
                .stdin
                .take()
                .expect("stdin")
                .write_all(Value::Array(cases.clone()).to_string().as_bytes())?;
            child.wait_with_output()
        })
        .expect("bun");
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let ts: Vec<Value> = serde_json::from_slice(&out.stdout).expect("json");
    let _ = bun_script; // the shared helper runs from the repo root; this needs the db arg.

    for (case, expected) in cases.iter().zip(ts) {
        let (s, g, m) = (
            case[0].as_i64().expect("since"),
            case[1].as_i64().expect("grain"),
            case[2].as_str(),
        );
        let mut buckets = sum_buckets(store.connection(), "k1", s, g, m).expect("buckets");
        buckets.sort_by_key(|b| b.0);
        let got_buckets: Vec<Value> = buckets
            .iter()
            .map(|(start, c)| {
                json!([start, { "requests": c.requests, "tokens": c.tokens, "costUsd": c.cost_usd }])
            })
            .collect();
        assert_eq!(
            omni_ir::jsjson::to_string(&Value::Array(got_buckets)),
            omni_ir::jsjson::to_string(&expected["buckets"]),
            "{case}"
        );
        let stamps = done_stamps(store.connection(), "k1", s, m, 1000).expect("stamps");
        assert_eq!(json!(stamps.first()), expected["oldest"], "{case}");
        assert!(stamps.windows(2).all(|w| w[0] <= w[1]));
    }
}

/// The seed payload is bounded in SQL: stamps are capped (oldest first,
/// which is what an exact reset reads), and nothing per-request beyond the
/// instant is selected.
#[test]
fn seed_stamps_are_capped_in_the_query_and_keep_the_newest() {
    let dir = tempfile::tempdir().expect("tempdir");
    let store = SqliteStore::open(dir.path().join("omni.db"), 0).expect("open");
    let c = store.connection();
    for i in 0..50_i64 {
        c.execute(
            "INSERT INTO request_logs (id, at, api_key_id, requested_model, status, duration_ms)
             VALUES (?,?,'k1','fast',200,1)",
            params![format!("r{i}"), T0 - 1000 + (49 - i) * 10],
        )
        .expect("row");
    }
    let stamps = done_stamps(c, "k1", T0 - 5 * HOUR, None, 7).expect("stamps");
    assert_eq!(stamps.len(), 7);
    assert_eq!(stamps[0], T0 - 1000 + 430);
    assert_eq!(stamps[6], T0 - 1000 + 490);
    // Eight rows remain: the omitted head still matters even after most rows
    // expire. At 425 only seven remain and the retained head is exact again.
    assert_eq!(
        done_stamps(c, "k1", T0 - 580, None, 100)
            .expect("live")
            .len(),
        8
    );
    assert_eq!(
        done_stamps(c, "k1", T0 - 575, None, 100).expect("recovery"),
        stamps
    );
    assert_eq!(
        done_stamps(c, "k1", T0 - 5 * HOUR, Some("fast"), 7).expect("model"),
        stamps
    );
    // Once older omitted rows expire, the retained head is exact again.
    for offset in [430, 480, 490, 500] {
        let since = T0 - 1000 + offset;
        let fresh = done_stamps(c, "k1", since, None, 7).expect("expiry");
        let retained: Vec<_> = stamps.iter().copied().filter(|s| *s >= since).collect();
        assert_eq!(fresh, retained);
    }
    let (buckets, capped) = seed_rows(c, "k1", T0 - 5 * HOUR, 60_000, None, 7).expect("seed");
    assert_eq!(capped, stamps);
    // The aggregate still counts every row, whatever the stamp cap.
    let total: f64 = buckets.iter().map(|(_, c)| c.requests).sum();
    assert_eq!(total, 50.0);
}

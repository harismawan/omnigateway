//! `getSettings` in `packages/store/src/sqlite/config.ts`: the same stored row
//! reads back as the same object, byte for byte once stringified.

mod common;

use common::{bun_available, bun_script, ts};
use omni_store::SqliteStore;
use omni_store::settings::{DEFAULT_SMART_ROUTER_POLICY, PonytailMode};

fn rows() -> Vec<Option<String>> {
    let mut rows: Vec<Option<String>> = vec![None];
    rows.extend(
        [
            "{}",
            "not json",
            "[]",
            "null",
            "5",
            r#""text""#,
            r#"{"maxAttempts":5,"rtkEnabled":true,"weights":{"cost":0.4}}"#,
            r#"{"zz":1,"maxAttempts":"x","weights":{"tier":1,"bogus":2},"smartRouterPolicy":"  hi ","3":true,"1":false}"#,
            r#"{"weights":5}"#,
            r#"{"weights":null}"#,
            r#"{"weights":[1,2]}"#,
            r#"{"weights":{"tier":"9","health":null,"load":-0,"latency":1e300}}"#,
            r#"{"rtkEnabled":1,"autoCacheEnabled":null,"bodyLoggingEnabled":"true","bodyLoggingCaptureStreamChunks":true}"#,
            r#"{"autoCacheEnabled":false}"#,
            r#"{"autoCacheEnabled":true,"ponytailMode":"ultra"}"#,
            r#"{"ponytailMode":"mega"}"#,
            r#"{"ponytailMode":"lite","bodyRetentionDays":3650}"#,
            r#"{"bodyRetentionDays":3651}"#,
            r#"{"bodyRetentionDays":0}"#,
            r#"{"bodyRetentionDays":2.0}"#,
            r#"{"bodyRetentionDays":2.5}"#,
            r#"{"bodyRetentionDays":"7"}"#,
            r#"{"guardrailModel":"  ","guardrailTimeoutMs":60000,"guardrailHistoryTurns":10}"#,
            r#"{"guardrailModel":"anthropic/claude","guardrailTimeoutMs":60001,"guardrailHistoryTurns":0}"#,
            r#"{"guardrailModel":5,"guardrailTimeoutMs":1.5,"guardrailHistoryTurns":11}"#,
            r#"{"smartRouterEnabled":true,"smartRouterClassifierModel":" local ","smartRouterLocalModel":"","smartRouterTimeoutMs":1}"#,
            r#"{"smartRouterEnabled":"yes","smartRouterClassifierModel":null,"smartRouterPolicy":"\u00a0\ufeff\u2028x\u3000"}"#,
            r#"{"smartRouterPolicy":"\u0085x\u0085"}"#,
            r#"{"smartRouterPolicy":"\t\n "}"#,
            r#"{"smartRouterPolicy":7}"#,
            r#"{"snapshotKeepLatest":1,"snapshotMaxAgeDays":3650,"requestDeadlineMs":1000,"breakerThreshold":2,"breakerCooldownMs":5,"logRetentionDays":7,"quotaPollIntervalMs":0}"#,
            r#"{"__proto__":{"x":1},"constructor":2}"#,
            r#"{"maxAttempts":1,"maxAttempts":2}"#,
        ]
        .map(|s| Some(s.to_owned())),
    );
    rows.push(Some(format!(
        r#"{{"smartRouterPolicy":"{}"}}"#,
        "😀".repeat(2000)
    )));
    rows.push(Some(format!(
        r#"{{"smartRouterPolicy":"{}"}}"#,
        "😀".repeat(2001)
    )));
    rows.push(Some(format!(
        r#"{{"smartRouterPolicy":"{}"}}"#,
        "a".repeat(4000)
    )));
    rows.push(Some(format!(
        r#"{{"smartRouterPolicy":"{}"}}"#,
        "a".repeat(4001)
    )));
    rows
}

fn store_with(dir: &std::path::Path, n: usize, raw: Option<&str>) -> SqliteStore {
    let store = SqliteStore::open(dir.join(format!("s{n}.db")), 0).expect("open");
    if let Some(raw) = raw {
        store
            .connection()
            .execute(
                "INSERT INTO settings (key, value) VALUES ('settings', ?)",
                [raw],
            )
            .expect("seed");
    }
    store
}

#[test]
fn typed_settings_read_the_documented_defaults_and_overrides() {
    let dir = tempfile::tempdir().expect("tempdir");
    let defaults = store_with(dir.path(), 0, None)
        .get_settings()
        .expect("settings");
    assert_eq!(defaults.weights.tier, 10.0);
    assert_eq!(defaults.max_attempts, 3.0);
    assert!(defaults.auto_cache_enabled);
    assert!(!defaults.rtk_enabled);
    assert_eq!(defaults.ponytail_mode, PonytailMode::Off);
    assert_eq!(defaults.smart_router_policy, DEFAULT_SMART_ROUTER_POLICY);
    assert_eq!(defaults.guardrail_model, None);

    let edited = store_with(
        dir.path(),
        1,
        Some(r#"{"maxAttempts":5,"rtkEnabled":true,"weights":{"cost":0.4},"ponytailMode":"full","guardrailModel":"x"}"#),
    )
    .get_settings()
    .expect("settings");
    assert_eq!(edited.max_attempts, 5.0);
    assert!(edited.rtk_enabled);
    assert_eq!(edited.weights.cost, 0.4);
    assert_eq!(edited.weights.health, 3.0);
    assert_eq!(edited.ponytail_mode, PonytailMode::Full);
    assert_eq!(edited.guardrail_model.as_deref(), Some("x"));
}

#[test]
fn every_row_reads_back_as_get_settings_does() {
    let rows = rows();
    if !bun_available("every_row_reads_back_as_get_settings_does") {
        return;
    }
    let dir = tempfile::tempdir().expect("tempdir");
    let script = format!(
        r#"
import {{ openDb }} from "{}";
import {{ createConfigRepo }} from "{}";
const out = [];
for (const raw of JSON.parse(await Bun.stdin.text())) {{
  const db = openDb(":memory:", 0);
  if (raw !== null) db.run("INSERT INTO settings (key, value) VALUES ('settings', ?)", [raw]);
  out.push(JSON.stringify(await createConfigRepo(db).getSettings()));
  db.close();
}}
console.log(JSON.stringify(out));
"#,
        ts("packages/store/src/sqlite/db.ts"),
        ts("packages/store/src/sqlite/config.ts")
    );
    let expected: Vec<String> = serde_json::from_str(&bun_script(
        dir.path(),
        &script,
        &serde_json::to_string(&rows).expect("rows"),
    ))
    .expect("json");
    for (n, (raw, want)) in rows.iter().zip(expected).enumerate() {
        let settings = store_with(dir.path(), n, raw.as_deref())
            .get_settings()
            .expect("settings");
        assert_eq!(
            omni_ir::jsjson::to_string(&settings.json),
            want,
            "settings row {raw:?}"
        );
    }
}

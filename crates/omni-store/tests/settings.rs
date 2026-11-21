//! `getSettings` in `packages/store/src/sqlite/config.ts`: the same stored row
//! reads back as the same object, byte for byte once stringified.

mod common;

use omni_store::SqliteStore;
use omni_store::settings::{DEFAULT_SMART_ROUTER_POLICY, PonytailMode};

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

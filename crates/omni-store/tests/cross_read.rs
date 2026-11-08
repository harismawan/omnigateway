//! A database the TS CLI wrote is read by Rust, and a database Rust migrated
//! is read by the TS CLI.

mod common;

use common::{ENCRYPTION_KEY, bun_available, canon, cli_root, omni};
use omni_store::{AuthType, BreakerState, Secret, SqliteStore, Strategy};
use serde_json::{Value, json};

const UPSTREAM_SECRET: &str = "sk-cross-read-upstream";

fn bench_model(id: &str, upstream: &str) -> Value {
    // `benchModel()` in scripts/bench-gateway.ts, plus the optional target
    // fields a console-built target can carry.
    json!({
        "id": id,
        "strategy": "priority",
        "isAlias": false,
        "targets": [
            {
                "provider": "custom",
                "endpointId": "bench",
                "model": upstream,
                "tier": 1,
                "weight": 1,
                "costPerMTok": { "input": 1, "output": 2 },
                "capabilities": { "tools": true, "images": true, "reasoning": true }
            },
            {
                "provider": "custom",
                "endpointId": "bench",
                "model": format!("{upstream}-big"),
                "tier": 2,
                "weight": 0.5,
                "costPerMTok": { "input": 3, "output": 15, "cacheRead": 0.3, "cacheWrite5m": 3.75, "cacheWrite1h": 6 },
                "contextWindow": 200000,
                "maxOutputTokens": 8192,
                "capabilities": { "tools": true, "images": false, "reasoning": false }
            }
        ]
    })
}

/// `omni keys list --json` minus the CLI-only `limitUsage`.
fn listed_keys(dir: &std::path::Path) -> Vec<Value> {
    omni(dir, &["keys", "list"], "")["keys"]
        .as_array()
        .expect("keys")
        .iter()
        .map(|k| {
            let mut k = k.clone();
            k.as_object_mut().expect("key").shift_remove("limitUsage");
            k
        })
        .collect()
}

#[test]
fn rust_reads_a_database_the_ts_cli_wrote() {
    if !bun_available("rust_reads_a_database_the_ts_cli_wrote") {
        return;
    }
    let dir = tempfile::tempdir().expect("tempdir");
    let db = cli_root(dir.path());
    let added = omni(
        dir.path(),
        &[
            "credentials",
            "add-key",
            "custom",
            "--label",
            "bench upstream",
            "--endpoint-id",
            "bench",
            "--endpoint-label",
            "Bench",
            "--origin",
            "http://127.0.0.1:18100",
            "--protocol",
            "chat-completions",
        ],
        &format!("{UPSTREAM_SECRET}\n"),
    );
    let credential_id = added["id"].as_str().expect("credential id").to_owned();
    for (id, upstream) in [("bench-a", "up-a"), ("bench-b", "up-b")] {
        let file = dir.path().join(format!("{id}.model.json"));
        std::fs::write(&file, bench_model(id, upstream).to_string()).expect("model file");
        omni(
            dir.path(),
            &["models", "put", id, "-f", file.to_str().expect("path")],
            "",
        );
    }
    let plain = omni(
        dir.path(),
        &["keys", "create", "--label", "bench plain"],
        "",
    );
    let limited = omni(
        dir.path(),
        &[
            "keys",
            "create",
            "--label",
            "bench limited",
            "--limit",
            "requests:1m=100",
            "--limit",
            "tokens:5h=1000",
            "--limit",
            "concurrency=5",
        ],
        "",
    );
    omni(dir.path(), &["settings", "set", "rtkEnabled", "true"], "");
    omni(dir.path(), &["settings", "set", "weights.cost", "0.4"], "");

    // Health is written only by a running gateway; this is the row
    // `UPSERT_HEALTH` in packages/store/src/sqlite/credentials.ts writes.
    {
        let conn = rusqlite::Connection::open(&db).expect("open");
        conn.execute(
            "INSERT INTO credential_health (credential_id, model, breaker_state,
               consecutive_failures, opened_at, rate_limited_until) VALUES (?,?,?,?,?,?)",
            rusqlite::params![
                credential_id,
                "up-a",
                "open",
                3,
                1_794_000_000_000_i64,
                None::<i64>
            ],
        )
        .expect("health");
    }

    let store = SqliteStore::open(&db, 420).expect("rust open");
    let key = omni_crypto::field::derive_key(ENCRYPTION_KEY);
    let version_before = store.data_version().expect("data_version");
    let snap = store.snapshot_reads(&key).expect("snapshot");

    // Keys: exactly what `omni keys list --json` reports, plus the hash.
    let rust_keys: Vec<Value> = snap
        .api_keys
        .iter()
        .map(|k| {
            let mut v = serde_json::to_value(k).expect("key json");
            v.as_object_mut().expect("key").shift_remove("hash");
            v
        })
        .collect();
    assert_eq!(
        canon(&Value::Array(rust_keys)),
        canon(&Value::Array(listed_keys(dir.path())))
    );
    for created in [&plain, &limited] {
        let raw = created["key"].as_str().expect("raw key");
        let found = snap
            .api_keys
            .iter()
            .find(|k| k.id == created["id"].as_str().expect("id"))
            .expect("key present");
        assert_eq!(found.hash, omni_crypto::apikey::hash(raw));
        assert_eq!(found.prefix, created["prefix"].as_str().expect("prefix"));
    }
    let limits = snap
        .api_keys
        .iter()
        .find(|k| k.label == "bench limited")
        .and_then(|k| k.limits.clone())
        .expect("limits readable");
    assert_eq!(
        limits.base.requests.as_ref().and_then(|w| w.one_minute),
        Some(Some(100))
    );
    assert_eq!(limits.base.concurrency, Some(Some(5)));

    // Credentials: metadata as `omni credentials list` reports it, and the
    // secret decrypted with the same key.
    let rust_creds: Vec<Value> = snap
        .credentials
        .iter()
        .map(|c| serde_json::to_value(c).expect("credential json"))
        .collect();
    assert_eq!(
        canon(&Value::Array(rust_creds)),
        canon(&omni(dir.path(), &["credentials", "list"], "")["credentials"])
    );
    let cred = &snap.credentials[0];
    assert_eq!(cred.auth_type, AuthType::ApiKey);
    assert_eq!(
        cred.secrets.api_key,
        Secret::Present(UPSTREAM_SECRET.to_owned())
    );
    assert_eq!(cred.secrets.access_token, Secret::Absent);
    assert_eq!(cred.secrets.refresh_token, Secret::Absent);
    assert_eq!(cred.secrets.id_token, Secret::Absent);
    assert_eq!(cred.provider_data["endpointId"], "bench");

    // Models with targets, as `omni models list` reports them.
    let models: Vec<&omni_store::VirtualModel> = snap
        .models
        .iter()
        .map(|m| m.as_ref().expect("model readable"))
        .collect();
    let rust_models: Vec<Value> = models
        .iter()
        .map(|m| serde_json::to_value(m).expect("model json"))
        .collect();
    assert_eq!(
        canon(&Value::Array(rust_models)),
        canon(&omni(dir.path(), &["models", "list"], "")["models"])
    );
    assert_eq!(models[0].strategy, Strategy::Priority);
    assert_eq!(models[0].targets[1].context_window, Some(200_000.0));

    // Health.
    assert_eq!(snap.health.len(), 1);
    assert_eq!(snap.health[0].credential_id, credential_id);
    assert_eq!(snap.health[0].breaker_state, BreakerState::Open);
    assert_eq!(snap.health[0].consecutive_failures, 3);
    assert_eq!(snap.health[0].opened_at, Some(1_794_000_000_000.0));
    assert_eq!(snap.health[0].rate_limited_until, None);

    // Settings, as `omni settings get` reports them.
    assert_eq!(
        canon(&snap.settings.json),
        canon(&omni(dir.path(), &["settings", "get"], "")["settings"])
    );
    assert!(snap.settings.rtk_enabled);
    assert_eq!(snap.settings.weights.cost, 0.4);

    // `PRAGMA data_version` moves when another connection commits.
    omni(dir.path(), &["keys", "create", "--label", "after"], "");
    assert_ne!(store.data_version().expect("data_version"), version_before);
}

#[test]
fn the_ts_cli_reads_a_database_rust_migrated() {
    if !bun_available("the_ts_cli_reads_a_database_rust_migrated") {
        return;
    }
    let dir = tempfile::tempdir().expect("tempdir");
    let db = cli_root(dir.path());
    let ledger = |conn: &rusqlite::Connection| -> Vec<i64> {
        let mut stmt = conn
            .prepare("SELECT id FROM migrations ORDER BY id")
            .expect("prepare");
        stmt.query_map([], |r| r.get(0))
            .expect("query")
            .collect::<Result<_, _>>()
            .expect("rows")
    };
    {
        let store = SqliteStore::open(&db, 0).expect("rust open");
        assert_eq!(ledger(store.connection()), (1..=20).collect::<Vec<i64>>());
    }
    assert_eq!(listed_keys(dir.path()), Vec::<Value>::new());
    let created = omni(
        dir.path(),
        &[
            "keys",
            "create",
            "--label",
            "on rust",
            "--limit",
            "requests:1m=7",
        ],
        "",
    );
    let listed = listed_keys(dir.path());
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0]["id"], created["id"]);
    assert_eq!(listed[0]["limits"], json!({ "requests": { "1m": 7 } }));
    // TS found nothing to apply.
    let conn = rusqlite::Connection::open(&db).expect("open");
    assert_eq!(ledger(&conn), (1..=20).collect::<Vec<i64>>());
}

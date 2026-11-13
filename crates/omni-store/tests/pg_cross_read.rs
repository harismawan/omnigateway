//! A Postgres database the frozen TS store wrote is read by Rust, and one the
//! Rust store wrote is read by TS: keys, encrypted credentials, health,
//! quota, models, settings, usage sums and rollups, body envelopes, and the
//! NULL / numeric / BIGINT edge values in between.

mod common;

use common::pg::{TestDb, base_url};
use common::{bun_required, bun_script, canon, ts};
use omni_store::keys::{ApiKey, KeyEdit};
use omni_store::limits::parse_limits;
use omni_store::pg::bodies::DetailState;
use omni_store::pg::{PgConfig, PgStore};
use omni_store::writer::{LogEvent, RequestLog, Writer, WriterConfig};
use omni_store::{AuthType, BreakerState, Secret, Strategy};
use serde_json::{Value, json};

const SECRET: &str = "pg-cross-read-secret";
const T0: i64 = 1_794_007_800_000;
const HOUR: i64 = 3_600_000;

fn ts_store(dir: &std::path::Path, input: &Value) -> Value {
    let script = format!("await import({:?});\n", ts("conformance/store/pg-store.ts"));
    let out = bun_script(dir, &script, &input.to_string());
    serde_json::from_str(out.trim()).expect("ts json")
}

fn model(id: &str) -> Value {
    json!({
        "id": id,
        "strategy": "priority",
        "isAlias": false,
        "targets": [{
            "provider": "custom", "endpointId": "bench", "model": "up", "tier": 1, "weight": 0.5,
            "costPerMTok": { "input": 3, "output": 15, "cacheRead": 0.3, "cacheWrite5m": 3.75 },
            "contextWindow": 200000,
            "capabilities": { "tools": true, "images": false, "reasoning": true },
            "futureField": { "kept": [1, "two"] }
        }]
    })
}

fn log(id: &str, at: i64, key: Option<&str>, model: &str, cost: f64) -> Value {
    json!({
        "id": id, "state": "done", "at": at, "apiKeyId": key, "requestedModel": model,
        "resolvedProvider": "anthropic", "resolvedModel": "claude", "credentialId": "c1",
        "attempts": 1, "status": 200, "errorCode": null,
        "inputTokens": 10, "outputTokens": 5, "cacheReadTokens": 2, "cacheWriteTokens": 1,
        "ttftMs": null, "durationMs": 200, "costUsd": cost, "degradations": ["x"],
        "rtkApplied": true, "rtkFilterHits": 1, "rtkOriginalCodeUnits": 9,
        "rtkCompressedCodeUnits": 4, "rtkEstimatedTokensSaved": 3, "rtkFilters": ["ls"]
    })
}

fn artifact(id: &str, at: i64) -> Value {
    json!({
        "schemaVersion": 1, "requestId": id, "at": at,
        "client": { "request": { "prompt": "hi ✓" }, "response": { "text": "ok" }, "truncated": true },
        "attempts": [{ "attempt": 1, "provider": "anthropic", "request": {}, "response": null,
                       "streamChunks": ["data: 1"], "truncated": false }],
        "error": null
    })
}

/// TS writes every kind of row; Rust reads each back as TS does.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn rust_reads_a_database_the_ts_store_wrote() {
    let Some(base) = base_url("rust_reads_a_database_the_ts_store_wrote") else {
        return;
    };
    if !bun_required("rust_reads_a_database_the_ts_store_wrote") {
        return;
    }
    let dir = tempfile::tempdir().expect("tempdir");
    let db = TestDb::create(&base, "ts_wrote").await;
    let hour = T0.div_euclid(HOUR) * HOUR;
    ts_store(
        dir.path(),
        &json!({
            "url": db.url, "op": "write", "secret": SECRET, "dayOffsetMinutes": 420,
            "credentials": [
                { "id": "c1", "provider": "anthropic", "label": "b-oauth", "authType": "oauth",
                  "enabled": true, "tier": 2, "weight": 0.25, "expiresAt": 1_794_000_000_123_i64,
                  "accountEmail": "a@example.com", "providerData": { "deviceId": "d1", "n": [1] },
                  "disabledReason": null, "disabledAt": null,
                  "accessToken": "at-✓", "refreshToken": "rt", "apiKey": null, "idToken": "id" },
                { "id": "c2", "provider": "custom", "label": "a-key", "authType": "apiKey",
                  "enabled": false, "tier": 1, "weight": 1, "expiresAt": null,
                  "accountEmail": null, "providerData": {},
                  "disabledReason": "manual", "disabledAt": 5,
                  "accessToken": null, "refreshToken": null, "apiKey": "sk-up", "idToken": null }
            ],
            "keys": [
                { "id": "k1", "label": "plain", "prefix": "sk-omni-aaaa", "hash": "h1",
                  "modelAllowlist": null, "limits": {}, "bodyLoggingOptOut": false,
                  "expiresAt": null, "guardrailPolicy": null, "smartRouting": false },
                { "id": "k2", "label": "limited", "prefix": "sk-omni-bbbb", "hash": "h2",
                  "modelAllowlist": ["fast", "m"],
                  "limits": { "requests": { "1m": 60, "5h": 2000 }, "spend": { "1w": 25.5 },
                              "concurrency": 8, "models": { "fast": { "tokens": { "1w": 9 } } } },
                  "bodyLoggingOptOut": true, "expiresAt": 1_900_000_000_000_i64,
                  "guardrailPolicy": "no pii", "smartRouting": true }
            ],
            "models": [model("fast"), { "id": "alias", "targets": [], "strategy": "roundRobin", "isAlias": true }],
            "settings": { "rtkEnabled": true, "maxAttempts": 5, "weights": { "cost": 0.4 }, "unknownKey": [1] },
            "health": [
                { "credentialId": "c1", "model": "m", "breakerState": "open", "consecutiveFailures": 3,
                  "openedAt": 1_794_000_000_000_i64, "rateLimitedUntil": 1_794_000_060_000.5 },
                { "credentialId": "c2", "model": "m", "breakerState": "halfOpen", "consecutiveFailures": 0,
                  "openedAt": null, "rateLimitedUntil": null }
            ],
            "quota": [
                { "credentialId": "c1", "windowType": "fiveHour", "startsAt": 1, "used": 40,
                  "limit": 100, "resetsAt": 99, "observedAt": 7, "windowMs": null },
                { "credentialId": "c1", "windowType": "someday", "startsAt": 2, "used": 0,
                  "limit": null, "resetsAt": null, "observedAt": 0, "windowMs": 5 }
            ],
            "logs": [
                log("l1", hour + 10, Some("k2"), "fast", 0.1),
                log("l2", hour + 20, Some("k2"), "m", 0.2),
                log("l3", hour + HOUR + 1, Some("k2"), "fast", -0.0),
                log("l4", hour + 5, None, "fast", 1.0)
            ],
            "body": [artifact("req_b1", T0)]
        }),
    );
    let store = PgStore::open(PgConfig::new(&db.url), 420)
        .await
        .expect("rust open");
    let key = omni_crypto::field::derive_key(SECRET);
    let snap = store.snapshot_reads(&key).await.expect("snapshot");
    let read = ts_store(
        dir.path(),
        &json!({ "url": db.url, "op": "read", "secret": SECRET, "dayOffsetMinutes": 420 }),
    );

    // Keys: what TS reads, field for field.
    let rust_keys: Vec<Value> = snap
        .api_keys
        .iter()
        .flatten()
        .map(|k| serde_json::to_value(k).expect("key"))
        .collect();
    assert_eq!(canon(&Value::Array(rust_keys)), canon(&read["keys"]));
    let k2 = snap
        .api_keys
        .iter()
        .flatten()
        .find(|k| k.id == "k2")
        .expect("k2");
    assert!(k2.smart_routing && k2.body_logging_opt_out);
    assert_eq!(
        k2.model_allowlist.as_deref(),
        Some(&["fast".into(), "m".into()][..])
    );

    // Credentials: metadata as TS reads it, secrets decrypted alike.
    let rust_creds: Vec<Value> = snap
        .credentials
        .iter()
        .map(|c| serde_json::to_value(c).expect("credential"))
        .collect();
    let ts_creds: Vec<Value> = read["credentials"]
        .as_array()
        .expect("credentials")
        .iter()
        .map(|c| {
            let mut c = c.clone();
            c.as_object_mut().expect("object").shift_remove("secrets");
            c
        })
        .collect();
    assert_eq!(
        canon(&Value::Array(rust_creds)),
        canon(&Value::Array(ts_creds))
    );
    let c1 = snap.credentials.iter().find(|c| c.id == "c1").expect("c1");
    assert_eq!(c1.auth_type, AuthType::OAuth);
    assert_eq!(c1.secrets.access_token, Secret::Present("at-✓".into()));
    assert_eq!(c1.secrets.refresh_token, Secret::Present("rt".into()));
    assert_eq!(c1.secrets.api_key, Secret::Absent);
    assert_eq!(c1.secrets.id_token, Secret::Present("id".into()));
    assert_eq!(snap.credentials[0].id, "c2", "tier, then label");
    assert_eq!(
        snap.credentials[0].secrets.api_key,
        Secret::Present("sk-up".into())
    );

    // Health: the fractional instant TS bound was rounded by BIGINT; both
    // read the stored integer.
    let rust_health: Vec<Value> = snap
        .health
        .iter()
        .map(|h| serde_json::to_value(h).expect("health"))
        .collect();
    let mut want = read["health"].as_array().expect("health").clone();
    let mut got = rust_health;
    let by = |v: &Value| v["credentialId"].as_str().unwrap_or_default().to_owned();
    want.sort_by_key(by);
    got.sort_by_key(by);
    assert_eq!(canon(&Value::Array(got)), canon(&Value::Array(want)));
    let h = snap
        .health
        .iter()
        .find(|h| h.credential_id == "c1")
        .expect("h");
    assert_eq!(h.breaker_state, BreakerState::Open);
    assert_eq!(h.rate_limited_until, Some(1_794_000_060_000.0));

    // Quota, models, settings.
    let rust_quota: Vec<Value> = snap
        .quota
        .iter()
        .map(|q| serde_json::to_value(q).expect("quota"))
        .collect();
    let mut wq = read["quota"].as_array().expect("quota").clone();
    let mut gq = rust_quota;
    let by_type = |v: &Value| v["windowType"].as_str().unwrap_or_default().to_owned();
    wq.sort_by_key(by_type);
    gq.sort_by_key(by_type);
    assert_eq!(canon(&Value::Array(gq)), canon(&Value::Array(wq)));
    let models: Vec<Value> = snap
        .models
        .iter()
        .map(|m| serde_json::to_value(m.as_ref().expect("model")).expect("json"))
        .collect();
    assert_eq!(canon(&Value::Array(models)), canon(&read["models"]));
    assert_eq!(
        snap.models[1].as_ref().expect("fast").strategy,
        Strategy::Priority
    );
    assert_eq!(canon(&snap.settings.json), canon(&read["settings"]));
    assert!(snap.settings.rtk_enabled);
    assert_eq!(snap.settings.weights.cost, 0.4);

    // Usage reads agree with TS's, sliding and narrowed, including a `-0`.
    let queries = [
        (Some("fast"), hour),
        (None, hour),
        (None, hour + 15),
        (Some("m"), 0),
        (None, hour + 2 * HOUR),
    ];
    let ts_sums = ts_store(
        dir.path(),
        &json!({ "url": db.url, "op": "read", "secret": SECRET, "dayOffsetMinutes": 420,
                 "sums": queries.iter().map(|(m, s)| {
                    // Absent, not null: TS narrows on `!== undefined`.
                    let mut q = json!({"key": "k2", "since": s});
                    if let Some(m) = m { q["model"] = json!(m); }
                    q
                 }).collect::<Vec<_>>(),
                 "buckets": [
                    {"key": "k2", "since": hour, "grain": HOUR},
                    {"key": "k2", "since": hour, "grain": 60_000},
                    {"key": "k2", "since": hour + 11, "grain": HOUR, "model": "fast"}
                 ] }),
    );
    for (n, (m, since)) in queries.iter().enumerate() {
        let c = store.sum_since("k2", *since, *m).await.expect("sum");
        let w = &ts_sums["sums"][n];
        assert_eq!(
            (c.requests, c.tokens, c.cost_usd),
            (
                w["requests"].as_f64().expect("requests"),
                w["tokens"].as_f64().expect("tokens"),
                w["costUsd"].as_f64().expect("cost")
            ),
            "sumSince {m:?} {since}"
        );
    }
    for (n, (since, grain, m)) in [
        (hour, HOUR, None),
        (hour, 60_000, None),
        (hour + 11, HOUR, Some("fast")),
    ]
    .iter()
    .enumerate()
    {
        let (mut buckets, _) = store
            .seed_rows("k2", *since, *grain, *m, 10)
            .await
            .expect("seed");
        buckets.sort_by_key(|b| b.0);
        let got: Vec<Value> = buckets
            .iter()
            .map(|(b, c)| {
                json!([b, {"requests": c.requests, "tokens": c.tokens, "costUsd": c.cost_usd}])
            })
            .collect();
        assert_eq!(
            canon(&Value::Array(got)),
            canon(&ts_sums["buckets"][n]),
            "sumBuckets {since} {grain} {m:?}"
        );
    }

    // The body TS sealed opens in Rust.
    let body = store
        .get_body(&key, "req_b1")
        .await
        .expect("read")
        .expect("row");
    assert_eq!(body.row.detail_state, DetailState::Ready);
    assert!(body.row.truncated, "client.truncated was set");
    assert_eq!(
        body.row.rel_path.as_deref(),
        Some("2026/11/06/req_b1.json.enc")
    );
    let a = body.artifact.expect("artifact");
    assert_eq!(a["client"]["request"]["prompt"], "hi ✓");
    assert_eq!(a["requestId"], "req_b1");

    // The change probe is the counter TS reads.
    assert_eq!(
        store.config_version().await.expect("version"),
        read["version"].as_i64().expect("version")
    );
}

/// Rust writes through its own store and writer; TS reads every row back.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_ts_store_reads_a_database_rust_wrote() {
    let Some(base) = base_url("the_ts_store_reads_a_database_rust_wrote") else {
        return;
    };
    if !bun_required("the_ts_store_reads_a_database_rust_wrote") {
        return;
    }
    let dir = tempfile::tempdir().expect("tempdir");
    let db = TestDb::create(&base, "rs_wrote").await;
    let store = PgStore::open(PgConfig::new(&db.url), -330)
        .await
        .expect("open");
    let key = omni_crypto::field::derive_key(SECRET);
    // A credential row with secrets the Rust field cipher sealed.
    let c = db.client().await;
    let seal = |v: &str| omni_crypto::field::encrypt(&key, v);
    c.execute(
        "INSERT INTO credentials (id, provider, label, auth_type, enabled, tier, weight, expires_at,
            account_email, provider_data, access_token, refresh_token, api_key, id_token,
            created_at, updated_at)
         VALUES ('c1', 'anthropic', 'one', 'oauth', TRUE, 1, 1.5, NULL, NULL, '{\"x\":1}',
                 $1, $2, NULL, NULL, 10, 11)",
        &[&seal("access-✓"), &seal("refresh")],
    )
    .await
    .expect("credential");

    let limits = parse_limits(r#"{"requests":{"1m":5},"models":{"m":{"spend":{"1w":2.5}}}}"#);
    for (id, hash, created) in [("k1", "h1", 100), ("k2", "h2", 200)] {
        store
            .create_key(&ApiKey {
                id: id.into(),
                label: format!("label {id}"),
                prefix: "sk-omni-cccc".into(),
                hash: hash.into(),
                model_allowlist: (id == "k2").then(|| vec!["m".into()]),
                lone_allowlist: Vec::new(),
                limits: limits.clone(),
                body_logging_opt_out: id == "k2",
                created_at: created,
                revoked_at: None,
                expires_at: None,
                guardrail_policy: None,
                smart_routing: false,
            })
            .await
            .expect("create key");
    }
    store
        .edit_key("k1", KeyEdit::Expiry(Some(1_900_000_000_000)))
        .await
        .expect("expiry");
    store
        .edit_key("k1", KeyEdit::Guardrail(Some("no pii")))
        .await
        .expect("guardrail");
    store
        .edit_key("k1", KeyEdit::SmartRouting(true))
        .await
        .expect("smart");
    store
        .edit_key("k2", KeyEdit::Limits(r#"{"concurrency":3}"#))
        .await
        .expect("limits");
    store
        .edit_key("k2", KeyEdit::Revoke(300))
        .await
        .expect("revoke");
    let m = model("fast");
    store
        .put_model("fast", &m["targets"].to_string(), "priority", false)
        .await
        .expect("model");
    store
        .put_settings(&json!({ "rtkEnabled": true, "weights": { "tier": 20 } }))
        .await
        .expect("settings");

    // Usage through the batched writer.
    let writer = Writer::spawn_postgres(
        store.clone(),
        WriterConfig {
            node_id: "node-rs".into(),
            day_offset_minutes: -330,
            ..WriterConfig::default()
        },
    )
    .expect("writer");
    let h = writer.handle();
    for (n, (k, cost)) in [
        (Some("k1"), 0.1),
        (Some("k1"), 0.2),
        (None, 0.3),
        (Some("k2"), -0.0),
    ]
    .into_iter()
    .enumerate()
    {
        let mut l = RequestLog::new(
            format!("r{n}"),
            T0 + i64::try_from(n).expect("n") * HOUR,
            200,
        );
        l.api_key_id = k.map(Into::into);
        l.requested_model = "fast".into();
        l.input_tokens = 10;
        l.output_tokens = 5;
        l.cost_usd = cost;
        l.ttft_ms = (n % 2 == 0).then_some(7);
        l.degradations = vec!["d\u{2028}".into()];
        assert!(h.send(LogEvent::Finish(l)));
    }
    writer.close().await.expect("close");
    let body = store
        .put_body(
            &key,
            "req_rs1",
            T0,
            &artifact("req_rs1", T0).to_string(),
            true,
        )
        .await
        .expect("body");

    let read = ts_store(
        dir.path(),
        &json!({ "url": db.url, "op": "read", "secret": SECRET, "dayOffsetMinutes": -330,
                 "bodies": ["req_rs1"],
                 "sums": [{"key": "k1", "since": 0}, {"key": "k1", "since": T0 + 1, "model": "fast"}] }),
    );

    // Keys as Rust reads them are what TS reads.
    let rust_keys: Vec<Value> = store
        .list_api_keys()
        .await
        .expect("keys")
        .iter()
        .map(|k| serde_json::to_value(k).expect("key"))
        .collect();
    assert_eq!(canon(&Value::Array(rust_keys)), canon(&read["keys"]));
    assert_eq!(read["keys"][0]["id"], "k2", "newest first");
    assert_eq!(read["keys"][0]["revokedAt"], 300);
    assert_eq!(read["keys"][0]["limits"], json!({ "concurrency": 3 }));
    assert_eq!(read["keys"][1]["expiresAt"], 1_900_000_000_000_i64);
    assert_eq!(read["keys"][1]["smartRouting"], true);

    // Secrets Rust sealed open in TS.
    assert_eq!(
        read["credentials"][0]["secrets"],
        json!({ "accessToken": "access-✓", "refreshToken": "refresh", "apiKey": null, "idToken": null })
    );
    assert_eq!(read["credentials"][0]["weight"], 1.5);
    assert_eq!(
        canon(&read["models"][0]),
        canon(
            &json!({"id": "fast", "targets": m["targets"], "strategy": "priority", "isAlias": false})
        )
    );
    assert_eq!(read["settings"]["rtkEnabled"], true);
    assert_eq!(read["settings"]["weights"]["tier"], 20);
    assert_eq!(
        canon(&read["settings"]),
        canon(&store.get_settings().await.expect("settings").json)
    );

    // Logs and rollups Rust batched read back in TS, and audit clean.
    let recent = read["recent"].as_array().expect("recent");
    assert_eq!(recent.len(), 4);
    let r3 = recent.iter().find(|r| r["id"] == "r3").expect("r3");
    assert_eq!(r3["costUsd"], 0.0);
    assert_eq!(r3["state"], "done");
    let r0 = recent.iter().find(|r| r["id"] == "r0").expect("r0");
    assert_eq!(r0["ttftMs"], 7);
    assert_eq!(r0["degradations"], json!(["d\u{2028}"]));
    assert_eq!(read["audit"]["ok"], true, "{}", read["audit"]);
    assert_eq!(read["sums"][0]["requests"], 2);
    let s = store
        .sum_since("k1", T0 + 1, Some("fast"))
        .await
        .expect("sum");
    assert_eq!(read["sums"][1]["requests"].as_f64(), Some(s.requests));
    assert_eq!(read["sums"][1]["costUsd"].as_f64(), Some(s.cost_usd));

    // The body Rust sealed opens in TS, byte-for-byte the row Rust reported.
    let ts_body = &read["bodies"][0];
    assert_eq!(ts_body["row"]["detailState"], "ready");
    assert_eq!(ts_body["row"]["sha256"], json!(body.sha256));
    assert_eq!(ts_body["row"]["sizeBytes"], json!(body.size_bytes));
    assert_eq!(ts_body["row"]["truncated"], true);
    assert_eq!(ts_body["artifact"]["client"]["request"]["prompt"], "hi ✓");
}

/// A body whose bytes were tampered with reads as corrupt on both sides,
/// and the state is recorded; one whose bytes are gone reads as missing.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn tampered_and_missing_bodies_read_as_corrupt_and_missing() {
    let Some(base) = base_url("tampered_and_missing_bodies_read_as_corrupt_and_missing") else {
        return;
    };
    let db = TestDb::create(&base, "bodies_bad").await;
    let store = PgStore::open(PgConfig::new(&db.url), 0)
        .await
        .expect("open");
    let key = omni_crypto::field::derive_key(SECRET);
    for id in ["req_ok", "req_flip", "req_gone", "req_big"] {
        store
            .put_body(&key, id, T0, &artifact(id, T0).to_string(), false)
            .await
            .expect("put");
    }
    let c = db.client().await;
    c.batch_execute(
        "UPDATE request_bodies SET bytes = set_byte(bytes, 30, get_byte(bytes, 30) # 1)
          WHERE request_id = 'req_flip';
         UPDATE request_bodies SET bytes = NULL WHERE request_id = 'req_gone';
         UPDATE request_bodies SET bytes = decode(repeat('00', 1048641), 'hex')
          WHERE request_id = 'req_big';",
    )
    .await
    .expect("tamper");
    let state = |id: &'static str| {
        let store = store.clone();
        let key = key.clone();
        async move {
            store
                .get_body(&key, id)
                .await
                .expect("read")
                .expect("row")
                .row
                .detail_state
        }
    };
    assert_eq!(state("req_ok").await, DetailState::Ready);
    assert_eq!(state("req_flip").await, DetailState::Corrupt);
    assert_eq!(state("req_gone").await, DetailState::Missing);
    assert_eq!(state("req_big").await, DetailState::Corrupt);
    let stored: Vec<(String, String)> = c
        .query(
            "SELECT request_id, detail_state FROM request_bodies ORDER BY request_id",
            &[],
        )
        .await
        .expect("rows")
        .iter()
        .map(|r| (r.get(0), r.get(1)))
        .collect();
    assert_eq!(
        stored,
        vec![
            ("req_big".into(), "corrupt".into()),
            ("req_flip".into(), "corrupt".into()),
            ("req_gone".into(), "missing".into()),
            ("req_ok".into(), "ready".into()),
        ]
    );
    // Restoring the bytes recovers the state.
    c.batch_execute("UPDATE request_bodies SET bytes = (SELECT bytes FROM request_bodies WHERE request_id = 'req_ok'), sha256 = (SELECT sha256 FROM request_bodies WHERE request_id = 'req_ok') WHERE request_id = 'req_gone'")
        .await
        .expect("restore");
    assert_eq!(state("req_gone").await, DetailState::Ready);
    assert!(store.get_body(&key, "nope").await.expect("read").is_none());
}

/// NULL, numeric and BIGINT edges as both readers see them: a hand-edited
/// row with an unreadable allowlist or targets, a key with NULL dates,
/// and the largest safe instant.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn edge_rows_read_as_ts_reads_them() {
    let Some(base) = base_url("edge_rows_read_as_ts_reads_them") else {
        return;
    };
    let db = TestDb::create(&base, "edges").await;
    let store = PgStore::open(PgConfig::new(&db.url), 0)
        .await
        .expect("open");
    let c = db.client().await;
    c.batch_execute(
        "INSERT INTO api_keys (id, label, prefix, hash, model_allowlist, limits, created_at, expires_at)
           VALUES ('a', 'a', 'p', 'ha', 'null', '{bad', 9007199254740991, NULL),
                  ('b', 'b', 'p', 'hb', '\"str\"', '{}', 1, 0);
         INSERT INTO virtual_models (id, targets) VALUES ('bad', 'not json'), ('ok', '[]');
         INSERT INTO credentials (id, provider, label, auth_type, created_at, updated_at, access_token)
           VALUES ('c', 'p', 'l', 'weird', 1, 1, 'enc:v1:00:00:00');
         INSERT INTO quota_windows (credential_id, window_type, starts_at)
           VALUES ('c', 'daily', -1);",
    )
    .await
    .expect("edges");
    let key = omni_crypto::field::derive_key(SECRET);
    let snap = store.snapshot_reads(&key).await.expect("snapshot");
    let a = snap
        .api_keys
        .iter()
        .flatten()
        .find(|k| k.id == "a")
        .expect("a");
    assert_eq!(a.created_at, 9_007_199_254_740_991);
    assert_eq!(a.model_allowlist, None, "JSON null is unrestricted");
    assert_eq!(a.limits, None, "unreadable limits mark the key");
    let b = snap
        .api_keys
        .iter()
        .flatten()
        .find(|k| k.id == "b")
        .expect("b");
    assert_eq!(b.model_allowlist, Some(vec![]), "a non-array denies all");
    assert!(!b.usable(1), "expires at 0");
    assert!(snap.models[0].is_err(), "bad targets fail only their row");
    assert!(snap.models[1].is_ok());
    assert_eq!(
        snap.credentials[0].auth_type,
        AuthType::Other("weird".into())
    );
    assert!(matches!(
        snap.credentials[0].secrets.access_token,
        Secret::Unreadable(_)
    ));
    assert_eq!(snap.quota[0].starts_at, -1.0);
    assert_eq!(snap.quota[0].used, 0.0);
    assert_eq!(snap.quota[0].limit, None);
    assert!(
        store
            .find_api_key_by_hash("ha")
            .await
            .expect("find")
            .is_some()
    );
    assert!(
        store
            .find_api_key_by_hash("zz")
            .await
            .expect("find")
            .is_none()
    );
}

/// Review A5 r1 (I2 on a live Postgres, minor 2): a key whose stored
/// allowlist `JSON.parse` refuses is that key's entry alone, carrying
/// `JSON.parse(stored)`'s own message: an empty column is `Unexpected EOF`,
/// not an empty request body's wording. Every other key still reads.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_unreadable_allowlist_is_isolated_with_json_parses_message() {
    let Some(base) = base_url("an_unreadable_allowlist_is_isolated_with_json_parses_message")
    else {
        return;
    };
    let db = TestDb::create(&base, "bad_allowlist").await;
    let store = PgStore::open(PgConfig::new(&db.url), 0)
        .await
        .expect("open");
    let c = db.client().await;
    c.batch_execute(
        "INSERT INTO api_keys (id, label, prefix, hash, model_allowlist, limits, created_at)
           VALUES ('empty', 'e', 'p', 'h-empty', '', '{}', 3),
                  ('bad', 'b', 'p', 'h-bad', '{bad', '{}', 2),
                  ('good', 'g', 'p', 'h-good', '[\"m\"]', '{}', 1);",
    )
    .await
    .expect("rows");
    let key = omni_crypto::field::derive_key(SECRET);
    let snap = store.snapshot_reads(&key).await.expect("snapshot");
    let errors: Vec<(&str, &str, &str)> = snap
        .api_keys
        .iter()
        .filter_map(|e| e.as_ref().err())
        .map(|e| (e.id.as_str(), e.hash.as_str(), e.message.as_str()))
        .collect();
    assert_eq!(
        errors,
        [
            ("empty", "h-empty", "JSON Parse error: Unexpected EOF"),
            ("bad", "h-bad", "JSON Parse error: Expected '}'"),
        ]
    );
    let good: Vec<&str> = snap
        .api_keys
        .iter()
        .flatten()
        .map(|k| k.id.as_str())
        .collect();
    assert_eq!(good, ["good"], "the readable key is served beside them");
    assert!(
        store.list_api_keys().await.is_err(),
        "the admin listing still fails, as `keys.list()` throws"
    );
}

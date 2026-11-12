//! The TS contract suite's semantics (`packages/store/test/contract`), ported
//! for the surface the Rust store offers, run once per backend through
//! [`Store`]: SQLite always, Postgres when `OMNI_TEST_DATABASE_URL` names a
//! server (skipped visibly otherwise, as the TS harness does).
//!
//! Rows are filed through the batched writer, which is how the gateway files
//! them; the writer's own row-for-row equality with TS is `writer.rs` and
//! `pg_writer.rs`.

mod common;

use common::canon;
use common::pg::{TestDb, base_url};
use omni_store::keys::ApiKey;
use omni_store::limits::parse_limits;
use omni_store::pg::PgConfig;
use omni_store::writer::{LogEvent, PendingLog, RequestLog, WriterConfig};
use omni_store::{Engine, OwnedKeyEdit, Store, StoreConfig};
use serde_json::json;
use std::future::Future;

const T: i64 = 1_700_000_000_000;
const HOUR: i64 = 3_600_000;

/// One backend's fresh store, and what keeps it alive.
struct Fresh {
    store: Store,
    _dir: Option<tempfile::TempDir>,
    _db: Option<TestDb>,
}

async fn sqlite(offset: i64) -> Fresh {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("omni.db");
    let store = Store::open(StoreConfig::Sqlite { path }, offset)
        .await
        .expect("open sqlite");
    Fresh {
        store,
        _dir: Some(dir),
        _db: None,
    }
}

async fn postgres(base: &str, hint: &str, offset: i64) -> Fresh {
    let db = TestDb::create(base, hint).await;
    let store = Store::open(StoreConfig::Postgres(PgConfig::new(&db.url)), offset)
        .await
        .expect("open postgres");
    Fresh {
        store,
        _dir: None,
        _db: Some(db),
    }
}

/// Runs `body` on SQLite, then on Postgres when a server is configured.
async fn each<F, Fut>(name: &str, offset: i64, body: F)
where
    F: Fn(Store) -> Fut,
    Fut: Future<Output = ()>,
{
    let s = sqlite(offset).await;
    body(s.store.clone()).await;
    match base_url(name) {
        Some(base) => {
            let p = postgres(&base, name, offset).await;
            assert_eq!(p.store.engine(), Engine::Postgres);
            body(p.store.clone()).await;
            println!("{name}: ran on sqlite and postgres");
        }
        None => println!("{name}: ran on sqlite only"),
    }
}

fn log(id: &str, at: i64) -> RequestLog {
    let mut l = RequestLog::new(id, at, 200);
    l.api_key_id = Some("k1".into());
    l.requested_model = "fast".into();
    l.resolved_provider = Some("anthropic".into());
    l.resolved_model = Some("claude-opus-4".into());
    l.credential_id = Some("c1".into());
    l.attempts = 1;
    l.input_tokens = 10;
    l.output_tokens = 5;
    l.cache_read_tokens = 2;
    l.cache_write_tokens = 1;
    l.ttft_ms = Some(100);
    l.duration_ms = 200;
    l.cost_usd = 0.001;
    l
}

fn begin(id: &str, at: i64, model: &str) -> LogEvent {
    LogEvent::Begin(PendingLog {
        id: id.into(),
        at,
        api_key_id: Some("k1".into()),
        requested_model: model.into(),
        resolved_provider: None,
        resolved_model: None,
        credential_id: None,
    })
}

async fn file(store: &Store, events: Vec<LogEvent>) {
    let w = store
        .spawn_writer(WriterConfig {
            node_id: "n".into(),
            day_offset_minutes: store.day_offset_minutes(),
            ..WriterConfig::default()
        })
        .expect("writer");
    for e in events {
        assert!(w.handle().send(e));
    }
    let stats = w.close().await.expect("close");
    assert_eq!(stats.failed, 0);
}

fn key(id: &str, created_at: i64) -> ApiKey {
    ApiKey {
        id: id.into(),
        label: id.into(),
        prefix: "sk-omni-cccc".into(),
        hash: format!("hash-{id}"),
        model_allowlist: None,
        limits: parse_limits("{}"),
        body_logging_opt_out: false,
        created_at,
        revoked_at: None,
        expires_at: None,
        guardrail_policy: None,
        smart_routing: false,
    }
}

fn close(a: f64, b: f64) -> bool {
    (a - b).abs() < 1e-12
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn keys_are_found_by_hash_list_newest_first_and_edit_whole() {
    each("contract_keys", 0, |s| async move {
        let mut k1 = key("k1", 1);
        k1.limits =
            parse_limits(r#"{"requests":{"1m":60,"5h":2000},"spend":{"1w":25.5},"concurrency":8}"#);
        k1.model_allowlist = Some(vec!["fast".into()]);
        k1.body_logging_opt_out = true;
        s.create_key(&k1).await.expect("create");
        s.create_key(&key("k2", 2)).await.expect("create");
        let found = s
            .find_api_key_by_hash("hash-k1")
            .await
            .expect("find")
            .expect("k1");
        assert_eq!(found, k1);
        assert!(
            s.find_api_key_by_hash("nope")
                .await
                .expect("find")
                .is_none()
        );
        let listed: Vec<String> = s
            .list_api_keys()
            .await
            .expect("list")
            .into_iter()
            .map(|k| k.id)
            .collect();
        assert_eq!(listed, ["k2", "k1"], "newest first");

        s.edit_key("k1", OwnedKeyEdit::Limits(r#"{"tokens":{"1w":5}}"#.into()))
            .await
            .expect("limits");
        assert!(
            s.edit_key("k1", OwnedKeyEdit::Limits(r#"{"bogus":1}"#.into()))
                .await
                .is_err(),
            "a shape the schema refuses is refused at write"
        );
        s.edit_key("k1", OwnedKeyEdit::Expiry(Some(5)))
            .await
            .expect("expiry");
        s.edit_key("k1", OwnedKeyEdit::Guardrail(Some("no pii".into())))
            .await
            .expect("guardrail");
        s.edit_key("k1", OwnedKeyEdit::SmartRouting(true))
            .await
            .expect("smart");
        s.edit_key("k1", OwnedKeyEdit::Models(Some("[]".into())))
            .await
            .expect("models");
        s.edit_key("k2", OwnedKeyEdit::Revoke(9))
            .await
            .expect("revoke");
        let k = s
            .find_api_key_by_hash("hash-k1")
            .await
            .expect("find")
            .expect("k1");
        assert_eq!(k.limits, parse_limits(r#"{"tokens":{"1w":5}}"#));
        assert_eq!(k.expires_at, Some(5));
        assert!(!k.usable(5) && k.usable(4), "expiry is exclusive");
        assert_eq!(k.guardrail_policy.as_deref(), Some("no pii"));
        assert!(k.smart_routing);
        assert_eq!(
            k.model_allowlist,
            Some(vec![]),
            "[] stays distinct from null"
        );
        s.edit_key("k1", OwnedKeyEdit::Models(None))
            .await
            .expect("models");
        s.edit_key("k1", OwnedKeyEdit::Expiry(None))
            .await
            .expect("expiry");
        let k = s
            .find_api_key_by_hash("hash-k1")
            .await
            .expect("find")
            .expect("k1");
        assert_eq!((k.model_allowlist, k.expires_at), (None, None));
        let k2 = s
            .find_api_key_by_hash("hash-k2")
            .await
            .expect("find")
            .expect("k2");
        assert_eq!(k2.revoked_at, Some(9));
        assert!(!k2.usable(0));
        let op = s.operator_keys(Some("k1")).await.expect("op");
        assert_eq!(op.len(), 1);
        assert_eq!(canon(&op[0].created_at), canon(&json!(1)));
        assert!(s.get_operator_key("k1").await.expect("op").is_some());
        assert!(s.get_operator_key("zz").await.expect("op").is_none());
    })
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn settings_return_defaults_persist_patches_and_merge_weights() {
    each("contract_settings", 0, |s| async move {
        let d = s.get_settings().await.expect("get");
        assert_eq!(d.json, omni_store::settings::default_settings_json());
        let next = s
            .put_settings(&json!({ "maxAttempts": 5, "weights": { "tier": 20 } }))
            .await
            .expect("put");
        assert_eq!(next["maxAttempts"], 5);
        assert_eq!(next["weights"]["tier"], 20);
        assert_eq!(next["weights"]["health"], 3, "weights merge");
        assert_eq!(s.get_settings().await.expect("get").json, next);
        let again = s
            .put_settings(&json!({ "rtkEnabled": true }))
            .await
            .expect("put");
        assert_eq!(again["maxAttempts"], 5);
        assert_eq!(again["rtkEnabled"], true);
        // Malformed stored windows read as the default.
        for bad in ["0", "-1", "1.5", "3651", "\"7\"", "null"] {
            s.write_operator_settings_raw(&format!("{{\"bodyRetentionDays\":{bad}}}"))
                .await
                .expect("raw");
            assert_eq!(
                s.get_settings().await.expect("get").body_retention_days,
                1.0,
                "{bad}"
            );
        }
        s.write_operator_settings_raw("not json")
            .await
            .expect("raw");
        assert_eq!(
            s.get_settings().await.expect("get").json,
            omni_store::settings::default_settings_json()
        );
        assert_eq!(
            s.operator_settings_raw().await.expect("raw").as_deref(),
            Some("not json")
        );
    })
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn virtual_models_round_trip_replace_on_put_and_remove() {
    each("contract_models", 0, |s| async move {
        let targets = json!([
            { "provider": "anthropic", "model": "claude-opus-4", "credentialId": "c1", "tier": 1,
              "weight": 1, "costPerMTok": { "input": 3, "output": 15, "cacheRead": 0.3 },
              "capabilities": { "tools": true, "images": true, "reasoning": true } },
            { "provider": "custom", "model": "x", "endpointId": "e1", "tier": 1, "weight": 1,
              "costPerMTok": { "input": 3, "output": 15 },
              "capabilities": { "tools": true, "images": true, "reasoning": true } }
        ]);
        s.put_model("fast", &targets.to_string(), "score", false)
            .await
            .expect("put");
        s.put_model("alias", "[]", "roundRobin", true)
            .await
            .expect("put");
        s.put_model("fast", &targets.to_string(), "roundRobin", false)
            .await
            .expect("put");
        let models = s.list_models().await.expect("list");
        let ids: Vec<String> = models
            .iter()
            .map(|m| m.as_ref().expect("ok").id.clone())
            .collect();
        assert_eq!(ids, ["alias", "fast"]);
        let fast = models[1].as_ref().expect("fast");
        assert_eq!(fast.strategy, omni_store::Strategy::RoundRobin);
        assert_eq!(
            canon(&serde_json::to_value(&fast.targets).expect("json")),
            canon(&targets)
        );
        assert!(models[0].as_ref().expect("alias").is_alias);
        let raw = s.operator_models().await.expect("raw");
        assert_eq!(raw[1].2, "roundRobin");
        s.remove_model("fast").await.expect("remove");
        assert_eq!(s.list_models().await.expect("list").len(), 1);
    })
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn begin_route_append_updates_one_row_and_rolls_up_once() {
    each("contract_lifecycle", 0, |s| async move {
        let hour = T.div_euclid(HOUR) * HOUR;
        file(
            &s,
            vec![
                begin("a", hour + 10, "fast"),
                LogEvent::Route {
                    id: "a".into(),
                    target: omni_store::writer::RouteTarget {
                        provider: "openai".into(),
                        model: "gpt".into(),
                        credential_id: "c2".into(),
                    },
                },
            ],
        )
        .await;
        // Pending rows are not counted anywhere.
        assert_eq!(s.sum_since("k1", 0, None).await.expect("sum").requests, 0.0);
        file(&s, vec![LogEvent::Finish(log("a", hour + 999))]).await;
        // A second finish loses the claim and counts nothing.
        file(&s, vec![LogEvent::Finish(log("a", hour + 999))]).await;
        let sum = s.sum_since("k1", 0, None).await.expect("sum");
        assert_eq!((sum.requests, sum.tokens), (1.0, 18.0));
        assert!(close(sum.cost_usd, 0.001));
    })
    .await;
}

/// `sumSince slides exactly, sums four token classes, excludes pending, and scopes`.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sum_since_slides_exactly_excludes_pending_and_scopes() {
    each("contract_sum_since", 0, |s| async move {
        let hour = T.div_euclid(HOUR) * HOUR;
        let mut a = log("a", hour + 10);
        a.cache_read_tokens = 100;
        a.cache_write_tokens = 1000;
        let mut c = log("c", hour + 2 * HOUR + 10);
        c.api_key_id = Some("k2".into());
        file(
            &s,
            vec![
                LogEvent::Finish(a),
                LogEvent::Finish(log("b", hour + HOUR + 10)),
                LogEvent::Finish(c),
                begin("p", hour + 15, "fast"),
                begin("q", hour + HOUR + 20, "fast"),
            ],
        )
        .await;
        let k = |since| {
            let s = s.clone();
            async move { s.sum_since("k1", since, None).await.expect("sum") }
        };
        let x = k(hour + 10).await;
        assert_eq!((x.requests, x.tokens), (2.0, 1133.0));
        assert!(close(x.cost_usd, 0.002));
        let x = k(hour + 11).await;
        assert_eq!((x.requests, x.tokens), (1.0, 18.0));
        assert_eq!(s.sum_since("k2", 0, None).await.expect("sum").requests, 1.0);
        assert_eq!(
            s.sum_since("nope", 0, None).await.expect("sum").requests,
            0.0
        );
        assert_eq!(k(hour + 10 + 2 * HOUR).await.requests, 0.0);
        assert_eq!(k(hour - 10 * HOUR).await.requests, 2.0);
    })
    .await;
}

/// `sumBuckets answers whole hours from the rollup and finer grains from the rows`,
/// and the narrowed reads behind model overrides.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sum_buckets_and_narrowed_reads() {
    each("contract_buckets", 0, |s| async move {
        let hour = T.div_euclid(HOUR) * HOUR;
        let with = |id: &str, at: i64, model: &str, key: &str, cost: f64| {
            let mut l = log(id, at);
            l.requested_model = model.into();
            l.api_key_id = Some(key.into());
            l.cost_usd = cost;
            LogEvent::Finish(l)
        };
        file(
            &s,
            vec![
                with("o1", hour + 10, "opus", "k1", 0.001),
                with("o2", hour + 60_000 + 10, "opus", "k1", 0.5),
                with("o3", hour + HOUR + 10, "opus", "k1", 0.001),
                with("f1", hour + 5, "fast", "k1", 0.001),
                with("f2", hour + HOUR + 5, "fast", "k1", 0.001),
                with("x1", hour + 10, "opus", "k2", 0.001),
                begin("p1", hour + 15, "opus"),
                begin("p2", hour + HOUR + 1, "opus"),
            ],
        )
        .await;
        let buckets = |since, grain, model: Option<&'static str>| {
            let s = s.clone();
            async move {
                let (mut b, _) = s
                    .seed_rows("k1", since, grain, model, 100)
                    .await
                    .expect("seed");
                b.sort_by_key(|x| x.0);
                b.into_iter()
                    .map(|(at, c)| (at, c.requests, c.tokens))
                    .collect::<Vec<_>>()
            }
        };
        assert_eq!(
            buckets(hour, HOUR, Some("opus")).await,
            [(hour, 2.0, 36.0), (hour + HOUR, 1.0, 18.0)]
        );
        assert_eq!(
            buckets(hour, 60_000, Some("opus")).await,
            [
                (hour, 1.0, 18.0),
                (hour + 60_000, 1.0, 18.0),
                (hour + HOUR, 1.0, 18.0)
            ]
        );
        assert_eq!(
            buckets(hour + HOUR + 11, HOUR, Some("opus")).await,
            [(hour + HOUR, 1.0, 18.0)],
            "the hour grain counts the whole bucket holding since"
        );
        assert_eq!(
            buckets(hour + HOUR + 11, HOUR, None).await,
            [(hour + HOUR, 2.0, 36.0)]
        );
        assert_eq!(buckets(hour, HOUR, Some("nope")).await, []);
        let whole: Vec<f64> = buckets(hour, HOUR, None)
            .await
            .iter()
            .map(|b| b.1)
            .collect();
        assert_eq!(whole, [3.0, 2.0]);
        let n = s.sum_since("k1", hour, Some("opus")).await.expect("sum");
        assert_eq!((n.requests, n.tokens), (3.0, 54.0));
        assert!(close(n.cost_usd, 0.502));
        let n = s
            .sum_since("k1", hour + 11, Some("opus"))
            .await
            .expect("sum");
        assert_eq!(n.requests, 2.0);
        assert!(close(n.cost_usd, 0.501));
        assert_eq!(
            s.sum_since("k1", hour, None).await.expect("sum").requests,
            5.0
        );
        // Stamps: newest `cap` done rows, ascending.
        let (_, stamps) = s
            .seed_rows("k1", hour, HOUR, Some("opus"), 2)
            .await
            .expect("seed");
        assert_eq!(stamps, [hour + 60_000 + 10, hour + HOUR + 10]);
    })
    .await;
}

/// `configured day offset controls the daily bucket on every backend`.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_configured_day_offset_cuts_the_daily_bucket() {
    for offset in [0, 420, -330] {
        each("contract_day_offset", offset, move |s| async move {
            // 23:30 UTC: the same day at UTC-5:30, the next at UTC+7.
            let at = 1_794_007_800_000;
            file(&s, vec![LogEvent::Finish(log("d", at))]).await;
            let day = omni_store::rollup::start_of_day_ms(at, offset);
            let n = match &s {
                Store::Sqlite { store, .. } => {
                    let s = store.lock().expect("lock");
                    s.connection()
                        .query_row("SELECT day FROM usage_daily", [], |r| r.get::<_, i64>(0))
                        .expect("day")
                }
                Store::Postgres(_) => {
                    let c = s_client(&s).await;
                    c.query_one("SELECT day FROM usage_daily", &[])
                        .await
                        .expect("day")
                        .get(0)
                }
            };
            assert_eq!(n, day, "offset {offset}");
        })
        .await;
    }
}

async fn s_client(s: &Store) -> omni_store::pg::PgClient {
    match s {
        Store::Postgres(pg) => pg.client().await.expect("client"),
        Store::Sqlite { .. } => unreachable!("postgres only"),
    }
}

/// `sweepPending retires own rows and a dead node's, and leaves a live node's alone`.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sweep_pending_retires_own_and_dead_rows_only() {
    each("contract_sweep", 0, |s| async move {
        let now = T + 10 * HOUR;
        let begin_as = |node: &str, id: &str| {
            let s = s.clone();
            let node = node.to_owned();
            let id = id.to_owned();
            async move {
                let w = s
                    .spawn_writer(WriterConfig {
                        node_id: node,
                        ..WriterConfig::default()
                    })
                    .expect("writer");
                assert!(w.handle().send(begin(&id, T, "fast")));
                w.close().await.expect("close");
            }
        };
        begin_as("me", "mine").await;
        begin_as("dead", "theirs").await;
        begin_as("live", "alive").await;
        // `live` heartbeats now; `dead` never did.
        s.sweep_pending("live", now).await.expect("live heartbeat");
        let swept = s.sweep_pending("me", now).await.expect("sweep");
        let mut ids: Vec<String> = swept.iter().map(|l| l.id.clone()).collect();
        ids.sort();
        assert_eq!(ids, ["mine", "theirs"]);
        assert!(swept.iter().all(|l| l.status == 499
            && l.error_code.as_deref() == Some("interrupted")
            && l.duration_ms == 0));
        // Filed through the writer, they complete and count once.
        file(&s, swept.into_iter().map(LogEvent::Finish).collect()).await;
        assert_eq!(s.sum_since("k1", 0, None).await.expect("sum").requests, 2.0);
    })
    .await;
}

/// The change probe moves when configuration changes.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_change_probe_moves_on_a_configuration_write() {
    let s = sqlite(0).await;
    // SQLite's `data_version` moves only for another connection's commits.
    let other = Store::open(
        StoreConfig::Sqlite {
            path: match &s.store {
                Store::Sqlite { path, .. } => path.clone(),
                Store::Postgres(_) => unreachable!(),
            },
        },
        0,
    )
    .await
    .expect("other");
    let before = s.store.change_version().await.expect("v");
    other.create_key(&key("k", 1)).await.expect("create");
    assert_ne!(s.store.change_version().await.expect("v"), before);
    if let Some(base) = base_url("the_change_probe_moves_on_a_configuration_write") {
        let p = postgres(&base, "probe", 0).await;
        let before = p.store.change_version().await.expect("v");
        p.store.create_key(&key("k", 1)).await.expect("create");
        assert_ne!(p.store.change_version().await.expect("v"), before);
        // A request log write is not configuration.
        let mid = p.store.change_version().await.expect("v");
        file(&p.store, vec![LogEvent::Finish(log("r", T))]).await;
        assert_eq!(p.store.change_version().await.expect("v"), mid);
        assert!(p.store.database_path().starts_with("postgres://"));
    }
}

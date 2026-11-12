//! TS ↔ Rust against one server: the frozen TS `redisCoord` (and the TS
//! session and OAuth-pending consumers over it) runs in Bun beside
//! `RedisCoord`, and each writes what the other reads or continues —
//! sessions, OAuth pending flows, leases and locks (contention between a TS
//! and a Rust holder), windows, gauges, buckets, counters, and pub/sub frames
//! in both directions.
//!
//! Needs `OMNI_TEST_REDIS_URL` and `bun` on `PATH` (override with
//! `OMNI_TEST_BUN`); skipped with a note otherwise.

mod common;

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use common::{fresh_db, redis_base, sleep_ms};
use omni_coord::{
    Coord, CoordError, Counts, ROUTING_TOPIC, RedisCoord, RedisCoordOptions, RoutingMessage,
    split_sequenced, system_clock, with_lock,
};
use serde_json::{Value, json};
use sha2::Digest;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{mpsc, oneshot};

static SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Replies awaited from the agent, by request id.
type Waiters = Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>>;

/// The TS agent process and its reply routing.
struct Ts {
    child: Child,
    stdin: ChildStdin,
    next: AtomicU64,
    pending: Waiters,
    events: mpsc::UnboundedReceiver<Value>,
}

impl Ts {
    async fn spawn(url: &str) -> Option<Self> {
        let bun = std::env::var("OMNI_TEST_BUN").unwrap_or_else(|_| "bun".to_owned());
        let agent = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/compat/agent.ts");
        let mut child = match Command::new(&bun)
            .arg(agent)
            .arg(url)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .kill_on_drop(true)
            .spawn()
        {
            Ok(child) => child,
            Err(e) => {
                eprintln!("skipped: cannot run {bun}: {e}");
                return None;
            }
        };
        let stdin = child.stdin.take().expect("stdin");
        let stdout = child.stdout.take().expect("stdout");
        let pending: Waiters = Arc::default();
        let (events_tx, events) = mpsc::unbounded_channel();
        let routes = Arc::clone(&pending);
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let Ok(msg) = serde_json::from_str::<Value>(&line) else {
                    eprintln!("agent: {line}");
                    continue;
                };
                if msg.get("event").is_some() {
                    if events_tx.send(msg).is_err() {
                        return;
                    }
                    continue;
                }
                let Some(id) = msg["id"].as_u64() else {
                    continue;
                };
                let reply = if msg["ok"] == json!(true) {
                    Ok(msg["value"].clone())
                } else {
                    Err(msg["error"].as_str().unwrap_or("").to_owned())
                };
                let waiter = routes
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .remove(&id);
                // A waiter that timed out has gone; its reply is dropped.
                if let Some(tx) = waiter
                    && tx.send(reply).is_err()
                {
                    eprintln!("agent reply {id} had no waiter");
                }
            }
        });
        let mut ts = Self {
            child,
            stdin,
            next: AtomicU64::new(1),
            pending,
            events,
        };
        // The TS coordinator connects in the background; wait for it.
        for _ in 0..100 {
            if ts.call("healthy", json!([])).await == json!(true) {
                return Some(ts);
            }
            sleep_ms(50).await;
        }
        ts.child.kill().await.expect("kill agent");
        panic!("the TS coordinator never reached the server");
    }

    async fn try_call(&mut self, op: &str, args: Value) -> Result<Value, String> {
        let id = self.next.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        self.pending
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(id, tx);
        let line = format!("{}\n", json!({ "id": id, "op": op, "args": args }));
        self.stdin
            .write_all(line.as_bytes())
            .await
            .expect("agent stdin");
        self.stdin.flush().await.expect("agent flush");
        tokio::time::timeout(Duration::from_secs(10), rx)
            .await
            .expect("agent reply in time")
            .expect("agent alive")
    }

    async fn call(&mut self, op: &str, args: Value) -> Value {
        match self.try_call(op, args).await {
            Ok(v) => v,
            Err(e) => panic!("TS {op} failed: {e}"),
        }
    }

    async fn event(&mut self) -> Value {
        tokio::time::timeout(Duration::from_secs(3), self.events.recv())
            .await
            .expect("a TS delivery in time")
            .expect("agent alive")
    }

    async fn no_event(&mut self, ms: u64) {
        if let Ok(Some(ev)) =
            tokio::time::timeout(Duration::from_millis(ms), self.events.recv()).await
        {
            panic!("unexpected TS delivery {ev}");
        }
    }

    async fn close(mut self) {
        self.try_call("close", json!([]))
            .await
            .expect("agent close");
        let exited = tokio::time::timeout(Duration::from_secs(2), self.child.wait()).await;
        assert!(
            matches!(exited, Ok(Ok(status)) if status.success()),
            "{exited:?}"
        );
    }
}

struct Pair {
    ts: Ts,
    rs: RedisCoord,
    raw: redis::aio::MultiplexedConnection,
    _db: common::Db,
}

async fn pair() -> Option<Pair> {
    let base = redis_base().or_else(|| {
        eprintln!("skipped: set OMNI_TEST_REDIS_URL to run TS↔Rust compat");
        None
    })?;
    let db = fresh_db(&base).await;
    let ts = Ts::spawn(&db.url).await?;
    let rs = RedisCoord::connect(&db.url, RedisCoordOptions::default())
        .await
        .expect("connect");
    assert!(rs.healthy());
    let raw = common::admin(&db.url).await;
    Some(Pair {
        ts,
        rs,
        raw,
        _db: db,
    })
}

fn now_ms() -> f64 {
    system_clock()()
}

fn sha256_hex(s: &str) -> String {
    sha2::Sha256::digest(s.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

async fn pttl(raw: &mut redis::aio::MultiplexedConnection, key: &str) -> i64 {
    redis::cmd("PTTL")
        .arg(key)
        .query_async(raw)
        .await
        .expect("pttl")
}

// --- sessions -------------------------------------------------------------

/// A TS login's session is found by Rust at `sess:admin:<sha256hex(token)>`
/// with TS's JSON value and TTL, and survives a Rust rewrite; a Rust-written
/// session verifies in TS; Rust's prefix delete ends TS sessions, and TS's
/// `invalidateSessions` ends Rust-written ones.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sessions_written_by_either_runtime_are_read_and_ended_by_the_other() {
    let _serial = SERIAL.lock().await;
    let Some(mut p) = pair().await else { return };
    p.ts.call("auth.setPassword", json!(["correct horse battery staple"]))
        .await;
    let token =
        p.ts.call("auth.login", json!(["correct horse battery staple"]))
            .await;
    let token = token.as_str().expect("a session token").to_owned();
    let key = format!("sess:admin:{}", sha256_hex(&token));

    let raw =
        p.rs.kv_get(&key)
            .await
            .expect("kv")
            .expect("TS session visible to Rust");
    let session: Value = serde_json::from_str(&raw).expect("TS session JSON");
    assert_eq!(session["principal"], json!({ "kind": "admin" }));
    let expires = session["expiresAt"].as_f64().expect("expiresAt");
    assert!((expires - now_ms() - 3_600_000.0).abs() < 5_000.0);
    let ttl = pttl(&mut p.raw, &format!("omni:kv:{key}")).await;
    assert!((3_590_000..=3_600_000).contains(&ttl), "{ttl}");

    // Rust writes a session (its own token) in the TS format; TS verifies it.
    let rust_token = "rust-issued-token";
    let rust_key = format!("sess:viewer:{}", sha256_hex(rust_token));
    let value = json!({ "expiresAt": now_ms() + 60_000.0, "principal": { "kind": "viewer" } });
    p.rs.kv_set(&rust_key, &value.to_string(), 60_000)
        .await
        .expect("set");
    assert_eq!(
        p.ts.call("auth.verify", json!([rust_token])).await,
        json!({ "kind": "viewer" })
    );
    assert_eq!(
        p.ts.call("auth.verify", json!([token])).await,
        json!({ "kind": "admin" })
    );

    // Rust ends one kind; TS sees exactly that kind gone.
    p.rs.kv_del_prefix("sess:viewer:")
        .await
        .expect("del prefix");
    assert_eq!(
        p.ts.call("auth.verify", json!([rust_token])).await,
        Value::Null
    );
    assert_eq!(
        p.ts.call("auth.verify", json!([token])).await,
        json!({ "kind": "admin" })
    );

    // TS ends every session; Rust's are gone too.
    p.rs.kv_set(&rust_key, &value.to_string(), 60_000)
        .await
        .expect("set");
    p.ts.call("auth.invalidateSessions", json!([])).await;
    assert_eq!(p.rs.kv_get(&rust_key).await, Ok(None));
    assert_eq!(p.rs.kv_get(&key).await, Ok(None));

    // A TS logout deletes what Rust wrote under the same key.
    let again =
        p.ts.call("auth.login", json!(["correct horse battery staple"]))
            .await;
    let again = again.as_str().expect("token").to_owned();
    let again_key = format!("sess:admin:{}", sha256_hex(&again));
    assert!(p.rs.kv_get(&again_key).await.expect("kv").is_some());
    p.ts.call("auth.logout", json!([again])).await;
    assert_eq!(p.rs.kv_get(&again_key).await, Ok(None));
    p.ts.close().await;
}

// --- OAuth pending state ---------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn oauth_pending_flows_cross_both_ways() {
    let _serial = SERIAL.lock().await;
    let Some(mut p) = pair().await else { return };
    let flow = json!({
        "provider": "anthropic",
        "label": "work",
        "pending": { "kind": "pkce", "verifier": "v3r1f13r", "state": "s", "redirectUri": "http://localhost/cb" }
    });
    let id = p.ts.call("flows.put", json!([flow])).await;
    let id = id.as_str().expect("flow id").to_owned();
    let raw =
        p.rs.kv_get(&format!("oauth:pending:{id}"))
            .await
            .expect("kv")
            .expect("visible");
    assert_eq!(serde_json::from_str::<Value>(&raw).expect("json"), flow);
    let ttl = pttl(&mut p.raw, &format!("omni:kv:oauth:pending:{id}")).await;
    assert!((590_000..=600_000).contains(&ttl), "{ttl}");
    // Rust takes it (get + del); TS no longer finds it.
    p.rs.kv_del(&format!("oauth:pending:{id}"))
        .await
        .expect("del");
    assert_eq!(p.ts.call("flows.peek", json!([id])).await, Value::Null);

    // Rust puts one the way TS does; TS takes it exactly once.
    let rid = "rust-flow-id";
    p.rs.kv_set(&format!("oauth:pending:{rid}"), &flow.to_string(), 600_000)
        .await
        .expect("set");
    assert_eq!(p.ts.call("flows.peek", json!([rid])).await, flow);
    assert_eq!(p.ts.call("flows.take", json!([rid])).await, flow);
    assert_eq!(p.ts.call("flows.take", json!([rid])).await, Value::Null);
    assert_eq!(p.rs.kv_get(&format!("oauth:pending:{rid}")).await, Ok(None));
    p.ts.close().await;
}

// --- leases and locks ------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_lease_is_held_by_one_runtime_at_a_time() {
    let _serial = SERIAL.lock().await;
    let Some(mut p) = pair().await else { return };
    assert_eq!(
        p.ts.call("lease.acquire", json!(["refresh", "node-ts", 60_000]))
            .await,
        json!(true)
    );
    assert!(!p.rs.lease_acquire("refresh", "node-rs", 60_000).await);
    // Owner mismatch: Rust's release of a TS-held lease is nothing.
    p.rs.lease_release("refresh", "node-rs").await;
    assert!(!p.rs.lease_acquire("refresh", "node-rs", 60_000).await);
    // TS renews its own.
    assert_eq!(
        p.ts.call("lease.acquire", json!(["refresh", "node-ts", 60_000]))
            .await,
        json!(true)
    );
    p.ts.call("lease.release", json!(["refresh", "node-ts"]))
        .await;
    assert!(p.rs.lease_acquire("refresh", "node-rs", 100).await);
    assert_eq!(
        p.ts.call("lease.acquire", json!(["refresh", "node-ts", 60_000]))
            .await,
        json!(false)
    );
    // Expiry: the Rust lease lapses and TS takes over.
    sleep_ms(150).await;
    assert_eq!(
        p.ts.call("lease.acquire", json!(["refresh", "node-ts", 60_000]))
            .await,
        json!(true)
    );
    assert!(!p.rs.lease_acquire("refresh", "node-rs", 60_000).await);
    p.ts.close().await;
}

/// `omni:lock:refresh:<id>` / `omni:lock:seed:*`: a lock held by TS refuses
/// Rust until released (and vice versa); a Rust waiter acquires the moment
/// TS lets go; an expired holder's late release does not free the new
/// holder's lock.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn locks_contend_across_runtimes() {
    let _serial = SERIAL.lock().await;
    let Some(mut p) = pair().await else { return };
    // TS holds refresh:c1.
    assert_eq!(
        p.ts.call("mutex.hold", json!(["refresh:c1", 10_000, 1_000, 1]))
            .await,
        json!("held")
    );
    let holder: String = redis::cmd("GET")
        .arg("omni:lock:refresh:c1")
        .query_async(&mut p.raw)
        .await
        .expect("get");
    assert_eq!(holder.len(), 36, "TS token is a uuid");
    let refused =
        p.rs.lock("refresh:c1", 10_000, Duration::from_millis(120))
            .await;
    assert_eq!(
        refused,
        Err(CoordError::LockUnavailable("refresh:c1".to_owned()))
    );
    // Rust waits; TS releases mid-wait; Rust gets it.
    let rs = &p.rs;
    let waiter = async {
        with_lock(rs, "refresh:c1", 10_000, Duration::from_secs(3), || async {
            "rust ran"
        })
        .await
    };
    let release = async {
        sleep_ms(150).await;
        p.ts.call("mutex.release", json!([1])).await;
    };
    let (got, ()) = tokio::join!(waiter, release);
    assert_eq!(got, Ok("rust ran"));

    // Rust holds seed:k; TS gives up after its wait, then gets it once free.
    let token =
        p.rs.lock("seed:k", 10_000, Duration::ZERO)
            .await
            .expect("rust holds");
    let ts_try =
        p.ts.try_call("mutex.hold", json!(["seed:k", 10_000, 100, 2]))
            .await;
    assert!(ts_try.expect_err("TS refused").contains("LOCK_UNAVAILABLE"));
    p.rs.unlock(token).await;
    assert_eq!(
        p.ts.call("mutex.hold", json!(["seed:k", 10_000, 500, 3]))
            .await,
        json!("held")
    );
    p.ts.call("mutex.release", json!([3])).await;

    // Expiry and owner mismatch: a Rust lock lapses, TS takes it, and the
    // stale Rust unlock leaves TS's lock in place.
    let stale =
        p.rs.lock("refresh:c2", 100, Duration::ZERO)
            .await
            .expect("rust holds");
    sleep_ms(150).await;
    assert_eq!(
        p.ts.call("mutex.hold", json!(["refresh:c2", 10_000, 0, 4]))
            .await,
        json!("held")
    );
    p.rs.unlock(stale).await;
    let still: Option<String> = redis::cmd("GET")
        .arg("omni:lock:refresh:c2")
        .query_async(&mut p.raw)
        .await
        .expect("get");
    assert!(
        still.is_some(),
        "the TS holder's lock survived the stale unlock"
    );
    assert_eq!(
        p.rs.lock("refresh:c2", 10_000, Duration::from_millis(60))
            .await,
        Err(CoordError::LockUnavailable("refresh:c2".to_owned()))
    );
    p.ts.call("mutex.release", json!([4])).await;
    p.ts.close().await;
}

// --- limiter state -----------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn windows_and_gauges_are_one_counter_across_runtimes() {
    let _serial = SERIAL.lock().await;
    let Some(mut p) = pair().await else { return };
    let t0 = 1_700_000_000_000.0;
    let a = p.ts.call("window.claim", json!(["k", 60_000, t0])).await;
    assert_eq!(a["before"]["used"].as_f64(), Some(0.0));
    assert_eq!(a["before"]["resetAt"].as_f64(), Some(t0));
    let b = p.rs.window_claim("k", 60_000.0, t0 + 1.0).await;
    assert_eq!((b.before.used, b.before.reset_at), (1.0, t0 + 60_000.0));
    let c =
        p.ts.call("window.claim", json!(["k", 60_000, t0 + 2.0]))
            .await;
    assert_eq!(c["before"]["used"], json!(2));
    // Rust rolls back TS's stamp; TS rolls back Rust's.
    p.rs.window_rollback("k", t0).await;
    p.ts.call("window.rollback", json!(["k", t0 + 1.0])).await;
    assert_eq!(
        p.rs.window_claim("k", 60_000.0, t0 + 3.0).await.before.used,
        1.0
    );

    // Gauges: named slots from both, one count; a Rust release of a TS slot.
    assert_eq!(
        p.ts.call("gauge.acquire", json!(["load:cred", 60_000, "req-ts"]))
            .await,
        json!(0)
    );
    assert_eq!(
        p.rs.gauge_acquire("load:cred", 60_000, Some("req-rs"))
            .await,
        Ok(1)
    );
    assert_eq!(p.rs.gauge_acquire("load:other", 60_000, None).await, Ok(0));
    // Re-acquire across runtimes under one name is one slot.
    assert_eq!(
        p.rs.gauge_acquire("load:cred", 60_000, Some("req-ts"))
            .await,
        Ok(1)
    );
    assert_eq!(
        p.ts.call("gauge.read", json!(["load:cred"])).await,
        json!(2)
    );
    let snap = p.ts.call("gauge.snapshot", json!(["load:"])).await;
    assert_eq!(snap, json!({ "load:cred": 2, "load:other": 1 }));
    let rs_snap: Vec<_> = p.rs.gauge_snapshot("load:c").await.into_iter().collect();
    assert_eq!(rs_snap, vec![("load:cred".to_owned(), 2)]);
    p.rs.gauge_release("load:cred", Some("req-ts"))
        .await
        .expect("release");
    p.ts.call("gauge.renew", json!(["load:cred", "req-rs", 60_000]))
        .await;
    assert_eq!(
        p.ts.call("gauge.read", json!(["load:cred"])).await,
        json!(1)
    );
    p.ts.call("gauge.release", json!(["load:cred", null])).await;
    assert_eq!(p.rs.gauge_read("load:cred").await, 0);
    // Counters: one sequence.
    assert_eq!(p.ts.call("incr", json!(["n"])).await, json!(1));
    assert_eq!(p.rs.incr("n").await, 2);
    assert_eq!(p.ts.call("incr", json!(["n"])).await, json!(3));
    p.ts.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn buckets_seeded_by_one_runtime_are_debited_and_summed_by_the_other() {
    let _serial = SERIAL.lock().await;
    let Some(mut p) = pair().await else { return };
    let t0 = 1_700_000_000_000.0;
    let (g, w) = (3_600_000.0, 18_000_000.0);
    let row = |r: f64, t: f64, c: f64| Counts {
        requests: r,
        tokens: t,
        cost_usd: c,
    };
    // TS seeds (one row aged out), Rust debits, TS sums.
    p.ts.call(
        "buckets.seed",
        json!(["key:a:5h", g, w, t0, [[t0 - 7_200_000.0, { "requests": 3, "tokens": 300, "costUsd": 0.25 }], [t0 - 90_000_000.0, { "requests": 99, "tokens": 99, "costUsd": 99 }]]]),
    )
    .await;
    p.rs.buckets_add("key:a:5h", g, w, t0, row(1.0, 50.0, 0.1))
        .await;
    let sum =
        p.ts.call("buckets.sum", json!(["key:a:5h", g, w, t0]))
            .await;
    assert_eq!(
        sum,
        json!({ "requests": 4, "tokens": 350, "costUsd": 0.35 })
    );
    // Rust seeds, TS debits, Rust sums — fractional cost round-trips.
    p.rs.buckets_seed(
        "key:b:1w",
        g,
        w,
        t0,
        &[(t0 - 3_600_000.0, row(2.0, 20.0, 0.1))],
    )
    .await;
    p.ts.call(
        "buckets.add",
        json!(["key:b:1w", g, w, t0, { "requests": 1, "tokens": 1, "costUsd": 0.2 }]),
    )
    .await;
    let got =
        p.rs.buckets_sum("key:b:1w", g, w, t0)
            .await
            .expect("seeded");
    assert_eq!((got.requests, got.tokens), (3.0, 21.0));
    assert!((got.cost_usd - 0.3).abs() < 1e-12, "{}", got.cost_usd);
    // Unseeded stays null in both, and a debit on it is dropped by both.
    p.rs.buckets_add("key:c", g, w, t0, row(1.0, 1.0, 1.0))
        .await;
    p.ts.call(
        "buckets.add",
        json!(["key:c", g, w, t0, { "requests": 1, "tokens": 1, "costUsd": 1 }]),
    )
    .await;
    assert_eq!(
        p.ts.call("buckets.sum", json!(["key:c", g, w, t0])).await,
        Value::Null
    );
    assert_eq!(p.rs.buckets_sum("key:c", g, w, t0).await, None);
    // Same hash layout: the fields either runtime wrote.
    let fields: Vec<String> = redis::cmd("HKEYS")
        .arg("omni:b:key:b:1w")
        .query_async(&mut p.raw)
        .await
        .expect("hkeys");
    let mut fields = fields;
    fields.sort();
    // Hour buckets: floor(start / grain) * grain, the same in Lua, TS and Rust.
    let start = 1_699_995_600_000_u64;
    assert_eq!(
        fields,
        vec![
            format!("{}:c", start),
            format!("{}:r", start),
            format!("{}:t", start),
            format!("{}:c", start + 3_600_000),
            format!("{}:r", start + 3_600_000),
            format!("{}:t", start + 3_600_000),
            "seeded".to_owned(),
        ]
    );
    p.ts.close().await;
}

// --- pub/sub -----------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn pubsub_frames_cross_both_ways_in_the_ts_envelope() {
    let _serial = SERIAL.lock().await;
    let Some(mut p) = pair().await else { return };
    let seen = Arc::new(Mutex::new(Vec::<(String, String)>::new()));
    let s = Arc::clone(&seen);
    let _sub = p.rs.subscribe(
        "*",
        Arc::new(move |t, pl| {
            if t != omni_coord::RECONNECTED_TOPIC {
                s.lock().expect("seen").push((t.to_owned(), pl.to_owned()));
            }
        }),
    );
    p.ts.call("pubsub.subscribe", json!(["routing", 1])).await;
    p.ts.call("pubsub.subscribe", json!(["broadcast", 2])).await;

    // TS → Rust: a routing change exactly as `app.ts` publishes it.
    let change = json!({ "kind": "health", "credentialId": "c1", "rows": [{ "a": 1 }] });
    let ts_msg = json!({ "from": "node-ts", "change": change }).to_string();
    p.ts.call("pubsub.publish", json!([ROUTING_TOPIC, ts_msg]))
        .await;
    // The TS process hears its own publish.
    let ev = p.ts.event().await;
    assert_eq!(
        (ev["topic"].as_str(), ev["payload"].as_str()),
        (Some("routing"), Some(ts_msg.as_str()))
    );
    sleep_ms(100).await;
    let got = std::mem::take(&mut *seen.lock().expect("seen"));
    assert_eq!(got.len(), 1);
    let parsed: RoutingMessage = serde_json::from_str(&got[0].1).expect("routing message");
    assert_eq!(parsed.from, "node-ts");
    assert_eq!(parsed.change, change);

    // Rust → TS, payload with characters JSON must escape.
    let rs_msg = serde_json::to_string(&RoutingMessage {
        from: "node-rs".to_owned(),
        change: json!({ "kind": "config", "note": "line\nbreak \"q\" é \u{1}" }),
    })
    .expect("json");
    p.rs.publish(ROUTING_TOPIC, &rs_msg).await;
    let ev = p.ts.event().await;
    assert_eq!(ev["sub"], json!(1));
    assert_eq!(ev["payload"].as_str(), Some(rs_msg.as_str()));

    // Sequenced: one `omni:seq:<key>` counter shared by both runtimes, and
    // each side reads the other's `<seq>:<payload>`.
    let n1 =
        p.ts.call(
            "pubsub.publishSequenced",
            json!(["broadcast", "from-ts", "seq:stream:x"]),
        )
        .await;
    assert_eq!(n1, json!(1));
    let ev = p.ts.event().await;
    assert_eq!(ev["payload"], json!("1:from-ts"));
    let n2 =
        p.rs.publish_sequenced("broadcast", "from-rs", "seq:stream:x")
            .await;
    assert_eq!(n2, 2);
    let ev = p.ts.event().await;
    assert_eq!(ev["payload"], json!("2:from-rs"));
    sleep_ms(100).await;
    let got = std::mem::take(&mut *seen.lock().expect("seen"));
    let seqs: Vec<_> = got
        .iter()
        .filter(|(t, _)| t == "broadcast")
        .map(|(_, pl)| split_sequenced(pl).map(|(n, s)| (n, s.to_owned())))
        .collect();
    assert_eq!(
        seqs,
        vec![
            Some((1, "from-ts".to_owned())),
            Some((2, "from-rs".to_owned()))
        ]
    );
    // A topic nobody on TS subscribed to is not delivered there.
    p.rs.publish("console:read", "x").await;
    p.ts.no_event(150).await;
    p.ts.close().await;
}

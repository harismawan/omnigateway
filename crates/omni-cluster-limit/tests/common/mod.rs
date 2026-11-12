//! Shared harness: the server from the environment, leased logical
//! databases, a movable clock, the frozen-TS limiter agent, and usage
//! sources.
#![allow(dead_code)]

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, LazyLock, Mutex, PoisonError};
use std::time::Duration;

use async_trait::async_trait;
use omni_cluster_limit::{ClusterLimiter, ClusterLimiterOptions, SeedRead, UsageSource, scripts};
use omni_coord::{Clock, Counts, RedisCoord, RedisCoordOptions};
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{Semaphore, SemaphorePermit, oneshot};

pub const T0: f64 = 1_700_000_000_000.0;
pub const HOUR: f64 = 3_600_000.0;

/// `OMNI_TEST_REDIS_URL` without a trailing `/<db>`. With
/// `OMNI_TEST_REQUIRE_REDIS=1` a missing server fails instead of skipping.
pub fn redis_base() -> Option<String> {
    let Ok(url) = std::env::var("OMNI_TEST_REDIS_URL") else {
        assert!(
            std::env::var_os("OMNI_TEST_REQUIRE_REDIS").is_none(),
            "OMNI_TEST_REQUIRE_REDIS is set but OMNI_TEST_REDIS_URL is not"
        );
        eprintln!("skipped: OMNI_TEST_REDIS_URL not set");
        return None;
    };
    Some(match url.rsplit_once('/') {
        Some((head, tail)) if !tail.is_empty() && tail.bytes().all(|b| b.is_ascii_digit()) => {
            head.to_owned()
        }
        _ => url.trim_end_matches('/').to_owned(),
    })
}

static POOL: LazyLock<(Semaphore, Mutex<Vec<u8>>)> =
    LazyLock::new(|| (Semaphore::new(14), Mutex::new((1..=14).collect())));

/// A logical database held for the life of the guard, flushed at lease.
pub struct Db {
    pub url: String,
    pub index: i64,
    number: u8,
    _permit: SemaphorePermit<'static>,
}

impl Drop for Db {
    fn drop(&mut self) {
        POOL.1
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push(self.number);
    }
}

pub async fn fresh_db(base: &str) -> Db {
    let permit = POOL.0.acquire().await.expect("db pool");
    let number = POOL
        .1
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .pop()
        .expect("a permit implies a free db");
    let url = format!("{base}/{number}");
    flush(&url).await;
    Db {
        url,
        index: i64::from(number),
        number,
        _permit: permit,
    }
}

pub async fn flush(url: &str) {
    let mut conn = admin(url).await;
    let _: () = redis::cmd("FLUSHDB")
        .query_async(&mut conn)
        .await
        .expect("flushdb");
}

pub async fn admin(url: &str) -> redis::aio::MultiplexedConnection {
    redis::Client::open(url)
        .expect("url")
        .get_multiplexed_async_connection()
        .await
        .expect("admin connect")
}

pub async fn sleep_ms(ms: u64) {
    tokio::time::sleep(Duration::from_millis(ms)).await;
}

/// A clock a test moves by hand.
#[derive(Clone)]
pub struct ManualClock(Arc<AtomicU64>);

impl ManualClock {
    pub fn at(t: f64) -> Self {
        Self(Arc::new(AtomicU64::new(t.to_bits())))
    }
    pub fn get(&self) -> f64 {
        f64::from_bits(self.0.load(Ordering::SeqCst))
    }
    pub fn set(&self, t: f64) {
        self.0.store(t.to_bits(), Ordering::SeqCst);
    }
    pub fn clock(&self) -> Clock {
        let me = self.clone();
        Arc::new(move || me.get())
    }
}

pub async fn coord(url: &str, clock: Clock) -> Arc<RedisCoord> {
    Arc::new(
        RedisCoord::connect(
            url,
            RedisCoordOptions {
                now: clock,
                extra_scripts: scripts::all(),
                ..RedisCoordOptions::default()
            },
        )
        .await
        .expect("connect"),
    )
}

pub fn limiter(
    coord: &Arc<RedisCoord>,
    usage: Arc<dyn UsageSource>,
    clock: Clock,
) -> ClusterLimiter {
    ClusterLimiter::new(
        Arc::clone(coord),
        usage,
        ClusterLimiterOptions {
            clock,
            ..ClusterLimiterOptions::default()
        },
    )
}

pub fn limits(json: &str) -> omni_ratelimit::limits::LimitConfig {
    omni_ratelimit::limits::parse_limits(json).expect("limits")
}

// --- usage sources -----------------------------------------------------------

/// `(key, model, at, tokens, cost)`.
pub type Row = (String, String, f64, f64, f64);

/// A model of the store: rows committed one transaction each, numbered
/// from 1 (`commit`), and a seed read that returns counts, ranges and a
/// `pg_snapshot`-format snapshot of exactly the rows it saw. Counts reads;
/// can fail, be slow, or block on a gate.
#[derive(Default)]
pub struct MemUsage {
    /// `(row, its commit id)`.
    pub rows: Mutex<Vec<(Row, u64)>>,
    next_commit: AtomicU64,
    /// Seed reads made.
    pub sums: AtomicUsize,
    /// Kept for the zero-store-call assertions (no other read exists).
    pub oldest: AtomicUsize,
    pub fail: std::sync::atomic::AtomicBool,
    pub delay_ms: AtomicU64,
    /// When set, a seed read signals `entered` and waits for `release`
    /// (after taking its snapshot, as a REPEATABLE READ transaction would).
    pub gate: Mutex<Option<Gate>>,
}

/// Holds a seed read open until the test lets it go.
pub struct Gate {
    pub entered: Arc<tokio::sync::Notify>,
    pub release: Arc<tokio::sync::Semaphore>,
}

impl MemUsage {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }
    /// Every store read made so far.
    pub fn calls(&self) -> usize {
        self.sums.load(Ordering::SeqCst) + self.oldest.load(Ordering::SeqCst)
    }
    /// Commits one row in its own transaction; returns its commit id.
    pub fn row(&self, key: &str, model: &str, at: f64, tokens: f64, cost: f64) -> String {
        let c = self.next_commit.fetch_add(1, Ordering::SeqCst) + 1;
        self.rows
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push(((key.into(), model.into(), at, tokens, cost), c));
        c.to_string()
    }
    /// Arms a gate on the next seed reads; returns (entered, release).
    pub fn gate(&self) -> (Arc<tokio::sync::Notify>, Arc<tokio::sync::Semaphore>) {
        let entered = Arc::new(tokio::sync::Notify::new());
        let release = Arc::new(tokio::sync::Semaphore::new(0));
        *self.gate.lock().unwrap_or_else(PoisonError::into_inner) = Some(Gate {
            entered: Arc::clone(&entered),
            release: Arc::clone(&release),
        });
        (entered, release)
    }
}

/// Aggregates rows into `SeedRead` (counts per bucket, ranges per bucket of
/// the row's own `at`), as Postgres `sumBuckets` and the range query would.
pub fn seed_read_of<'a>(
    rows: impl Iterator<Item = &'a Row>,
    since_ms: f64,
    grain_ms: f64,
    snapshot: String,
) -> SeedRead {
    let mut by: std::collections::BTreeMap<i64, Counts> = Default::default();
    let mut ranges: std::collections::BTreeMap<i64, (f64, f64)> = Default::default();
    for (_, _, at, t, c) in rows {
        if *at < since_ms {
            continue;
        }
        #[allow(clippy::cast_possible_truncation)]
        let b = ((at / grain_ms).floor() * grain_ms) as i64;
        by.entry(b).or_default().add(Counts {
            requests: 1.0,
            tokens: *t,
            cost_usd: *c,
        });
        let e = ranges.entry(b).or_insert((*at, *at));
        e.0 = e.0.min(*at);
        e.1 = e.1.max(*at);
    }
    #[allow(clippy::cast_precision_loss)]
    SeedRead {
        rows: by.into_iter().map(|(b, c)| (b as f64, c)).collect(),
        ranges: ranges
            .into_iter()
            .map(|(b, (lo, hi))| (b as f64, lo, hi))
            .collect(),
        snapshot,
    }
}

#[async_trait]
impl UsageSource for MemUsage {
    async fn seed_read(
        &self,
        key_id: &str,
        since_ms: f64,
        grain_ms: f64,
        model: Option<&str>,
    ) -> Result<SeedRead, String> {
        self.sums.fetch_add(1, Ordering::SeqCst);
        // The snapshot: every commit so far (xmin = xmax = next).
        let (rows, next) = {
            let all = self.rows.lock().unwrap_or_else(PoisonError::into_inner);
            let rows: Vec<Row> = all
                .iter()
                .filter(|(r, _)| r.0 == key_id && model.is_none_or(|m| m == r.1))
                .map(|(r, _)| r.clone())
                .collect();
            (rows, self.next_commit.load(Ordering::SeqCst) + 1)
        };
        let gate = self
            .gate
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .as_ref()
            .map(|g| (Arc::clone(&g.entered), Arc::clone(&g.release)));
        if let Some((entered, release)) = gate {
            entered.notify_waiters();
            entered.notify_one();
            let permit = release.acquire().await.map_err(|e| e.to_string())?;
            permit.forget();
        }
        let delay = self.delay_ms.load(Ordering::SeqCst);
        if delay > 0 {
            sleep_ms(delay).await;
        }
        if self.fail.load(Ordering::SeqCst) {
            return Err("store down".into());
        }
        Ok(seed_read_of(
            rows.iter(),
            since_ms,
            grain_ms,
            format!("{next}:{next}:"),
        ))
    }
}

/// The TS agent's store: both runtimes judge the same rows. Each row the
/// agent appends is its own commit (numbered from 1); its seed read reports
/// the matching snapshot.
pub struct AgentUsage(pub Arc<Ts>);

#[async_trait]
impl UsageSource for AgentUsage {
    async fn seed_read(
        &self,
        key_id: &str,
        since_ms: f64,
        grain_ms: f64,
        model: Option<&str>,
    ) -> Result<SeedRead, String> {
        let v = self
            .0
            .try_call("usage.seedRead", json!([key_id, since_ms, grain_ms, model]))
            .await?;
        let nums = |k: &str| -> Vec<Vec<f64>> {
            v[k].as_array()
                .expect("array")
                .iter()
                .map(|r| {
                    r.as_array()
                        .expect("row")
                        .iter()
                        .map(|x| x.as_f64().expect("n"))
                        .collect()
                })
                .collect()
        };
        Ok(SeedRead {
            rows: nums("rows")
                .into_iter()
                .map(|r| {
                    (
                        r[0],
                        Counts {
                            requests: r[1],
                            tokens: r[2],
                            cost_usd: r[3],
                        },
                    )
                })
                .collect(),
            ranges: nums("ranges")
                .into_iter()
                .map(|r| (r[0], r[1], r[2]))
                .collect(),
            snapshot: v["snapshot"].as_str().expect("snapshot").to_owned(),
        })
    }
}

// --- the frozen TS limiter, in Bun -------------------------------------------

type Waiters = Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>>;

pub struct Ts {
    child: tokio::sync::Mutex<Child>,
    stdin: tokio::sync::Mutex<ChildStdin>,
    next: AtomicU64,
    pending: Waiters,
}

impl Ts {
    /// The agent against `url`. Fails (never skips) when Bun cannot run:
    /// the differential has no meaning without its oracle.
    pub async fn spawn(url: &str) -> Arc<Self> {
        let bun = std::env::var("OMNI_TEST_BUN").unwrap_or_else(|_| "bun".to_owned());
        let agent = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/agent/limiter.ts");
        let mut child = Command::new(&bun)
            .arg(agent)
            .arg(url)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .kill_on_drop(true)
            .spawn()
            .unwrap_or_else(|e| panic!("mandatory TS oracle: cannot run {bun}: {e}"));
        let stdin = child.stdin.take().expect("stdin");
        let stdout = child.stdout.take().expect("stdout");
        let pending: Waiters = Arc::default();
        let routes = Arc::clone(&pending);
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let Ok(msg) = serde_json::from_str::<Value>(&line) else {
                    eprintln!("agent: {line}");
                    continue;
                };
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
                if let Some(tx) = waiter {
                    let _sent = tx.send(reply).is_ok();
                }
            }
        });
        let ts = Arc::new(Self {
            child: tokio::sync::Mutex::new(child),
            stdin: tokio::sync::Mutex::new(stdin),
            next: AtomicU64::new(1),
            pending,
        });
        for _ in 0..100 {
            if ts.call("healthy", json!([])).await == json!(true) {
                return ts;
            }
            sleep_ms(50).await;
        }
        panic!("the TS coordinator never reached the server");
    }

    pub async fn try_call(&self, op: &str, args: Value) -> Result<Value, String> {
        let id = self.next.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        self.pending
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(id, tx);
        let line = format!("{}\n", json!({ "id": id, "op": op, "args": args }));
        {
            let mut stdin = self.stdin.lock().await;
            stdin.write_all(line.as_bytes()).await.expect("agent stdin");
            stdin.flush().await.expect("agent flush");
        }
        tokio::time::timeout(Duration::from_secs(20), rx)
            .await
            .expect("agent reply in time")
            .expect("agent alive")
    }

    pub async fn call(&self, op: &str, args: Value) -> Value {
        match self.try_call(op, args).await {
            Ok(v) => v,
            Err(e) => panic!("TS {op} failed: {e}"),
        }
    }

    pub async fn close(&self) {
        let _closed = self.try_call("close", json!([])).await.is_ok();
        let mut child = self.child.lock().await;
        let _exited = tokio::time::timeout(Duration::from_secs(2), child.wait()).await;
    }
}

// --- rendering ---------------------------------------------------------------

pub fn headroom_json(h: &omni_ratelimit::HeadroomByDimension) -> Value {
    let mut m = serde_json::Map::new();
    for (name, entry) in [
        ("requests", h.requests),
        ("tokens", h.tokens),
        ("spend", h.spend),
    ] {
        if let Some(e) = entry {
            m.insert(
                name.into(),
                json!({ "window": e.window.as_str(), "limit": e.limit, "used": e.used,
                        "remaining": e.remaining, "resetAt": e.reset_at }),
            );
        }
    }
    Value::Object(m)
}

pub fn outcome_json<T>(
    r: &Result<T, omni_cluster_limit::RateLimitExceeded>,
    ok: impl Fn(&T) -> Value,
) -> Value {
    match r {
        Ok(a) => json!({ "ok": ok(a) }),
        Err(e) => {
            json!({ "refused": { "retryAfterMs": e.retry_after_ms, "headroom": headroom_json(&e.headroom) } })
        }
    }
}

/// JS-number-normalized rendering with object keys sorted, so `5` and `5.0`
/// compare equal and so does `{tokens, spend}` against `{spend, tokens}`
/// (TS's headroom object gains a model scope's dimension after the key-wide
/// ones; headers read entries by name, never by order).
pub fn js(v: &Value) -> String {
    fn sorted(v: &Value) -> Value {
        match v {
            Value::Object(m) => {
                let mut keys: Vec<&String> = m.keys().collect();
                keys.sort();
                Value::Object(
                    keys.into_iter()
                        .map(|k| (k.clone(), sorted(&m[k])))
                        .collect(),
                )
            }
            Value::Array(a) => Value::Array(a.iter().map(sorted).collect()),
            other => other.clone(),
        }
    }
    omni_ir::jsjson::to_string(&sorted(v))
}

// --- state dumps -------------------------------------------------------------

/// Every key in a database, normalized so two runtimes' states compare:
/// windows as their scores (members carry a random uuid), gauges as their
/// expiry scores (named holders are random), bucket hashes exactly, sets as
/// sorted members, plus whether a TTL is set. Keys for which `skip` answers
/// true are left out.
pub async fn dump(
    url: &str,
    skip: &dyn Fn(&str) -> bool,
) -> std::collections::BTreeMap<String, Value> {
    let mut conn = admin(url).await;
    let keys: Vec<String> = redis::cmd("KEYS")
        .arg("*")
        .query_async(&mut conn)
        .await
        .expect("keys");
    let mut out = std::collections::BTreeMap::new();
    for k in keys {
        if skip(&k) {
            continue;
        }
        let ty: String = redis::cmd("TYPE")
            .arg(&k)
            .query_async(&mut conn)
            .await
            .expect("type");
        let pttl: i64 = redis::cmd("PTTL")
            .arg(&k)
            .query_async(&mut conn)
            .await
            .expect("pttl");
        let v = match ty.as_str() {
            "zset" => {
                let pairs: Vec<(String, f64)> = redis::cmd("ZRANGE")
                    .arg(&k)
                    .arg(0)
                    .arg(-1)
                    .arg("WITHSCORES")
                    .query_async(&mut conn)
                    .await
                    .expect("zrange");
                json!(pairs.into_iter().map(|p| p.1).collect::<Vec<_>>())
            }
            "hash" => {
                // In the server's iteration order: for the small (listpack)
                // hashes these are, insertion order — so field order is
                // compared too, not just content.
                let h: Vec<(String, String)> = redis::cmd("HGETALL")
                    .arg(&k)
                    .query_async(&mut conn)
                    .await
                    .expect("hgetall");
                Value::Array(h.into_iter().map(|(f, v)| json!([f, v])).collect())
            }
            "set" => {
                let mut s: Vec<String> = redis::cmd("SMEMBERS")
                    .arg(&k)
                    .query_async(&mut conn)
                    .await
                    .expect("smembers");
                s.sort();
                json!(s)
            }
            other => json!(format!("<{other}>")),
        };
        out.insert(k, json!({ "v": v, "ttl": pttl > 0 }));
    }
    out
}

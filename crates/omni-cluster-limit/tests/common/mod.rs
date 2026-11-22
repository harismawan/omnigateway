//! Shared harness: the server from the environment, leased logical
//! databases, a movable clock, and usage sources.
#![allow(dead_code)]

use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, LazyLock, Mutex, PoisonError};
use std::time::Duration;

use async_trait::async_trait;
use omni_cluster_limit::{ClusterLimiter, ClusterLimiterOptions, SeedRead, UsageSource, scripts};
use omni_coord::{Clock, Counts, RedisCoord, RedisCoordOptions};
use tokio::sync::{Semaphore, SemaphorePermit};

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
    /// Commits several rows in one transaction; returns its commit id.
    pub fn rows_in_one_commit(&self, rows: &[(&str, &str, f64, f64, f64)]) -> String {
        let c = self.next_commit.fetch_add(1, Ordering::SeqCst) + 1;
        let mut all = self.rows.lock().unwrap_or_else(PoisonError::into_inner);
        for (k, m, at, t, cost) in rows {
            all.push((((*k).into(), (*m).into(), *at, *t, *cost), c));
        }
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

// --- rendering ---------------------------------------------------------------

// --- state dumps -------------------------------------------------------------

// --- direct script calls -------------------------------------------------------

/// `SEED_INSTALL` of an empty picture (`seeded 1` only) for `lim:<subject>:5h`,
/// as another replica holding the lock under `token` would, with
/// `snapshot` and the selection boundary `since`.
pub async fn install_5h(
    c: &RedisCoord,
    subject: &str,
    token: &str,
    snapshot: &str,
    since: f64,
) -> redis::Value {
    c.remote()
        .eval(
            &scripts::SEED_INSTALL,
            &[
                format!("omni:b:lim:{subject}:5h"),
                format!("omni:b:lim:{subject}:5h:meta"),
                format!("omni:lock:seed:lim:{subject}:5h"),
            ],
            &[
                token.to_owned(),
                "36000000".into(),
                snapshot.to_owned(),
                "60000".into(),
                js_num(since),
                "1".into(),
                "seeded".into(),
                "1".into(),
            ],
        )
        .await
        .expect("install")
}

/// Takes `omni:lock:seed:lim:<subject>:5h` under `token`.
pub async fn hold_lock_5h(url: &str, subject: &str, token: &str) {
    let mut conn = admin(url).await;
    let _: () = redis::cmd("SET")
        .arg(format!("omni:lock:seed:lim:{subject}:5h"))
        .arg(token)
        .arg("PX")
        .arg(60_000)
        .query_async(&mut conn)
        .await
        .expect("lock");
}

/// JS `String(n)` for the integral values tests send.
pub fn js_num(n: f64) -> String {
    if n.fract() == 0.0 {
        format!("{n:.0}")
    } else {
        n.to_string()
    }
}

/// `CLIENT PAUSE <ms> WRITE` on `url`, ended by [`Paused::end`] — or, if the
/// test panics first, on drop (best effort), so a failure cannot leave the
/// shared server paused for the tests after it.
///
/// A pause is server-wide: it holds every client's writes, including the
/// other tests sharing the server. So pauses are exclusive across *all*
/// test binaries (an OS file lock, `std::fs::File::lock`), and every test
/// that is sensitive to write latency takes the shared side of the same
/// lock ([`quiet`]).
pub struct Paused {
    url: String,
    ended: bool,
    _exclusive: std::fs::File,
}

fn pause_lock_file() -> std::fs::File {
    let path = std::env::temp_dir().join("omni-cluster-limit-pause.lock");
    std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(path)
        .expect("pause lock file")
}

/// Holds the shared side of the pause lock: no `CLIENT PAUSE` (from any
/// test binary) runs while it is held. For tests whose assertions depend
/// on writes not being held (lock waits, timeouts).
pub async fn quiet() -> std::fs::File {
    tokio::task::spawn_blocking(|| {
        let f = pause_lock_file();
        f.lock_shared().expect("shared pause lock");
        f
    })
    .await
    .expect("lock task")
}

impl Paused {
    pub async fn start(url: &str, ms: u64) -> Self {
        let exclusive = tokio::task::spawn_blocking(|| {
            let f = pause_lock_file();
            f.lock().expect("exclusive pause lock");
            f
        })
        .await
        .expect("lock task");
        let mut conn = admin(url).await;
        let _: () = redis::cmd("CLIENT")
            .arg("PAUSE")
            .arg(ms)
            .arg("WRITE")
            .query_async(&mut conn)
            .await
            .expect("pause");
        Self {
            url: url.to_owned(),
            ended: false,
            _exclusive: exclusive,
        }
    }

    pub async fn end(mut self) {
        unpause(&self.url).await;
        self.ended = true;
    }
}

async fn unpause(url: &str) {
    let mut conn = admin(url).await;
    let _: () = redis::cmd("CLIENT")
        .arg("UNPAUSE")
        .query_async(&mut conn)
        .await
        .expect("unpause");
}

impl Drop for Paused {
    fn drop(&mut self) {
        if !self.ended {
            let url = self.url.clone();
            // A panicking test: unpause from a fresh thread (the runtime may
            // be shutting down).
            let _joined = std::thread::spawn(move || {
                if let Ok(rt) = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                {
                    rt.block_on(unpause(&url));
                }
            })
            .join()
            .is_ok();
        }
    }
}

//! Shared test harness: a movable clock, the Redis URL from the environment,
//! and per-test logical databases.
#![allow(dead_code)]

use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, LazyLock, Mutex, PoisonError};

use omni_coord::Clock;
use tokio::sync::{Semaphore, SemaphorePermit};

pub const T0: f64 = 1_700_000_000_000.0;

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
    pub fn advance(&self, ms: f64) {
        self.set(self.get() + ms);
    }
    pub fn clock(&self) -> Clock {
        let me = self.clone();
        Arc::new(move || me.get())
    }
}

/// `OMNI_TEST_REDIS_URL`, without a trailing `/<db>`. Tests that need a
/// server return early (and say so) without it, as the TS suite skips.
///
/// With `OMNI_TEST_REQUIRE_REDIS=1` a missing server is a failure, not a
/// skip, so a run that claims Redis coverage cannot pass without it.
pub fn redis_base() -> Option<String> {
    let Ok(url) = std::env::var("OMNI_TEST_REDIS_URL") else {
        assert!(
            std::env::var_os("OMNI_TEST_REQUIRE_REDIS").is_none(),
            "OMNI_TEST_REQUIRE_REDIS is set but OMNI_TEST_REDIS_URL is not"
        );
        return None;
    };
    let trimmed = match url.rsplit_once('/') {
        Some((head, tail)) if !tail.is_empty() && tail.bytes().all(|b| b.is_ascii_digit()) => {
            head.to_owned()
        }
        _ => url.trim_end_matches('/').to_owned(),
    };
    Some(trimmed)
}

/// Logical databases 1..=12, leased one per live test. Cargo runs tests in
/// parallel, and a test that flushed a database another test was still
/// using would erase that test's keys mid-assertion (observed: a held gauge
/// reading 0). 0 and 13..=15 stay free for ad-hoc use.
static POOL: LazyLock<(Semaphore, Mutex<Vec<u8>>)> =
    LazyLock::new(|| (Semaphore::new(12), Mutex::new((1..=12).collect())));

/// A logical database held for the life of the guard.
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

/// Leases a database and flushes it.
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

/// Counter for unique names across tests sharing a server.
pub fn unique(prefix: &str) -> String {
    static N: AtomicUsize = AtomicUsize::new(0);
    format!(
        "{prefix}-{}-{}",
        std::process::id(),
        N.fetch_add(1, Ordering::SeqCst)
    )
}

pub async fn flush(url: &str) {
    let client = redis::Client::open(url).expect("url");
    let mut conn = client
        .get_multiplexed_async_connection()
        .await
        .expect("connect for flush");
    let _: () = redis::cmd("FLUSHDB")
        .query_async(&mut conn)
        .await
        .expect("flushdb");
}

/// A plain connection, for poking the server from a test.
pub async fn admin(url: &str) -> redis::aio::MultiplexedConnection {
    redis::Client::open(url)
        .expect("url")
        .get_multiplexed_async_connection()
        .await
        .expect("admin connect")
}

/// Kills every client connection selected on database `db` except `keep`'s.
/// What a dropped TCP connection looks like to the coordinator, scoped so
/// that tests on other databases are not disturbed.
pub async fn kill_clients_on_db(conn: &mut redis::aio::MultiplexedConnection, db: i64) -> usize {
    let me: i64 = redis::cmd("CLIENT")
        .arg("ID")
        .query_async(conn)
        .await
        .expect("client id");
    let list: String = redis::cmd("CLIENT")
        .arg("LIST")
        .query_async(conn)
        .await
        .expect("client list");
    let mut killed = 0;
    for line in list.lines() {
        let field = |name: &str| {
            line.split(' ')
                .find_map(|kv| kv.strip_prefix(name).and_then(|v| v.strip_prefix('=')))
                .map(str::to_owned)
        };
        let (Some(id), Some(on)) = (field("id"), field("db")) else {
            continue;
        };
        let (Ok(id), Ok(on)) = (id.parse::<i64>(), on.parse::<i64>()) else {
            continue;
        };
        if on == db && id != me {
            // A client that already went is not an error here.
            let gone: redis::RedisResult<i64> = redis::cmd("CLIENT")
                .arg("KILL")
                .arg("ID")
                .arg(id)
                .query_async(conn)
                .await;
            if gone.is_ok() {
                killed += 1;
            }
        }
    }
    killed
}

pub async fn sleep_ms(ms: u64) {
    tokio::time::sleep(std::time::Duration::from_millis(ms)).await;
}

/// `host:port` of a `redis://host:port` base URL.
pub fn host_port(base: &str) -> String {
    base.trim_start_matches("redis://")
        .split('/')
        .next()
        .unwrap_or_default()
        .to_owned()
}

/// A TCP proxy in front of the server whose *established* connections a
/// test can blackhole — still open, nothing forwarded either way — while new
/// connections keep working. The failure an RST or a server-wide pause does
/// not produce: one socket that is silently dead.
pub struct Proxy {
    pub port: u16,
    conns: Arc<Mutex<Vec<Arc<std::sync::atomic::AtomicBool>>>>,
    tasks: Arc<Mutex<Vec<tokio::task::JoinHandle<()>>>>,
}

impl Proxy {
    pub async fn start(target: &str) -> Self {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind proxy");
        let port = listener.local_addr().expect("addr").port();
        let conns: Arc<Mutex<Vec<Arc<std::sync::atomic::AtomicBool>>>> = Arc::default();
        let tasks: Arc<Mutex<Vec<tokio::task::JoinHandle<()>>>> = Arc::default();
        let target = target.to_owned();
        let (c, t) = (Arc::clone(&conns), Arc::clone(&tasks));
        let accept = tokio::spawn(async move {
            while let Ok((client, _)) = listener.accept().await {
                let Ok(server) = tokio::net::TcpStream::connect(&target).await else {
                    continue;
                };
                let frozen = Arc::new(std::sync::atomic::AtomicBool::new(false));
                c.lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .push(Arc::clone(&frozen));
                let (cr, cw) = client.into_split();
                let (sr, sw) = server.into_split();
                let up = tokio::spawn(pump(cr, sw, Arc::clone(&frozen)));
                let down = tokio::spawn(pump(sr, cw, frozen));
                t.lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .extend([up, down]);
            }
        });
        tasks
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push(accept);
        Self { port, conns, tasks }
    }

    /// Blackholes every connection established so far. Returns how many.
    pub fn freeze_existing(&self) -> usize {
        let conns = self.conns.lock().unwrap_or_else(PoisonError::into_inner);
        for frozen in conns.iter() {
            frozen.store(true, Ordering::SeqCst);
        }
        conns.len()
    }

    pub fn connections(&self) -> usize {
        self.conns
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .len()
    }
}

impl Drop for Proxy {
    fn drop(&mut self) {
        for task in self
            .tasks
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .drain(..)
        {
            task.abort();
        }
    }
}

/// Copies one direction until frozen; frozen, it swallows everything and
/// never closes either half, so the peer sees an open, silent socket.
async fn pump(
    mut from: tokio::net::tcp::OwnedReadHalf,
    mut to: tokio::net::tcp::OwnedWriteHalf,
    frozen: Arc<std::sync::atomic::AtomicBool>,
) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let mut buf = vec![0_u8; 16 * 1024];
    loop {
        let n = match from.read(&mut buf).await {
            Ok(0) | Err(_) => break,
            Ok(n) => n,
        };
        if frozen.load(Ordering::SeqCst) {
            continue;
        }
        if to.write_all(&buf[..n]).await.is_err() {
            break;
        }
    }
    if frozen.load(Ordering::SeqCst) {
        // Hold the write half open (dropping it would send a FIN).
        std::future::pending::<()>().await;
    }
    drop(to);
}

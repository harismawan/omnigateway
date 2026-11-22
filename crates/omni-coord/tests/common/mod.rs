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
/// server return early (and say so) without it.
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

/// Wait for the listener's startup PING before testing the command queue.
/// Call before using the command connection, with the periodic heartbeat
/// outside the test window. Zero alone can precede PING submission, so
/// first observe it on the normal connection in this test's leased DB.
pub async fn settle_startup_ping(base: &str, db: &Db, remote: &omni_coord::redis::Remote) {
    let mut inspector = admin(base).await;
    let selected_db = format!("db={}", db.index);
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        loop {
            let clients: String = redis::cmd("CLIENT")
                .arg("LIST")
                .arg("TYPE")
                .arg("NORMAL")
                .query_async(&mut inspector)
                .await
                .expect("inspect Redis clients");
            let ping_seen = clients.lines().any(|line| {
                let mut fields = line.split_whitespace();
                fields.clone().any(|f| f == selected_db) && fields.any(|f| f == "cmd=ping")
            });
            if ping_seen && remote.outstanding_bytes() == 0 {
                break;
            }
            sleep_ms(1).await;
        }
    })
    .await
    .expect("startup PING completed");
}

/// A controlled write stall. `INCR` and scripts wait, but reads such as
/// `PING` still answer. End it within the coordinator's command deadline;
/// Redis's 20 s safety timeout is only for a test that panics first.
pub struct WriteStall {
    conn: redis::aio::MultiplexedConnection,
    ended: bool,
}

impl WriteStall {
    pub async fn start(url: &str) -> Self {
        let mut conn = admin(url).await;
        let _: () = redis::cmd("CLIENT")
            .arg("PAUSE")
            .arg(20_000)
            .arg("WRITE")
            .query_async(&mut conn)
            .await
            .expect("pause writes");
        Self { conn, ended: false }
    }

    pub async fn end(mut self) {
        let _: () = redis::cmd("CLIENT")
            .arg("UNPAUSE")
            .query_async(&mut self.conn)
            .await
            .expect("unpause");
        self.ended = true;
    }
}

impl Drop for WriteStall {
    fn drop(&mut self) {
        if !self.ended {
            let mut conn = self.conn.clone();
            tokio::spawn(async move {
                let _done: redis::RedisResult<()> = redis::cmd("CLIENT")
                    .arg("UNPAUSE")
                    .query_async(&mut conn)
                    .await;
            });
        }
    }
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
    conns: Arc<Mutex<Vec<Flow>>>,
    tasks: Arc<Mutex<Vec<tokio::task::JoinHandle<()>>>>,
}

/// One proxied connection's two directions, each freezable on its own.
#[derive(Clone)]
struct Flow {
    up: Arc<std::sync::atomic::AtomicBool>,
    down: Arc<std::sync::atomic::AtomicBool>,
}

impl Proxy {
    pub async fn start(target: &str) -> Self {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind proxy");
        let port = listener.local_addr().expect("addr").port();
        let conns: Arc<Mutex<Vec<Flow>>> = Arc::default();
        let tasks: Arc<Mutex<Vec<tokio::task::JoinHandle<()>>>> = Arc::default();
        let target = target.to_owned();
        let (c, t) = (Arc::clone(&conns), Arc::clone(&tasks));
        let accept = tokio::spawn(async move {
            while let Ok((client, _)) = listener.accept().await {
                let Ok(server) = tokio::net::TcpStream::connect(&target).await else {
                    continue;
                };
                let flow = Flow {
                    up: Arc::new(std::sync::atomic::AtomicBool::new(false)),
                    down: Arc::new(std::sync::atomic::AtomicBool::new(false)),
                };
                c.lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .push(flow.clone());
                let (cr, cw) = client.into_split();
                let (sr, sw) = server.into_split();
                let up = tokio::spawn(pump(cr, sw, flow.up));
                let down = tokio::spawn(pump(sr, cw, flow.down));
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
        for flow in conns.iter() {
            flow.up.store(true, Ordering::SeqCst);
            flow.down.store(true, Ordering::SeqCst);
        }
        conns.len()
    }

    /// Drops only *replies* on every connection established so far: requests
    /// still reach the server and execute, their answers never arrive.
    pub fn drop_replies_existing(&self) -> usize {
        let conns = self.conns.lock().unwrap_or_else(PoisonError::into_inner);
        for flow in conns.iter() {
            flow.down.store(true, Ordering::SeqCst);
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

/// A fake server: accepts connections and runs `script` on each, given the
/// connection's read and write halves, so a test can send hostile or slow
/// replies. Returns the port and the accept task.
pub async fn fake_server<F, Fut>(script: F) -> (u16, tokio::task::JoinHandle<()>)
where
    F: Fn(tokio::net::tcp::OwnedReadHalf, tokio::net::tcp::OwnedWriteHalf) -> Fut
        + Send
        + Sync
        + 'static,
    Fut: Future<Output = ()> + Send + 'static,
{
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind fake server");
    let port = listener.local_addr().expect("addr").port();
    let script = Arc::new(script);
    let task = tokio::spawn(async move {
        while let Ok((sock, _)) = listener.accept().await {
            let (r, w) = sock.into_split();
            tokio::spawn(script(r, w));
        }
    });
    (port, task)
}

/// Reads one RESP2 request (an array of bulk strings, what clients send),
/// or `None` at EOF. Enough for a fake server; not a general parser.
pub async fn read_request(
    r: &mut tokio::io::BufReader<tokio::net::tcp::OwnedReadHalf>,
) -> Option<Vec<String>> {
    use tokio::io::{AsyncBufReadExt, AsyncReadExt};
    let mut line = String::new();
    if r.read_line(&mut line).await.ok()? == 0 {
        return None;
    }
    let n: usize = line.trim().strip_prefix('*')?.parse().ok()?;
    let mut out = Vec::with_capacity(n);
    for _ in 0..n {
        line.clear();
        r.read_line(&mut line).await.ok()?;
        let len: usize = line.trim().strip_prefix('$')?.parse().ok()?;
        let mut buf = vec![0_u8; len + 2];
        r.read_exact(&mut buf).await.ok()?;
        buf.truncate(len);
        out.push(String::from_utf8_lossy(&buf).into_owned());
    }
    Some(out)
}

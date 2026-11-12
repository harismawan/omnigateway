//! The command connection: one multiplexed connection, replaced in the
//! background when it drops, with a deadline on every command.
//!
//! TS runs Bun's client with `enableOfflineQueue: false` and
//! `autoReconnect: true`: a command issued while Redis is away fails *now*
//! (and is answered from memory), and reconnection keeps trying behind it.
//! Here the same: while no connection is installed a command is
//! [`Fault::NotConnected`] at once, and the link task reconnects with backoff,
//! loads every script, and only then installs the connection — so a call
//! never waits on a script load, which keeps call order on the wire.

use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, PoisonError, RwLock};
use std::task::{Context, Waker};
use std::time::{Duration, Instant};

use redis::aio::MultiplexedConnection;
use redis::{AsyncConnectionConfig, Cmd, ErrorKind, RedisError, RedisResult, ServerErrorKind};
use tokio::sync::{Notify, watch};

use super::scripts::CoordScript;
use super::{Fault, RedisCoordOptions};

/// What one call to the server can end as, before it is classified.
pub(crate) type BoxFuture<T> = Pin<Box<dyn Future<Output = T> + Send>>;

pub(crate) struct Link {
    pub(crate) client: redis::Client,
    pub(crate) opts: RedisCoordOptions,
    pub(crate) scripts: Vec<CoordScript>,
    conn: RwLock<Option<(u64, MultiplexedConnection)>>,
    generation: AtomicU64,
    wake: Notify,
    /// True once a connection is installed; the first-connect wait reads it.
    pub(crate) connected: watch::Sender<bool>,
    pub(crate) shutdown: watch::Sender<bool>,
    healthy: AtomicBool,
    faults: AtomicU64,
    last_fault_log: Mutex<Option<Instant>>,
    /// A debit went to memory while Redis was away (TS `lostDebit`).
    lost_debit: AtomicBool,
    pub(crate) runtime: tokio::runtime::Handle,
}

impl Link {
    pub(crate) fn new(
        client: redis::Client,
        opts: RedisCoordOptions,
        scripts: Vec<CoordScript>,
    ) -> Self {
        Self {
            client,
            opts,
            scripts,
            conn: RwLock::new(None),
            generation: AtomicU64::new(0),
            wake: Notify::new(),
            connected: watch::Sender::new(false),
            shutdown: watch::Sender::new(false),
            healthy: AtomicBool::new(false),
            faults: AtomicU64::new(0),
            last_fault_log: Mutex::new(None),
            lost_debit: AtomicBool::new(false),
            runtime: tokio::runtime::Handle::current(),
        }
    }

    pub(crate) fn healthy(&self) -> bool {
        self.healthy.load(Ordering::SeqCst)
    }

    pub(crate) fn faults(&self) -> u64 {
        self.faults.load(Ordering::SeqCst)
    }

    pub(crate) fn note_lost_debit(&self) {
        self.lost_debit.store(true, Ordering::SeqCst);
    }

    fn current(&self) -> Option<(u64, MultiplexedConnection)> {
        self.conn
            .read()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    /// Drops the installed connection if it is still `generation`, and asks
    /// the link task for a new one.
    fn discard(&self, generation: u64) {
        let mut conn = self.conn.write().unwrap_or_else(PoisonError::into_inner);
        if conn.as_ref().is_some_and(|(g, _)| *g == generation) {
            *conn = None;
            self.connected.send_replace(false);
        }
        drop(conn);
        self.wake.notify_one();
    }

    pub(crate) fn close(&self) {
        self.shutdown.send_replace(true);
        *self.conn.write().unwrap_or_else(PoisonError::into_inner) = None;
        self.connected.send_replace(false);
        self.wake.notify_one();
    }

    /// Counts and (at most once per interval) logs a fault. The message and
    /// fields are TS's: the reason is the fault's kind, never the server's
    /// text.
    pub(crate) fn fault(&self, fault: &Fault) {
        self.healthy.store(false, Ordering::SeqCst);
        self.faults.fetch_add(1, Ordering::SeqCst);
        let now = Instant::now();
        let mut last = self
            .last_fault_log
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        if last.is_some_and(|at| now.duration_since(at) < self.opts.fault_log_interval) {
            return;
        }
        *last = Some(now);
        drop(last);
        let msg = if matches!(fault, Fault::TimedOut) {
            "coordinator slow; serving from memory"
        } else {
            "coordinator unreachable; serving from memory"
        };
        tracing::warn!(
            coord = "redis",
            coord_fallback = true,
            reason = fault.reason(),
            "{msg}"
        );
    }

    /// Runs `op` on the connection under the command deadline.
    ///
    /// Every outcome is accounted here, so `healthy`/`faults` cover direct
    /// [`super::Remote`] callers (D3's admission script) as well as the
    /// fail-open [`super::RedisCoord`]. The deadline does not cancel a command
    /// already written: it may still land, which over-counts a claim (the
    /// permitted direction) and is undone explicitly for a lock.
    pub(crate) async fn run<T, F, Fut>(self: &Arc<Self>, op: F) -> Result<T, Fault>
    where
        F: FnOnce(MultiplexedConnection) -> Fut,
        Fut: Future<Output = RedisResult<T>>,
    {
        let outcome = self.run_quiet(op).await;
        match &outcome {
            Ok(_) => self.succeeded(),
            Err(fault) => self.fault(fault),
        }
        outcome
    }

    async fn run_quiet<T, F, Fut>(&self, op: F) -> Result<T, Fault>
    where
        F: FnOnce(MultiplexedConnection) -> Fut,
        Fut: Future<Output = RedisResult<T>>,
    {
        let Some((generation, conn)) = self.current() else {
            self.wake.notify_one();
            return Err(Fault::NotConnected);
        };
        match tokio::time::timeout(self.opts.command_timeout, op(conn)).await {
            Err(_) => Err(Fault::TimedOut),
            Ok(Ok(out)) => Ok(out),
            Ok(Err(error)) => {
                if is_connection_error(&error) {
                    self.discard(generation);
                    Err(Fault::Connection(format!("{:?}", error.kind())))
                } else {
                    Err(Fault::Server(server_reason(&error)))
                }
            }
        }
    }

    fn succeeded(self: &Arc<Self>) {
        self.healthy.store(true, Ordering::SeqCst);
        if self.lost_debit.swap(false, Ordering::SeqCst) {
            let me = Arc::clone(self);
            self.runtime.spawn(reseed_after_outage(me));
        }
    }

    /// Writes `cmd` onto the connection *now* and lets the reply land
    /// whenever: TS's `void evalScript(...)`.
    ///
    /// The send is polled once inline, so the command is queued on the
    /// multiplexed connection before this returns and reaches the server
    /// ahead of any command issued after it; the rest (reply, `NOSCRIPT`
    /// retry) finishes on a spawned task. Silent when not connected.
    pub(crate) fn send_detached(self: &Arc<Self>, cmd: Cmd, retry_whole: Option<Cmd>) {
        let Some((_, mut conn)) = self.current() else {
            return;
        };
        let mut fut: BoxFuture<()> = Box::pin(async move {
            let first: RedisResult<redis::Value> = cmd.query_async(&mut conn).await;
            if let (Err(e), Some(whole)) = (first, retry_whole)
                && is_noscript(&e)
                && whole.query_async::<redis::Value>(&mut conn).await.is_err()
            {
                // Nobody awaits this reply; the lock it releases lapses at
                // its TTL instead.
                tracing::debug!(coord = "redis", "detached release failed");
            }
        });
        let mut cx = Context::from_waker(Waker::noop());
        if fut.as_mut().poll(&mut cx).is_pending() {
            let _task = self.runtime.spawn(fut);
        }
    }

    /// The link task: keeps one connection installed until shutdown.
    pub(crate) async fn maintain(self: Arc<Self>) {
        let mut shutdown = self.shutdown.subscribe();
        let mut delay = self.opts.reconnect_min;
        loop {
            if *shutdown.borrow() {
                return;
            }
            if let Some((generation, mut conn)) = self.current() {
                tokio::select! {
                    () = self.wake.notified() => {}
                    () = tokio::time::sleep(self.opts.heartbeat) => {
                        // An idle connection that died is otherwise noticed
                        // only by the next call, which is then answered from
                        // memory. A dead PING replaces it ahead of traffic.
                        let ping = redis::cmd("PING");
                        let probe = tokio::time::timeout(
                            self.opts.command_timeout,
                            ping.query_async::<redis::Value>(&mut conn),
                        )
                        .await;
                        if let Ok(Err(e)) = probe
                            && is_connection_error(&e)
                        {
                            self.discard(generation);
                        }
                    }
                    _ = shutdown.changed() => return,
                }
                continue;
            }
            match self.open().await {
                Ok(conn) => {
                    if *shutdown.borrow() {
                        return;
                    }
                    let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
                    *self.conn.write().unwrap_or_else(PoisonError::into_inner) =
                        Some((generation, conn));
                    self.healthy.store(true, Ordering::SeqCst);
                    self.connected.send_replace(true);
                    delay = self.opts.reconnect_min;
                }
                Err(fault) => {
                    self.fault(&fault);
                    tokio::select! {
                        () = tokio::time::sleep(delay) => {}
                        _ = shutdown.changed() => return,
                    }
                    delay = (delay * 2).min(self.opts.reconnect_max);
                }
            }
        }
    }

    /// Connects and loads every script (TS `loadScripts`), under the connect
    /// timeout.
    async fn open(&self) -> Result<MultiplexedConnection, Fault> {
        let config = AsyncConnectionConfig::new()
            .set_connection_timeout(Some(self.opts.connect_timeout))
            // The command deadline is ours (`run`), so it is one number and
            // a timeout is always `Fault::TimedOut`.
            .set_response_timeout(None);
        let attempt = async {
            let mut conn = self
                .client
                .get_multiplexed_async_connection_with_config(&config)
                .await?;
            for script in &self.scripts {
                let sha: String = redis::cmd("SCRIPT")
                    .arg("LOAD")
                    .arg(script.source)
                    .query_async(&mut conn)
                    .await?;
                if sha != script.sha {
                    return Err(RedisError::from((
                        ErrorKind::Client,
                        "script digest mismatch",
                        script.name.to_owned(),
                    )));
                }
            }
            Ok(conn)
        };
        match tokio::time::timeout(self.opts.connect_timeout, attempt).await {
            Err(_) => Err(Fault::TimedOut),
            Ok(Err(e)) if is_connection_error(&e) => {
                Err(Fault::Connection(format!("{:?}", e.kind())))
            }
            Ok(Err(e)) => Err(Fault::Server(server_reason(&e))),
            Ok(Ok(conn)) => Ok(conn),
        }
    }
}

/// TS `reseedAfterOutage`: debits made while Redis was away were dropped by
/// the memory fallback, so every bucket hash goes and the next admission
/// reseeds from the store. Boxed: it calls `run`, which spawns it.
fn reseed_after_outage(link: Arc<Link>) -> BoxFuture<()> {
    Box::pin(async move {
        let pattern = format!("{}*", super::key("b", ""));
        let found = link
            .run(|mut conn| async move { scan(&mut conn, &pattern).await })
            .await;
        let outcome = match found {
            Ok(keys) if keys.is_empty() => Ok(()),
            Ok(keys) => {
                link.run(|mut conn| async move {
                    let _: i64 = redis::cmd("UNLINK")
                        .arg(keys)
                        .query_async(&mut conn)
                        .await?;
                    Ok(())
                })
                .await
            }
            Err(e) => Err(e),
        };
        if outcome.is_err() {
            link.note_lost_debit();
        }
    })
}

/// Every key matching `pattern`: `SCAN`, never `KEYS`.
pub(crate) async fn scan(
    conn: &mut MultiplexedConnection,
    pattern: &str,
) -> RedisResult<Vec<String>> {
    let mut out = Vec::new();
    let mut cursor: u64 = 0;
    loop {
        let (next, keys): (u64, Vec<String>) = redis::cmd("SCAN")
            .arg(cursor)
            .arg("MATCH")
            .arg(pattern)
            .arg("COUNT")
            .arg(1_000)
            .query_async(conn)
            .await?;
        out.extend(keys);
        if next == 0 {
            return Ok(out);
        }
        cursor = next;
    }
}

pub(crate) fn is_noscript(e: &RedisError) -> bool {
    e.kind() == ErrorKind::Server(ServerErrorKind::NoScript)
}

/// Whether the connection the error came from is unusable.
fn is_connection_error(e: &RedisError) -> bool {
    e.is_io_error() || e.is_connection_dropped() || e.is_unrecoverable_error()
}

/// A server error's code (`BUSY`, `ERR`, …), never its text: TS logs the
/// fault's kind through closed fields, and a script error's text can carry
/// argument values.
fn server_reason(e: &RedisError) -> String {
    e.code()
        .map_or_else(|| format!("{:?}", e.kind()), str::to_owned)
}

/// The reconnect backoff bounds, re-exported for options.
pub(crate) const RECONNECT_MIN: Duration = Duration::from_millis(50);
pub(crate) const RECONNECT_MAX: Duration = Duration::from_secs(2);

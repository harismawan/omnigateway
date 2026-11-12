//! The command connection: one TCP connection to the server, one ordered
//! submission queue, one writer and one reader.
//!
//! **Ordering.** Every command — awaited calls and detached releases alike —
//! is pushed onto one queue synchronously, under one lock, at the moment it
//! is submitted (an awaited call: its first poll; a detached release: the
//! call itself, which is not async). The writer writes the queue in order
//! and the server executes one connection's commands in order, so a release
//! submitted before an admission is executed before it. Nothing is reordered
//! by capacity: a full queue *refuses* (counted, logged) rather than parking
//! a sender that a later submission can overtake.
//!
//! **Script cache misses.** An awaited `EVALSHA` answered `NOSCRIPT` is sent
//! again whole (`EVAL`) ahead of everything not yet written; the caller has
//! not returned, so nothing it orders against has been submitted. A detached
//! release is sent as `EVAL` from the start, so it never needs a second
//! round trip a later command could overtake. Redis caches an `EVAL`'d script
//! by digest, so this costs bytes, not a recompile.
//!
//! **Boundedness.** `queue_capacity` bounds queued plus in-flight commands.
//! Admissions (awaited calls) may use all but `release_reserve` of it, so a
//! saturated connection still takes releases; past the full capacity a
//! release is refused. Every awaited call is bounded by `command_timeout`.
//!
//! **Retirement.** The reader keeps a watchdog: when anything is in flight
//! and no reply has arrived for `command_timeout`, the connection is
//! *suspect*. A suspect connection is retired — closed, and a new one opened
//! — when a fresh probe connection to the same server is answered within
//! the connect timeout: the server is alive and only this socket is dead
//! (blackholed: open, nothing forwarded). When the probe also gets no answer
//! (the server itself is stalled — a long script, a pause), the connection
//! is kept, so the replies it is owed still arrive in order; callers have
//! been answered by their own deadlines meanwhile. An idle connection is
//! PINGed every `heartbeat`, so a silently dead socket is found while idle
//! too. Policy for what was outstanding on a retired connection:
//! - awaited calls fail (`Fault::Connection`/`NotConnected`) — their callers
//!   have been answered from memory, and a call never crosses a reconnect;
//! - idempotent releases (named gauge slot, compare-and-delete of a lock or
//!   lease token) are kept, in order, and written first on the next
//!   connection, whether or not they reached the old one;
//! - a non-idempotent release (unnamed gauge slot: `ZPOPMIN`) that was
//!   already written may or may not have landed; it is not replayed (that
//!   could drop a second slot), and is counted and logged — the slot's TTL
//!   bounds an unreleased one;
//! - a command written to a retired socket may still execute later (a server
//!   that was only slow reads it after we close): for a window or gauge
//!   claim that over-counts, the permitted direction; a lock `SET NX` that
//!   lands so is released by the token-safe cleanup the lock path queues,
//!   or failing that expires at its TTL.
//!
//! **Shutdown.** `close` stops admissions at once; queued releases are still
//! written and their replies awaited for up to `drain_timeout`, after which
//! anything left is counted, logged, and left to its TTL.
//!
//! The connection speaks RESP2 (`resp.rs`) over plain TCP. TLS and Unix
//! sockets are not supported (the URL is refused at connect with a fault).

use std::collections::VecDeque;
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use redis::{ConnectionAddr, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::net::tcp::{OwnedReadHalf, OwnedWriteHalf};
use tokio::sync::{Notify, oneshot, watch};

use super::resp::{self, Reply};
use super::scripts::CoordScript;
use super::{Fault, RedisCoordOptions};

pub(crate) type BoxFuture<T> = Pin<Box<dyn Future<Output = T> + Send>>;

/// One submission: the bytes, how many replies they produce, and who wants
/// them.
struct Op {
    bytes: Arc<[u8]>,
    replies: usize,
    got: Vec<Reply>,
    kind: OpKind,
}

enum OpKind {
    Call {
        tx: oneshot::Sender<Result<Vec<Reply>, Fault>>,
        /// `EVAL` bytes to send once on `NOSCRIPT`.
        retry: Option<Arc<[u8]>>,
    },
    Release {
        /// Safe to send twice (see the module comment).
        idempotent: bool,
    },
    Ping,
}

/// Why a detached release was not queued.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refused {
    /// Queue at capacity.
    Full,
    /// No connection and the release is not safe to hold for the next one.
    Down,
    /// The coordinator is closing.
    Closed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Mode {
    Down,
    Up,
    Closing,
}

struct State {
    mode: Mode,
    pending: VecDeque<Op>,
    in_flight: VecDeque<Op>,
    /// The last reply, or when the connection last went from idle to busy.
    last_progress: Instant,
}

impl State {
    fn outstanding(&self) -> usize {
        self.pending.len() + self.in_flight.len()
    }
}

/// What a connection generation ended with.
enum End {
    Stalled,
    Broken(String),
    Drained,
}

/// A request for `call`.
pub(crate) enum Request {
    One(Vec<u8>),
    /// `EVALSHA`, with the `EVAL` to send on `NOSCRIPT`.
    Eval {
        by_sha: Vec<u8>,
        whole: Vec<u8>,
    },
    /// Several commands written together; `replies` replies come back.
    Many {
        bytes: Vec<u8>,
        replies: usize,
    },
}

pub(crate) struct Link {
    pub(crate) client: redis::Client,
    pub(crate) opts: RedisCoordOptions,
    pub(crate) scripts: Vec<CoordScript>,
    state: Mutex<State>,
    wake_writer: Notify,
    pub(crate) connected: watch::Sender<bool>,
    pub(crate) shutdown: watch::Sender<bool>,
    stopped: watch::Sender<bool>,
    healthy: AtomicBool,
    faults: AtomicU64,
    releases_dropped: AtomicU64,
    last_fault_log: Mutex<Option<Instant>>,
    last_release_log: Mutex<Option<Instant>>,
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
            state: Mutex::new(State {
                mode: Mode::Down,
                pending: VecDeque::new(),
                in_flight: VecDeque::new(),
                last_progress: Instant::now(),
            }),
            wake_writer: Notify::new(),
            connected: watch::Sender::new(false),
            shutdown: watch::Sender::new(false),
            stopped: watch::Sender::new(false),
            healthy: AtomicBool::new(false),
            faults: AtomicU64::new(0),
            releases_dropped: AtomicU64::new(0),
            last_fault_log: Mutex::new(None),
            last_release_log: Mutex::new(None),
            lost_debit: AtomicBool::new(false),
            runtime: tokio::runtime::Handle::current(),
        }
    }

    fn state(&self) -> MutexGuard<'_, State> {
        // Every critical section leaves the queues consistent.
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    pub(crate) fn healthy(&self) -> bool {
        self.healthy.load(Ordering::SeqCst)
    }

    pub(crate) fn faults(&self) -> u64 {
        self.faults.load(Ordering::SeqCst)
    }

    pub(crate) fn releases_dropped(&self) -> u64 {
        self.releases_dropped.load(Ordering::SeqCst)
    }

    pub(crate) fn outstanding(&self) -> usize {
        self.state().outstanding()
    }

    pub(crate) fn note_lost_debit(&self) {
        self.lost_debit.store(true, Ordering::SeqCst);
    }

    /// Stops admissions now; the link task drains releases (bounded by
    /// `drain_timeout`) and stops.
    pub(crate) fn close(&self) {
        self.state().mode = Mode::Closing;
        self.shutdown.send_replace(true);
        self.wake_writer.notify_one();
    }

    /// Waits until the link task has drained and stopped.
    pub(crate) async fn stopped(&self) {
        let mut rx = self.stopped.subscribe();
        // Only fails if the sender is gone, which is the link itself.
        if rx.wait_for(|s| *s).await.is_err() {
            tracing::debug!(coord = "redis", "link dropped before it stopped");
        }
    }

    /// Counts and (at most once per interval) logs a fault. The message and
    /// fields are TS's: the reason is the fault's kind, never the server's
    /// text.
    pub(crate) fn fault(&self, fault: &Fault) {
        self.healthy.store(false, Ordering::SeqCst);
        self.faults.fetch_add(1, Ordering::SeqCst);
        if !self.due(&self.last_fault_log) {
            return;
        }
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

    /// Counts a release that will not reach the server (or may not have),
    /// and logs it at most once per interval. The gauge slot or lock it
    /// would have freed is held until its TTL.
    fn release_dropped(&self, n: u64, why: &'static str) {
        if n == 0 {
            return;
        }
        self.releases_dropped.fetch_add(n, Ordering::SeqCst);
        if self.due(&self.last_release_log) {
            tracing::warn!(
                coord = "redis",
                releases = n,
                reason = why,
                "coordinator release not delivered; held until its TTL"
            );
        }
    }

    fn due(&self, last: &Mutex<Option<Instant>>) -> bool {
        let now = Instant::now();
        let mut last = last.lock().unwrap_or_else(PoisonError::into_inner);
        if last.is_some_and(|at| now.duration_since(at) < self.opts.fault_log_interval) {
            return false;
        }
        *last = Some(now);
        true
    }

    fn succeeded(self: &Arc<Self>) {
        self.healthy.store(true, Ordering::SeqCst);
        if self.lost_debit.swap(false, Ordering::SeqCst) {
            let me = Arc::clone(self);
            self.runtime.spawn(reseed_after_outage(me));
        }
    }

    /// Submits `req` (synchronously, on the first poll) and waits for its
    /// replies under the command deadline. Every outcome is accounted
    /// (`healthy`, `faults`).
    pub(crate) async fn call(self: &Arc<Self>, req: Request) -> Result<Vec<Reply>, Fault> {
        let outcome = self.call_quiet(req).await;
        match &outcome {
            Ok(_) => self.succeeded(),
            Err(fault) => self.fault(fault),
        }
        outcome
    }

    async fn call_quiet(&self, req: Request) -> Result<Vec<Reply>, Fault> {
        let (tx, rx) = oneshot::channel();
        let (bytes, replies, retry) = match req {
            Request::One(b) => (b, 1, None),
            Request::Eval { by_sha, whole } => (by_sha, 1, Some(Arc::from(whole))),
            Request::Many { bytes, replies } => (bytes, replies, None),
        };
        {
            let mut st = self.state();
            if st.mode != Mode::Up {
                return Err(Fault::NotConnected);
            }
            let room = self
                .opts
                .queue_capacity
                .saturating_sub(self.opts.release_reserve);
            if st.outstanding() >= room {
                return Err(Fault::Saturated);
            }
            st.pending.push_back(Op {
                bytes: Arc::from(bytes),
                replies,
                got: Vec::with_capacity(replies),
                kind: OpKind::Call { tx, retry },
            });
        }
        self.wake_writer.notify_one();
        match tokio::time::timeout(self.opts.command_timeout, rx).await {
            Err(_) => Err(Fault::TimedOut),
            Ok(Err(_)) => Err(Fault::Connection("retired".to_owned())),
            Ok(Ok(out)) => out,
        }
    }

    /// Queues `bytes` (one command, sent whole) as a release, ordered ahead
    /// of every later submission. Not async: queued when this returns.
    pub(crate) fn release(&self, bytes: Vec<u8>, idempotent: bool) -> Result<(), Refused> {
        let refused = {
            let mut st = self.state();
            match st.mode {
                Mode::Closing => Some(Refused::Closed),
                Mode::Down if !idempotent => Some(Refused::Down),
                _ if st.outstanding() >= self.opts.queue_capacity => Some(Refused::Full),
                _ => {
                    st.pending.push_back(Op {
                        bytes: Arc::from(bytes),
                        replies: 1,
                        got: Vec::with_capacity(1),
                        kind: OpKind::Release { idempotent },
                    });
                    None
                }
            }
        };
        match refused {
            None => {
                self.wake_writer.notify_one();
                Ok(())
            }
            Some(r) => {
                self.release_dropped(
                    1,
                    match r {
                        Refused::Full => "queue full",
                        Refused::Down => "disconnected",
                        Refused::Closed => "closing",
                    },
                );
                Err(r)
            }
        }
    }

    /// The link task: keeps one connection serving until shutdown, then
    /// drains and stops. Draining (writing queued releases and awaiting
    /// their replies, reconnecting once if need be) is bounded by one
    /// `drain_timeout` from the moment `close` is called.
    pub(crate) async fn maintain(self: Arc<Self>) {
        let mut shutdown = self.shutdown.subscribe();
        let mut delay = self.opts.reconnect_min;
        let mut drain_deadline: Option<tokio::time::Instant> = None;
        loop {
            if drain_deadline.is_none() && *shutdown.borrow_and_update() {
                drain_deadline = Some(tokio::time::Instant::now() + self.opts.drain_timeout);
            }
            if let Some(deadline) = drain_deadline
                && (self.state().pending.is_empty() || tokio::time::Instant::now() >= deadline)
            {
                break;
            }
            let opened = match drain_deadline {
                Some(deadline) => tokio::time::timeout_at(deadline, self.open())
                    .await
                    .unwrap_or(Err(Fault::TimedOut)),
                None => tokio::select! {
                    out = self.open() => out,
                    _ = shutdown.changed() => continue,
                },
            };
            match opened {
                Ok((stream, leftover)) => {
                    {
                        let mut st = self.state();
                        if st.mode == Mode::Down {
                            st.mode = Mode::Up;
                        }
                        st.last_progress = Instant::now();
                    }
                    self.healthy.store(true, Ordering::SeqCst);
                    self.connected.send_replace(true);
                    delay = self.opts.reconnect_min;
                    let end = self
                        .serve_until(stream, leftover, &mut drain_deadline)
                        .await;
                    self.connected.send_replace(false);
                    self.retire(&end);
                    match end {
                        End::Drained => break,
                        End::Stalled => self.fault(&Fault::TimedOut),
                        End::Broken(kind) => self.fault(&Fault::Connection(kind)),
                    }
                }
                Err(fault) => {
                    self.fault(&fault);
                    if drain_deadline.is_some() {
                        break;
                    }
                    tokio::select! {
                        () = tokio::time::sleep(delay) => {}
                        _ = shutdown.changed() => {}
                    }
                    delay = (delay * 2).min(self.opts.reconnect_max);
                }
            }
        }
        self.finish();
    }

    /// `serve`, cut off at the drain deadline once shutdown begins.
    async fn serve_until(
        &self,
        stream: TcpStream,
        leftover: Vec<u8>,
        drain_deadline: &mut Option<tokio::time::Instant>,
    ) -> End {
        let serve = self.serve(stream, leftover);
        tokio::pin!(serve);
        if drain_deadline.is_none() {
            let mut shutdown = self.shutdown.subscribe();
            tokio::select! {
                end = &mut serve => return end,
                _ = shutdown.wait_for(|s| *s) => {}
            }
        }
        let deadline = *drain_deadline
            .get_or_insert_with(|| tokio::time::Instant::now() + self.opts.drain_timeout);
        tokio::select! {
            end = &mut serve => end,
            () = tokio::time::sleep_until(deadline) => End::Broken("drain timeout".to_owned()),
        }
    }

    /// Runs one connection generation until it breaks, stalls, or (closing)
    /// has nothing left outstanding.
    async fn serve(&self, stream: TcpStream, leftover: Vec<u8>) -> End {
        let (read, write) = stream.into_split();
        tokio::select! {
            end = self.write_loop(write) => end,
            end = self.read_loop(read, leftover) => end,
        }
    }

    async fn write_loop(&self, mut write: OwnedWriteHalf) -> End {
        let mut buf = Vec::new();
        loop {
            let (batch, closing_and_idle) = {
                let mut st = self.state();
                if st.in_flight.is_empty() && !st.pending.is_empty() {
                    st.last_progress = Instant::now();
                }
                let mut batch = Vec::with_capacity(st.pending.len());
                while let Some(op) = st.pending.pop_front() {
                    batch.push(Arc::clone(&op.bytes));
                    st.in_flight.push_back(op);
                }
                (batch, st.mode == Mode::Closing && st.outstanding() == 0)
            };
            if closing_and_idle {
                return End::Drained;
            }
            if batch.is_empty() {
                tokio::select! {
                    () = self.wake_writer.notified() => {}
                    () = tokio::time::sleep(self.opts.heartbeat) => self.ping_if_idle(),
                }
                continue;
            }
            buf.clear();
            for bytes in &batch {
                buf.extend_from_slice(bytes);
            }
            if let Err(e) = write.write_all(&buf).await {
                return End::Broken(format!("{:?}", e.kind()));
            }
        }
    }

    fn ping_if_idle(&self) {
        let mut st = self.state();
        if st.mode == Mode::Up && st.outstanding() == 0 {
            st.pending.push_back(Op {
                bytes: Arc::from(redis::cmd("PING").get_packed_command()),
                replies: 1,
                got: Vec::with_capacity(1),
                kind: OpKind::Ping,
            });
        }
    }

    async fn read_loop(&self, mut read: OwnedReadHalf, mut buf: Vec<u8>) -> End {
        let mut chunk = vec![0_u8; 16 * 1024];
        let tick = (self.opts.command_timeout / 4).max(Duration::from_millis(5));
        let mut watchdog = tokio::time::interval(tick);
        // While the connection is suspect: a probe of the server on a fresh
        // connection. This socket keeps being read meanwhile, and any byte
        // on it clears the suspicion.
        let mut probe: Option<AbortOnDrop> = None;
        loop {
            // Replies already buffered (the handshake's leftover, or a read
            // that carried several).
            loop {
                match resp::parse(&buf) {
                    Err(resp::ProtocolError) => return End::Broken("protocol".to_owned()),
                    Ok(None) => break,
                    Ok(Some((reply, used))) => {
                        buf.drain(..used);
                        if let Err(end) = self.deliver(reply) {
                            return end;
                        }
                    }
                }
            }
            tokio::select! {
                n = read.read(&mut chunk) => {
                    probe = None;
                    match n {
                        Ok(0) => return End::Broken("closed".to_owned()),
                        Ok(n) => buf.extend_from_slice(&chunk[..n]),
                        Err(e) => return End::Broken(format!("{:?}", e.kind())),
                    }
                }
                answered = async {
                    match probe.as_mut() {
                        Some(p) => (&mut p.0).await.unwrap_or(false),
                        None => std::future::pending().await,
                    }
                }, if probe.is_some() => {
                    probe = None;
                    // The server answers a fresh connection while this one,
                    // owing replies, has been silent past the deadline: only
                    // this socket is dead. If the server too is stalled, keep
                    // the connection; its replies will come in order.
                    //
                    // A server that was stalled and just resumed answers the
                    // probe and this socket at about the same moment; a short
                    // grace read keeps a connection that is flowing again.
                    if answered {
                        let grace = (self.opts.command_timeout / 4).max(Duration::from_millis(20));
                        match tokio::time::timeout(grace, read.read(&mut chunk)).await {
                            Ok(Ok(n)) if n > 0 => buf.extend_from_slice(&chunk[..n]),
                            Ok(Ok(_)) => return End::Broken("closed".to_owned()),
                            Ok(Err(e)) => return End::Broken(format!("{:?}", e.kind())),
                            Err(_) => return End::Stalled,
                        }
                    }
                }
                _ = watchdog.tick(), if probe.is_none() => {
                    let silent = {
                        let st = self.state();
                        !st.in_flight.is_empty()
                            && st.last_progress.elapsed() > self.opts.command_timeout
                    };
                    if silent {
                        let client = self.client.clone();
                        let timeout = self.opts.connect_timeout;
                        probe = Some(AbortOnDrop(self.runtime.spawn(async move {
                            matches!(
                                tokio::time::timeout(timeout, probe_server(&client)).await,
                                Ok(Ok(()))
                            )
                        })));
                    }
                }
            }
        }
    }

    /// Hands one reply to the op it answers.
    fn deliver(&self, reply: Reply) -> Result<(), End> {
        let done = {
            let mut st = self.state();
            st.last_progress = Instant::now();
            let Some(op) = st.in_flight.front_mut() else {
                return Err(End::Broken("unsolicited reply".to_owned()));
            };
            op.got.push(reply);
            if op.got.len() < op.replies {
                return Ok(());
            }
            let Some(op) = st.in_flight.pop_front() else {
                return Ok(());
            };
            if st.mode == Mode::Closing && st.outstanding() == 0 {
                // The writer decides when a drain is done.
                self.wake_writer.notify_one();
            }
            // A cache miss on an awaited EVALSHA: send it whole, ahead of
            // everything not yet written.
            match op.kind {
                OpKind::Call {
                    tx,
                    retry: Some(whole),
                } if is_noscript(&op.got) => {
                    st.pending.push_front(Op {
                        bytes: whole,
                        replies: 1,
                        got: Vec::with_capacity(1),
                        kind: OpKind::Call { tx, retry: None },
                    });
                    drop(st);
                    self.wake_writer.notify_one();
                    return Ok(());
                }
                kind => (kind, op.got),
            }
        };
        match done {
            (OpKind::Call { tx, .. }, got) => {
                // The caller may have given up at its deadline.
                if tx.send(Ok(got)).is_err() {
                    tracing::trace!(coord = "redis", "reply after the caller's deadline");
                }
            }
            (OpKind::Release { .. }, got) => {
                if got.iter().any(Result::is_err) {
                    self.release_dropped(1, "server error");
                }
            }
            (OpKind::Ping, _) => {}
        }
        Ok(())
    }

    /// Ends a generation: the outstanding work is settled by the policy in
    /// the module comment.
    fn retire(&self, end: &End) {
        let (calls, uncertain) = {
            let mut st = self.state();
            if st.mode == Mode::Up {
                st.mode = Mode::Down;
            }
            let mut keep = VecDeque::new();
            let mut calls = Vec::new();
            let mut uncertain = 0;
            for mut op in st.in_flight.drain(..) {
                match op.kind {
                    OpKind::Call { tx, .. } => calls.push((tx, true)),
                    OpKind::Release { idempotent: true } => {
                        op.got.clear();
                        keep.push_back(op);
                    }
                    OpKind::Release { idempotent: false } => uncertain += 1,
                    OpKind::Ping => {}
                }
            }
            let pending: Vec<Op> = st.pending.drain(..).collect();
            for op in pending {
                match op.kind {
                    OpKind::Call { tx, .. } => calls.push((tx, false)),
                    OpKind::Release { .. } => keep.push_back(op),
                    OpKind::Ping => {}
                }
            }
            st.pending = keep;
            (calls, uncertain)
        };
        for (tx, written) in calls {
            let fault = if written {
                Fault::Connection(match end {
                    End::Stalled => "retired: stalled".to_owned(),
                    End::Broken(kind) => format!("retired: {kind}"),
                    End::Drained => "closed".to_owned(),
                })
            } else {
                Fault::NotConnected
            };
            if tx.send(Err(fault)).is_err() {
                tracing::trace!(coord = "redis", "retired call already gone");
            }
        }
        self.release_dropped(uncertain, "written to a retired connection");
    }

    /// After the last generation: nothing more will be written.
    fn finish(&self) {
        let left = {
            let mut st = self.state();
            st.mode = Mode::Closing;
            let mut left = 0;
            let mut ops: Vec<Op> = st.in_flight.drain(..).collect();
            ops.extend(st.pending.drain(..));
            for op in ops {
                match op.kind {
                    OpKind::Call { tx, .. } => {
                        if tx.send(Err(Fault::NotConnected)).is_err() {
                            tracing::trace!(coord = "redis", "closed call already gone");
                        }
                    }
                    OpKind::Release { .. } => left += 1,
                    OpKind::Ping => {}
                }
            }
            left
        };
        self.release_dropped(left, "closed before delivery");
        self.connected.send_replace(false);
        self.stopped.send_replace(true);
    }

    /// Connects, authenticates, selects the database and loads every script
    /// (TS `loadScripts`), under the connect timeout. Returns the stream and
    /// any bytes read past the handshake.
    async fn open(&self) -> Result<(TcpStream, Vec<u8>), Fault> {
        let handshake = handshake(&self.client, Some(&self.scripts));
        match tokio::time::timeout(self.opts.connect_timeout, handshake).await {
            Err(_) => Err(Fault::TimedOut),
            Ok(out) => out,
        }
    }
}

/// Connects, authenticates, selects the database and (with `scripts`)
/// loads every script, checking each digest. Returns the stream and any
/// bytes read past the handshake.
async fn handshake(
    client: &redis::Client,
    scripts: Option<&[CoordScript]>,
) -> Result<(TcpStream, Vec<u8>), Fault> {
    let info = client.get_connection_info();
    let (host, port) = match info.addr() {
        ConnectionAddr::Tcp(host, port) => (host.clone(), *port),
        _ => return Err(Fault::Connection("unsupported address".to_owned())),
    };
    let settings = info.redis_settings();
    let mut hello = Vec::new();
    let mut expect: Vec<Option<&CoordScript>> = Vec::new();
    if let Some(password) = settings.password() {
        let mut auth = redis::cmd("AUTH");
        if let Some(user) = settings.username() {
            auth.arg(user);
        }
        auth.arg(password);
        hello.extend(auth.get_packed_command());
        expect.push(None);
    }
    if settings.db() != 0 {
        hello.extend(redis::cmd("SELECT").arg(settings.db()).get_packed_command());
        expect.push(None);
    }
    for script in scripts.into_iter().flatten() {
        hello.extend(
            redis::cmd("SCRIPT")
                .arg("LOAD")
                .arg(script.source)
                .get_packed_command(),
        );
        expect.push(Some(script));
    }
    let mut stream = TcpStream::connect((host.as_str(), port))
        .await
        .map_err(|e| Fault::Connection(format!("{:?}", e.kind())))?;
    stream
        .set_nodelay(true)
        .map_err(|e| Fault::Connection(format!("{:?}", e.kind())))?;
    stream
        .write_all(&hello)
        .await
        .map_err(|e| Fault::Connection(format!("{:?}", e.kind())))?;
    let mut buf = Vec::new();
    for want in expect {
        let reply = read_reply(&mut stream, &mut buf).await?;
        match (reply, want) {
            (Err(e), _) => return Err(Fault::Server(e.code)),
            (Ok(Value::BulkString(sha)), Some(script)) if sha == script.sha.as_bytes() => {}
            (Ok(_), Some(_)) => {
                return Err(Fault::Server("script digest mismatch".to_owned()));
            }
            (Ok(_), None) => {}
        }
    }
    Ok((stream, buf))
}

/// A `PING` answered on a fresh connection: the server is alive.
async fn probe_server(client: &redis::Client) -> Result<(), Fault> {
    let (mut stream, mut buf) = handshake(client, None).await?;
    stream
        .write_all(&redis::cmd("PING").get_packed_command())
        .await
        .map_err(|e| Fault::Connection(format!("{:?}", e.kind())))?;
    match read_reply(&mut stream, &mut buf).await? {
        Ok(_) => Ok(()),
        Err(e) => Err(Fault::Server(e.code)),
    }
}

/// Reads one reply from a stream being handshaken (no queue yet).
async fn read_reply(stream: &mut TcpStream, buf: &mut Vec<u8>) -> Result<Reply, Fault> {
    let mut chunk = [0_u8; 4 * 1024];
    loop {
        match resp::parse(buf) {
            Err(resp::ProtocolError) => return Err(Fault::Connection("protocol".to_owned())),
            Ok(Some((reply, used))) => {
                buf.drain(..used);
                return Ok(reply);
            }
            Ok(None) => {
                let n = stream
                    .read(&mut chunk)
                    .await
                    .map_err(|e| Fault::Connection(format!("{:?}", e.kind())))?;
                if n == 0 {
                    return Err(Fault::Connection("closed".to_owned()));
                }
                buf.extend_from_slice(&chunk[..n]);
            }
        }
    }
}

/// A spawned probe that dies with the read loop that started it.
struct AbortOnDrop(tokio::task::JoinHandle<bool>);

impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        self.0.abort();
    }
}

fn is_noscript(got: &[Reply]) -> bool {
    matches!(got, [Err(e)] if e.code == "NOSCRIPT")
}

/// The single reply of a one-command call.
pub(crate) fn one(mut replies: Vec<Reply>) -> Result<Value, Fault> {
    match replies.pop() {
        Some(Ok(v)) if replies.is_empty() => Ok(v),
        Some(Err(e)) => Err(Fault::Server(e.code)),
        _ => Err(Fault::Server("unexpected reply count".to_owned())),
    }
}

/// TS `reseedAfterOutage`: debits made while Redis was away were dropped by
/// the memory fallback, so every bucket hash goes and the next admission
/// reseeds from the store. Boxed: it calls `call`, which spawns it.
fn reseed_after_outage(link: Arc<Link>) -> BoxFuture<()> {
    Box::pin(async move {
        let pattern = format!("{}*", super::key("b", ""));
        let outcome = async {
            let keys = scan(&link, &pattern).await?;
            for chunk in keys.chunks(512) {
                let mut unlink = redis::cmd("UNLINK");
                unlink.arg(chunk);
                one(link.call(Request::One(unlink.get_packed_command())).await?)?;
            }
            Ok::<_, Fault>(())
        };
        if outcome.await.is_err() {
            link.note_lost_debit();
        }
    })
}

/// Every key matching `pattern`: `SCAN`, never `KEYS`. Each page is one
/// bounded call.
pub(crate) async fn scan(link: &Arc<Link>, pattern: &str) -> Result<Vec<String>, Fault> {
    let mut out = Vec::new();
    let mut cursor = "0".to_owned();
    loop {
        let mut cmd = redis::cmd("SCAN");
        cmd.arg(&cursor)
            .arg("MATCH")
            .arg(pattern)
            .arg("COUNT")
            .arg(1_000);
        let page = one(link.call(Request::One(cmd.get_packed_command())).await?)?;
        let Value::Array(mut parts) = page else {
            return Err(Fault::Server("unexpected reply to SCAN".to_owned()));
        };
        let (Some(Value::Array(keys)), Some(Value::BulkString(next))) = (parts.pop(), parts.pop())
        else {
            return Err(Fault::Server("unexpected reply to SCAN".to_owned()));
        };
        for key in keys {
            if let Value::BulkString(k) = key {
                out.push(String::from_utf8_lossy(&k).into_owned());
            }
        }
        cursor = String::from_utf8_lossy(&next).into_owned();
        if cursor == "0" {
            return Ok(out);
        }
    }
}

pub(crate) const RECONNECT_MIN: Duration = Duration::from_millis(50);
pub(crate) const RECONNECT_MAX: Duration = Duration::from_secs(2);

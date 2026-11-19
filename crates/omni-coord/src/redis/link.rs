//! The command connection: one ordered, bounded submission queue in front of
//! one `redis` crate [`MultiplexedConnection`] per connection generation.
//!
//! **Wire.** Encoding, reply parsing and request/reply pairing are the
//! `redis` crate's (`MultiplexedConnection`: a bounded mpsc into one driver
//! task that writes in channel order and answers replies in FIFO order;
//! replies decoded incrementally by its `combine` codec). This module owns
//! only what that type cannot give: ordering across *callers*, a hard
//! bound, retirement of a silent socket, and shutdown draining. Evidence for
//! the ordering argument is recorded in `d2-report.md` ("Fix round 2").
//!
//! **Ordering.** Every command — awaited calls and detached releases alike —
//! is pushed onto [`State::pending`] synchronously, under one lock, at the
//! moment it is submitted (an awaited call: its first poll; a detached
//! release: the call itself, which is not async). One *writer* task pops
//! the queue in order and hands each submission to the multiplexed
//! connection, waiting until that submission is inside the crate's send
//! channel before taking the next. A single sender into a FIFO channel
//! feeding one writer to one socket preserves order, and the server
//! executes one connection's commands in order. So a release whose call has
//! returned is executed before any command submitted after it. Nothing is
//! reordered by capacity: a full queue *refuses* (counted, logged) rather
//! than parking a submitter that a later one could overtake.
//!
//! **Script cache misses.** Detached releases are sent as `EVAL` from the
//! start, so they never need a second round trip. An awaited `EVALSHA`
//! answered `NOSCRIPT` is resubmitted once as `EVAL`, at the back of the
//! queue; its caller has not returned, so a command the caller orders
//! against has not been submitted, but *other* callers' later commands may
//! run before the retry. The retry is not a new admission: its bytes were
//! charged when the original call was accepted and are transferred to it,
//! so it cannot be refused for capacity.
//!
//! **Boundedness.** The budget is in commands *and* bytes, charged at
//! submission and returned when the reply arrives (or the op is settled):
//! - `queue_capacity` commands (a pipeline costs its length) and
//!   `queue_bytes` request bytes, queued plus in flight — *every* byte an op
//!   retains, including an `EVALSHA` call's `EVAL` fallback (script source
//!   and a second copy of the arguments), each form validated against
//!   `max_request_bytes` before acceptance;
//! - every accepted op is response-bearing and stays charged until its reply
//!   settles it: a command flagged no-response is refused (`Fault::Invalid`),
//!   since the `redis` crate would answer it at once while its request still
//!   occupied the send channel and the driver's in-flight list;
//! - awaited calls may use all but `release_reserve` commands and
//!   `release_reserve_bytes` bytes of it, so a connection saturated by
//!   admissions still takes the releases that free them;
//! - one request may be at most `max_request_bytes`, one pipeline at most
//!   `max_pipeline_len` commands;
//! - replies are decoded by the `redis` crate, under the reply guard
//!   (`guard.rs`): one reply at most `max_reply_bytes` and
//!   `max_reply_elements`, nesting 16, header lines 4 KiB, lengths `-1` or
//!   non-negative; a violation drops the connection.
//!
//! Every awaited call is bounded by `command_timeout`.
//!
//! **Retirement** (a heuristic). "Progress" is a *completed* reply (one op
//! settled), not bytes arriving: a long reply still streaming in, or a
//! pipeline whose replies are arriving but not yet all in, counts as silent.
//! A watchdog marks the connection suspect when ops are in flight and none
//! has completed for `command_timeout`. A suspect
//! connection is retired — dropped (which ends its driver task and closes
//! the socket) and replaced — when a fresh probe connection to the same
//! server is answered within the connect timeout and the old connection
//! still owes replies and completes none through a short grace period
//! (rechecked at its end): the server is alive, so this socket is taken to
//! be dead (blackholed). That inference can be wrong — a reply too large to
//! complete within `command_timeout`, or a pipeline completing slowly,
//! looks the same — and then a healthy connection is retired: conservative
//! (callers fall back), never a mis-delivered reply. When the probe also gets no answer
//! (the server itself is stalled — a long script, a pause), the connection
//! is kept, so the replies it is owed still arrive in order; callers have
//! been answered by their own deadlines meanwhile. An idle connection is
//! PINGed every `heartbeat`. Policy for what was outstanding when a
//! generation ends:
//! - awaited calls fail (`Fault::Connection`/`NotConnected`) — their callers
//!   have been answered from memory, and a call never crosses a reconnect;
//! - idempotent releases (named gauge slot, compare-and-delete of a lock or
//!   lease token) are kept, in order, and written first on the next
//!   connection, whether or not they reached the old one (executed-but-
//!   reply-lost included: running one twice is harmless by construction);
//! - a non-idempotent release (unnamed gauge slot: `ZPOPMIN`) that was
//!   already handed to the connection may or may not have run; it is not
//!   replayed (that could drop a second slot), and is counted and logged —
//!   the slot's TTL bounds an unreleased one;
//! - a command written to a retired socket may still execute later (a
//!   server that was only slow reads it after we close): a window or gauge
//!   claim then over-counts, the permitted direction; a lock `SET NX` that
//!   lands so is not ordered against cleanup sent on the new connection and
//!   may hold the lock until its TTL.
//!
//! **Shutdown.** `close` records the drain deadline (`drain_timeout` from
//! that moment) and stops admissions at once; queued releases are still
//! written and their replies awaited until the deadline, after which
//! anything left is counted, logged, and left to its TTL.

use std::collections::{HashSet, VecDeque};
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use redis::aio::MultiplexedConnection;
use redis::{AsyncConnectionConfig, Cmd, ErrorKind, Pipeline, RedisError, ServerErrorKind, Value};
use tokio::sync::{Notify, oneshot, watch};

use super::scripts::CoordScript;
use super::{Fault, RedisCoordOptions};

pub(crate) type BoxFuture<T> = Pin<Box<dyn Future<Output = T> + Send>>;

/// One submission and what it costs against the budget.
struct Op {
    /// Sequence number within the queue's lifetime; reply routing uses it.
    id: u64,
    /// Of `cost.bytes`, what the retained `EVAL` fallback accounts for
    /// (`OpKind::Call { retry: Some(..) }`); transferred to the retry op.
    retry_bytes: usize,
    /// Taken by the writer when handed over, except for releases, which keep
    /// it (one `EVAL`, `max_request_bytes` at most) to be replayed.
    req: Option<Wire>,
    cost: Cost,
    kind: OpKind,
}

#[derive(Clone)]
enum Wire {
    One(Cmd),
    Many(Pipeline),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
struct Cost {
    commands: usize,
    bytes: usize,
}

enum OpKind {
    Call {
        tx: oneshot::Sender<Result<Value, Fault>>,
        /// `EVAL` to send once on `NOSCRIPT`.
        retry: Option<Cmd>,
    },
    Release {
        /// Safe to run twice (see the module comment).
        idempotent: bool,
    },
    Ping,
}

/// Why a detached release was not queued.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refused {
    /// Queue at capacity (commands or bytes), or the release is larger than
    /// one request may be.
    Full,
    /// No connection and the release is not safe to hold for the next one.
    Down,
    /// The coordinator is closing.
    Closed,
    /// Not a release this API can make safely (a blank named holder).
    Invalid,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Mode {
    Down,
    Up,
    Closing,
}

struct State {
    mode: Mode,
    next_id: u64,
    pending: VecDeque<Op>,
    /// Handed to the connection, reply not yet in.
    in_flight: VecDeque<Op>,
    /// Charged for `pending` + `in_flight`.
    used: Cost,
    /// The last reply, or when the connection last went from idle to busy.
    last_progress: Instant,
}

impl State {
    fn charge(&mut self, cost: Cost) {
        self.used.commands += cost.commands;
        self.used.bytes += cost.bytes;
    }

    fn refund(&mut self, cost: Cost) {
        self.used.commands = self.used.commands.saturating_sub(cost.commands);
        self.used.bytes = self.used.bytes.saturating_sub(cost.bytes);
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
    One(Cmd),
    /// `EVALSHA`, with the `EVAL` to send on `NOSCRIPT`.
    Eval {
        by_sha: Cmd,
        whole: Cmd,
    },
    Many(Pipeline),
}

pub(crate) struct Link {
    pub(crate) client: redis::Client,
    pub(crate) opts: RedisCoordOptions,
    pub(crate) scripts: Vec<CoordScript>,
    state: Mutex<State>,
    wake_writer: Notify,
    /// A reply came in or an op was settled: the watchdog and drain read it.
    progress: Notify,
    pub(crate) connected: watch::Sender<bool>,
    pub(crate) shutdown: watch::Sender<bool>,
    /// Set once, by the first `close`.
    drain_deadline: Mutex<Option<tokio::time::Instant>>,
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

/// The size of a request on the wire, as the `redis` crate packs it.
fn wire_cost(req: &Wire) -> Cost {
    match req {
        Wire::One(cmd) => Cost {
            commands: 1,
            bytes: packed_len(cmd),
        },
        Wire::Many(pipe) => Cost {
            commands: pipe.len(),
            bytes: pipe.cmd_iter().map(packed_len).sum(),
        },
    }
}

fn packed_len(cmd: &Cmd) -> usize {
    // `*<n>\r\n` then `$<len>\r\n<arg>\r\n` per argument; the digits are
    // bounded by 20 each, so this over-estimates by at most a few bytes.
    let args = cmd.args_iter();
    let mut n = 1 + 20 + 2;
    for arg in args {
        let len = match arg {
            redis::Arg::Simple(a) => a.len(),
            // A cursor argument (`Arg` is non-exhaustive): a u64 in decimal.
            _ => 20,
        };
        n += 1 + 20 + 2 + len + 2;
    }
    n
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
                next_id: 0,
                pending: VecDeque::new(),
                in_flight: VecDeque::new(),
                used: Cost::default(),
                last_progress: Instant::now(),
            }),
            wake_writer: Notify::new(),
            progress: Notify::new(),
            connected: watch::Sender::new(false),
            shutdown: watch::Sender::new(false),
            drain_deadline: Mutex::new(None),
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

    /// Commands queued or awaiting replies (a pipeline counts its length).
    pub(crate) fn outstanding(&self) -> usize {
        self.state().used.commands
    }

    /// Request bytes queued or awaiting replies.
    pub(crate) fn outstanding_bytes(&self) -> usize {
        self.state().used.bytes
    }

    pub(crate) fn note_lost_debit(&self) {
        self.lost_debit.store(true, Ordering::SeqCst);
    }

    /// Stops admissions now and fixes the drain deadline (`drain_timeout`
    /// from this call); the link task drains releases until then and stops.
    pub(crate) fn close(&self) {
        {
            let mut deadline = self
                .drain_deadline
                .lock()
                .unwrap_or_else(PoisonError::into_inner);
            if deadline.is_none() {
                *deadline = Some(tokio::time::Instant::now() + self.opts.drain_timeout);
            }
        }
        self.state().mode = Mode::Closing;
        self.shutdown.send_replace(true);
        self.wake_writer.notify_one();
        self.progress.notify_waiters();
    }

    fn drain_deadline(&self) -> Option<tokio::time::Instant> {
        *self
            .drain_deadline
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
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
    /// reply until `deadline`. Every outcome is accounted *after* the reply
    /// is classified: a server error reply is a fault (`Fault::Server`), not
    /// a success.
    pub(crate) async fn call_until(
        self: &Arc<Self>,
        req: Request,
        deadline: tokio::time::Instant,
    ) -> Result<Value, Fault> {
        let outcome = self.call_quiet(req, deadline).await;
        match &outcome {
            Ok(_) => self.succeeded(),
            // The caller's bug, refused before anything was sent: not a
            // statement about the server.
            Err(Fault::Invalid) => {}
            Err(fault) => self.fault(fault),
        }
        outcome
    }

    /// [`Link::call_until`] with the command deadline from now.
    pub(crate) async fn call(self: &Arc<Self>, req: Request) -> Result<Value, Fault> {
        let deadline = tokio::time::Instant::now() + self.opts.command_timeout;
        self.call_until(req, deadline).await
    }

    async fn call_quiet(
        &self,
        req: Request,
        deadline: tokio::time::Instant,
    ) -> Result<Value, Fault> {
        // A spent budget submits nothing: the remaining-budget contract of
        // multi-call operations (`kv_del_prefix`) is then exact.
        if tokio::time::Instant::now() >= deadline {
            return Err(Fault::TimedOut);
        }
        let (tx, rx) = oneshot::channel();
        let (wire, retry) = match req {
            Request::One(cmd) => (Wire::One(cmd), None),
            Request::Eval { by_sha, whole } => (Wire::One(by_sha), Some(whole)),
            Request::Many(pipe) => (Wire::Many(pipe), None),
        };
        self.submit(wire, OpKind::Call { tx, retry }, false)?;
        match tokio::time::timeout_at(deadline, rx).await {
            Err(_) => Err(Fault::TimedOut),
            Ok(Err(_)) => Err(Fault::Connection("retired".to_owned())),
            Ok(Ok(out)) => out,
        }
    }

    /// Charges and queues one op, or refuses it. `release` ops may use the
    /// reserve; awaited calls may not.
    fn submit(&self, req: Wire, kind: OpKind, release: bool) -> Result<(), Fault> {
        self.submit_op(req, kind, release)
            .map_err(|(fault, _)| fault)
    }

    /// [`Link::submit`], handing a refused op's kind back to the caller.
    ///
    /// Every byte the op retains is validated and charged here: the request
    /// itself and, for an `EVALSHA` call, the `EVAL` fallback kept for a
    /// `NOSCRIPT` retry (script source plus a second copy of the arguments).
    /// A request flagged no-response is refused (`Fault::Invalid`): its reply
    /// would never settle the charge, and `Handoff`'s free-slot invariant
    /// counts on every accepted op holding its charge until its reply.
    fn submit_op(&self, req: Wire, kind: OpKind, release: bool) -> Result<(), (Fault, OpKind)> {
        if no_response(&req) {
            return Err((Fault::Invalid, kind));
        }
        let mut cost = wire_cost(&req);
        let retry_bytes = match &kind {
            OpKind::Call {
                retry: Some(whole), ..
            } => {
                if whole.is_no_response() {
                    return Err((Fault::Invalid, kind));
                }
                packed_len(whole)
            }
            _ => 0,
        };
        if cost.bytes > self.opts.max_request_bytes
            || retry_bytes > self.opts.max_request_bytes
            || (matches!(req, Wire::Many(_)) && cost.commands > self.opts.max_pipeline_len)
        {
            return Err((Fault::TooLarge, kind));
        }
        cost.bytes += retry_bytes;
        {
            let mut st = self.state();
            let idempotent = matches!(kind, OpKind::Release { idempotent: true });
            match st.mode {
                Mode::Up => {}
                Mode::Down if release && idempotent => {}
                Mode::Closing if release => return Err((Fault::Closing, kind)),
                _ => return Err((Fault::NotConnected, kind)),
            }
            let (cmds, bytes) = if release {
                (self.opts.queue_capacity, self.opts.queue_bytes)
            } else {
                (
                    self.opts
                        .queue_capacity
                        .saturating_sub(self.opts.release_reserve),
                    self.opts
                        .queue_bytes
                        .saturating_sub(self.opts.release_reserve_bytes),
                )
            };
            if st.used.commands + cost.commands > cmds || st.used.bytes + cost.bytes > bytes {
                return Err((Fault::Saturated, kind));
            }
            st.charge(cost);
            let id = st.next_id;
            st.next_id += 1;
            st.pending.push_back(Op {
                id,
                retry_bytes,
                req: Some(req),
                cost,
                kind,
            });
        }
        self.wake_writer.notify_one();
        Ok(())
    }

    /// Queues one `EVAL` as a release, ordered ahead of every later
    /// submission. Not async: queued when this returns.
    pub(crate) fn release(&self, cmd: Cmd, idempotent: bool) -> Result<(), Refused> {
        let refused = match self.submit(Wire::One(cmd), OpKind::Release { idempotent }, true) {
            Ok(()) => return Ok(()),
            Err(Fault::Closing) => Refused::Closed,
            Err(Fault::NotConnected) => Refused::Down,
            Err(_) => Refused::Full,
        };
        self.release_dropped(
            1,
            match refused {
                Refused::Full => "queue full",
                Refused::Down => "disconnected",
                Refused::Closed => "closing",
                Refused::Invalid => "invalid",
            },
        );
        Err(refused)
    }

    /// Counts a release the caller's own validation refused.
    pub(crate) fn release_invalid(&self) -> Refused {
        self.release_dropped(1, "invalid");
        Refused::Invalid
    }

    /// The link task: keeps one connection serving until shutdown, then
    /// drains (writing queued releases and awaiting their replies,
    /// reconnecting if need be) until the deadline `close` recorded.
    pub(crate) async fn maintain(self: Arc<Self>) {
        let mut shutdown = self.shutdown.subscribe();
        let mut delay = self.opts.reconnect_min;
        loop {
            let draining = self.drain_deadline();
            if let Some(deadline) = draining
                && (self.state().pending.is_empty() || tokio::time::Instant::now() >= deadline)
            {
                break;
            }
            let opened = match draining {
                Some(deadline) => tokio::time::timeout_at(deadline, self.open())
                    .await
                    .unwrap_or(Err(Fault::TimedOut)),
                None => tokio::select! {
                    out = self.open() => out,
                    _ = shutdown.changed() => continue,
                },
            };
            match opened {
                Ok(conn) => {
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
                    let end = self.serve_until_drained(conn).await;
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
                    if self.drain_deadline().is_some() {
                        continue;
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
    async fn serve_until_drained(self: &Arc<Self>, conn: Conn) -> End {
        let serve = self.serve(conn);
        tokio::pin!(serve);
        if self.drain_deadline().is_none() {
            let mut shutdown = self.shutdown.subscribe();
            tokio::select! {
                end = &mut serve => return end,
                _ = shutdown.wait_for(|s| *s) => {}
            }
        }
        let Some(deadline) = self.drain_deadline() else {
            return End::Broken("closed without a deadline".to_owned());
        };
        tokio::select! {
            end = &mut serve => end,
            () = tokio::time::sleep_until(deadline) => End::Broken("drain timeout".to_owned()),
        }
    }

    /// One connection generation: the writer hands ops to the connection in
    /// queue order; replies come back on per-op tasks; the watchdog decides
    /// retirement. Ends when the connection breaks, stalls, or (closing) has
    /// nothing outstanding.
    async fn serve(self: &Arc<Self>, conn: Conn) -> End {
        let (broke_tx, mut broke_rx) = tokio::sync::mpsc::unbounded_channel::<String>();
        let replies = tokio::task::JoinSet::new();
        let replies = Arc::new(Mutex::new(replies));
        let writer = self.write_loop(conn.conn.clone(), broke_tx, Arc::clone(&replies));
        let watchdog = self.watchdog();
        let end = tokio::select! {
            end = writer => end,
            end = watchdog => end,
            kind = broke_rx.recv() => End::Broken(kind.unwrap_or_else(|| "closed".to_owned())),
        };
        // The reply tasks go first, then the driver (closing the socket).
        replies
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .abort_all();
        drop(conn);
        end
    }

    async fn write_loop(
        self: &Arc<Self>,
        conn: MultiplexedConnection,
        broke: tokio::sync::mpsc::UnboundedSender<String>,
        replies: Arc<Mutex<tokio::task::JoinSet<()>>>,
    ) -> End {
        loop {
            let next = {
                let mut st = self.state();
                if st.mode == Mode::Closing && st.used.commands == 0 {
                    return End::Drained;
                }
                match st.pending.pop_front() {
                    Some(mut op) => {
                        if st.in_flight.is_empty() {
                            st.last_progress = Instant::now();
                        }
                        let id = op.id;
                        let (req, retry) = match &mut op.kind {
                            OpKind::Call { retry, .. } => (op.req.take(), retry.take()),
                            OpKind::Ping => (op.req.take(), None),
                            OpKind::Release { .. } => (op.req.clone(), None),
                        };
                        st.in_flight.push_back(op);
                        req.map(|req| (id, req, retry))
                    }
                    None => None,
                }
            };
            // Finished reply tasks are reaped here, so the set holds at most
            // the outstanding ops.
            {
                let mut set = replies.lock().unwrap_or_else(PoisonError::into_inner);
                while set.try_join_next().is_some() {}
            }
            let Some((id, req, retry)) = next else {
                tokio::select! {
                    () = self.wake_writer.notified() => {}
                    () = tokio::time::sleep(self.opts.heartbeat) => self.ping_if_idle(),
                }
                continue;
            };
            // Hand the op to the connection *on this task*, polling its
            // request future here until it is inside the crate's send channel
            // (see `Handoff`); only then does its reply wait move to a task
            // of its own. The next op is handed over strictly after this one,
            // by this one task, so the channel — and the socket — see the
            // queue's order.
            let mut fut = request(&conn, &req);
            let handed = Handoff { fut: &mut fut }.await;
            let me = Arc::clone(self);
            let broke = broke.clone();
            match handed {
                Some(reply) => me.reply(id, reply, retry, &broke),
                None => {
                    replies
                        .lock()
                        .unwrap_or_else(PoisonError::into_inner)
                        .spawn(async move {
                            let reply = fut.await;
                            me.reply(id, reply, retry, &broke);
                        });
                }
            }
        }
    }

    fn ping_if_idle(&self) {
        let mut st = self.state();
        if st.mode == Mode::Up && st.used.commands == 0 {
            let req = Wire::One(redis::cmd("PING"));
            let cost = wire_cost(&req);
            st.charge(cost);
            let id = st.next_id;
            st.next_id += 1;
            st.pending.push_back(Op {
                id,
                retry_bytes: 0,
                req: Some(req),
                cost,
                kind: OpKind::Ping,
            });
            drop(st);
            self.wake_writer.notify_one();
        }
    }

    /// Settles the op `id` with its reply. A `NOSCRIPT` on an awaited
    /// `EVALSHA` is resubmitted once as `EVAL`.
    fn reply(
        &self,
        id: u64,
        reply: Result<Value, RedisError>,
        retry: Option<Cmd>,
        broke: &tokio::sync::mpsc::UnboundedSender<String>,
    ) {
        if let Err(e) = &reply
            && is_connection_error(e)
        {
            // The generation is over; `retire` settles every op, this one
            // included. The receiver is gone only if serve already ended.
            if broke.send(format!("{:?}", e.kind())).is_err() {
                tracing::trace!(coord = "redis", "reply after the generation ended");
            }
            return;
        }
        let op = {
            let mut st = self.state();
            st.last_progress = Instant::now();
            let Some(at) = st.in_flight.iter().position(|op| op.id == id) else {
                return;
            };
            let Some(mut op) = st.in_flight.remove(at) else {
                return;
            };
            // A cache miss on an awaited EVALSHA with its fallback in hand:
            // the fallback goes to the back of the queue as a new op that
            // *keeps* the bytes already charged for it (a transfer — it was
            // budgeted at acceptance, so it cannot be refused now). Only the
            // EVALSHA's own share is refunded.
            //
            // Not when closing: the retry would be a new admission, which a
            // closing link refuses; the caller gets the NOSCRIPT fault.
            let noscript = matches!(&reply, Err(e) if is_noscript(e));
            if let (true, Some(whole), OpKind::Call { .. }, Mode::Up) =
                (noscript, retry.as_ref(), &op.kind, st.mode)
            {
                let kept = Cost {
                    commands: 1,
                    bytes: op.retry_bytes,
                };
                let OpKind::Call { tx, .. } = std::mem::replace(&mut op.kind, OpKind::Ping) else {
                    unreachable!("matched OpKind::Call above")
                };
                st.refund(Cost {
                    commands: op.cost.commands.saturating_sub(1),
                    bytes: op.cost.bytes.saturating_sub(op.retry_bytes),
                });
                let id = st.next_id;
                st.next_id += 1;
                st.pending.push_back(Op {
                    id,
                    retry_bytes: 0,
                    req: Some(Wire::One(whole.clone())),
                    cost: kept,
                    kind: OpKind::Call { tx, retry: None },
                });
                drop(st);
                self.progress.notify_waiters();
                self.wake_writer.notify_one();
                return;
            }
            st.refund(op.cost);
            if st.mode == Mode::Closing && st.used.commands == 0 {
                // `notify_one` stores a permit: the writer cannot miss it.
                self.wake_writer.notify_one();
            }
            op
        };
        self.progress.notify_waiters();
        match (op.kind, reply) {
            (OpKind::Call { tx, .. }, reply) => {
                let out = reply.map_err(|e| server_fault(&e));
                // The caller may have given up at its deadline.
                if tx.send(out).is_err() {
                    tracing::trace!(coord = "redis", "reply after the caller's deadline");
                }
            }
            (OpKind::Release { .. }, Err(_)) => self.release_dropped(1, "server error"),
            (OpKind::Release { .. } | OpKind::Ping, Ok(_)) | (OpKind::Ping, Err(_)) => {}
        }
    }

    /// Watches the connection while it serves; returns when it must be
    /// retired.
    async fn watchdog(&self) -> End {
        let tick = (self.opts.command_timeout / 4).max(Duration::from_millis(5));
        let mut interval = tokio::time::interval(tick);
        loop {
            interval.tick().await;
            let silent = {
                let st = self.state();
                !st.in_flight.is_empty() && st.last_progress.elapsed() > self.opts.command_timeout
            };
            if !silent {
                continue;
            }
            let client = self.client.clone();
            let timeout = self.opts.connect_timeout;
            let limits = self.limits();
            let mut probe = AbortOnDrop(self.runtime.spawn(async move {
                matches!(
                    tokio::time::timeout(timeout, probe_server(&client, limits)).await,
                    Ok(Ok(()))
                )
            }));
            // Any reply on this connection meanwhile clears the suspicion.
            let answered = loop {
                let before = self.state().last_progress;
                tokio::select! {
                    alive = &mut probe.0 => break alive.unwrap_or(false),
                    () = self.progress.notified() => {
                        if self.state().last_progress != before {
                            break false;
                        }
                    }
                }
            };
            if !answered {
                continue;
            }
            // The server answers a fresh connection while this one, owing
            // replies, has completed none past the deadline. A server that
            // was stalled and just resumed answers both at about the same
            // time; a short grace keeps a connection that is flowing again.
            let before = self.state().last_progress;
            let grace = (self.opts.command_timeout / 4).max(Duration::from_millis(20));
            tokio::time::sleep(grace).await;
            // Final recheck: still owing replies, and none completed.
            let st = self.state();
            if !st.in_flight.is_empty() && st.last_progress == before {
                return End::Stalled;
            }
        }
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
            let mut refund = Cost::default();
            for op in st.in_flight.drain(..).collect::<Vec<_>>() {
                match op.kind {
                    OpKind::Call { tx, .. } => {
                        refund.commands += op.cost.commands;
                        refund.bytes += op.cost.bytes;
                        calls.push((tx, true));
                    }
                    OpKind::Release { idempotent: true } => keep.push_back(op),
                    OpKind::Release { idempotent: false } => {
                        refund.commands += op.cost.commands;
                        refund.bytes += op.cost.bytes;
                        uncertain += 1;
                    }
                    OpKind::Ping => {
                        refund.commands += op.cost.commands;
                        refund.bytes += op.cost.bytes;
                    }
                }
            }
            for op in st.pending.drain(..).collect::<Vec<_>>() {
                match op.kind {
                    OpKind::Call { tx, .. } => {
                        refund.commands += op.cost.commands;
                        refund.bytes += op.cost.bytes;
                        calls.push((tx, false));
                    }
                    OpKind::Release { .. } => keep.push_back(op),
                    OpKind::Ping => {
                        refund.commands += op.cost.commands;
                        refund.bytes += op.cost.bytes;
                    }
                }
            }
            st.refund(refund);
            st.pending = keep;
            (calls, uncertain)
        };
        self.progress.notify_waiters();
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
            st.used = Cost::default();
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

    /// The reply bounds every connection's guard enforces.
    pub(crate) fn limits(&self) -> super::guard::Limits {
        super::guard::Limits {
            reply_bytes: self.opts.max_reply_bytes,
            reply_nodes: self.opts.max_reply_elements,
            depth: 16,
            line: 4 * 1024,
        }
    }

    /// Connects (the `redis` crate's handshake: AUTH, SELECT) and loads
    /// every script (TS `loadScripts`), checking each digest, under the
    /// connect timeout.
    async fn open(&self) -> Result<Conn, Fault> {
        let attempt = async {
            let mut conn =
                connect(&self.client, self.limits(), self.opts.queue_capacity + 1).await?;
            for script in &self.scripts {
                let sha: Result<String, RedisError> = redis::cmd("SCRIPT")
                    .arg("LOAD")
                    .arg(script.source)
                    .query_async(&mut conn.conn)
                    .await;
                match sha {
                    Ok(sha) if sha == script.sha => {}
                    Ok(_) => return Err(Fault::Server("script digest mismatch".to_owned())),
                    Err(e) if is_connection_error(&e) => {
                        return Err(Fault::Connection(format!("{:?}", e.kind())));
                    }
                    Err(e) => return Err(server_fault(&e)),
                }
            }
            Ok(conn)
        };
        match tokio::time::timeout(self.opts.connect_timeout, attempt).await {
            Err(_) => Err(Fault::TimedOut),
            Ok(out) => out,
        }
    }
}

/// One connection generation: the `redis` crate's multiplexed connection
/// over a [`Guarded`](super::guard::Guarded) socket, and its driver task,
/// which is aborted (closing the socket) when this is dropped.
pub(crate) struct Conn {
    pub(crate) conn: MultiplexedConnection,
    driver: tokio::task::JoinHandle<()>,
}

impl Drop for Conn {
    fn drop(&mut self) {
        self.driver.abort();
    }
}

/// Connects over TCP or verified TLS, wraps the stream in the reply guard, and runs
/// the `redis` crate's handshake (AUTH, SELECT) on it. Our deadlines only:
/// the crate's own response timeout is off. The send channel is sized above
/// the queue's command capacity so the writer never finds it full.
async fn connect(
    client: &redis::Client,
    limits: super::guard::Limits,
    send_queue: usize,
) -> Result<Conn, Fault> {
    let info = client.get_connection_info();
    let stream = verified_stream(info.addr())
        .await
        .map_err(|e| Fault::Connection(format!("{:?}", e.kind())))?;
    let guarded = super::guard::Guarded::new(stream, limits);
    let config = AsyncConnectionConfig::new()
        .set_response_timeout(None)
        .set_pipeline_buffer_size(send_queue.max(1));
    let (conn, driver) =
        MultiplexedConnection::new_with_config(info.redis_settings(), guarded, config)
            .await
            .map_err(|e| {
                if is_connection_error(&e) {
                    Fault::Connection(format!("{:?}", e.kind()))
                } else {
                    server_fault(&e)
                }
            })?;
    Ok(Conn {
        conn,
        driver: tokio::spawn(driver),
    })
}

/// The request future for `req`: the `redis` crate's `query_async`, which
/// sends into the connection's channel and then awaits the reply.
fn request(conn: &MultiplexedConnection, req: &Wire) -> BoxFuture<Result<Value, RedisError>> {
    let mut conn = conn.clone();
    match req {
        Wire::One(cmd) => {
            let cmd = cmd.clone();
            Box::pin(async move { cmd.query_async::<Value>(&mut conn).await })
        }
        Wire::Many(pipe) => {
            let pipe = pipe.clone();
            Box::pin(async move {
                pipe.query_async::<Vec<Value>>(&mut conn)
                    .await
                    .map(Value::Array)
            })
        }
    }
}

/// Polls a request future until it is *in the send channel*: resolves to
/// `Some(reply)` if it completed outright, `None` once it is waiting on its
/// reply.
///
/// Why one poll suffices (redis-rs 1.4.0, `MultiplexedConnection`, no
/// concurrency limiter, no client cache, response timeout off — all as
/// `connect` configures it): `query_async` → `send_packed_command(s)` →
/// `Pipeline::send_recv`, whose first await is `mpsc::Sender::send` on the
/// connection's bounded channel and whose second is the reply `oneshot`.
/// `send` completes on its first poll whenever the channel has a free slot
/// and the task's cooperative budget is not exhausted. The budget is lifted
/// by polling under [`tokio::task::coop::unconstrained`]; the channel always
/// has a free slot because it is sized `queue_capacity + 1` and at most
/// `queue_capacity` ops are ever outstanding, each one channel message (the
/// driver may lag in *draining* it, but never has more than that queued).
/// So the first `Pending` is the reply wait.
///
/// "At most `queue_capacity` outstanding" holds because every op is
/// charged from submission until *its reply* settles it: no-response
/// commands, which the crate answers at once while their request still sits
/// in the channel, are refused at submission (`Fault::Invalid`); a timed-out
/// caller's op stays charged until its reply arrives; a `NOSCRIPT` retry
/// takes over its original's charge only after the original's reply.
///
/// This is an assumption about redis-rs internals, so it is pinned: the
/// exact `redis = "=1.4.0"` in `Cargo.toml` (an upgrade must re-check it),
/// and the regression tests
/// `round2::releases_precede_later_admissions_under_concurrent_load`,
/// `round3::release_then_immediate_reacquire_of_the_same_key_under_backpressure`
/// and `round3::no_response_commands_stay_charged_and_cannot_break_release_order`.
struct Handoff<'a> {
    fut: &'a mut BoxFuture<Result<Value, RedisError>>,
}

impl Future for Handoff<'_> {
    type Output = Option<Result<Value, RedisError>>;

    fn poll(
        mut self: Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Self::Output> {
        let fut = &mut *self.fut;
        let polled = tokio::task::coop::unconstrained(fut.as_mut());
        tokio::pin!(polled);
        match polled.poll(cx) {
            std::task::Poll::Ready(out) => std::task::Poll::Ready(Some(out)),
            std::task::Poll::Pending => std::task::Poll::Ready(None),
        }
    }
}

/// A `PING` answered on a fresh connection: the server is alive.
async fn probe_server(client: &redis::Client, limits: super::guard::Limits) -> Result<(), Fault> {
    let mut probe = connect(client, limits, 4).await?;
    let pong: Result<Value, RedisError> = redis::cmd("PING").query_async(&mut probe.conn).await;
    pong.map(drop).map_err(|e| server_fault(&e))
}

/// A spawned probe that dies with the watchdog that started it.
struct AbortOnDrop(tokio::task::JoinHandle<bool>);

impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        self.0.abort();
    }
}

pub(crate) fn is_noscript(e: &RedisError) -> bool {
    e.kind() == ErrorKind::Server(ServerErrorKind::NoScript)
}

/// Whether the connection the error came from is unusable.
fn is_connection_error(e: &RedisError) -> bool {
    e.is_io_error() || e.is_connection_dropped() || e.is_unrecoverable_error()
}

/// A server error reply as a fault: its code (`NOSCRIPT`, `WRONGTYPE`,
/// `ERR`…), never its text — a script error's text can carry argument
/// values. A pipeline error carries its first command's code.
pub(crate) fn server_fault(e: &RedisError) -> Fault {
    Fault::Server(
        e.code()
            .map_or_else(|| format!("{:?}", e.kind()), str::to_owned),
    )
}

/// TS `reseedAfterOutage`: debits made while Redis was away were dropped by
/// the memory fallback, so every bucket hash goes and the next admission
/// reseeds from the store. Boxed: it calls `call`, which spawns it.
fn reseed_after_outage(link: Arc<Link>) -> BoxFuture<()> {
    Box::pin(async move {
        if sweep_buckets(&link).await.is_err() {
            link.note_lost_debit();
        }
    })
}

pub(crate) async fn sweep_buckets(link: &Arc<Link>) -> Result<(), Fault> {
    let deadline = tokio::time::Instant::now() + link.opts.command_timeout * 10;
    let pattern = format!("{}*", super::key("b", ""));
    let keys = scan(link, &pattern, deadline).await?;
    for chunk in keys.chunks(512) {
        let mut unlink = redis::cmd("UNLINK");
        unlink.arg(chunk);
        link.call_until(Request::One(unlink), deadline).await?;
    }
    Ok(())
}

/// Every key matching `pattern`: `SCAN`, never `KEYS`, every page under the
/// one `deadline`. Keys found are deduplicated (`SCAN` may repeat one), and
/// at most `MAX_SCAN_KEYS` are collected: past that it is `Fault::TooLarge`.
pub(crate) async fn scan(
    link: &Arc<Link>,
    pattern: &str,
    deadline: tokio::time::Instant,
) -> Result<Vec<String>, Fault> {
    const MAX_SCAN_KEYS: usize = 1_000_000;
    let mut out = HashSet::new();
    let mut cursor = "0".to_owned();
    loop {
        let mut cmd = redis::cmd("SCAN");
        cmd.arg(&cursor)
            .arg("MATCH")
            .arg(pattern)
            .arg("COUNT")
            .arg(1_000);
        let page = link.call_until(Request::One(cmd), deadline).await?;
        let Value::Array(mut parts) = page else {
            return Err(Fault::Server("unexpected reply to SCAN".to_owned()));
        };
        let (Some(Value::Array(keys)), Some(Value::BulkString(next))) = (parts.pop(), parts.pop())
        else {
            return Err(Fault::Server("unexpected reply to SCAN".to_owned()));
        };
        for key in keys {
            if let Value::BulkString(k) = key {
                out.insert(String::from_utf8_lossy(&k).into_owned());
            }
        }
        if out.len() > MAX_SCAN_KEYS {
            return Err(Fault::TooLarge);
        }
        cursor = String::from_utf8_lossy(&next).into_owned();
        if cursor == "0" {
            return Ok(out.into_iter().collect());
        }
    }
}

pub(crate) const RECONNECT_MIN: Duration = Duration::from_millis(50);
pub(crate) const RECONNECT_MAX: Duration = Duration::from_secs(2);

/// Whether `req` contains a command flagged no-response.
fn no_response(req: &Wire) -> bool {
    match req {
        Wire::One(cmd) => cmd.is_no_response(),
        Wire::Many(pipe) => pipe.cmd_iter().any(Cmd::is_no_response),
    }
}

/// The pub/sub connection: TCP or verified TLS through the same reply guard as the
/// command connection, then the `redis` crate's RESP2 `PubSub` (AUTH, SELECT
/// handshake included).
pub(crate) async fn connect_pubsub(
    client: &redis::Client,
    limits: super::guard::Limits,
) -> Result<redis::aio::PubSub, RedisError> {
    let info = client.get_connection_info();
    let stream = verified_stream(info.addr()).await?;
    redis::aio::PubSub::new(
        info.redis_settings(),
        super::guard::Guarded::new(stream, limits),
    )
    .await
}

trait Transport: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send {}
impl<T: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send> Transport for T {}

/// Wrap TLS before the RESP reply guard, so plaintext limits apply identically
/// on both command and pubsub connections. Never accept URL insecure bypass.
async fn verified_stream(addr: &redis::ConnectionAddr) -> std::io::Result<Box<dyn Transport>> {
    use std::io::{Error, ErrorKind};
    let (host, port, tls) = match addr {
        redis::ConnectionAddr::Tcp(host, port) => (host, *port, false),
        redis::ConnectionAddr::TcpTls {
            host,
            port,
            insecure: false,
            ..
        } => (host, *port, true),
        _ => {
            return Err(Error::new(
                ErrorKind::InvalidInput,
                "unsupported Redis transport",
            ));
        }
    };
    let stream = tokio::net::TcpStream::connect((host.as_str(), port)).await?;
    stream.set_nodelay(true)?;
    if !tls {
        return Ok(Box::new(stream));
    }
    let mut roots = rustls::RootCertStore::empty();
    for cert in rustls_native_certs::load_native_certs().certs {
        let _result = roots.add(cert);
    }
    let config = rustls::ClientConfig::builder_with_provider(std::sync::Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .map_err(Error::other)?
    .with_root_certificates(roots)
    .with_no_client_auth();
    let name = rustls::pki_types::ServerName::try_from(host.clone())
        .map_err(|_| Error::new(ErrorKind::InvalidInput, "invalid Redis TLS hostname"))?;
    let stream = tokio_rustls::TlsConnector::from(std::sync::Arc::new(config))
        .connect(name, stream)
        .await?;
    Ok(Box::new(stream))
}

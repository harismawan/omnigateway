//! The writer task, its handle, and its lifecycle.
//!
//! An async loop gathers events into a batch and hands the batch with the
//! connection to `spawn_blocking`, which writes it in one transaction and hands
//! the connection back. One batch is in flight at a time; events arriving
//! meanwhile wait in the bounded channel, stamped with when they were queued,
//! so the next batch's deadline counts from its oldest event's enqueue rather
//! than from when the writer got round to it.

use super::batch;
use super::events::{Committed, SeedQuery, SeedRows, WriteEvent};
use crate::error::StoreError;
use rusqlite::{Connection, ErrorCode};
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;
use tokio::time::{Instant, sleep, sleep_until};

/// Attempts per batch when the database is busy or locked.
const MAX_ATTEMPTS: u32 = 3;
/// First retry delay; doubled for each later one.
const RETRY_BASE: Duration = Duration::from_millis(100);

/// How the writer batches. [`Default`]: 200 ms (the spec's) or 4096 events.
///
/// 4096 rather than the spec's 512: a batch's cost is mostly the pages it
/// dirties, and `request_logs` has a random primary key (`req_<uuid v4>`), so
/// each row dirties one more leaf of it. Bigger batches share those pages and
/// the per-transaction fixed cost: on one quiet core, bench-shaped requests,
/// 512 committed ~47 k events/s and 4096 (with the checkpoint below) ~76 k.
/// The 200 ms bound on how long an event waits is unchanged.
#[derive(Debug, Clone)]
pub struct WriterConfig {
    /// `request_logs.node_id` for every row this process files.
    pub node_id: String,
    /// The fixed offset `usage_daily` days are cut at.
    pub day_offset_minutes: i64,
    /// Channel capacity, in events: what may be pending while the database
    /// stalls. A full channel drops, never waits. 131 072 events is ~3 s of
    /// the gateway's 20 k requests/s (two events each), so a stall of the
    /// disk under the WAL's fsync (XFS log flushes of up to ~1 s were seen on
    /// the bench host) queues instead of shedding; a longer outage still
    /// sheds. The channel allocates in blocks as it fills, so an idle writer
    /// holds little of it.
    ///
    /// **It bounds events, not bytes.** What a full queue holds:
    /// - **slots**: 360 bytes each (a 344-byte [`WriteEvent`] plus its
    ///   enqueue time), ~45 MiB for 131 072;
    /// - **payload** each event owns on the heap, on top: its id and model
    ///   strings and, for a Finish, its `degradations` and `rtk_filters`
    ///   lists. A bench-shaped event's six short strings (a 40-byte id, the
    ///   key, model, provider and credential) are ~120-200 bytes with
    ///   allocator rounding, ~15-25 MiB for a full queue; there is no fixed
    ///   maximum, since the strings are the
    ///   request's own (a model name, say, is as long as the client sent and
    ///   the snapshot allowed), so the worst case grows with them.
    pub capacity: usize,
    /// Most events per batch.
    pub max_batch: usize,
    /// Longest an event waits, from its enqueue, before its batch is written
    /// (plus the write itself, and any write already in flight).
    pub interval: Duration,
    /// The writer connection's `busy_timeout`; the TS pragma's 5 s by default.
    pub busy_timeout: Duration,
    /// How often the writer's checkpointer copies the WAL back into the
    /// database (`wal_checkpoint(PASSIVE)` on a connection of its own, on a
    /// thread of its own). Off the batch path, so no batch's commit pays for
    /// a checkpoint: with SQLite's in-commit auto-checkpoint, one batch in
    /// several stalled 80-900 ms at bench rates and the channel filled
    /// behind it. `None` leaves checkpoints to `wal_autocheckpoint` alone.
    /// Like it, this cannot shrink a WAL that an open reader pins.
    pub checkpoint_every: Option<Duration>,
    /// The writer connection's `wal_autocheckpoint`, in pages: a **trigger**,
    /// not a bound. Once a commit leaves the WAL at this many pages or more,
    /// that commit runs a passive checkpoint (a backstop when the checkpointer
    /// runs, the only checkpoint when it does not). 10 000 pages is ~40 MiB.
    ///
    /// It does **not** bound the WAL. A passive checkpoint copies only frames
    /// no open reader still needs, and the WAL restarts from its start only
    /// once every frame is copied; while some connection holds a read
    /// transaction open, the WAL keeps growing past this, however often a
    /// checkpoint runs (`a_pinned_reader_lets_the_wal_grow_past_the_trigger`).
    /// TS's `bun:sqlite` default auto-checkpoint behaves the same way.
    pub wal_autocheckpoint: u32,
    /// At most one dropped-event warning per this long.
    pub drop_warn_interval: Duration,
    /// Where committed completions and seed reads go, in the order they
    /// happened (the rate limiter). `None` sends nothing.
    ///
    /// The writer never waits on it: everything is `try_send`.
    ///
    /// - A full sink drops a batch's debits (counted in `sink_dropped`).
    ///   Their rows are committed, so the next seed of those subjects reads
    ///   them; until then the windows under-count by them.
    /// - A full sink drops a seed result (counted in `seeds_dropped`). The
    ///   limiter treats it as a failed seed: the window stays unseeded, so it
    ///   ignores debits, and is asked again after its seed timeout.
    ///
    /// Either is warned at most once per `drop_warn_interval`. Under a
    /// sustained full sink long-window limits are therefore not enforced
    /// until the limiter drains: fail-open, the direction TS takes on a
    /// coordinator fault. `1m` and `concurrency` never depend on the sink.
    pub commit_sink: Option<mpsc::Sender<Committed>>,
    /// Added to every seed read. Zero in production; tests use it to make a
    /// seed slow while completions keep queuing behind it.
    pub seed_delay: Duration,
}

impl Default for WriterConfig {
    fn default() -> Self {
        Self {
            node_id: String::new(),
            day_offset_minutes: 0,
            capacity: 131_072,
            max_batch: 4096,
            interval: Duration::from_millis(200),
            busy_timeout: Duration::from_secs(5),
            checkpoint_every: Some(Duration::from_millis(20)),
            wal_autocheckpoint: 10_000,
            drop_warn_interval: Duration::from_secs(10),
            commit_sink: None,
            seed_delay: Duration::ZERO,
        }
    }
}

/// What the writer has done so far.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct WriterStats {
    /// Events accepted into the channel (seed reads aside). After a
    /// [`WriterHandle::flush`] barrier, `enqueued == written + failed`.
    pub enqueued: u64,
    /// Events refused because the channel was full or the writer had closed.
    /// The full total: the rate-limited warning may not have reported the
    /// last of them (see [`Writer::close`]).
    pub dropped: u64,
    /// Transactions committed.
    pub batches: u64,
    /// Events in committed batches.
    pub written: u64,
    /// Events accepted into the channel whose batch could not be persisted
    /// (after retrying a busy database). Distinct from `dropped`.
    pub failed: u64,
    /// Health rows the foreign key refused: no such credential, which TS's
    /// `updateHealth` would also have thrown on.
    pub health_refused: u64,
    /// Committed completions the commit sink had no room for.
    pub sink_dropped: u64,
    /// Seed results the commit sink had no room for.
    pub seeds_dropped: u64,
}

#[derive(Debug)]
struct Counters {
    enqueued: AtomicU64,
    dropped: AtomicU64,
    batches: AtomicU64,
    written: AtomicU64,
    failed: AtomicU64,
    health_refused: AtomicU64,
    sink_dropped: AtomicU64,
    seeds_dropped: AtomicU64,
}

impl Counters {
    fn new() -> Self {
        Self {
            enqueued: AtomicU64::new(0),
            dropped: AtomicU64::new(0),
            batches: AtomicU64::new(0),
            written: AtomicU64::new(0),
            failed: AtomicU64::new(0),
            health_refused: AtomicU64::new(0),
            sink_dropped: AtomicU64::new(0),
            seeds_dropped: AtomicU64::new(0),
        }
    }

    fn snapshot(&self) -> WriterStats {
        WriterStats {
            enqueued: self.enqueued.load(Ordering::Relaxed),
            dropped: self.dropped.load(Ordering::Relaxed),
            batches: self.batches.load(Ordering::Relaxed),
            written: self.written.load(Ordering::Relaxed),
            failed: self.failed.load(Ordering::Relaxed),
            health_refused: self.health_refused.load(Ordering::Relaxed),
            sink_dropped: self.sink_dropped.load(Ordering::Relaxed),
            seeds_dropped: self.seeds_dropped.load(Ordering::Relaxed),
        }
    }
}

/// The dropped-event warning, emitted from the writer task only: the request
/// path just bumps `dropped`, so a subscriber doing blocking output can never
/// stall it. Checked on a tick whether or not the writer has work, and at most
/// one warning per `every`, carrying the drops since the last one.
struct DropWarner {
    every: Duration,
    last: Option<Instant>,
    reported: u64,
}

impl DropWarner {
    fn new(every: Duration) -> Self {
        Self {
            every,
            last: None,
            reported: 0,
        }
    }

    /// How often to look: twice per interval, so timer jitter cannot push a
    /// due warning out by a whole interval.
    fn tick_period(&self) -> Duration {
        (self.every / 2).max(Duration::from_millis(1))
    }

    /// Warns if there are unreported drops and the interval has passed. Never
    /// two warnings inside one interval, on close included: drops a closing
    /// writer could not yet warn about are not lost, only unwarned — they are
    /// in `dropped`, which [`Writer::close`] returns as the full total.
    fn check(&mut self, counters: &Counters) {
        let total = counters.dropped.load(Ordering::Relaxed);
        if total <= self.reported {
            return;
        }
        let due = self.last.is_none_or(|l| l.elapsed() >= self.every);
        if !due {
            return;
        }
        // TS `LogFields` names: `count` is dropped since the last warning,
        // `rawCount` the total ever dropped.
        tracing::warn!(
            count = total - self.reported,
            rawCount = total,
            "request log writer is full; events dropped (count since the last warning, rawCount in total)"
        );
        self.reported = total;
        self.last = Some(Instant::now());
    }
}

/// An event and when it was queued.
#[derive(Debug)]
struct Queued {
    at: Instant,
    item: Item,
}

/// The bytes one queue slot takes (the [`WriterConfig::capacity`] docs).
pub fn queue_slot_bytes() -> usize {
    std::mem::size_of::<Queued>()
}

/// What travels the channel: an event, or a [`WriterHandle::flush`] barrier
/// answered once everything queued before it is committed.
#[derive(Debug)]
// Nearly every item is an event; boxing it to shrink the rare barrier would
// cost an allocation per event.
#[allow(clippy::large_enum_variant)]
enum Item {
    Event(WriteEvent),
    Barrier(oneshot::Sender<WriterStats>),
}

/// The request path's side: cheap to clone, and [`Self::send`] never waits.
#[derive(Debug, Clone)]
pub struct WriterHandle {
    tx: mpsc::Sender<Queued>,
    counters: Arc<Counters>,
}

impl WriterHandle {
    /// Queues an event. `false` means it was dropped (channel full, or the
    /// writer closed) and counted in [`Self::dropped`]; the writer task warns
    /// about it later, rate-limited. Nothing here but the `try_send` and an
    /// atomic add.
    pub fn send(&self, event: impl Into<WriteEvent>) -> bool {
        let event = event.into();
        let counted = !matches!(event, WriteEvent::Seed(_));
        let queued = Queued {
            at: Instant::now(),
            item: Item::Event(event),
        };
        match self.tx.try_send(queued) {
            Ok(()) => {
                if counted {
                    self.counters.enqueued.fetch_add(1, Ordering::Relaxed);
                }
                true
            }
            Err(_) => {
                self.counters.dropped.fetch_add(1, Ordering::Relaxed);
                false
            }
        }
    }

    /// A barrier: waits until every event accepted before this call is
    /// committed (or counted failed), then returns the cumulative counters.
    /// It goes through the channel like an event, so it waits for queue room
    /// (it is never dropped), and it ends the batch it lands in, so it is
    /// answered without waiting out the batch interval. `Err` when the writer
    /// has closed.
    ///
    /// Not for the request path, which never waits on the writer: the bench
    /// harness calls it (`POST /__omni/bench/flush`, only with `OMNI_BENCH=1`)
    /// to read exact per-scenario drop counts.
    pub async fn flush(&self) -> Result<WriterStats, StoreError> {
        let (tx, rx) = oneshot::channel();
        let queued = Queued {
            at: Instant::now(),
            item: Item::Barrier(tx),
        };
        let closed = || StoreError::Writer("writer closed".into());
        self.tx.send(queued).await.map_err(|_| closed())?;
        rx.await.map_err(|_| closed())
    }

    /// Queues a long-window seed read, run on the writer's connection after
    /// every event queued before it is committed. `false` means it was not
    /// queued (channel full or closed): ask again later. Never waits.
    pub fn seed(&self, query: SeedQuery) -> bool {
        self.send(WriteEvent::Seed(query))
    }

    /// Events dropped so far.
    pub fn dropped(&self) -> u64 {
        self.counters.dropped.load(Ordering::Relaxed)
    }

    pub fn stats(&self) -> WriterStats {
        self.counters.snapshot()
    }
}

/// The running writer. Call [`Self::close`] to flush on shutdown; dropping it
/// instead also flushes, but nobody waits for that to finish.
#[derive(Debug)]
pub struct Writer {
    handle: WriterHandle,
    shutdown: Option<oneshot::Sender<()>>,
    task: JoinHandle<Result<(), StoreError>>,
    checkpointer: Option<Checkpointer>,
}

/// The background checkpoint thread and the flag that stops it.
#[derive(Debug)]
struct Checkpointer {
    stop: Arc<std::sync::atomic::AtomicBool>,
    thread: std::thread::JoinHandle<()>,
}

impl Checkpointer {
    /// Starts a thread that runs `wal_checkpoint(PASSIVE)` on its own
    /// connection every `every`. Passive: it never waits on the writer or on
    /// a reader, copying only what no reader still needs, so it cannot stall
    /// a batch; the writer's commits only append to the WAL meanwhile.
    fn spawn(path: &Path, every: Duration) -> Result<Self, StoreError> {
        let conn = crate::open_connection(path)?;
        let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let flag = Arc::clone(&stop);
        let thread = std::thread::Builder::new()
            .name("omni-checkpoint".into())
            .spawn(move || {
                let mut failing = false;
                while !flag.load(Ordering::Relaxed) {
                    std::thread::park_timeout(every);
                    match conn.query_row("PRAGMA wal_checkpoint(PASSIVE)", [], |_| Ok(())) {
                        Ok(()) => failing = false,
                        // Busy is the normal answer while another checkpoint
                        // runs; anything else is reported once per streak,
                        // and the writer's own backstop still checkpoints.
                        Err(e) if !failing => {
                            failing = true;
                            tracing::warn!(reason = %e, "request log checkpoint failed; retrying");
                        }
                        Err(_) => {}
                    }
                }
            })
            .map_err(|e| StoreError::Writer(format!("checkpoint thread: {e}")))?;
        Ok(Self { stop, thread })
    }

    fn stop(self) {
        self.stop.store(true, Ordering::Relaxed);
        self.thread.thread().unpark();
        // A panic there has nothing to hand back; the writer is unaffected.
        self.thread.join().ok();
    }
}

impl Writer {
    /// Opens its own connection to the (already migrated) database at `path`
    /// and starts the task on the current Tokio runtime.
    pub fn spawn(path: impl AsRef<Path>, config: WriterConfig) -> Result<Self, StoreError> {
        let conn = crate::open_connection(path.as_ref())?;
        conn.busy_timeout(config.busy_timeout)?;
        conn.pragma_update(None, "wal_autocheckpoint", config.wal_autocheckpoint)?;
        let checkpointer = config
            .checkpoint_every
            .map(|every| Checkpointer::spawn(path.as_ref(), every))
            .transpose()?;
        let (tx, rx) = mpsc::channel(config.capacity.max(1));
        let (shutdown, stop) = oneshot::channel();
        let counters = Arc::new(Counters::new());
        let task = tokio::spawn(run(conn, rx, stop, config, Arc::clone(&counters)));
        Ok(Self {
            handle: WriterHandle { tx, counters },
            shutdown: Some(shutdown),
            task,
            checkpointer,
        })
    }

    pub fn handle(&self) -> WriterHandle {
        self.handle.clone()
    }

    /// Stops accepting events, writes everything already queued, and returns
    /// the final counters. `Err` when any of that failed to persist —
    /// including a batch already being written (or retried) when the close
    /// arrived, whose outcome this waits for; the counters then still say how
    /// much.
    ///
    /// The returned `dropped` is the total ever dropped. The drop warning
    /// keeps its minimum interval at shutdown too, so drops in the last
    /// interval before the close may have had no warning; the caller reports
    /// them from this.
    pub async fn close(mut self) -> Result<WriterStats, StoreError> {
        if let Some(s) = self.shutdown.take() {
            // An Err means the task already ended; the join below reports why.
            s.send(()).ok();
        }
        let task = &mut self.task;
        let ended = task.await;
        if let Some(c) = self.checkpointer.take() {
            // Joins within one checkpoint; the writer's connection closing
            // after it checkpoints whatever is left.
            tokio::task::spawn_blocking(move || c.stop()).await.ok();
        }
        ended.map_err(|e| StoreError::Writer(format!("writer task ended abnormally: {e}")))??;
        Ok(self.handle.counters.snapshot())
    }
}

/// A writer dropped without [`Writer::close`] still stops its checkpointer
/// (without waiting for it), so no thread outlives it.
impl Drop for Writer {
    fn drop(&mut self) {
        if let Some(c) = self.checkpointer.take() {
            c.stop.store(true, Ordering::Relaxed);
            c.thread.thread().unpark();
        }
    }
}

/// `SQLITE_BUSY` / `SQLITE_LOCKED`: another connection holds the lock, and
/// the same batch may well commit a moment later.
fn transient(e: &StoreError) -> bool {
    matches!(
        e,
        StoreError::Sqlite(rusqlite::Error::SqliteFailure(f, _))
            if matches!(f.code, ErrorCode::DatabaseBusy | ErrorCode::DatabaseLocked)
    )
}

/// Owns the connection between batches; `None` only while one is in flight.
struct Sink {
    conn: Option<Connection>,
    node_id: Arc<str>,
    day_offset_minutes: i64,
    counters: Arc<Counters>,
    commit_sink: Option<mpsc::Sender<Committed>>,
    sink_warned: Option<Instant>,
    sink_warn_every: Duration,
    seed_delay: Duration,
}

impl Sink {
    /// Writes a batch that may contain seed requests: the events before each
    /// seed are flushed (and their completions delivered) first, then the
    /// seed is read and its result delivered, so the sink sees one ordered
    /// story. Returns the events lost.
    async fn flush_ordered(&mut self, events: Vec<WriteEvent>) -> Result<u64, StoreError> {
        let mut lost = 0;
        let mut run = Vec::with_capacity(events.len());
        for e in events {
            match e {
                WriteEvent::Seed(q) => {
                    lost += self.flush(std::mem::take(&mut run)).await?;
                    self.seed(q).await?;
                }
                other => run.push(other),
            }
        }
        lost += self.flush(run).await?;
        Ok(lost)
    }

    /// One seed read, in one read transaction on the writer's connection.
    async fn seed(&mut self, query: SeedQuery) -> Result<(), StoreError> {
        let conn = self
            .conn
            .take()
            .ok_or_else(|| StoreError::Writer("writer connection lost".into()))?;
        let q = query.clone();
        let delay = self.seed_delay;
        let (conn, result) = tokio::task::spawn_blocking(move || {
            if !delay.is_zero() {
                std::thread::sleep(delay);
            }
            let r = crate::usage::seed_rows(
                &conn,
                &q.api_key_id,
                q.since_ms,
                q.grain_ms,
                q.requested_model.as_deref(),
                q.stamp_cap,
            );
            (conn, r)
        })
        .await
        .map_err(|e| StoreError::Writer(format!("seed read panicked: {e}")))?;
        self.conn = Some(conn);
        let result = result
            .map(|(buckets, stamps)| SeedRows { buckets, stamps })
            .map_err(|e| e.to_string());
        if let Some(sink) = &self.commit_sink
            && let Err(mpsc::error::TrySendError::Full(_)) =
                sink.try_send(Committed::Seed { query, result })
        {
            // Never waited on: the limiter times the seed out and asks again.
            let total = self.counters.seeds_dropped.fetch_add(1, Ordering::Relaxed) + 1;
            self.warn_sink_full("seed", 1, total);
        }
        Ok(())
    }

    /// At most one sink-full warning per `drop_warn_interval`.
    fn warn_sink_full(&mut self, what: &str, n: u64, total: u64) {
        if self
            .sink_warned
            .is_some_and(|t| t.elapsed() < self.sink_warn_every)
        {
            return;
        }
        self.sink_warned = Some(Instant::now());
        tracing::warn!(
            count = n,
            rawCount = total,
            reason = %format!("{what} dropped"),
            "rate limiter commit sink full; dropped (long-window limits fail open until it drains; count since the last warning, rawCount in total)"
        );
    }

    fn deliver(&mut self, completions: Vec<super::events::Completion>) {
        let Some(sink) = &self.commit_sink else {
            return;
        };
        if completions.is_empty() {
            return;
        }
        let n = completions.len() as u64;
        if let Err(mpsc::error::TrySendError::Full(_)) =
            sink.try_send(Committed::Completions(completions))
        {
            let total = self.counters.sink_dropped.fetch_add(n, Ordering::Relaxed) + n;
            self.warn_sink_full("completions", n, total);
        }
    }

    /// Writes `events` off the async threads, retrying a busy database with
    /// backoff. Returns how many events were lost (0 when it committed). Only
    /// losing the connection itself ends the writer.
    async fn flush(&mut self, mut events: Vec<WriteEvent>) -> Result<u64, StoreError> {
        let n = events.len() as u64;
        if n == 0 {
            return Ok(0);
        }
        let mut attempt = 1;
        loop {
            let mut conn = self
                .conn
                .take()
                .ok_or_else(|| StoreError::Writer("writer connection lost".into()))?;
            let node_id = Arc::clone(&self.node_id);
            let offset = self.day_offset_minutes;
            let (conn, back, result) = tokio::task::spawn_blocking(move || {
                let result = batch::write(&mut conn, &events, &node_id, offset);
                (conn, events, result)
            })
            .await
            .map_err(|e| StoreError::Writer(format!("batch write panicked: {e}")))?;
            self.conn = Some(conn);
            events = back;
            let c = Arc::clone(&self.counters);
            match result {
                Ok(outcome) => {
                    self.deliver(outcome.completions);
                    c.batches.fetch_add(1, Ordering::Relaxed);
                    c.written.fetch_add(n, Ordering::Relaxed);
                    c.health_refused
                        .fetch_add(outcome.health_refused, Ordering::Relaxed);
                    return Ok(0);
                }
                Err(e) if transient(&e) && attempt < MAX_ATTEMPTS => {
                    let delay = RETRY_BASE * 2u32.pow(attempt - 1);
                    tracing::warn!(
                        count = n,
                        attempt,
                        retryAfterMs = u64::try_from(delay.as_millis()).unwrap_or(u64::MAX),
                        reason = %e,
                        "request log batch hit a busy database; retrying (count events)"
                    );
                    sleep(delay).await;
                    attempt += 1;
                }
                Err(e) => {
                    c.failed.fetch_add(n, Ordering::Relaxed);
                    tracing::error!(
                        count = n,
                        attempts = attempt,
                        reason = %e,
                        "request log batch failed to persist; its events are lost (count events)"
                    );
                    return Ok(n);
                }
            }
        }
    }
}

/// `sink.flush`, still looking at the drop counter on the tick meanwhile: a
/// stalled database is exactly when the channel fills, and a flush retrying a
/// busy one can take several `busy_timeout`s.
async fn flush_watching(
    sink: &mut Sink,
    batch: Vec<WriteEvent>,
    warner: &mut DropWarner,
    tick: &mut tokio::time::Interval,
    counters: &Counters,
) -> Result<u64, StoreError> {
    let flush = sink.flush_ordered(batch);
    tokio::pin!(flush);
    let lost = loop {
        tokio::select! {
            biased;
            r = &mut flush => break r?,
            _ = tick.tick() => warner.check(counters),
        }
    };
    warner.check(counters);
    Ok(lost)
}

/// Sorts one channel item into the batch or the barriers waiting on it.
fn take(item: Item, batch: &mut Vec<WriteEvent>, barriers: &mut Vec<oneshot::Sender<WriterStats>>) {
    match item {
        Item::Event(e) => batch.push(e),
        Item::Barrier(b) => barriers.push(b),
    }
}

/// Answers barriers once the batch before them is written.
fn answer(barriers: Vec<oneshot::Sender<WriterStats>>, counters: &Counters) {
    for b in barriers {
        // A caller that gave up waiting is no one's concern.
        b.send(counters.snapshot()).ok();
    }
}

/// Whether the stop was signalled (or its sender dropped) without waiting.
/// Only called on a receiver that has not yet completed.
fn stop_arrived(stop: &mut oneshot::Receiver<()>) -> bool {
    !matches!(
        stop.try_recv(),
        Err(tokio::sync::oneshot::error::TryRecvError::Empty)
    )
}

async fn run(
    conn: Connection,
    mut rx: mpsc::Receiver<Queued>,
    mut stop: oneshot::Receiver<()>,
    config: WriterConfig,
    counters: Arc<Counters>,
) -> Result<(), StoreError> {
    let max_batch = config.max_batch.max(1);
    let mut sink = Sink {
        conn: Some(conn),
        node_id: Arc::from(config.node_id.as_str()),
        day_offset_minutes: config.day_offset_minutes,
        counters: Arc::clone(&counters),
        commit_sink: config.commit_sink.clone(),
        sink_warned: None,
        sink_warn_every: config.drop_warn_interval,
        seed_delay: config.seed_delay,
    };
    // Events lost from flushes the close waited on: any in flight when the
    // stop arrived, and the drain after it.
    let mut lost_on_close = 0;
    let mut warner = DropWarner::new(config.drop_warn_interval);
    let mut warn_tick = tokio::time::interval(warner.tick_period());
    warn_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

    'running: loop {
        // Idle until the first event of the next batch, or the stop.
        let first = tokio::select! {
            biased;
            _ = &mut stop => break 'running,
            e = rx.recv() => match e {
                Some(e) => e,
                None => break 'running,
            },
            _ = warn_tick.tick() => {
                warner.check(&counters);
                continue 'running;
            }
        };
        // From the oldest event's enqueue: one that queued behind a slow
        // write is already due, and goes out with the next write.
        let deadline = first.at + config.interval;
        let mut batch = Vec::with_capacity(max_batch);
        // Barriers end the batch they land in and are answered after it.
        let mut barriers = Vec::new();
        take(first.item, &mut batch, &mut barriers);
        let mut stopping = false;
        while batch.len() < max_batch && barriers.is_empty() {
            if let Ok(e) = rx.try_recv() {
                take(e.item, &mut batch, &mut barriers);
                continue;
            }
            tokio::select! {
                biased;
                _ = &mut stop => { stopping = true; break; }
                () = sleep_until(deadline) => break,
                e = rx.recv() => match e {
                    Some(e) => take(e.item, &mut batch, &mut barriers),
                    None => break,
                },
                _ = warn_tick.tick() => warner.check(&counters),
            }
        }
        let lost = flush_watching(&mut sink, batch, &mut warner, &mut warn_tick, &counters).await?;
        answer(barriers, &counters);
        // A stop that arrived while this batch was being written (or retried)
        // waited on its outcome, so its loss is the close's to report.
        if stopping || stop_arrived(&mut stop) {
            lost_on_close += lost;
            break 'running;
        }
    }

    // Graceful flush: refuse new events, then write what was already queued.
    rx.close();
    loop {
        let mut batch = Vec::with_capacity(max_batch);
        let mut barriers = Vec::new();
        let mut ended = false;
        while batch.len() < max_batch && barriers.is_empty() {
            match rx.recv().await {
                Some(e) => take(e.item, &mut batch, &mut barriers),
                None => {
                    ended = true;
                    break;
                }
            }
        }
        if !batch.is_empty() {
            lost_on_close +=
                flush_watching(&mut sink, batch, &mut warner, &mut warn_tick, &counters).await?;
        }
        answer(barriers, &counters);
        if ended {
            break;
        }
    }
    // A last look, still rate-limited: drops inside the current interval go
    // unwarned here and are reported by `close()`'s `dropped` total instead.
    warner.check(&counters);
    if lost_on_close > 0 {
        return Err(StoreError::Writer(format!(
            "{lost_on_close} queued events failed to persist on close"
        )));
    }
    Ok(())
}

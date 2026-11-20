//! The writer task, its handle, and its lifecycle.
//!
//! An async loop gathers events into a batch and hands the batch with the
//! connection to `spawn_blocking`, which writes it in one transaction and hands
//! the connection back. One batch is in flight at a time; events arriving
//! meanwhile wait in the bounded channel, stamped with when they were queued,
//! so the next batch's deadline counts from its oldest event's enqueue rather
//! than from when the writer got round to it.

use super::batch;
use super::epoch::{Entered, Epochs, Produced};
use super::events::{Committed, SeedQuery, SeedRows, WriteEvent};
use crate::error::StoreError;
use rusqlite::ErrorCode;
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
    /// Successful log calls, after the transaction commits; independent of the
    /// limiter sink. Called once per batch, with no per-row allocation.
    pub log_observer: Option<Arc<dyn LogObserver>>,
    /// `request_logs.node_id` for every row this process files.
    pub node_id: String,
    /// The fixed offset `usage_daily` days are cut at.
    pub day_offset_minutes: i64,
    /// Channel capacity, in events: what may be pending while the database
    /// stalls. PG shares this budget with terminal reservations, which wait
    /// before admission. SQLite retains its nonwaiting queue. 131 072 events is ~1.2 s of
    /// the gateway's ~55 k requests/s at full rate (two events each, so
    /// ~110 k events/s), enough to ride out the 0.5–1 s stalls of the disk
    /// under the WAL's fsync seen on the bench host (XFS log flushes); a
    /// longer outage still sheds. The channel allocates in blocks as it fills,
    /// so an idle writer holds little of it.
    ///
    /// **It bounds events, not bytes.** What a full queue holds:
    /// - **slots**: see [`queue_slot_bytes`] (the [`WriteEvent`] plus its
    ///   enqueue time, barrier epoch, and optional PG reservation);
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
    /// PG retains one committed batch while it waits for sink capacity. A
    /// closed consumer is counted in `sink_dropped`. SQLite keeps its
    /// nonwaiting delivery and reports a gap after a full sink drains.
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
            log_observer: None,
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

/// Resource notifications are not debits or queue acknowledgments.
pub trait LogObserver: std::fmt::Debug + Send + Sync {
    fn committed(&self, logs: usize, finishes: usize);
}

/// What the writer has done so far.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct WriterStats {
    /// Events accepted into the channel (seed reads aside).
    pub enqueued: u64,
    /// Seed reads refused because the channel was full or closed. Not
    /// events: they never enter `dropped` or barrier accounting.
    pub seeds_refused: u64,
    /// Events refused because the channel was full or the writer had closed.
    /// The full total: the rate-limited warning may not have reported the
    /// last of them (see [`Writer::close`]).
    pub dropped: u64,
    pub terminal_dropped: u64,
    pub optional_dropped: u64,
    /// Transactions committed.
    pub batches: u64,
    /// Transactions abandoned after the database refused the batch or retries ran out.
    pub failed_batches: u64,
    /// Events in committed batches.
    pub written: u64,
    /// Events accepted into the channel whose batch could not be persisted
    /// (after retrying a busy database). Distinct from `dropped`.
    pub failed: u64,
    /// Health rows the foreign key refused: no such credential, which TS's
    /// `updateHealth` would also have thrown on.
    pub health_refused: u64,
    /// Log events refused for their values (Postgres: a number its column
    /// cannot hold) while the rest of their batch committed. Not persisted:
    /// each is also counted in `failed`, never in `written`.
    pub refused: u64,
    /// Completions lost to a full (SQLite) or closed (Postgres) debit sink.
    pub sink_dropped: u64,
    /// Seed results the commit sink had no room for.
    pub seeds_dropped: u64,
}

#[derive(Debug)]
struct Counters {
    callbacks: std::sync::Mutex<tokio::task::JoinSet<()>>,
    /// Barrier accounting, lock-free on the producer side (see `epoch.rs`).
    epochs: Epochs,
    /// Committed and failed events per epoch not yet folded into a barrier's
    /// answer, and the folded total. The writer task's alone: producers never
    /// touch it.
    resolved: std::sync::Mutex<Resolved>,
    /// A barrier is admitted and not yet answered.
    barrier_busy: std::sync::atomic::AtomicBool,
    enqueued: AtomicU64,
    seeds_refused: AtomicU64,
    dropped: AtomicU64,
    terminal_dropped: AtomicU64,
    optional_dropped: AtomicU64,
    batches: AtomicU64,
    failed_batches: AtomicU64,
    written: AtomicU64,
    failed: AtomicU64,
    health_refused: AtomicU64,
    refused: AtomicU64,
    sink_dropped: AtomicU64,
    seeds_dropped: AtomicU64,
}

impl Counters {
    fn new() -> Self {
        Self {
            callbacks: std::sync::Mutex::new(tokio::task::JoinSet::new()),
            epochs: Epochs::default(),
            resolved: std::sync::Mutex::new(Resolved::default()),
            barrier_busy: std::sync::atomic::AtomicBool::new(false),
            enqueued: AtomicU64::new(0),
            seeds_refused: AtomicU64::new(0),
            dropped: AtomicU64::new(0),
            terminal_dropped: AtomicU64::new(0),
            optional_dropped: AtomicU64::new(0),
            batches: AtomicU64::new(0),
            failed_batches: AtomicU64::new(0),
            written: AtomicU64::new(0),
            failed: AtomicU64::new(0),
            health_refused: AtomicU64::new(0),
            refused: AtomicU64::new(0),
            sink_dropped: AtomicU64::new(0),
            seeds_dropped: AtomicU64::new(0),
        }
    }

    fn snapshot(&self) -> WriterStats {
        WriterStats {
            enqueued: self.enqueued.load(Ordering::Relaxed),
            seeds_refused: self.seeds_refused.load(Ordering::Relaxed),
            dropped: self.dropped.load(Ordering::Relaxed),
            terminal_dropped: self.terminal_dropped.load(Ordering::Relaxed),
            optional_dropped: self.optional_dropped.load(Ordering::Relaxed),
            batches: self.batches.load(Ordering::Relaxed),
            failed_batches: self.failed_batches.load(Ordering::Relaxed),
            written: self.written.load(Ordering::Relaxed),
            failed: self.failed.load(Ordering::Relaxed),
            health_refused: self.health_refused.load(Ordering::Relaxed),
            refused: self.refused.load(Ordering::Relaxed),
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
    /// The barrier epoch an event was published in; `None` for a seed or a
    /// barrier.
    epoch: Option<u64>,
    // PG counts both enqueued entries and pre-admission reservations against
    // one budget. Receiving the entry returns its credit.
    _credit: Option<tokio::sync::OwnedSemaphorePermit>,
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
    Fence(super::events::CommitFence),
    Event(WriteEvent),
    Barrier(Pending),
}

/// A barrier waiting in the queue: its epoch and the producer-side totals of
/// its prefix (final at admission), where to answer, and the busy flag it
/// holds until it is answered or discarded.
#[derive(Debug)]
struct Pending {
    fence: Option<super::events::CommitFence>,
    epoch: u64,
    produced: Produced,
    reply: oneshot::Sender<Barrier>,
    /// Held for its `Drop`, which frees the one-barrier slot.
    _busy: Option<BusyGuard>,
}

/// Clears `barrier_busy` when the barrier is answered or dropped unanswered.
#[derive(Debug)]
struct BusyGuard(Arc<Counters>);

impl Drop for BusyGuard {
    fn drop(&mut self) {
        self.0.barrier_busy.store(false, Ordering::Release);
    }
}

/// A [`WriterHandle::flush`] answer: the outcome of every event of the
/// barrier's prefix (every event whose producer entered an epoch up to the
/// barrier's, see `epoch.rs`): `watermark` events, of which `committed +
/// failed + dropped == watermark`, exactly, whatever was sent meanwhile.
/// `refused` is the part of `failed` the database refused for its values
/// while the rest of their batch committed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Barrier {
    pub watermark: u64,
    pub committed: u64,
    pub failed: u64,
    pub refused: u64,
    pub dropped: u64,
}

/// Why a barrier was not answered.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BarrierError {
    /// Another barrier is in flight; one at a time.
    Busy,
    /// The queue had no room. A barrier never waits for room, so it cannot
    /// reserve capacity ahead of the request path's events.
    Full,
    /// The writer has closed.
    Closed,
}

/// The request path's side: cheap to clone, and [`Self::send`] never waits.
#[derive(Debug, Clone)]
pub struct WriterHandle {
    tx: mpsc::Sender<Queued>,
    counters: Arc<Counters>,
    terminal: Option<Arc<tokio::sync::Semaphore>>,
    waiters: Option<Arc<tokio::sync::Semaphore>>,
}

/// A Postgres terminal slot acquired before starting work. Its send never
/// waits, including from a cancelled request's destructor.
pub struct FinishSlot(tokio::sync::OwnedSemaphorePermit);

#[derive(Debug, Clone, Copy)]
pub enum ReserveError {
    Full,
    Deadline,
    Closed,
}

pub enum FinishReservation<const N: usize> {
    Sqlite,
    Postgres([FinishSlot; N]),
}

/// One turn in the bounded PG slow path. Hold it through key revalidation
/// and any larger reservation that a policy change requires.
pub struct FinishWaiter<'a> {
    writer: &'a WriterHandle,
    _turn: tokio::sync::SemaphorePermit<'a>,
}

impl FinishWaiter<'_> {
    pub async fn reserve<const N: usize>(
        &self,
        deadline: Instant,
    ) -> Result<FinishReservation<N>, ReserveError> {
        if Instant::now() >= deadline {
            return Err(ReserveError::Deadline);
        }
        let writer = self.writer;
        assert!(N <= writer.tx.max_capacity());
        let credits = writer.terminal.as_ref().expect("PG credits");
        let reserve = async {
            tokio::select! {
                biased;
                () = writer.tx.closed() => Err(ReserveError::Closed),
                permit = credits.clone().acquire_many_owned(u32::try_from(N).expect("finish slot count")) =>
                    permit.map_err(|_| ReserveError::Closed),
            }
        };
        let reserved = tokio::time::timeout_at(deadline, reserve)
            .await
            .map_err(|_| ReserveError::Deadline)??;
        if Instant::now() >= deadline {
            return Err(ReserveError::Deadline);
        }
        if writer.postgres_closed() {
            return Err(ReserveError::Closed);
        }
        Ok(finish_reservation(reserved))
    }
}

fn finish_reservation<const N: usize>(
    mut permit: tokio::sync::OwnedSemaphorePermit,
) -> FinishReservation<N> {
    FinishReservation::Postgres(std::array::from_fn(|_| {
        FinishSlot(permit.split(1).expect("reserved finish slot"))
    }))
}

impl<const N: usize> FinishReservation<N> {
    pub fn into_slots(self) -> [Option<FinishSlot>; N] {
        match self {
            Self::Sqlite => std::array::from_fn(|_| None),
            Self::Postgres(slots) => slots.map(Some),
        }
    }
}

// Stay within the shortest inference keepalive interval and below PG's 5 s
// statement timeout: a stalled statement must not hold these HTTP waiters open.
pub const FINISH_WAIT: Duration = Duration::from_secs(4);

impl WriterHandle {
    /// Reserve the entire request's terminal row set atomically, before
    /// taking admission. Dropping a pending reservation or unused slots
    /// returns the credits. SQLite needs no reservation.
    pub fn try_reserve_finishes<const N: usize>(
        &self,
    ) -> Result<FinishReservation<N>, ReserveError> {
        let Some(credits) = &self.terminal else {
            return Ok(FinishReservation::Sqlite);
        };
        assert!(N <= self.tx.max_capacity());
        if self.tx.is_closed() {
            return Err(ReserveError::Closed);
        }
        let reserved = credits
            .clone()
            .try_acquire_many_owned(u32::try_from(N).expect("finish slot count"))
            .map_err(|e| match e {
                tokio::sync::TryAcquireError::Closed => ReserveError::Closed,
                tokio::sync::TryAcquireError::NoPermits => ReserveError::Full,
            })?;
        Ok(finish_reservation(reserved))
    }

    pub async fn reserve_finishes<const N: usize>(
        &self,
    ) -> Result<FinishReservation<N>, ReserveError> {
        match self.try_reserve_finishes() {
            Err(ReserveError::Full) => {
                self.finish_waiter()?
                    .reserve(Instant::now() + FINISH_WAIT)
                    .await
            }
            other => other,
        }
    }

    /// Call only after a PG reservation hit pressure.
    pub fn finish_waiter(&self) -> Result<FinishWaiter<'_>, ReserveError> {
        let waiters = self.waiters.as_ref().ok_or(ReserveError::Closed)?;
        if self.postgres_closed() {
            return Err(ReserveError::Closed);
        }
        let turn = waiters.try_acquire().map_err(|_| ReserveError::Full)?;
        Ok(FinishWaiter {
            writer: self,
            _turn: turn,
        })
    }

    pub fn postgres_closed(&self) -> bool {
        self.terminal
            .as_ref()
            .is_some_and(|credits| credits.is_closed() || self.tx.is_closed())
    }

    pub fn finish(&self, slot: Option<FinishSlot>, log: super::events::RequestLog) -> bool {
        let Some(FinishSlot(permit)) = slot else {
            return self.send(super::events::LogEvent::Finish(log));
        };
        let c = &self.counters;
        let entered = c.epochs.enter();
        let ok = self
            .tx
            .try_send(Queued {
                at: Instant::now(),
                item: Item::Event(super::events::LogEvent::Finish(log).into()),
                epoch: Some(entered.0),
                _credit: Some(permit),
            })
            .is_ok();
        if ok {
            c.enqueued.fetch_add(1, Ordering::Relaxed);
        } else {
            c.dropped.fetch_add(1, Ordering::Relaxed);
            c.terminal_dropped.fetch_add(1, Ordering::Relaxed);
        }
        c.epochs.leave(entered, !ok);
        ok
    }
    /// Completion callbacks are joined before writer shutdown. No work or
    /// allocation on the ordinary (body logging disabled) send path.
    pub fn completion_callback(
        &self,
        future: impl std::future::Future<Output = ()> + Send + 'static,
    ) {
        let mut tasks = self
            .counters
            .callbacks
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        while tasks.try_join_next().is_some() {}
        tasks.spawn(future);
    }
    /// Wait for the queued prefix and its debit consumer, without using the
    /// singleton diagnostic flush barrier. Only body-enabled requests use it.
    pub async fn after_completions(&self) {
        let credit = if let Some(credits) = &self.terminal {
            let Ok(credit) = credits.clone().acquire_owned().await else {
                return;
            };
            Some(credit)
        } else {
            None
        };
        let fence = super::events::CommitFence(Arc::new(tokio::sync::Notify::new()));
        let queued = Queued {
            at: Instant::now(),
            item: Item::Fence(fence.clone()),
            epoch: None,
            _credit: credit,
        };
        if self.tx.send(queued).await.is_ok() {
            fence.0.notified().await;
        }
    }
    /// Queues an event. `false` means it was dropped (channel full, or the
    /// writer closed) and counted in [`Self::dropped`]; the writer task warns
    /// about it later, rate-limited. Nothing here but the `try_send` and an
    /// atomic add.
    ///
    /// PG request producers must use [`Self::reserve_finishes`] and
    /// [`Self::finish`] for terminal rows, not this best-effort path.
    ///
    /// Takes no lock and never waits: its barrier bookkeeping is a few
    /// atomics (`epoch.rs`). A seed read is not an event: it takes no part in
    /// barrier accounting, and a refused one is counted in `seeds_refused`.
    pub fn send(&self, event: impl Into<WriteEvent>) -> bool {
        let event = event.into();
        let c = &self.counters;
        let terminal = matches!(&event, WriteEvent::Log(super::events::LogEvent::Finish(_)));
        let optional = matches!(
            &event,
            WriteEvent::Log(
                super::events::LogEvent::Begin(_) | super::events::LogEvent::Route { .. }
            )
        );
        let credit = self.try_credit(optional);
        if matches!(event, WriteEvent::Seed(_)) {
            let ok = credit.is_ok_and(|credit| {
                self.tx
                    .try_send(Queued {
                        at: Instant::now(),
                        item: Item::Event(event),
                        epoch: None,
                        _credit: credit,
                    })
                    .is_ok()
            });
            if !ok {
                c.seeds_refused.fetch_add(1, Ordering::Relaxed);
            }
            return ok;
        }
        let entered: Entered = c.epochs.enter();
        let ok = credit.is_ok_and(|credit| {
            self.tx
                .try_send(Queued {
                    at: Instant::now(),
                    item: Item::Event(event),
                    epoch: Some(entered.0),
                    _credit: credit,
                })
                .is_ok()
        });
        if ok {
            c.enqueued.fetch_add(1, Ordering::Relaxed);
        } else {
            c.dropped.fetch_add(1, Ordering::Relaxed);
            if terminal {
                c.terminal_dropped.fetch_add(1, Ordering::Relaxed);
            }
            if optional {
                c.optional_dropped.fetch_add(1, Ordering::Relaxed);
            }
        }
        c.epochs.leave(entered, !ok);
        ok
    }

    fn try_credit(
        &self,
        optional: bool,
    ) -> Result<Option<tokio::sync::OwnedSemaphorePermit>, BarrierError> {
        let Some(credits) = &self.terminal else {
            return Ok(None);
        };
        // Preserve room for terminal reservations rather than another
        // pending-row write when the primary falls behind.
        if optional && credits.available_permits() <= self.tx.max_capacity() / 2 {
            return Err(BarrierError::Full);
        }
        credits
            .clone()
            .try_acquire_owned()
            .map(Some)
            .map_err(|e| match e {
                tokio::sync::TryAcquireError::Closed => BarrierError::Closed,
                tokio::sync::TryAcquireError::NoPermits => BarrierError::Full,
            })
    }

    /// A barrier: the outcome of every event of its prefix, once all of them
    /// are resolved (see [`Barrier`] and `epoch.rs`).
    ///
    /// - **One at a time:** a second while one is in flight is
    ///   [`BarrierError::Busy`]. The slot is held until the writer answers or
    ///   discards it, also if the caller stops waiting.
    /// - **Never blocks a producer, never blocks a thread.** Admission bumps
    ///   an epoch; it then waits, by yielding, for the producers already
    ///   inside the previous and the bumped epoch to finish (a `try_send` and
    ///   a few atomics each). Every wait is an `.await`, so a caller's
    ///   timeout can cancel it at any point; a cancelled barrier leaves the
    ///   next one to wait out its epoch.
    /// - **Enters the queue by `try_send`,** as every event does: a full queue
    ///   is [`BarrierError::Full`], so it cannot reserve capacity ahead of the
    ///   request path.
    /// - It ends the batch it lands in, and is answered after that batch is
    ///   written, when every event of its prefix is resolved.
    ///
    /// Not for the request path, which never waits on the writer: the bench
    /// harness calls it (`POST /__omni/bench/flush`, only with `OMNI_BENCH=1`).
    pub async fn flush(&self) -> Result<Barrier, BarrierError> {
        let c = &self.counters;
        if c.barrier_busy
            .compare_exchange(false, true, Ordering::Acquire, Ordering::Relaxed)
            .is_err()
        {
            return Err(BarrierError::Busy);
        }
        let busy = BusyGuard(Arc::clone(c));
        let phase = Instant::now();
        while !c.epochs.previous_settled() {
            tokio::task::yield_now().await;
        }
        let (epoch, before) = c.epochs.bump();
        while !c.epochs.settled(epoch) {
            tokio::task::yield_now().await;
        }
        let produced = c.epochs.prefix(epoch, before);
        if std::env::var_os("OMNI_WRITER_PHASES").is_some() {
            eprintln!("writer_phase settlement_us={}", phase.elapsed().as_micros());
        }
        let phase = Instant::now();
        let (tx, rx) = oneshot::channel();
        let queued = Queued {
            at: Instant::now(),
            item: Item::Barrier(Pending {
                fence: None,
                epoch,
                produced,
                reply: tx,
                _busy: Some(busy),
            }),
            epoch: None,
            _credit: self.try_credit(false)?,
        };
        match self.tx.try_send(queued) {
            Ok(()) => {}
            // The guard goes with the refused item, freeing the slot.
            Err(mpsc::error::TrySendError::Full(_)) => return Err(BarrierError::Full),
            Err(mpsc::error::TrySendError::Closed(_)) => return Err(BarrierError::Closed),
        }
        let result = rx.await.map_err(|_| BarrierError::Closed);
        if std::env::var_os("OMNI_WRITER_PHASES").is_some() {
            eprintln!(
                "writer_phase queue_and_commit_us={}",
                phase.elapsed().as_micros()
            );
        }
        result
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

    /// Postgres queue occupancy and credits in use, sampled independently.
    /// Credits cover both queued entries and reservations not yet enqueued.
    /// Scrapes are approximate under concurrent traffic; neither sample
    /// includes a batch already dequeued for persistence.
    pub fn postgres_pressure(&self) -> Option<(usize, usize)> {
        let credits = self.terminal.as_ref()?;
        let cap = self.tx.max_capacity();
        Some((cap - self.tx.capacity(), cap - credits.available_permits()))
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
        let conn = crate::lifecycle::shared(crate::SqliteStore::from_connection(
            crate::open_connection(path)?,
            path.to_path_buf(),
            0,
        ));
        let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let flag = Arc::clone(&stop);
        let thread = std::thread::Builder::new()
            .name("omni-checkpoint".into())
            .spawn(move || {
                let mut failing = false;
                while !flag.load(Ordering::Relaxed) {
                    std::thread::park_timeout(every);
                    match conn
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner)
                        .connection()
                        .query_row("PRAGMA wal_checkpoint(PASSIVE)", [], |_| Ok(()))
                    {
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
        let task = tokio::spawn(run(
            Backend::Sqlite(crate::lifecycle::shared(
                crate::SqliteStore::from_connection(
                    conn,
                    path.as_ref().to_path_buf(),
                    config.day_offset_minutes,
                ),
            )),
            rx,
            stop,
            config,
            Arc::clone(&counters),
        ));
        Ok(Self {
            handle: WriterHandle {
                tx,
                counters,
                terminal: None,
                waiters: None,
            },
            shutdown: Some(shutdown),
            task,
            checkpointer,
        })
    }

    /// The same writer over a (migrated) Postgres store: each batch takes a
    /// pooled connection for its transaction (`pg_batch.rs`). Terminal rows
    /// reserve queue capacity and the commit sink retains its debits. `busy_timeout`,
    /// `checkpoint_every` and `wal_autocheckpoint` are SQLite's and ignored;
    /// the pool's statement and wait timeouts bound a stalled server instead,
    /// and a timed-out batch is retried like a busy one.
    pub fn spawn_postgres(
        store: crate::pg::PgStore,
        config: WriterConfig,
    ) -> Result<Self, StoreError> {
        let capacity = config.capacity.max(3);
        let (tx, rx) = mpsc::channel(capacity);
        let (shutdown, stop) = oneshot::channel();
        let counters = Arc::new(Counters::new());
        let terminal = Arc::new(tokio::sync::Semaphore::new(capacity));
        // One waiting HTTP request per default-sized writer batch of credits
        // (32 by default). Waiters hold connections, not just queue entries.
        let waiters = Arc::new(tokio::sync::Semaphore::new(
            capacity.div_ceil(WriterConfig::default().max_batch),
        ));
        let task = tokio::spawn({
            let terminal = terminal.clone();
            let counters = counters.clone();
            async move {
                let result = run(Backend::Postgres(store), rx, stop, config, counters).await;
                terminal.close();
                result
            }
        });
        Ok(Self {
            handle: WriterHandle {
                tx,
                counters,
                terminal: Some(terminal),
                waiters: Some(waiters),
            },
            shutdown: Some(shutdown),
            task,
            checkpointer: None,
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
        let mut tasks = {
            let mut tasks = self
                .handle
                .counters
                .callbacks
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            std::mem::take(&mut *tasks)
        };
        while tasks.join_next().await.is_some() {}
        if let Some(s) = self.shutdown.take() {
            // An Err means the task already ended; the join below reports why.
            s.send(()).ok();
        }
        if let Some(credits) = &self.handle.terminal {
            credits.close();
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
        if let Some(credits) = &self.handle.terminal {
            credits.close();
        }
        if let Some(c) = self.checkpointer.take() {
            c.stop.store(true, Ordering::Relaxed);
            c.thread.thread().unpark();
        }
    }
}

/// `SQLITE_BUSY` / `SQLITE_LOCKED`: another connection holds the lock, and
/// the same batch may well commit a moment later. On Postgres the same
/// class: another writer won a row race ([`StoreError::Conflict`]), a
/// serialization failure or deadlock, a lock or statement timeout, or no
/// connection to be had right now (pool wait, a dropped connection).
pub(crate) fn transient(e: &StoreError) -> bool {
    match e {
        StoreError::Sqlite(rusqlite::Error::SqliteFailure(f, _)) => {
            matches!(f.code, ErrorCode::DatabaseBusy | ErrorCode::DatabaseLocked)
        }
        StoreError::Conflict(_) | StoreError::Pool(_) => true,
        StoreError::Postgres(e) => {
            // A lost connection or a socket error is transient; a client-side
            // conversion error (no SQLSTATE, not I/O) is a bug, not retried.
            let io = std::error::Error::source(e).is_some_and(|s| s.is::<std::io::Error>());
            e.is_closed() || io || e.code().is_some_and(transient_sqlstate)
        }
        _ => false,
    }
}

/// The SQLSTATEs [`transient`] retries. From class 40, exactly the COMMIT
/// allowlist ([`crate::pg::health::COMMIT_RETRYABLE`]: serialization
/// failure, deadlock); the rest are errors a statement *before* COMMIT
/// returns (a lock or statement timeout, a server shutting down or not yet
/// accepting), which cannot have committed. A COMMIT's own error reaches
/// this only when it is on that allowlist: the health path turns every
/// other one into `UncertainCommit` or `Refused` first.
pub(crate) fn transient_sqlstate(c: &tokio_postgres::error::SqlState) -> bool {
    use tokio_postgres::error::SqlState;
    crate::pg::health::COMMIT_RETRYABLE.contains(c)
        || [
            SqlState::LOCK_NOT_AVAILABLE,
            SqlState::QUERY_CANCELED,
            SqlState::ADMIN_SHUTDOWN,
            SqlState::CANNOT_CONNECT_NOW,
        ]
        .contains(c)
}

/// Where a batch goes: the SQLite connection the writer owns (`None` only
/// while a batch is in flight on the blocking pool), or a Postgres pool.
enum Backend {
    Sqlite(Arc<std::sync::Mutex<crate::SqliteStore>>),
    Postgres(crate::pg::PgStore),
}

/// Owns the connection between batches.
struct Sink {
    log_observer: Option<Arc<dyn LogObserver>>,
    backend: Backend,
    node_id: Arc<str>,
    day_offset_minutes: i64,
    counters: Arc<Counters>,
    commit_sink: Option<mpsc::Sender<Committed>>,
    delivery_gap: bool,
    sink_warned: Option<Instant>,
    sink_warn_every: Duration,
    seed_delay: Duration,
}

impl Sink {
    /// Writes a batch that may contain seed requests: the events before each
    /// seed are flushed (and their completions delivered) first, then the
    /// seed is read and its result delivered, so the sink sees one ordered
    /// story. Returns the events lost.
    ///
    /// Each transaction's events are counted committed or failed against
    /// their barrier epochs as soon as it ends.
    async fn flush_ordered(&mut self, events: Vec<Tagged>) -> Result<u64, StoreError> {
        let mut lost = 0;
        let mut run = Vec::with_capacity(events.len());
        let mut tags = Vec::with_capacity(events.len());
        for (e, epoch) in events {
            match e {
                WriteEvent::Seed(q) => {
                    let flushed = self.flush(std::mem::take(&mut run)).await?;
                    lost += resolve(&std::mem::take(&mut tags), &flushed, &self.counters);
                    self.seed(q).await?;
                }
                other => {
                    tags.push(epoch);
                    run.push(other);
                }
            }
        }
        let flushed = self.flush(run).await?;
        lost += resolve(&tags, &flushed, &self.counters);
        Ok(lost)
    }

    /// One seed read, in one read transaction on the writer's connection.
    async fn seed(&mut self, query: SeedQuery) -> Result<(), StoreError> {
        let q = query.clone();
        let delay = self.seed_delay;
        let result = match &mut self.backend {
            Backend::Sqlite(slot) => {
                let store = slot.clone();
                tokio::task::spawn_blocking(move || {
                    let store = store
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner);
                    if !delay.is_zero() {
                        std::thread::sleep(delay);
                    }
                    crate::usage::seed_rows(
                        store.connection(),
                        &q.api_key_id,
                        q.since_ms,
                        q.grain_ms,
                        q.requested_model.as_deref(),
                        q.stamp_cap,
                    )
                })
                .await
                .map_err(|e| StoreError::Writer(format!("seed read panicked: {e}")))?
            }
            Backend::Postgres(store) => {
                if !delay.is_zero() {
                    sleep(delay).await;
                }
                store
                    .seed_rows(
                        &q.api_key_id,
                        q.since_ms,
                        q.grain_ms,
                        q.requested_model.as_deref(),
                        q.stamp_cap,
                    )
                    .await
            }
        };
        let result = result
            .map(|(buckets, stamps)| SeedRows { buckets, stamps })
            .map_err(|e| e.to_string());
        self.recover_gap();
        if self.delivery_gap {
            self.counters.seeds_dropped.fetch_add(1, Ordering::Relaxed);
            return Ok(());
        }
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

    async fn deliver(&mut self, completions: Vec<super::events::Completion>) {
        if matches!(self.backend, Backend::Postgres(_)) {
            if let Some(sink) = &self.commit_sink
                && !completions.is_empty()
            {
                let n = completions.len() as u64;
                // One retained batch. Backpressure is bounded by the writer
                // FIFO, and close joins the consumer before the coordinator.
                if sink
                    .send(Committed::Completions(completions))
                    .await
                    .is_err()
                {
                    self.counters.sink_dropped.fetch_add(n, Ordering::Relaxed);
                    tracing::error!(count = n, "request log completion consumer stopped");
                }
            }
            return;
        }
        self.recover_gap();
        if self.delivery_gap {
            self.counters
                .sink_dropped
                .fetch_add(completions.len() as u64, Ordering::Relaxed);
            return;
        }
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
            self.delivery_gap = true;
            self.warn_sink_full("completions", n, total);
        }
    }

    /// Bounded nonwaiting recovery: a single sticky bit, emitted before any
    /// later delivery. A full sink prevents later messages too, preserving FIFO.
    fn recover_gap(&mut self) {
        if self.delivery_gap
            && let Some(sink) = &self.commit_sink
            && sink.try_send(Committed::Gap).is_ok()
        {
            self.delivery_gap = false;
        }
    }

    /// Writes `events` off the async threads, retrying a busy database with
    /// backoff. Returns what became of them. Only losing the connection
    /// itself ends the writer.
    #[allow(clippy::cast_precision_loss)]
    async fn flush(&mut self, mut events: Vec<WriteEvent>) -> Result<Flushed, StoreError> {
        let n = events.len() as u64;
        if n == 0 {
            return Ok(Flushed::Committed {
                refused: Vec::new(),
            });
        }
        let mut attempt = 1;
        loop {
            let node_id = Arc::clone(&self.node_id);
            let offset = self.day_offset_minutes;
            let result = match &mut self.backend {
                Backend::Sqlite(slot) => {
                    let store = slot.clone();
                    let (back, result) = tokio::task::spawn_blocking(move || {
                        let mut store = store
                            .lock()
                            .unwrap_or_else(std::sync::PoisonError::into_inner);
                        let phase = Instant::now();
                        let result =
                            batch::write(store.connection_mut(), &events, &node_id, offset);
                        if std::env::var_os("OMNI_WRITER_PHASES").is_some() {
                            eprintln!(
                                "writer_phase sql_us={} events={}",
                                phase.elapsed().as_micros(),
                                events.len()
                            );
                        }
                        (events, result)
                    })
                    .await
                    .map_err(|e| StoreError::Writer(format!("batch write panicked: {e}")))?;
                    events = back;
                    result
                }
                Backend::Postgres(store) => {
                    let phase = Instant::now();
                    let result = async {
                        let mut client = store.client().await?;
                        if std::env::var_os("OMNI_WRITER_PHASES").is_some() {
                            eprintln!(
                                "pg_pool_phase events={} pool_us={}",
                                events.len(),
                                phase.elapsed().as_micros()
                            );
                        }
                        super::pg_batch::write(&mut client, &events, &node_id, offset).await
                    }
                    .await;
                    if std::env::var_os("OMNI_WRITER_PHASES").is_some() {
                        eprintln!(
                            "writer_phase sql_us={} events={}",
                            phase.elapsed().as_micros(),
                            events.len()
                        );
                    }
                    result
                }
            };
            let c = Arc::clone(&self.counters);
            match result {
                Ok(outcome) => {
                    if let Some(observer) = &self.log_observer {
                        observer.committed(outcome.log_notifications, outcome.finish_notifications);
                    }
                    self.deliver(outcome.completions).await;
                    let refused = outcome.refused.len() as u64;
                    if refused != 0 {
                        self.deliver(
                            outcome
                                .refused
                                .iter()
                                .filter_map(|&i| failure_debit(&events[i]))
                                .collect(),
                        )
                        .await;
                    }
                    c.batches.fetch_add(1, Ordering::Relaxed);
                    c.written.fetch_add(n - refused, Ordering::Relaxed);
                    c.failed.fetch_add(refused, Ordering::Relaxed);
                    c.refused.fetch_add(refused, Ordering::Relaxed);
                    c.health_refused
                        .fetch_add(outcome.health_refused, Ordering::Relaxed);
                    if refused > 0 {
                        tracing::error!(
                            count = refused,
                            "request log events refused for their values; they are lost (count events)"
                        );
                    }
                    return Ok(Flushed::Committed {
                        refused: outcome.refused,
                    });
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
                    // Spending is independent of persistence, just as frozen
                    // finishLog debits even when usage.append throws.
                    let debits = events.iter().filter_map(failure_debit).collect();
                    self.deliver(debits).await;
                    c.failed_batches.fetch_add(1, Ordering::Relaxed);
                    c.failed.fetch_add(n, Ordering::Relaxed);
                    tracing::error!(
                        count = n,
                        attempts = attempt,
                        reason = %e,
                        "request log batch failed to persist; its events are lost (count events)"
                    );
                    return Ok(Flushed::Lost);
                }
            }
        }
    }
}

#[allow(clippy::cast_precision_loss)]
fn failure_debit(event: &WriteEvent) -> Option<super::events::Completion> {
    let WriteEvent::Log(super::events::LogEvent::Finish(log)) = event else {
        return None;
    };
    Some(super::events::Completion {
        commit_id: None,
        id: log.id.clone(),
        api_key_id: log.api_key_id.clone(),
        requested_model: log.requested_model.clone(),
        tokens: log.input_tokens as f64
            + log.output_tokens as f64
            + log.cache_read_tokens as f64
            + log.cache_write_tokens as f64,
        cost_usd: log.cost_usd,
        at: log.at as f64,
        debit_model: !log.model_unencodable,
    })
}

/// `sink.flush`, still looking at the drop counter on the tick meanwhile: a
/// stalled database is exactly when the channel fills, and a flush retrying a
/// busy one can take several `busy_timeout`s.
async fn flush_watching(
    sink: &mut Sink,
    batch: Vec<Tagged>,
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
fn take(q: Queued, batch: &mut Vec<Tagged>, barriers: &mut Vec<Pending>) {
    match q.item {
        Item::Event(e) => batch.push((e, q.epoch)),
        Item::Barrier(b) => barriers.push(b),
        Item::Fence(fence) => {
            let (reply, _) = oneshot::channel();
            barriers.push(Pending {
                fence: Some(fence),
                epoch: 0,
                produced: Produced::default(),
                reply,
                _busy: None,
            });
        }
    }
}

/// An event and its barrier epoch (`None` for a seed).
type Tagged = (WriteEvent, Option<u64>);

/// What became of one transaction's events.
#[derive(Debug)]
enum Flushed {
    /// The transaction committed; these events (by index) were refused for
    /// their values and are not in it.
    Committed { refused: Vec<usize> },
    /// The transaction did not commit: every event is lost.
    Lost,
}

/// Per epoch, and folded: events committed, failed, and refused (a subset
/// of failed).
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
struct Tally {
    committed: u64,
    failed: u64,
    refused: u64,
}

impl Tally {
    fn add(&mut self, o: Self) {
        self.committed += o.committed;
        self.failed += o.failed;
        self.refused += o.refused;
    }
}

/// Resolved counts per epoch not yet folded into a barrier's answer, and the
/// total of epochs already answered.
#[derive(Debug, Default)]
struct Resolved {
    by_epoch: std::collections::BTreeMap<u64, Tally>,
    answered: Tally,
}

/// After one transaction: each event (tagged with its epoch, `None` for
/// none) committed, failed with it, or refused alone, counted against its
/// epoch. Returns how many were lost.
fn resolve(tags: &[Option<u64>], flushed: &Flushed, counters: &Counters) -> u64 {
    let mut resolved = counters
        .resolved
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let refused: std::collections::HashSet<usize> = match flushed {
        Flushed::Committed { refused } => refused.iter().copied().collect(),
        Flushed::Lost => std::collections::HashSet::new(),
    };
    let mut lost = 0;
    for (i, epoch) in tags.iter().enumerate() {
        let one = match flushed {
            Flushed::Lost => Tally {
                failed: 1,
                ..Tally::default()
            },
            Flushed::Committed { .. } if refused.contains(&i) => Tally {
                failed: 1,
                refused: 1,
                ..Tally::default()
            },
            Flushed::Committed { .. } => Tally {
                committed: 1,
                ..Tally::default()
            },
        };
        lost += one.failed;
        if let Some(epoch) = epoch {
            resolved.by_epoch.entry(*epoch).or_default().add(one);
        }
    }
    // No future barrier can ask for a prefix older than the previous
    // epoch. Fold older resolved outcomes even when admission was refused
    // or cancelled; otherwise those attempts grow this map indefinitely.
    let floor = counters.epochs.current().saturating_sub(1);
    let later = resolved.by_epoch.split_off(&floor);
    let older = std::mem::replace(&mut resolved.by_epoch, later);
    for t in older.values() {
        resolved.answered.add(*t);
    }
    lost
}

/// Answers barriers once the batch before them is written.
///
/// All validated producers in the barrier's epoch have settled before its
/// publication, so every event in its epoch prefix is committed or failed.
/// Later epochs may publish ahead of it too: global written/failed totals
/// are not the prefix. Fold only the tagged epochs through the barrier's.
async fn answer(
    barriers: Vec<Pending>,
    counters: &Counters,
    sink: &Option<mpsc::Sender<Committed>>,
) {
    for b in barriers {
        if let Some(fence) = b.fence {
            if let Some(sink) = sink {
                if sink.send(Committed::Fence(fence.clone())).await.is_err() {
                    fence.0.notify_one();
                }
            } else {
                fence.0.notify_one();
            }
            continue;
        }
        // Fold every epoch up to the barrier's into the answered total, so
        // the map holds only the epochs after it.
        let tally = {
            let mut resolved = counters
                .resolved
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let later = resolved.by_epoch.split_off(&(b.epoch + 1));
            let upto = std::mem::replace(&mut resolved.by_epoch, later);
            for t in upto.values() {
                resolved.answered.add(*t);
            }
            resolved.answered
        };
        let answer = Barrier {
            watermark: b.produced.events,
            committed: tally.committed,
            failed: tally.failed,
            refused: tally.refused,
            dropped: b.produced.dropped,
        };
        // Free the one-barrier slot before the caller is woken, so a caller
        // that asks again right after its answer is admitted.
        let Pending { reply, _busy, .. } = b;
        drop(_busy);
        // A caller that gave up waiting is no one's concern.
        reply.send(answer).ok();
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
    backend: Backend,
    mut rx: mpsc::Receiver<Queued>,
    mut stop: oneshot::Receiver<()>,
    config: WriterConfig,
    counters: Arc<Counters>,
) -> Result<(), StoreError> {
    let max_batch = config.max_batch.max(1);
    let mut sink = Sink {
        log_observer: config.log_observer.clone(),
        backend,
        node_id: Arc::from(config.node_id.as_str()),
        day_offset_minutes: config.day_offset_minutes,
        counters: Arc::clone(&counters),
        commit_sink: config.commit_sink.clone(),
        delivery_gap: false,
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
        sink.recover_gap();
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
        let mut batch: Vec<Tagged> = Vec::with_capacity(max_batch);
        // Barriers end the batch they land in and are answered after it.
        let mut barriers = Vec::new();
        take(first, &mut batch, &mut barriers);
        let mut stopping = false;
        // A seed ends collection like a barrier: flush preceding commits and
        // perform the ordered read immediately, without the ordinary batch
        // timer. It stays in the FIFO and flush_ordered retains SQL ordering.
        while batch.len() < max_batch
            && barriers.is_empty()
            && !matches!(batch.last(), Some((WriteEvent::Seed(_), _)))
        {
            if let Ok(e) = rx.try_recv() {
                take(e, &mut batch, &mut barriers);
                continue;
            }
            tokio::select! {
                biased;
                _ = &mut stop => { stopping = true; break; }
                () = sleep_until(deadline) => break,
                e = rx.recv() => match e {
                    Some(e) => take(e, &mut batch, &mut barriers),
                    None => break,
                },
                _ = warn_tick.tick() => warner.check(&counters),
            }
        }
        let lost = flush_watching(&mut sink, batch, &mut warner, &mut warn_tick, &counters).await?;
        let closing = stopping || stop_arrived(&mut stop);
        answer(barriers, &counters, &sink.commit_sink).await;
        // A stop that arrived while this batch was being written (or retried)
        // waited on its outcome, so its loss is the close's to report.
        if closing {
            lost_on_close += lost;
            break 'running;
        }
    }

    // Graceful flush: refuse new events, then write what was already queued.
    rx.close();
    loop {
        let mut batch: Vec<Tagged> = Vec::with_capacity(max_batch);
        let mut barriers = Vec::new();
        let mut ended = false;
        while batch.len() < max_batch && barriers.is_empty() {
            match rx.recv().await {
                Some(e) => take(e, &mut batch, &mut barriers),
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
        answer(barriers, &counters, &sink.commit_sink).await;
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

#[cfg(test)]
mod epoch_accounting_tests {
    use super::*;

    #[test]
    fn abandoned_and_refused_prefixes_keep_resolution_bounded() {
        let c = Counters::new();
        for n in 0..100_u64 {
            let delayed = c.epochs.enter();
            let (e, before) = c.epochs.bump();
            assert!(!c.epochs.previous_settled());
            // Cancellation before settlement, or refusal after settlement,
            // leaves exactly this state; no answer() is called.
            c.epochs.leave(delayed, false);
            resolve(
                &[Some(e)],
                &Flushed::Committed {
                    refused: Vec::new(),
                },
                &c,
            );
            let prefix = c.epochs.prefix(e, before);
            assert_eq!(prefix.events, n + 1);
            let r = c.resolved.lock().expect("resolved");
            assert!(r.by_epoch.len() <= 2);
            assert_eq!(
                r.answered.committed + r.by_epoch.values().map(|v| v.committed).sum::<u64>(),
                prefix.events
            );
        }
    }
}

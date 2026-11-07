//! The writer task, its handle, and its lifecycle.
//!
//! An async loop gathers events into a batch and hands the batch with the
//! connection to `spawn_blocking`, which writes it in one transaction and hands
//! the connection back. One batch is in flight at a time; events arriving
//! meanwhile wait in the bounded channel, stamped with when they were queued,
//! so the next batch's deadline counts from its oldest event's enqueue rather
//! than from when the writer got round to it.

use super::batch;
use super::events::WriteEvent;
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

/// How the writer batches. [`Default`] is the spec's: 200 ms or 512 events.
#[derive(Debug, Clone)]
pub struct WriterConfig {
    /// `request_logs.node_id` for every row this process files.
    pub node_id: String,
    /// The fixed offset `usage_daily` days are cut at.
    pub day_offset_minutes: i64,
    /// Channel capacity: what may be pending while the database stalls. A full
    /// channel drops, never waits.
    pub capacity: usize,
    /// Most events per batch.
    pub max_batch: usize,
    /// Longest an event waits, from its enqueue, before its batch is written
    /// (plus the write itself, and any write already in flight).
    pub interval: Duration,
    /// The writer connection's `busy_timeout`; the TS pragma's 5 s by default.
    pub busy_timeout: Duration,
    /// At most one dropped-event warning per this long.
    pub drop_warn_interval: Duration,
}

impl Default for WriterConfig {
    fn default() -> Self {
        Self {
            node_id: String::new(),
            day_offset_minutes: 0,
            capacity: 8192,
            max_batch: 512,
            interval: Duration::from_millis(200),
            busy_timeout: Duration::from_secs(5),
            drop_warn_interval: Duration::from_secs(10),
        }
    }
}

/// What the writer has done so far.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct WriterStats {
    /// Events refused because the channel was full or the writer had closed.
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
}

#[derive(Debug)]
struct Counters {
    dropped: AtomicU64,
    batches: AtomicU64,
    written: AtomicU64,
    failed: AtomicU64,
    health_refused: AtomicU64,
}

impl Counters {
    fn new() -> Self {
        Self {
            dropped: AtomicU64::new(0),
            batches: AtomicU64::new(0),
            written: AtomicU64::new(0),
            failed: AtomicU64::new(0),
            health_refused: AtomicU64::new(0),
        }
    }

    fn snapshot(&self) -> WriterStats {
        WriterStats {
            dropped: self.dropped.load(Ordering::Relaxed),
            batches: self.batches.load(Ordering::Relaxed),
            written: self.written.load(Ordering::Relaxed),
            failed: self.failed.load(Ordering::Relaxed),
            health_refused: self.health_refused.load(Ordering::Relaxed),
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

    /// Warns if there are unreported drops and the interval has passed, or
    /// regardless of the interval when `force` (the last look, on close).
    fn check(&mut self, counters: &Counters, force: bool) {
        let total = counters.dropped.load(Ordering::Relaxed);
        if total <= self.reported {
            return;
        }
        let due = force || self.last.is_none_or(|l| l.elapsed() >= self.every);
        if !due {
            return;
        }
        tracing::warn!(
            dropped = total - self.reported,
            dropped_total = total,
            "request log writer is full; events dropped"
        );
        self.reported = total;
        self.last = Some(Instant::now());
    }
}

/// An event and when it was queued.
#[derive(Debug)]
struct Queued {
    at: Instant,
    event: WriteEvent,
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
        let queued = Queued {
            at: Instant::now(),
            event: event.into(),
        };
        match self.tx.try_send(queued) {
            Ok(()) => true,
            Err(_) => {
                self.counters.dropped.fetch_add(1, Ordering::Relaxed);
                false
            }
        }
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
}

impl Writer {
    /// Opens its own connection to the (already migrated) database at `path`
    /// and starts the task on the current Tokio runtime.
    pub fn spawn(path: impl AsRef<Path>, config: WriterConfig) -> Result<Self, StoreError> {
        let conn = crate::open_connection(path.as_ref())?;
        conn.busy_timeout(config.busy_timeout)?;
        let (tx, rx) = mpsc::channel(config.capacity.max(1));
        let (shutdown, stop) = oneshot::channel();
        let counters = Arc::new(Counters::new());
        let task = tokio::spawn(run(conn, rx, stop, config, Arc::clone(&counters)));
        Ok(Self {
            handle: WriterHandle { tx, counters },
            shutdown: Some(shutdown),
            task,
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
    pub async fn close(mut self) -> Result<WriterStats, StoreError> {
        if let Some(s) = self.shutdown.take() {
            // An Err means the task already ended; the join below reports why.
            s.send(()).ok();
        }
        let task = &mut self.task;
        task.await
            .map_err(|e| StoreError::Writer(format!("writer task ended abnormally: {e}")))??;
        Ok(self.handle.counters.snapshot())
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
}

impl Sink {
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
            let c = &self.counters;
            match result {
                Ok(outcome) => {
                    c.batches.fetch_add(1, Ordering::Relaxed);
                    c.written.fetch_add(n, Ordering::Relaxed);
                    c.health_refused
                        .fetch_add(outcome.health_refused, Ordering::Relaxed);
                    return Ok(0);
                }
                Err(e) if transient(&e) && attempt < MAX_ATTEMPTS => {
                    let delay = RETRY_BASE * 2u32.pow(attempt - 1);
                    tracing::warn!(
                        events = n,
                        attempt,
                        retry_in_ms = u64::try_from(delay.as_millis()).unwrap_or(u64::MAX),
                        error = %e,
                        "request log batch hit a busy database; retrying"
                    );
                    sleep(delay).await;
                    attempt += 1;
                }
                Err(e) => {
                    c.failed.fetch_add(n, Ordering::Relaxed);
                    tracing::error!(
                        events = n,
                        attempts = attempt,
                        error = %e,
                        "request log batch failed to persist; its events are lost"
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
    let flush = sink.flush(batch);
    tokio::pin!(flush);
    let lost = loop {
        tokio::select! {
            biased;
            r = &mut flush => break r?,
            _ = tick.tick() => warner.check(counters, false),
        }
    };
    warner.check(counters, false);
    Ok(lost)
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
                warner.check(&counters, false);
                continue 'running;
            }
        };
        // From the oldest event's enqueue: one that queued behind a slow
        // write is already due, and goes out with the next write.
        let deadline = first.at + config.interval;
        let mut batch = Vec::with_capacity(max_batch);
        batch.push(first.event);
        let mut stopping = false;
        while batch.len() < max_batch {
            if let Ok(e) = rx.try_recv() {
                batch.push(e.event);
                continue;
            }
            tokio::select! {
                biased;
                _ = &mut stop => { stopping = true; break; }
                () = sleep_until(deadline) => break,
                e = rx.recv() => match e {
                    Some(e) => batch.push(e.event),
                    None => break,
                },
                _ = warn_tick.tick() => warner.check(&counters, false),
            }
        }
        let lost = flush_watching(&mut sink, batch, &mut warner, &mut warn_tick, &counters).await?;
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
        while batch.len() < max_batch {
            match rx.recv().await {
                Some(e) => batch.push(e.event),
                None => break,
            }
        }
        if batch.is_empty() {
            break;
        }
        lost_on_close +=
            flush_watching(&mut sink, batch, &mut warner, &mut warn_tick, &counters).await?;
    }
    warner.check(&counters, true);
    if lost_on_close > 0 {
        return Err(StoreError::Writer(format!(
            "{lost_on_close} queued events failed to persist on close"
        )));
    }
    Ok(())
}

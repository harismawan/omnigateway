//! The writer task, its handle, and its lifecycle.
//!
//! An async loop gathers events into a batch — closed at `max_batch` events or
//! `interval` after the batch's first event, whichever comes first — and hands
//! the batch with the connection to `spawn_blocking`, which writes it in one
//! transaction and hands the connection back. One batch is in flight at a
//! time; events arriving meanwhile wait in the bounded channel.

use super::batch;
use super::events::WriteEvent;
use crate::error::StoreError;
use rusqlite::Connection;
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;
use tokio::time::{Instant, sleep_until};

/// How the writer batches. [`Default`] is the spec's: 200 ms or 512 events.
#[derive(Debug, Clone)]
pub struct WriterConfig {
    /// `request_logs.node_id` for every row this process files.
    pub node_id: String,
    /// The fixed offset `usage_daily` days are cut at.
    pub day_offset_minutes: i64,
    /// Channel capacity. A full channel drops, never waits.
    pub capacity: usize,
    /// Most events per batch.
    pub max_batch: usize,
    /// Longest an event waits for its batch to be written.
    pub interval: Duration,
}

impl Default for WriterConfig {
    fn default() -> Self {
        Self {
            node_id: String::new(),
            day_offset_minutes: 0,
            capacity: 8192,
            max_batch: 512,
            interval: Duration::from_millis(200),
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
    /// Events in batches whose transaction failed and was rolled back. The
    /// accepted loss under a database failure; the request was still served.
    pub failed: u64,
    /// Health rows the foreign key refused: no such credential, which TS's
    /// `updateHealth` would also have thrown on.
    pub health_refused: u64,
}

#[derive(Debug, Default)]
struct Counters {
    dropped: AtomicU64,
    batches: AtomicU64,
    written: AtomicU64,
    failed: AtomicU64,
    health_refused: AtomicU64,
}

impl Counters {
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

/// The request path's side: cheap to clone, and [`Self::send`] never waits.
#[derive(Debug, Clone)]
pub struct WriterHandle {
    tx: mpsc::Sender<WriteEvent>,
    counters: Arc<Counters>,
}

impl WriterHandle {
    /// Queues an event. `false` means it was dropped (channel full, or the
    /// writer closed) and counted in [`Self::dropped`].
    pub fn send(&self, event: impl Into<WriteEvent>) -> bool {
        match self.tx.try_send(event.into()) {
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
        let (tx, rx) = mpsc::channel(config.capacity.max(1));
        let (shutdown, stop) = oneshot::channel();
        let counters = Arc::new(Counters::default());
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
    /// the final counters.
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

/// Owns the connection between batches; `None` only while one is in flight.
struct Sink {
    conn: Option<Connection>,
    node_id: Arc<str>,
    day_offset_minutes: i64,
    counters: Arc<Counters>,
}

impl Sink {
    /// Writes `events` off the async threads. A failed transaction costs its
    /// batch, counted; only losing the connection itself ends the writer.
    async fn flush(&mut self, events: Vec<WriteEvent>) -> Result<(), StoreError> {
        if events.is_empty() {
            return Ok(());
        }
        let mut conn = self
            .conn
            .take()
            .ok_or_else(|| StoreError::Writer("writer connection lost".into()))?;
        let node_id = Arc::clone(&self.node_id);
        let offset = self.day_offset_minutes;
        let (conn, n, result) = tokio::task::spawn_blocking(move || {
            let result = batch::write(&mut conn, &events, &node_id, offset);
            (conn, events.len() as u64, result)
        })
        .await
        .map_err(|e| StoreError::Writer(format!("batch write panicked: {e}")))?;
        self.conn = Some(conn);
        let c = &self.counters;
        match result {
            Ok(outcome) => {
                c.batches.fetch_add(1, Ordering::Relaxed);
                c.written.fetch_add(n, Ordering::Relaxed);
                c.health_refused
                    .fetch_add(outcome.health_refused, Ordering::Relaxed);
            }
            Err(_) => {
                c.failed.fetch_add(n, Ordering::Relaxed);
            }
        }
        Ok(())
    }
}

async fn run(
    conn: Connection,
    mut rx: mpsc::Receiver<WriteEvent>,
    mut stop: oneshot::Receiver<()>,
    config: WriterConfig,
    counters: Arc<Counters>,
) -> Result<(), StoreError> {
    let max_batch = config.max_batch.max(1);
    let mut sink = Sink {
        conn: Some(conn),
        node_id: Arc::from(config.node_id.as_str()),
        day_offset_minutes: config.day_offset_minutes,
        counters,
    };

    'running: loop {
        // Idle until the first event of the next batch, or the stop.
        let first = tokio::select! {
            biased;
            _ = &mut stop => break 'running,
            e = rx.recv() => match e {
                Some(e) => e,
                None => break 'running,
            },
        };
        let mut batch = Vec::with_capacity(max_batch);
        batch.push(first);
        let deadline = Instant::now() + config.interval;
        let mut stopping = false;
        while batch.len() < max_batch {
            if let Ok(e) = rx.try_recv() {
                batch.push(e);
                continue;
            }
            tokio::select! {
                biased;
                _ = &mut stop => { stopping = true; break; }
                () = sleep_until(deadline) => break,
                e = rx.recv() => match e {
                    Some(e) => batch.push(e),
                    None => break,
                },
            }
        }
        sink.flush(batch).await?;
        if stopping {
            break 'running;
        }
    }

    // Graceful flush: refuse new events, then write what was already queued.
    rx.close();
    loop {
        let mut batch = Vec::with_capacity(max_batch);
        while batch.len() < max_batch {
            match rx.recv().await {
                Some(e) => batch.push(e),
                None => break,
            }
        }
        if batch.is_empty() {
            return Ok(());
        }
        sink.flush(batch).await?;
    }
}

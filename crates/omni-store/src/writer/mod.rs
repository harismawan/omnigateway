//! The batched writer: one task per process owns request-path persistence.
//!
//! The request path hands it [`LogEvent`]s and health events through a bounded
//! channel with `try_send`, so it never waits; a full channel drops the event,
//! counts it, and warns at most once per interval. The task writes one
//! transaction per batch, leaving the rows the TS store would have left after
//! the same events one at a time (see `batch.rs`).
//!
//! **Timing.** A batch is written once it holds 4096 events, or once its oldest
//! event has waited 200 ms *since it was enqueued*, whichever comes first. So
//! under normal database latency no event waits longer than about 200 ms plus
//! one write.
//!
//! **Loss.** On a hard kill, under normal operation, at most one batch is lost:
//! the one being gathered or written. While the database is stalled (a long
//! lock, a slow disk), events keep queuing up to the channel capacity rather
//! than growing memory, and all of those are pending; beyond the capacity they
//! are dropped and counted. A batch whose transaction fails is retried when the
//! failure is transient (`SQLITE_BUSY`/`SQLITE_LOCKED`), and otherwise counted
//! as failed and reported with `tracing::error!`.

mod batch;
mod events;
mod num;
mod sql;
mod task;

pub use events::{
    BreakerTransition, Committed, Completion, HealthMeasurement, LogEvent, PendingLog, RequestLog,
    RouteTarget, SeedQuery, SeedRows, WriteEvent,
};
pub use task::{Writer, WriterConfig, WriterHandle, WriterStats};

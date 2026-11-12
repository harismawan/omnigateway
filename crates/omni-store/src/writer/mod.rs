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
//!
//! **Breaker health.** [`HealthWriter`] is the immediate path: failures and
//! transitions as mutations applied by [`crate::Store::update_health`] (the
//! shared atomic read-modify-write), one at a time, through a bounded queue
//! of its own, never behind a log batch. The batch path's
//! [`BreakerTransition`] / [`HealthMeasurement`] events remain for the
//! single-node SQLite gateway, which routes from its own snapshot; on a
//! shared Postgres they would write absolute rows computed from one
//! replica's view, so the cluster integration sends breaker changes through
//! [`HealthWriter`] instead.
//!
//! **Postgres.** [`Writer::spawn_postgres`] runs the same task over a pool;
//! each batch is one transaction whose `request_logs` and rollup writes are
//! single `INSERT … SELECT FROM unnest(...)` upserts (`pg_batch.rs`). A row
//! race with another replica, a serialization failure, a deadlock, or a
//! statement or pool timeout is the transient class there.

mod batch;
mod epoch;
mod events;
mod health;
mod num;
mod pg_batch;
mod sql;
mod task;

pub use events::{
    BreakerTransition, Committed, Completion, HealthMeasurement, LogEvent, PendingLog, RequestLog,
    RouteTarget, SeedQuery, SeedRows, WriteEvent,
};
pub use health::{
    HealthCommitted, HealthHandle, HealthMutation, HealthStats, HealthWriter, HealthWriterConfig,
};
pub use task::{
    Barrier, BarrierError, Writer, WriterConfig, WriterHandle, WriterStats, queue_slot_bytes,
};

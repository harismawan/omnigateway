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
pub use task::LogObserver;

/// Persist recovery work directly, never through the request-path lossy queue.
/// Each claim and its rollups commit atomically; already-completed rows count zero.
pub fn recover_pending(
    conn: &mut rusqlite::Connection,
    node: &str,
    now: i64,
    offset: i64,
) -> Result<usize, crate::StoreError> {
    let rows = crate::usage::pending_interruptions(conn, node, now)?;
    let mut count = 0;
    for row in rows {
        let outcome = batch::write(conn, &[events::LogEvent::Finish(row).into()], node, offset)?;
        count += outcome.completions.len();
    }
    Ok(count)
}

/// Primary boot recovery before the listener or limiter seeds are started.
pub async fn recover_pending_postgres(
    pg: &crate::pg::PgStore,
    node: &str,
    now: i64,
    committed: impl FnMut(Vec<Completion>),
) -> Result<usize, crate::StoreError> {
    recover_pg(pg, node, Some(node), now, committed).await
}

/// A live sweeper must not retire its own active requests. Forward actual
/// persisted completions to the same debit path used by the request writer.
pub async fn recover_dead_nodes_postgres(
    pg: &crate::pg::PgStore,
    node: &str,
    now: i64,
    committed: impl FnMut(Vec<Completion>),
) -> Result<usize, crate::StoreError> {
    recover_pg(pg, node, None, now, committed).await
}

async fn recover_pg(
    pg: &crate::pg::PgStore,
    node: &str,
    boot_node: Option<&str>,
    now: i64,
    mut committed: impl FnMut(Vec<Completion>),
) -> Result<usize, crate::StoreError> {
    let rows = pg.pending_interruptions(boot_node, now).await?;
    let mut count = 0;
    for row in rows {
        let mut client = pg.client().await?;
        let outcome = pg_batch::write(
            &mut client,
            &[events::LogEvent::Finish(row).into()],
            node,
            pg.day_offset_minutes(),
        )
        .await?;
        count += outcome.completions.len();
        if !outcome.completions.is_empty() {
            committed(outcome.completions);
        }
    }
    Ok(count)
}

pub use events::{
    BreakerTransition, Committed, Completion, HealthMeasurement, LogEvent, PendingLog, RequestLog,
    RouteTarget, SeedQuery, SeedRows, WriteEvent,
};
pub(crate) use health::panic_message;
pub use health::{
    HealthCommitted, HealthHandle, HealthMutation, HealthStats, HealthWriter, HealthWriterConfig,
    HealthWriterError, Observed,
};
#[cfg(test)]
pub(crate) use task::transient_sqlstate;
pub use task::{
    Barrier, BarrierError, FINISH_WAIT, FinishReservation, FinishSlot, FinishWaiter, ReserveError,
    RouteSlot, Writer, WriterConfig, WriterHandle, WriterStats, queue_slot_bytes,
};

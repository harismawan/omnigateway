//! The batched writer: one task per process owns request-path persistence.
//!
//! The request path hands it [`LogEvent`]s (and health rows) through a bounded
//! channel with `try_send`, so it never waits; a full channel drops the event
//! and counts it. The task writes one transaction every 200 ms or 512 events,
//! whichever comes first, leaving the rows the TS store would have left after
//! the same events one at a time (see `batch.rs`). On a hard kill at most the
//! batch being gathered is lost.

mod batch;
mod events;
mod num;
mod sql;
mod task;

pub use events::{LogEvent, PendingLog, RequestLog, RouteTarget, WriteEvent};
pub use task::{Writer, WriterConfig, WriterHandle, WriterStats};

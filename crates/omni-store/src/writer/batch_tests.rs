//! `batch.rs` unit tests: statement counts, which only a trace hook sees.

use super::*;
use crate::migrate;
use rusqlite::trace::{TraceEvent, TraceEventCodes};
use std::sync::{Arc, Mutex};

#[test]
fn a_full_batch_is_one_insert_per_table() {
    let mut conn = Connection::open_in_memory().expect("open");
    migrate::migrate(&mut conn, 0).expect("migrate");
    let events: Vec<WriteEvent> = (0..512)
        .map(|n| {
            let mut log = RequestLog::new(format!("r{n}"), 1_794_007_800_000 + n, 200);
            log.api_key_id = Some(format!("k{}", n % 300));
            log.requested_model = format!("m{n}");
            LogEvent::Finish(log).into()
        })
        .collect();
    let seen = Arc::new(Mutex::new(Vec::<String>::new()));
    let sink = Arc::clone(&seen);
    conn.trace_v2(
        TraceEventCodes::SQLITE_TRACE_STMT,
        Some(move |e: TraceEvent<'_>| {
            if let TraceEvent::Stmt(_, sql) = e {
                sink.lock().expect("lock").push(sql.trim_start().to_owned());
            }
        }),
    )
    .expect("trace");
    write(&mut conn, &events, "n", 0).expect("write");
    conn.trace_v2(TraceEventCodes::empty(), None::<fn(TraceEvent<'_>)>)
        .expect("untrace");
    let seen = seen.lock().expect("lock");
    let inserts = |table: &str| {
        seen.iter()
            .filter(|s| s.starts_with(&format!("INSERT INTO {table} ")))
            .count()
    };
    assert_eq!(inserts("request_logs"), 1);
    // 512 distinct daily keys and 300 hourly ones, one statement each.
    assert_eq!(inserts("usage_daily"), 1);
    assert_eq!(inserts("usage_rollup"), 1);
    let rows: i64 = conn
        .query_row("SELECT COUNT(*) FROM request_logs", [], |r| r.get(0))
        .expect("count");
    assert_eq!(rows, 512);
}

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

/// A batch reads `request_logs` once (the rows it touches) and writes each
/// touched id once: a Begin and its Finish in the same batch are one row
/// written, and the completed rows are rolled up from what the batch holds,
/// not read back.
#[test]
fn a_batch_reads_request_logs_once_and_writes_a_begun_and_finished_row_once() {
    let mut conn = Connection::open_in_memory().expect("open");
    migrate::migrate(&mut conn, 0).expect("migrate");
    conn.execute_batch(
        "CREATE TEMP TABLE touches (n INTEGER);
         CREATE TEMP TRIGGER t_li AFTER INSERT ON request_logs BEGIN INSERT INTO touches VALUES (1); END;
         CREATE TEMP TRIGGER t_lu AFTER UPDATE ON request_logs BEGIN INSERT INTO touches VALUES (1); END;",
    )
    .expect("triggers");
    let mut events: Vec<WriteEvent> = Vec::new();
    for n in 0..100 {
        let id = format!("r{n}");
        events.push(
            LogEvent::Begin(PendingLog {
                id: id.clone(),
                at: 1_794_007_800_000 + n,
                api_key_id: Some("k".into()),
                requested_model: "m".into(),
                resolved_provider: Some("p".into()),
                resolved_model: Some("pm".into()),
                credential_id: Some("c".into()),
            })
            .into(),
        );
        let mut log = RequestLog::new(id, 1_794_007_800_000 + n, 200);
        log.input_tokens = 3;
        events.push(LogEvent::Finish(log).into());
    }
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
    let outcome = write(&mut conn, &events, "n", 0).expect("write");
    conn.trace_v2(TraceEventCodes::empty(), None::<fn(TraceEvent<'_>)>)
        .expect("untrace");
    let reads = seen
        .lock()
        .expect("lock")
        .iter()
        .filter(|s| s.starts_with("SELECT") && s.contains(" FROM request_logs "))
        .count();
    assert_eq!(reads, 1, "one read of the touched rows, no read-back");
    let touches: i64 = conn
        .query_row("SELECT COUNT(*) FROM touches", [], |r| r.get(0))
        .expect("touches");
    assert_eq!(touches, 100, "one row write per request");
    assert_eq!(outcome.completions.len(), 100);
    let (done, input): (i64, i64) = conn
        .query_row(
            "SELECT COUNT(*), SUM(input_tokens) FROM request_logs WHERE state = 'done'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .expect("rows");
    assert_eq!((done, input), (100, 300));
}

//! `batch.rs` unit tests: statement counts, which only a trace hook sees.

use super::*;
use crate::migrate;
use rusqlite::trace::{TraceEvent, TraceEventCodes};
use std::sync::{Arc, Mutex};

#[test]
fn notifications_count_calls_not_coalesced_rows_and_failure_returns_none() {
    let mut conn = Connection::open_in_memory().expect("open");
    migrate::migrate(&mut conn, 0).expect("migrate");
    let finish = LogEvent::Finish(RequestLog::new("same", 1000, 200));
    let events = vec![finish.clone().into(), finish.into()];
    let outcome = write(&mut conn, &events, "n", 0).expect("write");
    assert_eq!(
        (outcome.log_notifications, outcome.finish_notifications),
        (2, 2)
    );
    assert_eq!(outcome.completions.len(), 1);
    conn.execute_batch("CREATE TRIGGER refuse BEFORE INSERT ON request_logs BEGIN SELECT RAISE(FAIL, 'refused'); END;").expect("trigger");
    assert!(
        write(
            &mut conn,
            &[LogEvent::Finish(RequestLog::new("fail", 1000, 200)).into()],
            "n",
            0
        )
        .is_err()
    );
}

#[test]
fn a_full_batch_is_a_few_multi_row_inserts_per_table() {
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
    // 512 rows in two 256-row statements; 512 distinct daily keys likewise,
    // and 300 hourly ones as 256 + 2 × 16 + 3 × 4.
    assert_eq!(inserts("request_logs"), 2);
    assert_eq!(inserts("usage_daily"), 2);
    assert_eq!(inserts("usage_rollup"), 6);
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
    // The touched ids, read once in fixed-size chunks; no read-back after.
    let once = super::sql::fixed_chunks(&[(); 100], &super::sql::CHUNK_SIZES).len();
    assert_eq!(reads, once, "one read of the touched rows, no read-back");
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

/// Every batch size reuses the same few prepared statements: full chunks
/// of one fixed row count plus single rows, never a statement per size, so
/// the statement cache stays small however the batches fall.
#[test]
fn batches_of_any_size_reuse_a_fixed_set_of_statements() {
    let mut conn = Connection::open_in_memory().expect("open");
    migrate::migrate(&mut conn, 0).expect("migrate");
    let seen = Arc::new(Mutex::new(std::collections::HashSet::<String>::new()));
    let sink = Arc::clone(&seen);
    conn.trace_v2(
        TraceEventCodes::SQLITE_TRACE_STMT,
        Some(move |e: TraceEvent<'_>| {
            if let TraceEvent::Stmt(stmt, _) = e {
                // The statement's own text (with `?`s), not the expanded one.
                let sql = stmt.sql();
                if sql.contains("request_logs") || sql.contains("usage_") {
                    sink.lock().expect("lock").insert(sql.into_owned());
                }
            }
        }),
    )
    .expect("trace");
    let mut n = 0;
    for size in [1, 2, 3, 5, 64, 127, 128, 129, 300, 511, 512, 777] {
        let events: Vec<WriteEvent> = (0..size)
            .map(|_| {
                n += 1;
                let mut log = RequestLog::new(format!("r{n}"), 1_794_007_800_000 + n, 200);
                log.api_key_id = Some(format!("k{}", n % 97));
                log.requested_model = format!("m{}", n % 89);
                LogEvent::Finish(log).into()
            })
            .collect();
        write(&mut conn, &events, "n", 0).expect("write");
    }
    conn.trace_v2(TraceEventCodes::empty(), None::<fn(TraceEvent<'_>)>)
        .expect("untrace");
    let seen = seen.lock().expect("lock");
    let count = |prefix: &str| seen.iter().filter(|s| s.starts_with(prefix)).count();
    // At most one statement per chunk size, for each statement shape.
    let sizes = super::sql::CHUNK_SIZES.len();
    assert!(count("INSERT INTO request_logs ") <= sizes, "{seen:#?}");
    assert!(count("INSERT INTO usage_daily ") <= sizes, "{seen:#?}");
    assert!(count("INSERT INTO usage_rollup ") <= sizes, "{seen:#?}");
    assert!(count("SELECT") <= sizes + 2, "{seen:#?}");
    let rows: i64 = conn
        .query_row("SELECT COUNT(*) FROM request_logs", [], |r| r.get(0))
        .expect("count");
    assert_eq!(rows, n);
}

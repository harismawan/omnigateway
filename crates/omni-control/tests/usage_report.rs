//! `GET /api/usage`'s body, byte for byte, for cells that exercise every
//! branch of the row writer: the report is written straight from the SQLite
//! rows, so nothing else pins its escaping, key order and number text.

use omni_store::SqliteStore;

fn report(store: &SqliteStore, query: &str) -> String {
    omni_control::reports::usage(store, query, 2e12).expect("usage report")
}

fn store() -> (tempfile::TempDir, SqliteStore) {
    let dir = tempfile::tempdir().expect("dir");
    let store = SqliteStore::open(dir.path().join("omni.db"), 0).expect("open");
    store
        .connection()
        .execute_batch(
            // Every group has its own request count: the report is ordered by
            // it, and SQLite alone decides the order of a tie.
            "INSERT INTO request_logs(id,at,requested_model,resolved_model,api_key_id,status,duration_ms,input_tokens,output_tokens,cost_usd,rtk_applied,rtk_estimated_tokens_saved) VALUES
               ('a',1000,'r','quote\"back\\slash',  'k1',200,10,   1,2,0.125,1,7),
               ('b',1001,'r','quote\"back\\slash',  'k1',500,5,    3,4,0.25, 0,0),
               ('c',1002,'r',char(1)||char(9)||char(10)||'é😀','k2',200,1.5,1e100,0,0,0,0),
               ('d',1003,'r',NULL,                  NULL,404,1,    0,0,0,   1,1),
               ('e',1004,'r','',                    '',  200,1,    0,0,0,   0,0),
               ('f',1005,'r',x'0102',               7,   200,1,    0,0,0,   0,0),
               ('g',1006,'r',2.5,                   'k3',200,1,    0,0,0,   0,0);
             UPDATE request_logs SET state='pending' WHERE id='g';
             INSERT INTO request_logs(id,at,requested_model,resolved_model,api_key_id,status,duration_ms)
               SELECT 'fill-'||b.id||n.i, b.at, 'r', b.resolved_model, b.api_key_id, 200, 0
               FROM request_logs b JOIN (SELECT 1 AS i UNION ALL SELECT 2 UNION ALL SELECT 3) n
               WHERE (b.id='a') OR (b.id='c' AND n.i<=3) OR (b.id='d' AND n.i<=2) OR (b.id='e' AND n.i<=1);",
        )
        .expect("seed");
    (dir, store)
}

#[test]
fn rows_are_written_as_json_stringify_writes_them() {
    let (_dir, store) = store();
    assert_eq!(
        report(&store, ""),
        concat!(
            r#"{"rows":["#,
            r#"{"key":"quote\"back\\slash","requests":5,"inputTokens":4,"outputTokens":6,"cacheReadTokens":0,"cacheWriteTokens":0,"rtkSavedTokens":7,"rtkAppliedRequests":1,"costUsd":0.375,"errors":1,"durationMsSum":15},"#,
            r#"{"key":"\u0001\t\né😀","requests":4,"inputTokens":1e+100,"outputTokens":0,"cacheReadTokens":0,"cacheWriteTokens":0,"rtkSavedTokens":0,"rtkAppliedRequests":0,"costUsd":0,"errors":0,"durationMsSum":1.5},"#,
            r#"{"key":"unknown","requests":3,"inputTokens":0,"outputTokens":0,"cacheReadTokens":0,"cacheWriteTokens":0,"rtkSavedTokens":1,"rtkAppliedRequests":1,"costUsd":0,"errors":1,"durationMsSum":1},"#,
            r#"{"key":"unknown","requests":2,"inputTokens":0,"outputTokens":0,"cacheReadTokens":0,"cacheWriteTokens":0,"rtkSavedTokens":0,"rtkAppliedRequests":0,"costUsd":0,"errors":0,"durationMsSum":1},"#,
            r#"{"key":"1,2","requests":1,"inputTokens":0,"outputTokens":0,"cacheReadTokens":0,"cacheWriteTokens":0,"rtkSavedTokens":0,"rtkAppliedRequests":0,"costUsd":0,"errors":0,"durationMsSum":1}"#,
            r#"]}"#,
        )
    );
}

#[test]
fn a_split_is_the_last_field_and_an_empty_report_is_an_empty_array() {
    let (_dir, store) = store();
    assert_eq!(
        report(&store, "groupBy=apiKey&splitBy=model&since=1003&until=1005"),
        concat!(
            r#"{"rows":["#,
            r#"{"key":"unknown","requests":3,"inputTokens":0,"outputTokens":0,"cacheReadTokens":0,"cacheWriteTokens":0,"rtkSavedTokens":1,"rtkAppliedRequests":1,"costUsd":0,"errors":1,"durationMsSum":1,"split":"unknown"},"#,
            r#"{"key":"unknown","requests":2,"inputTokens":0,"outputTokens":0,"cacheReadTokens":0,"cacheWriteTokens":0,"rtkSavedTokens":0,"rtkAppliedRequests":0,"costUsd":0,"errors":0,"durationMsSum":1,"split":"unknown"},"#,
            r#"{"key":"7","requests":1,"inputTokens":0,"outputTokens":0,"cacheReadTokens":0,"cacheWriteTokens":0,"rtkSavedTokens":0,"rtkAppliedRequests":0,"costUsd":0,"errors":0,"durationMsSum":1,"split":"1,2"}"#,
            r#"]}"#,
        )
    );
    assert_eq!(report(&store, "until=0"), r#"{"rows":[]}"#);
    assert_eq!(report(&store, "grain=daily"), r#"{"rows":[]}"#);
}

#[test]
fn a_failed_read_leaves_no_partial_report() {
    let (_dir, store) = store();
    // Two i64::MAX cells overflow SQLite's integer SUM: the statement fails
    // on its first step, as it does in TS (500 INTERNAL there and here).
    store
        .connection()
        .execute_batch(
            "INSERT INTO request_logs(id,at,requested_model,status,duration_ms,input_tokens) VALUES
               ('o1',1,'r',200,1,9223372036854775807),('o2',2,'r',200,1,9223372036854775807)",
        )
        .expect("seed");
    assert!(omni_control::reports::usage(&store, "", 2e12).is_err());
}

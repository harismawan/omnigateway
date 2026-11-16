#![allow(clippy::unwrap_used)]
use omni_store::SqliteStore;
#[tokio::test(flavor = "current_thread")]
async fn full_queue_reproduction() {
    let d = tempfile::tempdir().unwrap();
    let p = d.path().join("db");
    let s = SqliteStore::open(&p, 0).unwrap();
    let c = s.connection();
    for id in ["a", "b", "c"] {
        c.execute("INSERT INTO request_logs(id,at,requested_model,status,duration_ms,state,node_id) VALUES(?,1,'m',0,0,'pending','dead')",[id]).unwrap();
    }
    let w = omni_store::writer::Writer::spawn(
        &p,
        omni_store::writer::WriterConfig {
            capacity: 1,
            ..Default::default()
        },
    )
    .unwrap();
    let h = w.handle();
    let mut recovery = omni_store::open_connection(&p).unwrap();
    let accepted = omni_store::writer::recover_pending(&mut recovery, "mine", 100000, 0).unwrap();
    assert_eq!(
        omni_store::writer::recover_pending(&mut recovery, "mine", 100000, 0).unwrap(),
        0
    );
    drop(h);
    let stats = w.close().await.unwrap();
    let pending: i64 = c
        .query_row(
            "SELECT COUNT(*) FROM request_logs WHERE state='pending'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    println!("pending={pending} dropped={}", stats.dropped);
    assert_eq!(pending, 0);
    assert_eq!(accepted, 3);
}

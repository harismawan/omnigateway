use omni_store::migrate::migrate;
use rusqlite::Connection;

#[test]
fn raw_ledger_membership_uses_numeric_equality_only() {
    for cell in [
        "CAST(X'ff' AS TEXT)",
        "'1'",
        "NULL",
        "X'31'",
        "1.5",
        "-0.0",
        "1e999",
        "-1e999",
        "9223372036854775807",
    ] {
        let mut db = Connection::open_in_memory().expect("open fixture");
        db.execute_batch(&format!(
            "CREATE TABLE migrations(id,applied_at); INSERT INTO migrations VALUES({cell},1)"
        ))
        .expect("seed ledger");
        migrate(&mut db, 0).expect("nonnumeric or unknown ID must not block migrations");
        assert_eq!(
            db.query_row("SELECT COUNT(*) FROM migrations", [], |r| r
                .get::<_, i64>(0))
                .expect("count retained and new rows"),
            21,
            "{cell}"
        );
    }
    for cell in ["1", "1.0"] {
        let mut db = Connection::open_in_memory().expect("open fixture");
        db.execute_batch(&format!(
            "CREATE TABLE migrations(id,applied_at); INSERT INTO migrations VALUES({cell},1)"
        ))
        .expect("seed ledger");
        let error = migrate(&mut db, 0)
            .expect_err("numeric ID skips migration 1")
            .to_string();
        assert!(error.starts_with("migration 2 failed:"), "{cell}: {error}");
    }
}

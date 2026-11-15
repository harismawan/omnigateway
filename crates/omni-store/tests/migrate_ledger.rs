use omni_store::migrate::migrate;
use rusqlite::Connection;

#[test]
fn raw_ledger_membership_uses_numeric_equality_only() {
    for cell in ["CAST(X'ff' AS TEXT)", "'1'", "NULL", "X'31'", "1.5", "-0.0", "1e999", "-1e999", "9223372036854775807"] {
        let mut db = Connection::open_in_memory().unwrap();
        db.execute_batch(&format!("CREATE TABLE migrations(id,applied_at); INSERT INTO migrations VALUES({cell},1)")).unwrap();
        migrate(&mut db, 0).unwrap();
        assert_eq!(db.query_row("SELECT COUNT(*) FROM migrations", [], |r| r.get::<_, i64>(0)).unwrap(), 21, "{cell}");
    }
    for cell in ["1", "1.0"] {
        let mut db = Connection::open_in_memory().unwrap();
        db.execute_batch(&format!("CREATE TABLE migrations(id,applied_at); INSERT INTO migrations VALUES({cell},1)")).unwrap();
        let error=migrate(&mut db, 0).unwrap_err().to_string();
        assert!(error.starts_with("migration 2 failed:"), "{cell}: {error}");
    }
}

use omni_store::{SqliteStore, models};

#[test]
fn removal_invalidates_other_connection_and_is_idempotent() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("db");
    let writer = SqliteStore::open(&path, 0).expect("writer");
    let reader = SqliteStore::open(&path, 0).expect("reader");
    writer
        .connection()
        .execute(
            "INSERT INTO virtual_models VALUES ('a','[]','score',0),('b','[]','priority',1)",
            [],
        )
        .expect("seed");
    let before = reader.data_version().expect("version");
    models::remove(writer.connection(), "a").expect("remove");
    assert_ne!(before, reader.data_version().expect("version"));
    let rows = models::operator_rows(reader.connection()).expect("read");
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].0.as_deref(), Some("b"));
    models::remove(writer.connection(), "a").expect("idempotent remove");
    assert_eq!(
        models::operator_rows(reader.connection()).expect("read"),
        rows
    );
}

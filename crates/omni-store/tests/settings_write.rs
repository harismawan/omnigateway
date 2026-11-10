use omni_store::{SqliteStore, settings};
use serde_json::json;

#[test]
fn settings_write_invalidates_other_connection_and_preserves_internal_rows() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("db");
    let writer = SqliteStore::open(&path, 0).expect("writer");
    let reader = SqliteStore::open(&path, 0).expect("reader");
    writer
        .connection()
        .execute(
            "INSERT INTO settings(key,value) VALUES ('adminPasswordHash','secret')",
            [],
        )
        .expect("seed");
    let before = reader.data_version().expect("version");
    settings::put(
        writer.connection(),
        &json!({"rtkEnabled":true,"weights":{"cost":0.4}}),
    )
    .expect("save");
    assert_ne!(reader.data_version().expect("version"), before);
    let read = settings::get(reader.connection()).expect("read");
    assert!(read.rtk_enabled);
    assert_eq!(read.weights.cost, 0.4);
    assert_eq!(read.weights.tier, 10.0);
    let secret: String = reader
        .connection()
        .query_row(
            "SELECT value FROM settings WHERE key='adminPasswordHash'",
            [],
            |r| r.get(0),
        )
        .expect("secret");
    assert_eq!(secret, "secret");
}

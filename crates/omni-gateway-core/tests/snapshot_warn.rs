//! In its own test binary: `tracing`'s callsite interest is process-global,
//! and a test on another thread can cache it as uninterested.

use omni_gateway_core::snapshot::SnapshotHolder;
use omni_store::SqliteStore;
use std::sync::{Arc, Mutex};

/// Captures `tracing` output for the warn assertion.
#[derive(Clone, Default)]
struct Captured(Arc<Mutex<Vec<u8>>>);

impl std::io::Write for Captured {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0.lock().expect("lock").extend_from_slice(buf);
        Ok(buf.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

#[test]
fn a_model_that_does_not_read_is_dropped_with_a_warn_naming_it() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("omni.db");
    let store = SqliteStore::open(&path, 0).expect("store");
    rusqlite::Connection::open(&path)
        .expect("open")
        .execute(
            "INSERT INTO virtual_models (id, targets) VALUES ('broken-model', '{not json')",
            [],
        )
        .expect("insert");
    let captured = Captured::default();
    let writer = captured.clone();
    let subscriber = tracing_subscriber::fmt()
        .with_writer(move || writer.clone())
        .with_ansi(false)
        .finish();
    let holder = tracing::subscriber::with_default(subscriber, || {
        SnapshotHolder::build(
            &store,
            omni_crypto::field::derive_key("warn-test-key-0123456"),
            0.0,
        )
    })
    .expect("build survives the bad row");
    assert!(holder.load().routing.models.is_empty());
    let log = String::from_utf8(captured.0.lock().expect("lock").clone()).expect("utf8");
    assert!(log.contains("WARN"), "{log}");
    assert!(log.contains("model=broken-model"), "{log}");
}

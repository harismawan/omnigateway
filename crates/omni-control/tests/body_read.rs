#![allow(clippy::unwrap_used)]
use omni_ir::jsjson::parse_js;

#[test]
fn absent_and_lossless_present() {
    let root = tempfile::tempdir().unwrap();
    let store = omni_store::SqliteStore::open(root.path().join("omni.db"), 0).unwrap();
    let key = omni_crypto::field::derive_key("body-read-test");
    assert_eq!(
        omni_control::bodies::read_request_body(&store, &key, "a/b").unwrap(),
        r#"{"requestId":"a/b","detailState":"none","truncated":false,"sizeBytes":0,"at":null,"artifact":null}"#
    );
    let artifact = parse_js(r#"{"requestId":"r","at":0,"client":{"request":"\ud800","response":null},"attempts":[],"error":null}"#).unwrap();
    store.put_body(&key, &artifact).unwrap();
    let response = omni_control::bodies::read_request_body(&store, &key, "r").unwrap();
    assert!(response.contains(r#""request":"\ud800""#));
    assert!(!response.contains("relPath"));
    assert!(!response.contains("sha256"));
}

#![allow(clippy::unwrap_used)]
use std::process::Command;

#[test]
fn frozen_raw_body_cells() {
    let root = tempfile::Builder::new()
        .prefix("i2-cells-")
        .tempdir_in("/tmp/opencode/a3")
        .unwrap();
    let path = root.path().join("omni.db");
    let store = omni_store::SqliteStore::open(&path, 0).unwrap();
    // Preserve production affinities but permit operator-created NULLs too.
    store.connection().execute_batch("DROP TABLE request_bodies; CREATE TABLE request_bodies(request_id TEXT PRIMARY KEY,at INTEGER,rel_path TEXT,size_bytes INTEGER,sha256 TEXT,detail_state TEXT,truncated INTEGER);").unwrap();
    let key = omni_crypto::field::derive_key("body-cells");
    let input = omni_ir::jsjson::parse_js(r#"{"requestId":"r","at":0,"client":{"request":null,"response":null},"attempts":[],"error":null}"#).unwrap();
    let values = [
        "0",
        "1",
        "2",
        "0.5",
        "1.0",
        "1.5",
        "-0.0",
        "1e308",
        "9007199254740993",
        "'text'",
        "'1'",
        "''",
        "x'0031ff'",
        "NULL",
    ];
    let mut failures = Vec::new();
    let mut cases = 0;
    for affinity in [true, false] {
        if !affinity {
            store.connection().execute_batch("DROP TABLE request_bodies; CREATE TABLE request_bodies(request_id PRIMARY KEY,at,rel_path,size_bytes,sha256,detail_state,truncated);").unwrap();
        }
        for column in [
            "request_id",
            "at",
            "rel_path",
            "size_bytes",
            "sha256",
            "detail_state",
            "truncated",
        ] {
            for value in values {
                store
                    .connection()
                    .execute("DELETE FROM request_bodies", [])
                    .unwrap();
                store.put_body(&key, &input).unwrap();
                let sql = format!("UPDATE request_bodies SET {column}={value}");
                store.connection().execute(&sql, []).unwrap();
                let id = if column == "request_id" {
                    store
                        .connection()
                        .query_row("SELECT request_id FROM request_bodies", [], |r| {
                            Ok(match r.get_ref(0)? {
                                rusqlite::types::ValueRef::Text(b) => {
                                    String::from_utf8_lossy(b).into_owned()
                                }
                                _ => String::new(),
                            })
                        })
                        .unwrap()
                } else {
                    "r".into()
                };
                let out = Command::new("bun")
                    .args(["--no-env-file", "conformance/store/body-cell-reference.ts"])
                    .args([
                        path.to_str().unwrap(),
                        root.path().join("request_bodies").to_str().unwrap(),
                        &id,
                    ])
                    .current_dir(concat!(env!("CARGO_MANIFEST_DIR"), "/../.."))
                    .output()
                    .unwrap();
                assert!(
                    out.status.success(),
                    "{}",
                    String::from_utf8_lossy(&out.stderr)
                );
                // Restore the pre-read state; the frozen repository may record it.
                store
                    .connection()
                    .execute("DELETE FROM request_bodies", [])
                    .unwrap();
                store.put_body(&key, &input).unwrap();
                store.connection().execute(&sql, []).unwrap();
                let actual = omni_control::bodies::read_request_body(&store, &key, &id)
                    .unwrap_or_else(|_| {
                        r#"{"error":{"code":"INTERNAL","message":"internal error"}}"#.into()
                    });
                let expected = String::from_utf8(out.stdout).unwrap();
                cases += 1;
                if actual != expected.trim_end() {
                    failures.push(format!(
                        "{column}={value}: {actual} != {}",
                        expected.trim_end()
                    ));
                }
            }
        }
    }
    eprintln!("{cases} cases, {} mismatches", failures.len());
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

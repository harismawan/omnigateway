use omni_ir::jsjson::{parse_js, stringify};
use omni_store::{SqliteStore, pg::bodies::decode_plaintext};
use serde_json::{Value, json};
use std::{
    io::Write,
    process::{Command, Stdio},
};

#[test]
#[allow(clippy::unwrap_used)] // Fixture setup/assertions only.
fn frozen_sqlite_put_get_rows_and_maintenance() {
    let artifact = |id: &str, at: i64, text: &str| {
        format!(
            r#"{{"requestId":{id},"at":{at},"client":{{"request":{text},"response":null}},"attempts":[],"error":null}}"#,
            id = serde_json::to_string(id).unwrap()
        )
    };
    let mut ops = vec![json!({"op":"get","id":"absent"})];
    for (id, at, text) in [
        ("r", 0, r#""\ud800 Bearer secret""#),
        ("r", 86400000, r#"{"s":"sk-abcdefgh"}"#),
        ("b", 86400000, "null"),
        ("a", 86400000, "null"),
    ] {
        ops.push(json!({"op":"put","json":artifact(id,at,text)}));
        ops.push(json!({"op":"get","id":id}));
        ops.push(json!({"op":"rows"}));
    }
    for op in [
        "missing", "get", "restore", "get", "corrupt", "get", "restore", "get", "none", "get",
    ] {
        ops.push(json!({"op":op,"id":"r"}));
    }
    for id in ["", "../escape", "a/b", "a.b", "a\\b", "é", &"a".repeat(129)] {
        ops.push(json!({"op":"put","json":artifact(id,0,"null")}));
    }
    ops.extend([
        json!({"op":"sweep"}),
        json!({"op":"cap","cap":2}),
        json!({"op":"get","id":"a"}),
        json!({"op":"rows"}),
        json!({"op":"prune","at":86400000}),
        json!({"op":"prune","at":86400001}),
        json!({"op":"sweep"}),
        json!({"op":"rows"}),
    ]);
    let mut child = Command::new("bun")
        .args([
            "--no-env-file",
            "conformance/store/body-sqlite-reference.ts",
        ])
        .current_dir(concat!(env!("CARGO_MANIFEST_DIR"), "/../.."))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(serde_json::to_string(&ops).unwrap().as_bytes())
        .unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let expected: Value = serde_json::from_slice(&output.stdout).unwrap();
    let root = tempfile::tempdir_in("/tmp/opencode/a3").unwrap();
    let store = SqliteStore::open(root.path().join("omni.db"), 0).unwrap();
    let dir = root.path().join("request_bodies");
    let key = omni_crypto::field::derive_key("s2-sqlite");
    let mut got = Vec::new();
    for op in &ops {
        let id = op["id"].as_str().unwrap_or("");
        match op["op"].as_str().unwrap() {
            "put" => got.push(json!(if store.put_body(&key,&parse_js(op["json"].as_str().unwrap()).unwrap()).is_ok() {"ok"} else {"error"})),
            "get" => got.push(match store.get_body(&key,id).unwrap() { None=>Value::Null,Some(read)=>json!({"state":read.row.detail_state.as_str(),"truncated":read.row.truncated,"artifact":read.artifact.as_ref().map(|a|stringify(a).unwrap())}) }),
            "rows" => {
                let mut stmt=store.connection().prepare("SELECT *,typeof(request_id),typeof(at),typeof(rel_path),typeof(size_bytes),typeof(sha256),typeof(detail_state),typeof(truncated) FROM request_bodies ORDER BY request_id").unwrap();
                let rows=stmt.query_map([],|r| {
                    let rel:String=r.get(2)?; let digest:String=r.get(4)?;
                    let bytes=std::fs::read(dir.join(&rel)).unwrap();
                    let plain=decode_plaintext(&key,&bytes,Some(&digest)).unwrap();
                    Ok(json!({"request_id":r.get::<_,String>(0)?,"at":r.get::<_,i64>(1)?,"rel_path":rel,"size_bytes":r.get::<_,i64>(3)?,"sha256":true,"detail_state":r.get::<_,String>(5)?,"truncated":r.get::<_,i64>(6)?,"ti":r.get::<_,String>(7)?,"ta":r.get::<_,String>(8)?,"tp":r.get::<_,String>(9)?,"tb":r.get::<_,String>(10)?,"th":r.get::<_,String>(11)?,"td":r.get::<_,String>(12)?,"tt":r.get::<_,String>(13)?,"plaintext":plain}))
                }).unwrap().collect::<Result<Vec<_>,_>>().unwrap(); got.push(json!(rows));
            },
            "missing"|"corrupt"|"restore" => {
                let rel:String=store.connection().query_row("SELECT rel_path FROM request_bodies WHERE request_id=?",[id],|r|r.get(0)).unwrap();
                let path=dir.join(rel);let backup=path.with_extension("enc.backup");
                match op["op"].as_str().unwrap() { "missing"=>{std::fs::copy(&path,backup).unwrap();std::fs::remove_file(path).unwrap();},"corrupt"=>{std::fs::copy(&path,backup).unwrap();std::fs::write(path,"bad").unwrap();},_=>{std::fs::copy(&backup,path).unwrap();std::fs::remove_file(backup).unwrap();} }
            },
            "none"=>{store.connection().execute("UPDATE request_bodies SET detail_state='alien' WHERE request_id=?",[id]).unwrap();},
            "prune"=>got.push(json!(omni_control::database::prune_bodies(store.connection(),&dir,op["at"].as_f64().unwrap()).unwrap())),
            "cap"=>got.push(json!(omni_control::database::prune_bodies_to_cap(store.connection(),&dir,op["cap"].as_i64().unwrap()).unwrap())),
            "sweep"=>got.push(json!(omni_control::database::sweep_body_orphans(store.connection(),&dir).unwrap())),
            _=>unreachable!(),
        }
    }
    assert_eq!(json!(got), expected);
    println!(
        "{} frozen SQLite operations (typed rows, exact plaintext, reads, recovery, pruning)",
        ops.len()
    );
}

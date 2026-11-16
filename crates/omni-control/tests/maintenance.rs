#![allow(clippy::unwrap_used)]
use omni_control::database::{prune_bodies, prune_bodies_to_cap, sweep_body_orphans};
use serde_json::json;

#[test]
fn frozen_body_retention_cap_ties_and_orphans() {
    let dir = tempfile::tempdir().unwrap();
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .unwrap();
    let script = dir.path().join("bodies.ts");
    std::fs::write(&script, format!(r#"
import {{ Database }} from 'bun:sqlite';
import {{ createBodyRepo }} from '{}/packages/store/src/sqlite/bodies.ts';
const db = new Database(process.argv[2]);
const repo = createBodyRepo(db, null as any, process.argv[3]);
console.log(JSON.stringify([await repo.prune(100), await repo.pruneToCap(2), await repo.sweepOrphans()]));
db.close();
"#, root.display())).unwrap();
    let mut results = Vec::new();
    for name in ["rust", "ts"] {
        let base = dir.path().join(name);
        std::fs::create_dir(&base).unwrap();
        let path = base.join("db");
        let store = omni_store::SqliteStore::open(&path, 0).unwrap();
        let c = store.connection();
        let artifacts = base.join("request_bodies");
        std::fs::create_dir(&artifacts).unwrap();
        for (id, at) in [("before", 99), ("a", 100), ("b", 100), ("after", 101)] {
            c.execute(
                "INSERT INTO request_bodies(request_id,at,rel_path) VALUES (?,?,?)",
                rusqlite::params![id, at, format!("{id}.enc")],
            )
            .unwrap();
            std::fs::write(artifacts.join(format!("{id}.enc")), b"artifact").unwrap();
        }
        std::fs::write(artifacts.join("orphan.enc"), b"orphan").unwrap();
        let counts = if name == "rust" {
            json!([
                prune_bodies(c, &artifacts, 100.0).unwrap(),
                prune_bodies_to_cap(c, &artifacts, 2).unwrap(),
                sweep_body_orphans(c, &artifacts).unwrap()
            ])
        } else {
            let output = std::process::Command::new("bun")
                .arg("--no-env-file")
                .arg(&script)
                .arg(&path)
                .arg(&artifacts)
                .env_clear()
                .env("PATH", std::env::var("PATH").unwrap())
                .env("HOME", &base)
                .current_dir(&root)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            serde_json::from_slice(&output.stdout).unwrap()
        };
        let rows = c.prepare("SELECT request_id,at,rel_path,size_bytes,sha256,detail_state,truncated FROM request_bodies ORDER BY request_id").unwrap().query_map([], |r| Ok(json!([["string",r.get::<_,String>(0)?],["number",r.get::<_,i64>(1)?],["string",r.get::<_,String>(2)?],["number",r.get::<_,i64>(3)?],["null"],["string",r.get::<_,String>(5)?],["number",r.get::<_,i64>(6)?]]))).unwrap().collect::<Result<Vec<_>,_>>().unwrap();
        let mut files = std::fs::read_dir(&artifacts)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        files.sort();
        results.push(json!({"counts":counts,"rows":rows,"files":files}));
    }
    assert_eq!(results[0], results[1]);
    assert_eq!(results[0]["counts"], json!([1, 1, 1]));
}

//! Shared helpers: locating the repo, running Bun, driving the TS CLI.

#![allow(dead_code)]

use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

pub const ENCRYPTION_KEY: &str = "omni-store-test-key-0123456789";

pub fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .expect("repo root")
}

/// True when `bun` runs. Otherwise prints why the caller is skipping.
pub fn bun_available(test: &str) -> bool {
    let ok = Command::new("bun")
        .arg("--version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    if !ok {
        println!("skipping {test}: `bun` is not on PATH, so the TS side cannot run");
    }
    ok
}

fn run(mut cmd: Command, stdin: &str, what: &str) -> String {
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = cmd.spawn().expect("spawn bun");
    child
        .stdin
        .take()
        .expect("stdin")
        .write_all(stdin.as_bytes())
        .expect("write stdin");
    let out = child.wait_with_output().expect("bun output");
    assert!(
        out.status.success(),
        "{what} failed ({}): {}",
        out.status,
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8(out.stdout).expect("utf8 stdout")
}

/// Runs a TS script (written to `dir`) with Bun from the repo root.
pub fn bun_script(dir: &Path, source: &str, stdin: &str) -> String {
    let file = dir.join(format!("script-{}.ts", std::process::id()));
    std::fs::write(&file, source).expect("write script");
    let mut cmd = Command::new("bun");
    cmd.arg(&file).current_dir(repo_root());
    run(cmd, stdin, "bun script")
}

/// A CLI root: `<dir>/.env` naming the key and the database.
pub fn cli_root(dir: &Path) -> PathBuf {
    let db = dir.join("omni.db");
    std::fs::write(
        dir.join(".env"),
        format!(
            "OMNI_ENCRYPTION_KEY={ENCRYPTION_KEY}\nOMNI_DB_PATH={}\n",
            db.display()
        ),
    )
    .expect("write .env");
    db
}

/// `bun apps/cli/src/index.ts --root <dir> --json <args>`, parsed.
pub fn omni(dir: &Path, args: &[&str], stdin: &str) -> serde_json::Value {
    let mut cmd = Command::new("bun");
    cmd.arg("apps/cli/src/index.ts")
        .arg("--root")
        .arg(dir)
        .arg("--json")
        .args(args)
        .current_dir(repo_root())
        .env_clear()
        .env("PATH", std::env::var("PATH").unwrap_or_default())
        .env("HOME", std::env::var("HOME").unwrap_or_default());
    let out = run(cmd, stdin, &format!("omni {}", args.join(" ")));
    serde_json::from_str(&out).expect("cli json")
}

/// Numbers as f64 and object keys sorted, so a Rust `1.0` and a JS `1` compare
/// equal the way `JSON.stringify` would print them.
pub fn canon(value: &serde_json::Value) -> serde_json::Value {
    use serde_json::Value;
    match value {
        Value::Number(n) => serde_json::Number::from_f64(n.as_f64().expect("finite"))
            .map_or(Value::Null, Value::Number),
        Value::Array(items) => Value::Array(items.iter().map(canon).collect()),
        Value::Object(map) => {
            let mut entries: Vec<_> = map.iter().map(|(k, v)| (k.clone(), canon(v))).collect();
            entries.sort_by(|a, b| a.0.cmp(&b.0));
            Value::Object(entries.into_iter().collect())
        }
        other => other.clone(),
    }
}

/// Absolute TS module path, for imports in a script.
pub fn ts(rel: &str) -> String {
    repo_root().join(rel).display().to_string()
}

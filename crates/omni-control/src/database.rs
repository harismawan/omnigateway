//! File-backed database maintenance shared by operator front ends.
pub fn clear_bodies(
    conn: &rusqlite::Connection,
    dir: &std::path::Path,
    now: i64,
) -> Result<serde_json::Value, String> {
    let rows = conn
        .prepare("SELECT request_id, rel_path FROM request_bodies WHERE at < ?")
        .map_err(|e| e.to_string())?
        .query_map([now], |r| {
            Ok((bun_cell(r.get_ref(0)?), bun_cell(r.get_ref(1)?)))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    for (_, rel) in &rows {
        // Frozen path.join validates here, outside unlink's catch. Earlier
        // artifact deletions survive refusal; SQL deletion has not begun.
        match rel {
            rusqlite::types::Value::Null => {}
            rusqlite::types::Value::Text(rel) => delete_artifact(dir, rel),
            value => {
                let kind = match value {
                    rusqlite::types::Value::Blob(_) => "object",
                    _ => "number",
                };
                return Err(format!(
                    "The \"paths[1]\" property must be of type string, got {kind}"
                ));
            }
        }
    }
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    for (id, _) in &rows {
        tx.execute("DELETE FROM request_bodies WHERE request_id = ?", [id])
            .map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    // Frozen sweep takes this snapshot before walking, then rechecks only misses.
    // Non-TEXT cells cannot strictly equal a JavaScript path string.
    let known = conn
        .prepare("SELECT rel_path FROM request_bodies WHERE rel_path IS NOT NULL")
        .map_err(|e| e.to_string())?
        .query_map([], |r| {
            Ok(match r.get_ref(0)? {
                rusqlite::types::ValueRef::Text(bytes) => {
                    Some(String::from_utf8_lossy(bytes).into_owned())
                }
                _ => None,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?
        .into_iter()
        .flatten()
        .collect::<std::collections::HashSet<_>>();
    let mut files = Vec::new();
    list_artifacts(dir, dir, &mut files);
    let mut orphans = 0;
    for rel in files {
        if known.contains(&rel) {
            continue;
        }
        let claimed: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM request_bodies WHERE rel_path = ?",
                [&rel],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        if claimed == 0 {
            delete_artifact(dir, &rel);
            orphans += 1;
        }
    }
    Ok(serde_json::json!({"removed":rows.len(),"orphans":orphans}))
}

// Bun SQLite replaces malformed TEXT bytes, but keeps other cell types distinct.
fn bun_cell(cell: rusqlite::types::ValueRef<'_>) -> rusqlite::types::Value {
    match cell {
        rusqlite::types::ValueRef::Text(bytes) => {
            rusqlite::types::Value::Text(String::from_utf8_lossy(bytes).into_owned())
        }
        rusqlite::types::ValueRef::Null => rusqlite::types::Value::Null,
        rusqlite::types::ValueRef::Integer(n) => rusqlite::types::Value::Integer(n),
        rusqlite::types::ValueRef::Real(n) => rusqlite::types::Value::Real(n),
        rusqlite::types::ValueRef::Blob(bytes) => rusqlite::types::Value::Blob(bytes.to_vec()),
    }
}

// Node's POSIX path.join concatenates before normalizing, including absolute rels.
fn node_join(root: &str, rel: &str) -> std::path::PathBuf {
    let joined = [root, rel]
        .into_iter()
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("/");
    let absolute = joined.starts_with('/');
    let mut parts = Vec::new();
    for part in joined.split('/') {
        match part {
            "" | "." => {}
            ".." if parts.last().is_some_and(|p| *p != "..") => {
                parts.pop();
            }
            ".." if absolute => {}
            _ => parts.push(part),
        }
    }
    let mut result = format!("{}{}", if absolute { "/" } else { "" }, parts.join("/"));
    if result.is_empty() {
        result.push('.');
    }
    if joined.ends_with('/') && !result.ends_with('/') {
        result.push('/');
    }
    result.into()
}

fn delete_artifact(dir: &std::path::Path, rel: &str) {
    let full = node_join(&dir.to_string_lossy(), rel);
    if std::fs::remove_file(&full).is_err() {
        return;
    }
    let mut parent = full.parent();
    while let Some(path) = parent {
        if path == dir || !path.starts_with(dir) || std::fs::remove_dir(path).is_err() {
            break;
        }
        parent = path.parent();
    }
}

fn list_artifacts(root: &std::path::Path, dir: &std::path::Path, files: &mut Vec<String>) {
    for entry in crate::database_fs::readdir(dir) {
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        if kind.is_dir() {
            list_artifacts(root, &entry.path(), files);
        } else if kind.is_file()
            && let Ok(rel) = entry.path().strip_prefix(root)
        {
            files.push(rel.to_string_lossy().into_owned());
        }
    }
}

pub fn vacuum(
    conn: &rusqlite::Connection,
    path: &std::path::Path,
    now: &dyn Fn() -> i64,
) -> Result<serde_json::Value, String> {
    let _exclusive = EXCLUSIVE.enter("a vacuum")?;
    let before = size(path);
    let start = now();
    conn.execute_batch("VACUUM; PRAGMA wal_checkpoint(TRUNCATE)")
        .map_err(|e| e.to_string())?;
    Ok(
        serde_json::json!({"reclaimedBytes":before.saturating_sub(size(path)),"durationMs":(now()-start).max(0)}),
    )
}
use crate::fs_error::fs_error;
use serde_json::{Value, json};
use std::path::Path;

/// Shared preview/swap validation, before stat or acquiring the restore latch.
fn snapshot_path(live: &Path, id: &str) -> Result<std::path::PathBuf, String> {
    let invalid = || "BAD_REQUEST: invalid snapshot id".to_string();
    let (stamp, reason) = id
        .strip_prefix("db_")
        .and_then(|s| s.strip_suffix(".sqlite"))
        .and_then(|s| s.split_once('_'))
        .ok_or_else(invalid)?;
    if stamp.len() != 24
        || reason.is_empty()
        || !reason.bytes().all(|b| b.is_ascii_alphabetic())
        || !stamp.bytes().enumerate().all(|(i, b)| match i {
            4 | 7 | 13 | 16 | 19 => b == b'-',
            10 => b == b'T',
            23 => b == b'Z',
            _ => b.is_ascii_digit(),
        })
    {
        return Err(invalid());
    }
    let iso = format!(
        "{}:{}:{}.{}",
        &stamp[..13],
        &stamp[14..16],
        &stamp[17..19],
        &stamp[20..]
    );
    if crate::date::parse(&iso).is_none() {
        return Err(invalid());
    }
    let dir = live
        .parent()
        .ok_or("database has no parent")?
        .join("snapshots");
    let path = dir.join(id);
    if let Ok(real) = path.canonicalize() {
        let real_dir = dir.canonicalize().unwrap_or(dir);
        if real.parent() != Some(real_dir.as_path()) {
            return Err(invalid());
        }
    }
    Ok(path)
}

/// Resolve and judge a candidate without swapping any files.
pub fn validate_restore(live: &Path, id: &str) -> Result<Value, String> {
    let path = snapshot_path(live, id)?;
    if crate::database_fs::stat(&path).is_none() {
        return Err("BAD_REQUEST: no such snapshot".into());
    }
    with_exclusive("a restore preview", || {
        let snapshot = judge_candidate(&path)?;
        let live = judge_candidate(live).ok();
        Ok(json!({"snapshot": snapshot, "live": live}))
    })
}

fn judge_candidate(path: &Path) -> Result<Value, String> {
    let inspect = || -> Result<(String, Vec<String>, Value), rusqlite::Error> {
        let conn = rusqlite::Connection::open_with_flags(
            path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )?;
        let check = conn.query_row("PRAGMA quick_check", [], |r| r.get::<_, String>(0))?;
        let mut stmt = conn.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")?;
        let tables = stmt
            .query_map([], |r| {
                Ok(String::from_utf8_lossy(r.get_ref(0)?.as_bytes()?).into_owned())
            })?
            .collect::<Result<Vec<_>, _>>()?;
        let mut counts = json!({});
        for table in [
            "api_keys",
            "credential_health",
            "credentials",
            "migrations",
            "quota_windows",
            "request_logs",
            "settings",
            "virtual_models",
        ] {
            if tables.iter().any(|t| t == table) {
                counts[table] = json!(conn.query_row(
                    &format!("SELECT COUNT(*) FROM {table}"),
                    [],
                    |r| r.get::<_, i64>(0)
                )?);
            }
        }
        Ok((check, tables, counts))
    };
    let (check, tables, counts) = inspect()
        .map_err(|_| "BAD_REQUEST: that file failed its integrity check: unreadable".to_string())?;
    if check != "ok" {
        return Err(format!(
            "BAD_REQUEST: that file failed its integrity check: {check}"
        ));
    }
    if counts.as_object().is_none_or(|c| c.len() != 8) {
        let description = if tables.is_empty() {
            "it has no tables at all".into()
        } else {
            let mut text = format!("it has {}", tables[..tables.len().min(5)].join(", "));
            if tables.len() > 5 {
                text.push_str(&format!(" and {} more", tables.len() - 5));
            }
            text
        };
        return Err(format!(
            "BAD_REQUEST: that file is a database, but not one of ours: {description}"
        ));
    }
    Ok(counts)
}

pub fn create_snapshot(
    conn: &rusqlite::Connection,
    path: &Path,
    now: &dyn Fn() -> i64,
    retention: &dyn Fn() -> Result<(f64, f64), String>,
) -> Result<Value, String> {
    create_snapshot_with_free_bytes(conn, path, now, retention, &|dir| {
        rustix::fs::statfs(dir)
            .ok()
            .map(|s| s.f_bavail * s.f_bsize as u64)
    })
}

pub fn create_snapshot_with_free_bytes(
    conn: &rusqlite::Connection,
    path: &Path,
    now: &dyn Fn() -> i64,
    retention: &dyn Fn() -> Result<(f64, f64), String>,
    free_bytes: &dyn Fn(&Path) -> Option<u64>,
) -> Result<Value, String> {
    let _exclusive = EXCLUSIVE.enter("a snapshot")?;
    write_snapshot(conn, path, now, retention, free_bytes, false)
}

// The restore caller already holds the exclusive guard. Its forced undo must
// survive even a retention policy that would immediately prune every snapshot.
fn write_snapshot(
    conn: &rusqlite::Connection,
    path: &Path,
    now: &dyn Fn() -> i64,
    retention: &dyn Fn() -> Result<(f64, f64), String>,
    free_bytes: &dyn Fn(&Path) -> Option<u64>,
    force: bool,
) -> Result<Value, String> {
    let at = now();
    let stamp = chrono::DateTime::from_timestamp_millis(at)
        .ok_or("invalid snapshot time")?
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
        .replace([':', '.'], "-");
    let reason = if force { "preRestore" } else { "manual" };
    let name = format!("db_{stamp}_{reason}.sqlite");
    let dir = path
        .parent()
        .ok_or("database has no parent")?
        .join("snapshots");
    std::fs::create_dir_all(&dir).map_err(|e| fs_error(&e, "mkdir", &dir))?;
    let target = dir.join(&name);
    if crate::database_fs::stat(&target).is_some() {
        return Err("CONFLICT: a snapshot for this instant already exists".into());
    }
    let free = free_bytes(&dir);
    let needed = (crate::database_fs::stat(path).map_or(0, |s| s.len()) as f64 * 1.1).ceil();
    if free.is_some_and(|free| (free as f64) < needed) {
        return Err("CONFLICT: not enough free disk space to write a snapshot".into());
    }
    if let Err(error) = conn.execute_batch(&format!(
        "VACUUM INTO '{}'",
        target.to_string_lossy().replace('\'', "''")
    )) {
        unlink(&target)?;
        return Err(error.to_string());
    }
    let result = json!({"id":name,"filename":name,"createdAt":at,"sizeBytes":crate::database_fs::stat(&target).map_or(0, |s| s.len()),"reason":reason});
    if !force {
        let (keep_latest, max_age_days) = retention()?;
        prune(&dir, at, keep_latest, max_age_days)?;
    }
    Ok(result)
}

fn size(path: &Path) -> u64 {
    path.metadata().map(|s| s.len()).unwrap_or(0)
}

/// Operations on the one live handle. Implementations must release it at close.
pub type HashCell = Option<rusqlite::types::Value>;

// Bun returns numbers for INTEGER/REAL and a fresh Uint8Array for each BLOB.
// readRaw coalesces both an absent row and SQL NULL to JavaScript null.
fn hashes_equal(left: &HashCell, right: &HashCell) -> bool {
    use rusqlite::types::Value as Cell;
    match (
        left.as_ref().unwrap_or(&Cell::Null),
        right.as_ref().unwrap_or(&Cell::Null),
    ) {
        (Cell::Null, Cell::Null) => true,
        (Cell::Text(a), Cell::Text(b)) => a == b,
        (Cell::Integer(a), Cell::Integer(b)) => (*a as f64) == (*b as f64),
        (Cell::Real(a), Cell::Real(b)) => a == b,
        (Cell::Integer(a), Cell::Real(b)) | (Cell::Real(b), Cell::Integer(a)) => (*a as f64) == *b,
        _ => false,
    }
}

pub trait RestoreStore {
    fn inspect(&mut self, path: &Path) -> Result<Value, String>;
    fn snapshot_to(&mut self, path: &Path) -> Result<(), String>;
    fn admin_hash(&mut self) -> Result<HashCell, String>;
    fn viewer_hash(&mut self) -> Result<HashCell, String>;
    fn close(&mut self) -> Result<(), String>;
    fn reopen(&mut self) -> Result<(), String>;
    fn rebuild_rollup(&mut self) -> Result<(), String>;
}

/// Missing or inaccessible stat results are indistinguishable, as in the CLI adapter.
pub trait RestoreFiles {
    fn stat(&mut self, path: &Path) -> Option<u64>;
    fn mkdir(&mut self, path: &Path) -> Result<(), String>;
    fn free_bytes(&mut self, path: &Path) -> Option<u64>;
    fn unlink(&mut self, path: &Path) -> Result<(), String>;
    fn copy_file(&mut self, from: &Path, to: &Path) -> Result<(), String>;
    fn rename(&mut self, from: &Path, to: &Path) -> Result<(), String>;
}

#[derive(Debug)]
pub struct SwapFailedError {
    pub pre_restore_snapshot_id: String,
    pub cause: String,
    pub reopened: bool,
}

impl std::fmt::Display for SwapFailedError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("the database swap failed and the database may be incomplete")
    }
}
impl std::error::Error for SwapFailedError {}

#[derive(Debug)]
pub enum RestoreError {
    Ordinary(String),
    Swap(SwapFailedError),
}
impl From<String> for RestoreError {
    fn from(error: String) -> Self {
        Self::Ordinary(error)
    }
}
impl std::fmt::Display for RestoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Ordinary(error) => f.write_str(error),
            Self::Swap(error) => error.fmt(f),
        }
    }
}
impl std::error::Error for RestoreError {}

/// Revalidate the snapshot path, then inspect it again under the latch.
/// There is deliberately no rollback after staging: failed swaps retain the undo.
pub fn restore_snapshot(
    store: &mut dyn RestoreStore,
    files: &mut dyn RestoreFiles,
    live: &Path,
    id: &str,
    now: &dyn Fn() -> i64,
) -> Result<Value, RestoreError> {
    let candidate = snapshot_path(live, id)?;
    let dir = candidate
        .parent()
        .expect("validated snapshot parent")
        .to_path_buf();
    if files.stat(&candidate).is_none() {
        return Err("BAD_REQUEST: no such snapshot".to_string().into());
    }
    let _guard = EXCLUSIVE.enter("a restore")?;
    let counts = store.inspect(&candidate)?;
    let at = now();
    let stamp = chrono::DateTime::from_timestamp_millis(at)
        .ok_or_else(|| "invalid snapshot time".to_string())?
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
        .replace([':', '.'], "-");
    let name = format!("db_{stamp}_preRestore.sqlite");
    let target = dir.join(&name);
    files.mkdir(&dir)?;
    if files.stat(&target).is_some() {
        return Err("CONFLICT: a snapshot for this instant already exists"
            .to_string()
            .into());
    }
    let free = files.free_bytes(&dir);
    let needed = (files.stat(live).unwrap_or(0) as f64 * 1.1).ceil();
    if free.is_some_and(|free| (free as f64) < needed) {
        return Err("CONFLICT: not enough free disk space to write a snapshot"
            .to_string()
            .into());
    }
    if let Err(error) = store.snapshot_to(&target) {
        files.unlink(&target)?;
        return Err(error.into());
    }
    // Forced undo has no retention callback, even when policy would prune everything.
    let snapshot = json!({"id":name,"filename":name,"createdAt":at,"sizeBytes":files.stat(&target).unwrap_or(0),"reason":"preRestore"});
    let admin_before = store.admin_hash()?;
    let viewer_before = store.viewer_hash()?;
    let staged = live.with_file_name(format!(
        "{}.incoming",
        live.file_name().unwrap_or_default().to_string_lossy()
    ));
    if let Err(error) = files.copy_file(&candidate, &staged) {
        files.unlink(&staged)?;
        return Err(error.into());
    }
    let swap = (|| -> Result<(), String> {
        store.close()?;
        files.unlink(&live.with_file_name(format!(
            "{}-wal",
            live.file_name().unwrap_or_default().to_string_lossy()
        )))?;
        files.unlink(&live.with_file_name(format!(
            "{}-shm",
            live.file_name().unwrap_or_default().to_string_lossy()
        )))?;
        files.rename(&staged, live)?;
        store.reopen()
    })();
    if let Err(cause) = swap {
        let reopened = store.reopen().is_ok();
        return Err(RestoreError::Swap(SwapFailedError {
            pre_restore_snapshot_id: name,
            cause,
            reopened,
        }));
    }
    let admin_after = store.admin_hash()?;
    let viewer_after = store.viewer_hash()?;
    if let Err(error) = store.rebuild_rollup() {
        tracing::warn!(%error, "usage rollup not rebuilt after the swap; run omni doctor");
    }
    Ok(
        json!({"ok":true,"counts":counts,"preRestoreSnapshot":snapshot,"adminPasswordChanged":!hashes_equal(&admin_after, &admin_before),"viewerPasswordChanged":!hashes_equal(&viewer_after, &viewer_before)}),
    )
}

pub struct SqliteRestoreStore {
    store: Option<omni_store::SqliteStore>,
    path: std::path::PathBuf,
    day_offset: i64,
}
impl SqliteRestoreStore {
    pub fn new(store: omni_store::SqliteStore, path: std::path::PathBuf) -> Self {
        let day_offset = store.day_offset_minutes();
        Self {
            store: Some(store),
            path,
            day_offset,
        }
    }
    fn connection(&self) -> Result<&rusqlite::Connection, String> {
        self.store
            .as_ref()
            .map(|s| s.connection())
            .ok_or_else(|| "database is closed".into())
    }
    fn hash(&self, key: &str) -> Result<HashCell, String> {
        use rusqlite::OptionalExtension;
        self.connection()?
            .query_row("SELECT value FROM settings WHERE key = ?", [key], |r| {
                use rusqlite::types::{Value, ValueRef};
                Ok(match r.get_ref(0)? {
                    ValueRef::Text(bytes) => {
                        Value::Text(String::from_utf8_lossy(bytes).into_owned())
                    }
                    ValueRef::Null => Value::Null,
                    ValueRef::Integer(n) => Value::Integer(n),
                    ValueRef::Real(n) => Value::Real(n),
                    ValueRef::Blob(bytes) => Value::Blob(bytes.to_vec()),
                })
            })
            .optional()
            .map_err(|e| e.to_string())
    }
}
impl RestoreStore for SqliteRestoreStore {
    fn inspect(&mut self, path: &Path) -> Result<Value, String> {
        judge_candidate(path)
    }
    fn snapshot_to(&mut self, path: &Path) -> Result<(), String> {
        self.connection()?
            .execute_batch(&format!(
                "VACUUM INTO '{}'",
                path.to_string_lossy().replace('\'', "''")
            ))
            .map_err(|e| e.to_string())
    }
    fn admin_hash(&mut self) -> Result<HashCell, String> {
        self.hash("adminPasswordHash")
    }
    fn viewer_hash(&mut self) -> Result<HashCell, String> {
        self.hash("viewerPasswordHash")
    }
    fn close(&mut self) -> Result<(), String> {
        self.store.take();
        Ok(())
    }
    fn reopen(&mut self) -> Result<(), String> {
        self.store.take();
        self.store = Some(
            omni_store::SqliteStore::open(&self.path, self.day_offset)
                .map_err(|e| e.to_string())?,
        );
        Ok(())
    }
    fn rebuild_rollup(&mut self) -> Result<(), String> {
        omni_store::rollup::rebuild_rollup(self.connection()?).map_err(|e| e.to_string())
    }
}

pub struct LocalRestoreFiles;
impl RestoreFiles for LocalRestoreFiles {
    fn stat(&mut self, path: &Path) -> Option<u64> {
        crate::database_fs::stat(path).map(|s| s.len())
    }
    fn mkdir(&mut self, path: &Path) -> Result<(), String> {
        std::fs::create_dir_all(path).map_err(|e| fs_error(&e, "mkdir", path))
    }
    fn free_bytes(&mut self, path: &Path) -> Option<u64> {
        rustix::fs::statfs(path)
            .ok()
            .map(|s| s.f_bavail * s.f_bsize as u64)
    }
    fn unlink(&mut self, path: &Path) -> Result<(), String> {
        unlink(path)
    }
    fn copy_file(&mut self, from: &Path, to: &Path) -> Result<(), String> {
        std::fs::copy(from, to)
            .map(|_| ())
            .map_err(|e| format!("{} -> '{}'", fs_error(&e, "copyfile", from), to.display()))
    }
    fn rename(&mut self, from: &Path, to: &Path) -> Result<(), String> {
        std::fs::rename(from, to)
            .map_err(|e| format!("{} -> '{}'", fs_error(&e, "rename", from), to.display()))
    }
}

#[cfg(test)]
mod restore_sequence_tests {
    use super::*;
    use std::{cell::RefCell, rc::Rc};

    #[derive(Clone, Default)]
    struct Fake(Rc<RefCell<Vec<String>>>);
    impl Fake {
        fn call(&self, operation: &str) {
            self.0.borrow_mut().push(operation.into());
        }
    }
    impl RestoreStore for Fake {
        fn inspect(&mut self, _: &Path) -> Result<Value, String> {
            self.call("inspect");
            Ok(json!({"settings": 4}))
        }
        fn snapshot_to(&mut self, _: &Path) -> Result<(), String> {
            self.call("snapshot");
            Ok(())
        }
        fn admin_hash(&mut self) -> Result<HashCell, String> {
            self.call("admin");
            Ok(None)
        }
        fn viewer_hash(&mut self) -> Result<HashCell, String> {
            self.call("viewer");
            Ok(None)
        }
        fn close(&mut self) -> Result<(), String> {
            self.call("close");
            Ok(())
        }
        fn reopen(&mut self) -> Result<(), String> {
            self.call("reopen");
            Ok(())
        }
        fn rebuild_rollup(&mut self) -> Result<(), String> {
            self.call("rollup");
            Ok(())
        }
    }
    impl RestoreFiles for Fake {
        fn stat(&mut self, path: &Path) -> Option<u64> {
            let name = path
                .file_name()
                .expect("fixture filename")
                .to_string_lossy();
            let undo = name.ends_with("_preRestore.sqlite");
            self.call(if undo {
                "stat undo"
            } else if name == "db" {
                "stat live"
            } else {
                "stat candidate"
            });
            if undo && !self.0.borrow().iter().any(|s| s == "snapshot") {
                None
            } else {
                Some(100)
            }
        }
        fn mkdir(&mut self, _: &Path) -> Result<(), String> {
            self.call("mkdir");
            Ok(())
        }
        fn free_bytes(&mut self, _: &Path) -> Option<u64> {
            self.call("free");
            Some(1000)
        }
        fn unlink(&mut self, path: &Path) -> Result<(), String> {
            self.call(&format!(
                "unlink {}",
                path.file_name()
                    .expect("fixture filename")
                    .to_string_lossy()
            ));
            Ok(())
        }
        fn copy_file(&mut self, _: &Path, _: &Path) -> Result<(), String> {
            self.call("copy");
            Ok(())
        }
        fn rename(&mut self, _: &Path, _: &Path) -> Result<(), String> {
            self.call("rename");
            Ok(())
        }
    }
    #[test]
    fn restore_rejects_unchecked_ids_before_store_or_file_operations() {
        for id in ["../outside.sqlite", "..", "nested/candidate"] {
            let mut store = Fake::default();
            let mut files = store.clone();
            let error = restore_snapshot(
                &mut store,
                &mut files,
                Path::new("/tmp/opencode/e1-e5/unchecked/db"),
                id,
                &|| 0,
            )
            .expect_err("unchecked id must be rejected");
            assert_eq!(error.to_string(), "BAD_REQUEST: invalid snapshot id");
            assert!(files.0.borrow().is_empty());
        }
    }
    #[test]
    fn swap_exact_sequence_keeps_forced_undo_without_retention() {
        let mut store = Fake::default();
        let mut files = store.clone();
        // Retry only latch contention with other maintenance unit tests.
        let result = loop {
            files.0.borrow_mut().clear();
            match restore_snapshot(
                &mut store,
                &mut files,
                Path::new("/fixture/db"),
                "db_2026-11-01T00-00-00-000Z_manual.sqlite",
                &|| 0,
            ) {
                Err(RestoreError::Ordinary(e)) if e.starts_with("CONFLICT:") => {
                    std::thread::yield_now()
                }
                result => break result.expect("successful swap"),
            }
        };
        assert_eq!(
            *files.0.borrow(),
            [
                "stat candidate",
                "inspect",
                "mkdir",
                "stat undo",
                "free",
                "stat live",
                "snapshot",
                "stat undo",
                "admin",
                "viewer",
                "copy",
                "close",
                "unlink db-wal",
                "unlink db-shm",
                "rename",
                "reopen",
                "admin",
                "viewer",
                "rollup"
            ]
        );
        assert_eq!(result["preRestoreSnapshot"]["reason"], "preRestore");
        assert_eq!(result["counts"], json!({"settings":4}));
        assert_eq!(result["adminPasswordChanged"], false);
        assert_eq!(result["viewerPasswordChanged"], false);
    }

    #[derive(Default)]
    struct FailureState {
        calls: Vec<String>,
        undo: bool,
        incoming: bool,
        installed: bool,
    }
    #[derive(Clone)]
    struct Failing {
        state: Rc<RefCell<FailureState>>,
        failure: &'static str,
    }
    impl Failing {
        fn call(&self, name: &str) -> Result<(), String> {
            self.state.borrow_mut().calls.push(name.into());
            if name == self.failure {
                Err(format!("{name} failed"))
            } else {
                Ok(())
            }
        }
    }
    impl RestoreStore for Failing {
        fn inspect(&mut self, _: &Path) -> Result<Value, String> {
            self.call("inspect")?;
            Ok(json!({}))
        }
        fn snapshot_to(&mut self, _: &Path) -> Result<(), String> {
            self.state.borrow_mut().undo = true; // Include a partial VACUUM output.
            self.call("snapshot")
        }
        fn admin_hash(&mut self) -> Result<HashCell, String> {
            self.call("admin")?;
            Ok(None)
        }
        fn viewer_hash(&mut self) -> Result<HashCell, String> {
            self.call("viewer")?;
            Ok(None)
        }
        fn close(&mut self) -> Result<(), String> {
            self.call("close")
        }
        fn reopen(&mut self) -> Result<(), String> {
            self.call("reopen")
        }
        fn rebuild_rollup(&mut self) -> Result<(), String> {
            self.call("rollup")
        }
    }
    impl RestoreFiles for Failing {
        fn stat(&mut self, path: &Path) -> Option<u64> {
            let undo = path.to_string_lossy().ends_with("_preRestore.sqlite");
            self.call(if undo {
                "stat undo"
            } else if path.ends_with("db") {
                "stat live"
            } else {
                "stat candidate"
            })
            .expect("stat succeeds");
            if undo && !self.state.borrow().undo {
                None
            } else {
                Some(100)
            }
        }
        fn mkdir(&mut self, _: &Path) -> Result<(), String> {
            self.call("mkdir")
        }
        fn free_bytes(&mut self, _: &Path) -> Option<u64> {
            self.call("free").expect("free succeeds");
            Some(1000)
        }
        fn unlink(&mut self, path: &Path) -> Result<(), String> {
            let undo = path.to_string_lossy().ends_with("_preRestore.sqlite");
            self.call(if undo {
                "unlink undo"
            } else if path.to_string_lossy().ends_with("-wal") {
                "unlink wal"
            } else {
                "unlink shm"
            })?;
            if undo {
                self.state.borrow_mut().undo = false;
            }
            Ok(())
        }
        fn copy_file(&mut self, _: &Path, _: &Path) -> Result<(), String> {
            self.call("copy")?;
            self.state.borrow_mut().incoming = true;
            Ok(())
        }
        fn rename(&mut self, _: &Path, _: &Path) -> Result<(), String> {
            self.call("rename")?;
            let mut state = self.state.borrow_mut();
            state.incoming = false;
            state.installed = true;
            Ok(())
        }
    }
    #[test]
    fn failures_preserve_frozen_half_swap_states_and_sequences() {
        // packages/control/src/database.ts:603–621: "unconditional: whatever
        // file is at `live` now"; close, unlink WAL/SHM, rename, reopen; catch
        // retries reopen and throws SwapFailedError. No cleanup or rollback.
        // :421–427: "A half-written file ... It goes before the failure is
        // reported"; unlink failed undo then rethrow the ordinary write error.
        let prefix = [
            "stat candidate",
            "inspect",
            "mkdir",
            "stat undo",
            "free",
            "stat live",
            "snapshot",
        ];
        let tails: &[(&str, &[&str], bool, bool, bool)] = &[
            ("snapshot", &["unlink undo"], false, false, false),
            (
                "unlink wal",
                &[
                    "stat undo",
                    "admin",
                    "viewer",
                    "copy",
                    "close",
                    "unlink wal",
                    "reopen",
                ],
                true,
                true,
                false,
            ),
            (
                "unlink shm",
                &[
                    "stat undo",
                    "admin",
                    "viewer",
                    "copy",
                    "close",
                    "unlink wal",
                    "unlink shm",
                    "reopen",
                ],
                true,
                true,
                false,
            ),
            (
                "rename",
                &[
                    "stat undo",
                    "admin",
                    "viewer",
                    "copy",
                    "close",
                    "unlink wal",
                    "unlink shm",
                    "rename",
                    "reopen",
                ],
                true,
                true,
                false,
            ),
            (
                "reopen",
                &[
                    "stat undo",
                    "admin",
                    "viewer",
                    "copy",
                    "close",
                    "unlink wal",
                    "unlink shm",
                    "rename",
                    "reopen",
                    "reopen",
                ],
                true,
                false,
                true,
            ),
        ];
        for &(failure, tail, undo, incoming, installed) in tails {
            let mut seam = Failing {
                state: Rc::default(),
                failure,
            };
            let error = loop {
                *seam.state.borrow_mut() = FailureState::default();
                match restore_snapshot(
                    &mut seam.clone(),
                    &mut seam,
                    Path::new("/fixture/db"),
                    "db_2026-11-01T00-00-00-000Z_manual.sqlite",
                    &|| 0,
                ) {
                    Err(RestoreError::Ordinary(e)) if e.starts_with("CONFLICT:") => {
                        std::thread::yield_now()
                    }
                    result => break result.expect_err("injected failure"),
                }
            };
            let state = seam.state.borrow();
            assert_eq!(
                state.calls,
                prefix
                    .iter()
                    .chain(tail.iter())
                    .map(|s| s.to_string())
                    .collect::<Vec<_>>(),
                "{failure}"
            );
            assert_eq!(
                (state.undo, state.incoming, state.installed),
                (undo, incoming, installed),
                "{failure}"
            );
            if failure == "snapshot" {
                assert!(matches!(error, RestoreError::Ordinary(_)));
                assert_eq!(error.to_string(), "snapshot failed");
            } else {
                assert_eq!(
                    error.to_string(),
                    "the database swap failed and the database may be incomplete"
                );
                let RestoreError::Swap(error) = error else {
                    panic!("typed swap failure")
                };
                assert_eq!(error.cause, format!("{failure} failed"));
                assert_eq!(error.reopened, failure != "reopen");
                assert_eq!(
                    error.pre_restore_snapshot_id,
                    "db_1970-01-01T00-00-00-000Z_preRestore.sqlite"
                );
            }
        }
    }
}

/// Process-local maintenance latch, shared by all database handles.
#[derive(Default)]
struct Exclusive(std::sync::Mutex<Option<&'static str>>);

static EXCLUSIVE: Exclusive = Exclusive(std::sync::Mutex::new(None));

struct ExclusiveGuard<'a>(&'a Exclusive);

impl Exclusive {
    fn enter(&self, label: &'static str) -> Result<ExclusiveGuard<'_>, String> {
        let mut active = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(active) = *active {
            return Err(format!(
                "CONFLICT: {active} is already running on this database"
            ));
        }
        *active = Some(label);
        Ok(ExclusiveGuard(self))
    }
}

impl Drop for ExclusiveGuard<'_> {
    fn drop(&mut self) {
        *self.0.0.lock().unwrap_or_else(|e| e.into_inner()) = None;
    }
}

pub fn with_exclusive<T>(
    label: &'static str,
    operation: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    let _guard = EXCLUSIVE.enter(label)?;
    operation()
}

pub fn with_exclusive_or_skip<T>(
    label: &'static str,
    operation: impl FnOnce() -> Result<T, String>,
) -> Result<Option<T>, String> {
    let Ok(_guard) = EXCLUSIVE.enter(label) else {
        return Ok(None);
    };
    operation().map(Some)
}

/// Numeric coercion at the retention comparisons, without validating stored settings.
pub fn retention_number(value: Option<&omni_ir::jsjson::JsValue>) -> Result<f64, String> {
    use omni_ir::jsjson::JsValue as V;
    Ok(match value {
        None | Some(V::Undefined) => f64::NAN,
        Some(V::Number(n)) => *n,
        Some(V::Null) => 0.0,
        Some(V::Bool(b)) => f64::from(*b),
        Some(v) => omni_ir::js::string_to_number(&crate::operator_json::string(v)?),
    })
}

fn unlink(path: &Path) -> Result<(), String> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::IsADirectory => Err(format!(
            "Path is a directory: rm returned EISDIR (is a directory) {}",
            path.display()
        )),
        Err(e) => Err(fs_error(&e, "rm", path)),
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::items_after_test_module)]
mod tests {
    #[test]
    fn node_join_matches_bun_posix_table() {
        // Expected values captured from Bun path.join (dbfix1-c1-node-join.log).
        for (root, rel, expected) in [
            ("/root", "/outside", "/root/outside"),
            ("/root", "../outside", "/outside"),
            ("/root", "a//b/", "/root/a/b/"),
            ("/root/", "./a/../b", "/root/b"),
            ("/root", "", "/root"),
            ("", "", "."),
            ("", "/a//", "/a/"),
            ("a", "../../b/", "../b/"),
            ("/", "../../a", "/a"),
            ("/root", ".", "/root"),
        ] {
            assert_eq!(super::node_join(root, rel).as_os_str(), expected);
        }
    }
    use super::*;
    static TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    #[test]
    fn exclusive_conflicts_skips_and_releases() {
        let _serial = TEST_LOCK.lock().unwrap();
        with_exclusive("a snapshot", || {
            assert_eq!(
                with_exclusive("a vacuum", || Ok(())).unwrap_err(),
                "CONFLICT: a snapshot is already running on this database"
            );
            assert_eq!(
                with_exclusive_or_skip("a snapshot sweep", || panic!("must skip"))?,
                None::<()>
            );
            Ok(())
        })
        .unwrap();
        assert_eq!(
            with_exclusive_or_skip("a snapshot sweep", || Ok(42)).unwrap(),
            Some(42)
        );
        assert!(with_exclusive("a vacuum", || Err::<(), _>("failed".into())).is_err());
        assert!(with_exclusive("a restore", || Ok(())).is_ok());
        assert!(
            std::panic::catch_unwind(|| {
                with_exclusive("a vacuum", || -> Result<(), String> {
                    panic!("operation panicked")
                })
            })
            .is_err()
        );
        assert!(with_exclusive("a restore preview", || Ok(())).is_ok());
    }
    fn live_bytes(path: &Path) -> Vec<Option<Vec<u8>>> {
        ["", "-wal", "-shm"]
            .iter()
            .map(|suffix| {
                let path = std::path::PathBuf::from(format!("{}{suffix}", path.display()));
                match std::fs::read(path) {
                    Ok(bytes) => Some(bytes),
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
                    Err(e) => panic!("read live state: {e}"),
                }
            })
            .collect()
    }

    #[test]
    fn snapshot_free_space_threshold_and_unknown() {
        let _serial = TEST_LOCK.lock().unwrap();
        for free_offset in [Some(-1_i64), Some(0), Some(1), None] {
            let root = tempfile::tempdir().unwrap();
            let path = root.path().join("db");
            let conn = rusqlite::Connection::open(&path).unwrap();
            conn.execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE sentinel(value); INSERT INTO sentinel VALUES (42)").unwrap();
            let needed = (size(&path) as f64 * 1.1).ceil() as i64;
            let before = live_bytes(&path);
            let result = create_snapshot_with_free_bytes(
                &conn,
                &path,
                &|| 1_700_000_000_000,
                &|| Ok((3.0, 30.0)),
                &|_| free_offset.map(|offset| (needed + offset) as u64),
            );
            if free_offset == Some(-1) {
                assert_eq!(
                    result.unwrap_err(),
                    "CONFLICT: not enough free disk space to write a snapshot"
                );
                assert_eq!(live_bytes(&path), before);
                assert_eq!(
                    std::fs::read_dir(root.path().join("snapshots"))
                        .unwrap()
                        .count(),
                    0
                );
            } else {
                assert!(result.is_ok());
            }
        }
    }

    #[test]
    fn corrupt_table_snapshot_failure_removes_output() {
        let _serial = TEST_LOCK.lock().unwrap();
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("db");
        let conn = rusqlite::Connection::open(&path).unwrap();
        conn.execute_batch("PRAGMA page_size=4096; CREATE TABLE sentinel(value); INSERT INTO sentinel VALUES (zeroblob(100000))").unwrap();
        drop(conn);
        let mut bytes = std::fs::read(&path).unwrap();
        bytes[4096] = 0xff;
        std::fs::write(&path, bytes).unwrap();
        let conn = rusqlite::Connection::open(&path).unwrap();
        let before = live_bytes(&path);
        // Verify SQLite actually creates a partial output on this failure.
        let probe = root.path().join("probe");
        assert!(
            conn.execute_batch(&format!("VACUUM INTO '{}'", probe.display()))
                .is_err()
        );
        assert!(probe.exists());
        std::fs::remove_file(probe).unwrap();
        assert_eq!(
            create_snapshot(&conn, &path, &|| 1_700_000_000_000, &|| Ok((3.0, 30.0))).unwrap_err(),
            "database disk image is malformed"
        );
        assert_eq!(live_bytes(&path), before);
        assert_eq!(
            std::fs::read_dir(root.path().join("snapshots"))
                .unwrap()
                .count(),
            0
        );
    }
    #[test]
    fn forced_undo_inside_restore_guard_preserves_old_snapshot() {
        let _serial = TEST_LOCK.lock().unwrap();
        let root = tempfile::tempdir_in("/tmp/opencode/e1-e5").unwrap();
        let path = root.path().join("db");
        let store = omni_store::SqliteStore::open(&path, 0).unwrap();
        store.connection().execute_batch("CREATE TABLE sentinel(value); INSERT INTO sentinel VALUES (42); INSERT INTO settings (key,value) VALUES ('settings','{\"snapshotKeepLatest\":0,\"snapshotMaxAgeDays\":0}')")
            .unwrap();
        let dir = root.path().join("snapshots");
        std::fs::create_dir(&dir).unwrap();
        let old = dir.join("db_2000-01-01T00-00-00-000Z_manual.sqlite");
        std::fs::write(&old, b"retention sentinel").unwrap();
        let candidate = "db_2026-11-01T00-00-00-000Z_manual.sqlite";
        store
            .connection()
            .execute_batch(&format!("VACUUM INTO '{}'", dir.join(candidate).display()))
            .unwrap();
        let mut store = SqliteRestoreStore::new(store, path.clone());
        let restored = restore_snapshot(
            &mut store,
            &mut LocalRestoreFiles,
            &path,
            candidate,
            &|| 1_700_000_000_000,
        )
        .unwrap();
        let result = &restored["preRestoreSnapshot"];
        assert_eq!(result["reason"], "preRestore");
        assert_eq!(
            result["id"],
            "db_2023-11-14T22-13-20-000Z_preRestore.sqlite"
        );
        assert_eq!(std::fs::read(old).unwrap(), b"retention sentinel");
        let undo = rusqlite::Connection::open(dir.join(result["id"].as_str().unwrap())).unwrap();
        assert_eq!(
            undo.query_row("SELECT value FROM sentinel", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            42
        );
    }

    #[test]
    fn retention_is_read_after_snapshot_is_written() {
        let _serial = TEST_LOCK.lock().unwrap();
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("db");
        let conn = rusqlite::Connection::open(&path).unwrap();
        conn.execute_batch("CREATE TABLE sentinel(value)").unwrap();
        let result = create_snapshot(&conn, &path, &|| 1_700_000_000_000, &|| {
            let entry = std::fs::read_dir(root.path().join("snapshots"))
                .unwrap()
                .next()
                .unwrap()
                .unwrap();
            let snapshot = rusqlite::Connection::open(entry.path()).unwrap();
            assert_eq!(
                snapshot
                    .query_row("PRAGMA quick_check", [], |r| r.get::<_, String>(0))
                    .unwrap(),
                "ok"
            );
            Err("settings read failed".into())
        });
        assert_eq!(result.unwrap_err(), "settings read failed");
        assert_eq!(
            std::fs::read_dir(root.path().join("snapshots"))
                .unwrap()
                .count(),
            1
        );
    }
    #[test]
    fn same_instant_refused_and_failed_snapshot_cleaned() {
        let _serial = TEST_LOCK.lock().unwrap();
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("db");
        let conn = rusqlite::Connection::open(&path).unwrap();
        conn.execute_batch("CREATE TABLE sentinel(value); INSERT INTO sentinel VALUES (42)")
            .unwrap();
        let clock = || 1_700_000_000_000;
        let retention = || Ok((3.0, 30.0));
        let first = create_snapshot(&conn, &path, &clock, &retention).unwrap();
        let snapshot = root
            .path()
            .join("snapshots")
            .join(first["id"].as_str().unwrap());
        let before = std::fs::read(&snapshot).unwrap();
        let live_before = live_bytes(&path);
        assert_eq!(
            create_snapshot(&conn, &path, &clock, &retention).unwrap_err(),
            "CONFLICT: a snapshot for this instant already exists"
        );
        assert_eq!(std::fs::read(snapshot).unwrap(), before);
        assert_eq!(live_bytes(&path), live_before);
        conn.execute_batch("BEGIN").unwrap();
        assert!(create_snapshot(&conn, &path, &|| clock() + 1, &retention).is_err());
        assert_eq!(live_bytes(&path), live_before);
        assert_eq!(
            std::fs::read_dir(root.path().join("snapshots"))
                .unwrap()
                .count(),
            1
        );
        conn.execute_batch("ROLLBACK").unwrap();
        assert_eq!(
            conn.query_row("SELECT value FROM sentinel", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            42
        );
    }
}

pub fn prune(dir: &Path, now: i64, keep_latest: f64, max_age_days: f64) -> Result<(), String> {
    let mut snapshots = Vec::new();
    let entries = crate::database_fs::readdir(dir);
    for entry in entries {
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some((stamp, reason)) = name
            .strip_prefix("db_")
            .and_then(|s| s.strip_suffix(".sqlite"))
            .and_then(|s| s.split_once('_'))
        else {
            continue;
        };
        if stamp.len() != 24
            || reason.is_empty()
            || !reason.bytes().all(|b| b.is_ascii_alphabetic())
        {
            continue;
        }
        if !stamp.bytes().enumerate().all(|(i, b)| match i {
            4 | 7 | 13 | 16 | 19 => b == b'-',
            10 => b == b'T',
            23 => b == b'Z',
            _ => b.is_ascii_digit(),
        }) {
            continue;
        }
        let iso = format!(
            "{}:{}:{}.{}",
            &stamp[..13],
            &stamp[14..16],
            &stamp[17..19],
            &stamp[20..]
        );
        let Some(at) = crate::date::parse(&iso) else {
            continue;
        };
        snapshots.push((at, reason.to_owned(), entry.path()));
    }
    // Stable sort: frozen TS retains directory enumeration order on ties.
    snapshots.sort_by_key(|s| std::cmp::Reverse(s.0));
    let undo = snapshots.iter().position(|s| s.1 == "preRestore");
    for (i, (at, _, path)) in snapshots.iter().enumerate() {
        if i == 0
            || Some(i) == undo
            || ((i as f64) < keep_latest
                && (*at as f64) >= now as f64 - max_age_days * 86_400_000.0)
        {
            continue;
        }
        unlink(path)?;
    }
    Ok(())
}

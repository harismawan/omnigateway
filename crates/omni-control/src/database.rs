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
            Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    for (_, rel) in &rows {
        if let Some(rel) = rel {
            delete_artifact(dir, rel);
        }
    }
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    for (id, _) in &rows {
        tx.execute("DELETE FROM request_bodies WHERE request_id = ?", [id])
            .map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    let mut files = Vec::new();
    list_artifacts(dir, dir, &mut files);
    let mut orphans = 0;
    for rel in files {
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

fn delete_artifact(dir: &std::path::Path, rel: &str) {
    let full = dir.join(rel);
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
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
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

/// Resolve and judge a candidate without swapping any files.
pub fn validate_restore(live: &Path, id: &str) -> Result<Value, String> {
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
    if metadata(&path)?.is_none() {
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
            .query_map([], |r| r.get::<_, String>(0))?
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
    let at = now();
    let stamp = chrono::DateTime::from_timestamp_millis(at)
        .ok_or("invalid snapshot time")?
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
        .replace([':', '.'], "-");
    let name = format!("db_{stamp}_manual.sqlite");
    let dir = path
        .parent()
        .ok_or("database has no parent")?
        .join("snapshots");
    std::fs::create_dir_all(&dir).map_err(|e| fs_error(&e, "mkdir", &dir))?;
    let target = dir.join(&name);
    if metadata(&target)?.is_some() {
        return Err("CONFLICT: a snapshot for this instant already exists".into());
    }
    let needed = (metadata(path)?.map_or(0, |s| s.len()) as f64 * 1.1).ceil();
    if free_bytes(&dir).is_some_and(|free| (free as f64) < needed) {
        return Err("not enough free disk space to write a snapshot".into());
    }
    if let Err(error) = conn.execute_batch(&format!(
        "VACUUM INTO '{}'",
        target.to_string_lossy().replace('\'', "''")
    )) {
        unlink(&target)?;
        return Err(error.to_string());
    }
    let result = json!({"id":name,"filename":name,"createdAt":at,"sizeBytes":metadata(&target)?.map_or(0, |s| s.len()),"reason":"manual"});
    let (keep_latest, max_age_days) = retention()?;
    prune(&dir, at, keep_latest, max_age_days)?;
    Ok(result)
}

fn size(path: &Path) -> u64 {
    path.metadata().map(|s| s.len()).unwrap_or(0)
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

fn metadata(path: &Path) -> Result<Option<std::fs::Metadata>, String> {
    match path.metadata() {
        Ok(value) => Ok(Some(value)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(fs_error(&e, "stat", path)),
    }
}

fn unlink(path: &Path) -> Result<(), String> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(fs_error(&e, "unlink", path)),
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::items_after_test_module)]
mod tests {
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
                    "not enough free disk space to write a snapshot"
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
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(fs_error(&e, "scandir", dir)),
    };
    for entry in entries {
        let entry = entry.map_err(|e| fs_error(&e, "scandir", dir))?;
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

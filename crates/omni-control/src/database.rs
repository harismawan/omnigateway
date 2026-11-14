//! File-backed database maintenance shared by operator front ends.
pub fn vacuum(
    conn: &rusqlite::Connection,
    path: &std::path::Path,
    now: &dyn Fn() -> i64,
) -> Result<serde_json::Value, String> {
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

pub fn create_snapshot(
    conn: &rusqlite::Connection,
    path: &Path,
    now: &dyn Fn() -> i64,
    retention: &dyn Fn() -> Result<(f64, f64), String>,
) -> Result<Value, String> {
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
        return Err("a snapshot for this instant already exists".into());
    }
    let needed = (metadata(path)?.map_or(0, |s| s.len()) as f64 * 1.1).ceil();
    if rustix::fs::statfs(&dir).is_ok_and(|s| ((s.f_bavail * s.f_bsize as u64) as f64) < needed) {
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
    #[test]
    fn retention_is_read_after_snapshot_is_written() {
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
        assert_eq!(
            create_snapshot(&conn, &path, &clock, &retention).unwrap_err(),
            "a snapshot for this instant already exists"
        );
        assert_eq!(std::fs::read(snapshot).unwrap(), before);
        conn.execute_batch("BEGIN").unwrap();
        assert!(create_snapshot(&conn, &path, &|| clock() + 1, &retention).is_err());
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

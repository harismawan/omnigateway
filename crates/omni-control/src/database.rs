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
use serde_json::{Value, json};
use std::path::Path;

pub fn create_snapshot(
    conn: &rusqlite::Connection,
    path: &Path,
    now: &dyn Fn() -> i64,
    keep_latest: f64,
    max_age_days: f64,
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
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let target = dir.join(&name);
    if target.metadata().is_ok() {
        return Err("a snapshot for this instant already exists".into());
    }
    let needed = (size(path) as f64 * 1.1).ceil();
    if rustix::fs::statfs(&dir).is_ok_and(|s| ((s.f_bavail * s.f_bsize as u64) as f64) < needed) {
        return Err("not enough free disk space to write a snapshot".into());
    }
    if let Err(error) = conn.execute_batch(&format!(
        "VACUUM INTO '{}'",
        target.to_string_lossy().replace('\'', "''")
    )) {
        let _ = std::fs::remove_file(&target);
        return Err(error.to_string());
    }
    let result = json!({"id":name,"filename":name,"createdAt":at,"sizeBytes":size(&target),"reason":"manual"});
    prune(&dir, at, keep_latest, max_age_days)?;
    Ok(result)
}

fn size(path: &Path) -> u64 {
    path.metadata().map(|s| s.len()).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn same_instant_refused_and_failed_snapshot_cleaned() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("db");
        let conn = rusqlite::Connection::open(&path).unwrap();
        conn.execute_batch("CREATE TABLE sentinel(value); INSERT INTO sentinel VALUES (42)")
            .unwrap();
        let clock = || 1_700_000_000_000;
        let first = create_snapshot(&conn, &path, &clock, 3.0, 30.0).unwrap();
        let snapshot = root
            .path()
            .join("snapshots")
            .join(first["id"].as_str().unwrap());
        let before = std::fs::read(&snapshot).unwrap();
        assert_eq!(
            create_snapshot(&conn, &path, &clock, 3.0, 30.0).unwrap_err(),
            "a snapshot for this instant already exists"
        );
        assert_eq!(std::fs::read(snapshot).unwrap(), before);
        conn.execute_batch("BEGIN").unwrap();
        assert!(create_snapshot(&conn, &path, &|| clock() + 1, 3.0, 30.0).is_err());
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
    for entry in std::fs::read_dir(dir).into_iter().flatten().flatten() {
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
        let Ok(date) = chrono::DateTime::parse_from_rfc3339(&iso) else {
            continue;
        };
        snapshots.push((date.timestamp_millis(), reason.to_owned(), entry.path()));
    }
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
        std::fs::remove_file(path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

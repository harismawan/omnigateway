//! The production [`Host`]: real `systemctl`, `/proc`, HTTP and SQLite.
use super::{Host, Lock, Scope};
use std::{
    fs,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::Duration,
};

pub(crate) struct System;

impl Host for System {
    fn systemctl(&self, scope: Scope, args: &[&str]) -> Result<String, String> {
        let mut cmd = Command::new("systemctl");
        if scope == Scope::User {
            cmd.arg("--user");
        }
        let out = cmd
            .args(args)
            .stdin(Stdio::null())
            .output()
            .map_err(|e| format!("systemctl: {e}"))?;
        if out.status.success() {
            Ok(String::from_utf8_lossy(&out.stdout).into_owned())
        } else {
            let err = String::from_utf8_lossy(&out.stderr).trim().to_owned();
            Err(if err.is_empty() {
                format!(
                    "systemctl {} exited {}",
                    args.join(" "),
                    out.status.code().unwrap_or(1)
                )
            } else {
                err
            })
        }
    }

    fn holders(&self, db: &Path) -> Vec<u32> {
        let Ok(db) = fs::canonicalize(db) else {
            return vec![];
        };
        let names: Vec<PathBuf> = ["", "-wal", "-shm", "-journal"]
            .iter()
            .map(|s| PathBuf::from(format!("{}{s}", db.display())))
            .collect();
        let Ok(procs) = fs::read_dir("/proc") else {
            return vec![];
        };
        let mut found = vec![];
        for entry in procs.flatten() {
            let Some(pid) = entry
                .file_name()
                .to_str()
                .and_then(|n| n.parse::<u32>().ok())
            else {
                continue;
            };
            let Ok(fds) = fs::read_dir(entry.path().join("fd")) else {
                continue;
            };
            if fds
                .flatten()
                .filter_map(|fd| fs::read_link(fd.path()).ok())
                .any(|target| names.contains(&target))
            {
                found.push(pid);
            }
        }
        found
    }

    fn process_exe(&self, pid: u32) -> Option<PathBuf> {
        fs::read_link(format!("/proc/{pid}/exe")).ok()
    }

    fn healthy(&self, base: &str) -> bool {
        crate::service::healthy_within(base, Duration::from_secs(30))
    }

    fn lock_exclusive(&self, db: &Path) -> Result<Lock, String> {
        // `timeout=0`: a held lock is a refusal, not a wait.
        let conn = rusqlite::Connection::open_with_flags(
            db,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .map_err(|e| e.to_string())?;
        conn.busy_timeout(Duration::ZERO)
            .map_err(|e| e.to_string())?;
        conn.execute_batch("PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE; COMMIT;")
            .map_err(|e| e.to_string())?;
        Ok(Lock::Real(conn))
    }

    fn release(&self, lock: Lock) {
        // Closing the connection is what drops an EXCLUSIVE-mode lock.
        if let Some(conn) = lock.into_connection() {
            let _closed = conn.close();
        }
    }

    fn sleep(&self, duration: Duration) {
        std::thread::sleep(duration);
    }

    fn preflight_db(&self, db: &Path, snapshots: &Path) -> Result<(), String> {
        let size = fs::metadata(db)
            .map_err(|e| format!("cannot read {}: {e}", db.display()))?
            .len();
        // The destination must exist as a writable directory with room.
        fs::create_dir_all(snapshots)
            .map_err(|e| format!("cannot create {}: {e}", snapshots.display()))?;
        let probe = snapshots.join(format!(".omni-migrate-probe-{}", std::process::id()));
        fs::write(&probe, b"")
            .and_then(|()| fs::remove_file(&probe))
            .map_err(|e| format!("cannot write to {}: {e}", snapshots.display()))?;
        let free = rustix::fs::statfs(snapshots)
            .map(|s| s.f_bavail * s.f_bsize as u64)
            .map_err(|e| format!("cannot check free space in {}: {e}", snapshots.display()))?;
        if (free as f64) < (size as f64 * 1.1).ceil() {
            return Err(format!(
                "not enough free disk space in {} for a backup of {} ({size} bytes)",
                snapshots.display(),
                db.display()
            ));
        }
        let conn = rusqlite::Connection::open_with_flags(
            db,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .map_err(|e| format!("cannot open {}: {e}", db.display()))?;
        conn.busy_timeout(Duration::from_secs(5))
            .map_err(|e| e.to_string())?;
        let newest: Option<i64> = conn
            .query_row("SELECT MAX(id) FROM migrations", [], |r| r.get(0))
            .map_err(|e| format!("cannot read the migration ledger of {}: {e}", db.display()))?;
        if newest.is_some_and(|id| id > omni_store::migrate::LATEST_MIGRATION) {
            return Err(format!(
                "{} was migrated by a newer gateway (migration {}); this release knows up to {}",
                db.display(),
                newest.unwrap_or_default(),
                omni_store::migrate::LATEST_MIGRATION
            ));
        }
        Ok(())
    }

    fn binary_runs(&self, binary: &Path) -> bool {
        Command::new(binary)
            .args(["omni", "--version"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|s| s.success())
    }

    fn backup(&self, lock: &Lock, db: &Path) -> Result<String, String> {
        let conn = lock.connection().ok_or("no lock")?;
        let made = omni_control::database::create_pre_rust_snapshot(conn, db, &|| {
            chrono::Utc::now().timestamp_millis()
        })?;
        made["id"]
            .as_str()
            .map(str::to_owned)
            .ok_or_else(|| "snapshot has no id".into())
    }

    fn euid_root(&self) -> bool {
        rustix::process::geteuid().is_root()
    }

    fn binary_trusted(&self, binary: &Path) -> bool {
        use std::os::unix::fs::MetadataExt;
        let mut at = Some(binary);
        while let Some(path) = at {
            let Ok(meta) = fs::metadata(path) else {
                return false;
            };
            if meta.uid() != 0 || meta.mode() & 0o022 != 0 {
                return false;
            }
            at = path.parent().filter(|p| !p.as_os_str().is_empty());
        }
        true
    }

    fn foreground_gateway(&self, state: &Path) -> Option<u32> {
        let pid: u32 = fs::read_to_string(state.join("gateway.pid"))
            .ok()?
            .trim()
            .parse()
            .ok()?;
        crate::process::alive(f64::from(pid)).then_some(pid)
    }

    fn bridge_invoked_by(&self, main_pid: u32) -> bool {
        // Walk this process's ancestors: systemd's MainPID is the launcher
        // (bun gateway.js) that spawned us.
        let mut pid = std::process::id();
        for _ in 0..8 {
            if pid == main_pid {
                return true;
            }
            let Some(parent) = fs::read_to_string(format!("/proc/{pid}/stat"))
                .ok()
                .and_then(|s| {
                    s.rsplit_once(')')
                        .and_then(|(_, rest)| rest.split_whitespace().nth(1)?.parse().ok())
                })
            else {
                return false;
            };
            if parent <= 1 {
                return false;
            }
            pid = parent;
        }
        false
    }

    fn occupied(&self, addr: std::net::SocketAddr) -> bool {
        std::net::TcpStream::connect_timeout(&addr, Duration::from_millis(500)).is_ok()
    }

    fn listener_pid(&self, addr: std::net::SocketAddr) -> Option<u32> {
        let inodes = serving_inodes(addr);
        if inodes.is_empty() {
            return None;
        }
        // Every serving socket must be accounted for by one process: an
        // inode with no visible owner might be someone we cannot see.
        let mut owners = std::collections::BTreeSet::new();
        let mut owned = std::collections::BTreeSet::new();
        for entry in fs::read_dir("/proc").ok()?.flatten() {
            let Some(pid) = entry
                .file_name()
                .to_str()
                .and_then(|n| n.parse::<u32>().ok())
            else {
                continue;
            };
            let Ok(fds) = fs::read_dir(entry.path().join("fd")) else {
                continue;
            };
            for target in fds.flatten().filter_map(|fd| fs::read_link(fd.path()).ok()) {
                if let Some(inode) = target
                    .to_str()
                    .and_then(|t| t.strip_prefix("socket:[")?.strip_suffix(']'))
                    .filter(|i| inodes.iter().any(|n| n == i))
                {
                    owners.insert(pid);
                    owned.insert(inode.to_owned());
                }
            }
        }
        if owned.len() != inodes.len() || owners.len() != 1 {
            return None;
        }
        owners.into_iter().next()
    }
}

/// Inodes of listening sockets that serve `addr`: bound to exactly its IP
/// or to its own family's wildcard, on its port (`/proc/net/tcp*`, state
/// `0A`). An IPv4 probe is also served by an IPv6 wildcard socket on a
/// dual-stack host; `/proc` does not say whether that socket is v6only, so it
/// counts it — the caller then requires the owner to be the gateway, which
/// fails closed if it is someone else.
fn serving_inodes(addr: std::net::SocketAddr) -> Vec<String> {
    let port = format!("{:04X}", addr.port());
    let hex6 = |octets: [u8; 16]| -> String {
        octets
            .chunks(4)
            .map(|c| format!("{:08X}", u32::from_le_bytes([c[0], c[1], c[2], c[3]])))
            .collect()
    };
    let wild6 = "0".repeat(32);
    let wanted: Vec<(&str, String)> = match addr.ip() {
        std::net::IpAddr::V4(ip) => vec![
            (
                "/proc/net/tcp",
                format!("{:08X}", u32::from_le_bytes(ip.octets())),
            ),
            ("/proc/net/tcp", "00000000".to_owned()),
            ("/proc/net/tcp6", wild6.clone()),
            ("/proc/net/tcp6", hex6(ip.to_ipv6_mapped().octets())),
        ],
        std::net::IpAddr::V6(ip) => vec![
            ("/proc/net/tcp6", hex6(ip.octets())),
            ("/proc/net/tcp6", wild6.clone()),
        ],
    };
    let mut out = vec![];
    for file in ["/proc/net/tcp", "/proc/net/tcp6"] {
        let Ok(text) = fs::read_to_string(file) else {
            continue;
        };
        for line in text.lines().skip(1) {
            let cols: Vec<&str> = line.split_whitespace().collect();
            let (Some(local), Some(state), Some(inode)) = (cols.get(1), cols.get(3), cols.get(9))
            else {
                continue;
            };
            let Some((ip, p)) = local.split_once(':') else {
                continue;
            };
            if *state == "0A" && p == port && wanted.iter().any(|(f, w)| *f == file && w == ip) {
                out.push((*inode).to_owned());
            }
        }
    }
    out.sort();
    out.dedup();
    out
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    fn database(dir: &Path) -> PathBuf {
        let db = dir.join("omnigateway.db");
        let conn = rusqlite::Connection::open(&db).unwrap();
        conn.execute_batch(
            "PRAGMA journal_mode=WAL; CREATE TABLE migrations(id INTEGER, applied_at INTEGER); INSERT INTO migrations VALUES (1, 0); CREATE TABLE t(x); INSERT INTO t VALUES (7);",
        )
        .unwrap();
        db
    }

    #[test]
    fn exclusive_lock_is_refused_while_another_connection_is_open() {
        let dir = tempfile::tempdir().unwrap();
        let db = database(dir.path());
        let other = rusqlite::Connection::open(&db).unwrap();
        let _: i64 = other
            .query_row("SELECT x FROM t", [], |r| r.get(0))
            .unwrap();
        assert!(System.lock_exclusive(&db).is_err());
        drop(other);
        let lock = System.lock_exclusive(&db).unwrap();
        // While held, a new opener (the gateway, a stray TS) cannot read it.
        let late = rusqlite::Connection::open(&db).unwrap();
        late.busy_timeout(Duration::ZERO).unwrap();
        assert!(
            late.query_row("SELECT x FROM t", [], |r| r.get::<_, i64>(0))
                .is_err()
        );
        // The backup is taken through the lock and holds the data.
        let id = System.backup(&lock, &db).unwrap();
        assert!(id.ends_with("_preRust.sqlite"));
        let copy = rusqlite::Connection::open(dir.path().join("snapshots").join(&id)).unwrap();
        assert_eq!(
            copy.query_row("SELECT x FROM t", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            7
        );
        System.release(lock);
        assert_eq!(
            late.query_row("SELECT x FROM t", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            7
        );
    }

    #[test]
    fn preflight_refuses_an_unwritable_snapshot_destination_and_a_bad_ledger() {
        let dir = tempfile::tempdir().unwrap();
        let db = database(dir.path());
        System
            .preflight_db(&db, &dir.path().join("snapshots"))
            .unwrap();
        let file = dir.path().join("not-a-dir");
        fs::write(&file, b"").unwrap();
        assert!(System.preflight_db(&db, &file).is_err());
        let bare = dir.path().join("bare.db");
        rusqlite::Connection::open(&bare)
            .unwrap()
            .execute_batch("CREATE TABLE t(x)")
            .unwrap();
        let err = System
            .preflight_db(&bare, &dir.path().join("snapshots"))
            .unwrap_err();
        assert!(err.contains("migration ledger"), "{err}");
    }

    #[test]
    fn the_listener_is_attributed_to_the_process_that_holds_it() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        assert_eq!(System.listener_pid(addr), Some(std::process::id()));
        assert!(System.occupied(addr));
        // Another address on the same port is a different listener.
        let other: std::net::SocketAddr = format!("127.0.0.2:{}", addr.port()).parse().unwrap();
        assert_eq!(System.listener_pid(other), None);
        drop(listener);
        assert_eq!(System.listener_pid(addr), None);
        assert!(!System.occupied(addr));
    }

    #[test]
    fn this_process_descends_from_its_parent_not_from_pid_one() {
        assert!(System.bridge_invoked_by(std::process::id()));
        assert!(System.bridge_invoked_by(
            rustix::process::getppid().map_or(0, |p| p.as_raw_nonzero().get() as u32)
        ));
        assert!(!System.bridge_invoked_by(1));
    }
}

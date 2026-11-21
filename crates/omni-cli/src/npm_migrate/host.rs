//! The production [`Host`]: real `systemctl`, `/proc`, HTTP and SQLite.
use super::{Child, Host, Scope};
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

    fn preflight_db(&self, db: &Path) -> Result<(), String> {
        let size = fs::metadata(db)
            .map_err(|e| format!("cannot read {}: {e}", db.display()))?
            .len();
        let dir = db.parent().ok_or("database has no parent directory")?;
        let free = rustix::fs::statfs(dir)
            .map(|s| s.f_bavail * s.f_bsize as u64)
            .map_err(|e| format!("cannot check free space in {}: {e}", dir.display()))?;
        if (free as f64) < (size as f64 * 1.1).ceil() {
            return Err(format!(
                "not enough free disk space in {} for a backup of {} ({size} bytes)",
                dir.display(),
                db.display()
            ));
        }
        let conn = rusqlite::Connection::open_with_flags(
            db,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .map_err(|e| format!("cannot open {}: {e}", db.display()))?;
        let newest: Option<i64> = conn
            .query_row("SELECT MAX(id) FROM migrations", [], |r| r.get(0))
            .unwrap_or(None);
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

    fn backup(&self, db: &Path) -> Result<String, String> {
        let conn = rusqlite::Connection::open(db).map_err(|e| e.to_string())?;
        let made = omni_control::database::create_pre_rust_snapshot(&conn, db, &|| {
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

    fn run_gateway(&self, binary: &Path, root: &Path) -> Result<Child, String> {
        Command::new(binary)
            .current_dir(root)
            .stdin(Stdio::null())
            .spawn()
            .map(Child::Real)
            .map_err(|e| e.to_string())
    }
}

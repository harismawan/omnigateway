//! The production [`Host`]: real `systemctl`, `/proc`, HTTP and SQLite.
use super::{Child, Host, Lock, Scope};
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

    fn run_gateway(
        &self,
        binary: &Path,
        root: &Path,
        addr: std::net::SocketAddr,
    ) -> Result<Child, String> {
        // Armed before the child exists, so a TERM during its startup or
        // health wait is never lost.
        let target = relay_signals(addr)?;
        let child = Command::new(binary)
            .current_dir(root)
            .stdin(Stdio::null())
            .spawn()
            .map_err(|e| e.to_string())?;
        target.store(child.id(), std::sync::atomic::Ordering::SeqCst);
        Ok(Child::Real(child))
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

    fn native_child(&self, parent: u32, binary: &Path) -> Option<(u32, PathBuf)> {
        // Any thread of `parent` may have spawned it.
        let mut children = String::new();
        for task in fs::read_dir(format!("/proc/{parent}/task")).ok()?.flatten() {
            if let Ok(list) = fs::read_to_string(task.path().join("children")) {
                children.push_str(&list);
                children.push(' ');
            }
        }
        children
            .split_whitespace()
            .filter_map(|c| c.parse::<u32>().ok())
            .find_map(|pid| {
                let exe = fs::read_link(format!("/proc/{pid}/exe")).ok()?;
                let shown = exe.display().to_string();
                (exe == binary
                    || shown.trim_end_matches(" (deleted)") == binary.display().to_string())
                .then_some((pid, exe))
            })
    }
}

/// Inodes of listening sockets that serve `addr`: bound to exactly its IP,
/// or to the wildcard of its family, on its port (`/proc/net/tcp*`, `0A`).
fn serving_inodes(addr: std::net::SocketAddr) -> Vec<String> {
    let port = format!("{:04X}", addr.port());
    let (file, exact, wildcard) = match addr.ip() {
        std::net::IpAddr::V4(ip) => (
            "/proc/net/tcp",
            format!("{:08X}", u32::from_le_bytes(ip.octets())),
            "00000000".to_owned(),
        ),
        std::net::IpAddr::V6(ip) => {
            let mut hex = String::new();
            for chunk in ip.octets().chunks(4) {
                let word = u32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]);
                hex.push_str(&format!("{word:08X}"));
            }
            ("/proc/net/tcp6", hex, "0".repeat(32))
        }
    };
    let mut out = vec![];
    for (file, exact) in [(file, exact.as_str()), ("/proc/net/tcp6", "")] {
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
            if *state != "0A" || p != port {
                continue;
            }
            // An IPv6 wildcard socket also serves IPv4 unless v6only.
            let serves =
                ip == exact || ip == wildcard || (file == "/proc/net/tcp6" && ip == "0".repeat(32));
            if serves {
                out.push((*inode).to_owned());
            }
        }
        if file == "/proc/net/tcp6" {
            break;
        }
    }
    out.sort();
    out.dedup();
    out
}

/// This process's cgroup (`/proc/<pid>/cgroup`, unified hierarchy line).
fn cgroup_of(pid: u32) -> Option<String> {
    fs::read_to_string(format!("/proc/{pid}/cgroup"))
        .ok()?
        .lines()
        .find_map(|l| l.strip_prefix("0::").map(str::to_owned))
}

/// Relay unless both share a known control group (systemd already signals
/// every process in it, and a second TERM aborts the gateway's drain).
fn should_relay(child: Option<String>, ours: Option<String>) -> bool {
    match (child, ours) {
        (Some(child), Some(ours)) => child != ours,
        _ => true,
    }
}

/// Forward TERM/INT/HUP to the gateway, whose pid the caller stores into the
/// returned slot once spawned. Handlers are installed before this returns
/// (`Err` when they cannot be, so the caller does not spawn); a signal that
/// arrives before the pid is known is held and delivered once it is.
///
/// Under systemd's default `KillMode=control-group` a stop signals every
/// process in the unit, the gateway included, and a second TERM is the
/// gateway's "abort the drain" escalation. A signal aimed at this process
/// alone (`systemctl kill --kill-whom=main`) reaches only us. The gateway
/// closes its listener the moment it takes TERM, so: for a gateway in our
/// own cgroup, wait briefly and relay only if it is still listening.
fn relay_signals(
    listen: std::net::SocketAddr,
) -> Result<std::sync::Arc<std::sync::atomic::AtomicU32>, String> {
    use std::sync::atomic::{AtomicU32, Ordering};
    let target = std::sync::Arc::new(AtomicU32::new(0));
    let slot = target.clone();
    let (ready_tx, ready_rx) = std::sync::mpsc::channel::<Result<(), String>>();
    std::thread::spawn(move || {
        let runtime = match tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
        {
            Ok(runtime) => runtime,
            Err(e) => {
                let _sent = ready_tx.send(Err(e.to_string()));
                return;
            }
        };
        runtime.block_on(async move {
            use tokio::signal::unix::{SignalKind, signal};
            let (mut term, mut int, mut hup) = match (
                signal(SignalKind::terminate()),
                signal(SignalKind::interrupt()),
                signal(SignalKind::hangup()),
            ) {
                (Ok(t), Ok(i), Ok(h)) => (t, i, h),
                _ => {
                    let _sent = ready_tx.send(Err("cannot install signal handlers".into()));
                    return;
                }
            };
            let _sent = ready_tx.send(Ok(()));
            loop {
                let sig = tokio::select! {
                    _ = term.recv() => rustix::process::Signal::TERM,
                    _ = int.recv() => rustix::process::Signal::INT,
                    _ = hup.recv() => rustix::process::Signal::HUP,
                };
                // Not spawned yet: hold it until the pid is known.
                let mut pid = slot.load(Ordering::SeqCst);
                while pid == 0 {
                    tokio::time::sleep(Duration::from_millis(20)).await;
                    pid = slot.load(Ordering::SeqCst);
                }
                if !should_relay(cgroup_of(pid), cgroup_of(std::process::id())) {
                    // Same unit: a group stop reached it too. Give it a moment
                    // to close its listener; relay only if it did not.
                    tokio::time::sleep(Duration::from_millis(300)).await;
                    if !listening(listen) {
                        continue;
                    }
                }
                if let Some(pid) = rustix::process::Pid::from_raw(pid as i32) {
                    let _sent = rustix::process::kill_process(pid, sig);
                }
            }
        });
    });
    ready_rx
        .recv()
        .map_err(|_| "signal relay thread died".to_owned())??;
    Ok(target)
}

/// Something accepts at `addr` (the gateway still serving).
fn listening(addr: std::net::SocketAddr) -> bool {
    std::net::TcpStream::connect_timeout(&addr, Duration::from_millis(200)).is_ok()
}

/// Serve as the bridge: wait for the gateway (signals are already relayed by
/// [`relay_signals`]) and exit with its status, so systemd sees the gateway's
/// own outcome.
pub(crate) fn serve(child: Child) -> std::process::ExitCode {
    use std::process::ExitCode;
    let Some(mut child) = child.into_real() else {
        return ExitCode::FAILURE;
    };
    match child.wait() {
        Ok(status) => ExitCode::from(u8::try_from(status.code().unwrap_or(1)).unwrap_or(1)),
        Err(_) => ExitCode::FAILURE,
    }
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
    fn a_native_child_is_found_under_its_parent() {
        let sleep = PathBuf::from("/bin/sleep");
        let real = fs::canonicalize(&sleep).unwrap();
        let mut child = Command::new(&sleep).arg("5").spawn().unwrap();
        let found = (0..50).find_map(|_| {
            std::thread::sleep(Duration::from_millis(20));
            System.native_child(std::process::id(), &real)
        });
        let _killed = child.kill();
        let _reaped = child.wait();
        assert_eq!(found.map(|(pid, _)| pid), Some(child.id()));
        assert_eq!(
            System.native_child(std::process::id(), Path::new("/nope")),
            None
        );
    }

    #[test]
    fn relay_skips_a_child_systemd_already_signals() {
        let unit = Some("/user.slice/user@1000.service/app.slice/omnigateway.service".to_owned());
        assert!(!should_relay(unit.clone(), unit.clone()));
        assert!(should_relay(
            Some("/user.slice/session-4.scope".into()),
            unit
        ));
        assert!(should_relay(None, None));
    }

    /// The relay installs process-wide signal handlers, so it runs alone in
    /// a re-executed copy of this test binary, never beside other tests.
    #[test]
    fn relay_reaches_a_child_only_when_the_signal_missed_it() {
        if std::env::var_os("OMNI_RELAY_HARNESS").is_none() {
            let out = Command::new(std::env::current_exe().unwrap())
                .args([
                    "npm_migrate::host::tests::relay_reaches_a_child_only_when_the_signal_missed_it",
                    "--exact",
                    "--nocapture",
                    "--test-threads=1",
                ])
                .env("OMNI_RELAY_HARNESS", "1")
                .output()
                .unwrap();
            assert!(
                out.status.success(),
                "{}{}",
                String::from_utf8_lossy(&out.stdout),
                String::from_utf8_lossy(&out.stderr)
            );
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let script = dir.path().join("child.py");
        // Listens; logs every TERM and closes its listener on the first (as
        // the gateway does); exits on its own after a few seconds.
        fs::write(
            &script,
            "import signal,socket,sys,time\nport=int(sys.argv[1]);log=sys.argv[2]\ns=socket.socket();s.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1);s.bind(('127.0.0.1',port));s.listen()\ndef h(*a):\n  open(log,'a').write('TERM\\n')\n  s.close()\nsignal.signal(signal.SIGTERM,h)\nopen(log,'a').write('up\\n')\nt=time.time()\nwhile time.time()-t<8: time.sleep(0.05)\n",
        )
        .unwrap();
        let terms = |log: &Path| {
            fs::read_to_string(log)
                .unwrap_or_default()
                .matches("TERM")
                .count()
        };
        let spawn = |log: &Path, port: u16| {
            Command::new("python3")
                .arg(&script)
                .arg(port.to_string())
                .arg(log)
                .spawn()
                .unwrap()
        };
        let free_port = || {
            std::net::TcpListener::bind("127.0.0.1:0")
                .unwrap()
                .local_addr()
                .unwrap()
                .port()
        };
        let wait_up = |log: &Path, addr| {
            for _ in 0..200 {
                if fs::read_to_string(log).is_ok_and(|l| l.contains("up")) && listening(addr) {
                    return;
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            panic!("child did not start");
        };
        let me = rustix::process::getpid();

        // 1. A TERM aimed at the bridge alone: relayed to the child.
        let port = free_port();
        let addr: std::net::SocketAddr = format!("127.0.0.1:{port}").parse().unwrap();
        let log = dir.path().join("one");
        let slot = relay_signals(addr).unwrap();
        let mut child = spawn(&log, port);
        slot.store(child.id(), std::sync::atomic::Ordering::SeqCst);
        wait_up(&log, addr);
        rustix::process::kill_process(me, rustix::process::Signal::TERM).unwrap();
        std::thread::sleep(Duration::from_millis(800));
        assert_eq!(terms(&log), 1, "a bridge-only TERM must reach the child");
        let _killed = child.kill();
        let _reaped = child.wait();
        slot.store(0, std::sync::atomic::Ordering::SeqCst);

        // 2. A group stop: the child takes TERM itself (closing its listener),
        // the bridge gets one too; the relay must not send a second.
        let port = free_port();
        let addr: std::net::SocketAddr = format!("127.0.0.1:{port}").parse().unwrap();
        let log = dir.path().join("two");
        let slot = relay_signals(addr).unwrap();
        let mut child = spawn(&log, port);
        slot.store(child.id(), std::sync::atomic::Ordering::SeqCst);
        wait_up(&log, addr);
        let pid = rustix::process::Pid::from_raw(child.id() as i32).unwrap();
        rustix::process::kill_process(pid, rustix::process::Signal::TERM).unwrap();
        rustix::process::kill_process(me, rustix::process::Signal::TERM).unwrap();
        std::thread::sleep(Duration::from_millis(800));
        assert_eq!(terms(&log), 1, "a group stop must not be doubled");
        let _killed = child.kill();
        let _reaped = child.wait();
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

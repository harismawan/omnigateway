#![allow(clippy::unwrap_used, clippy::expect_used)]
use super::*;
use std::cell::{Cell, RefCell};
use std::time::Duration;

const BUN: &str = "/home/u/.bun/bin/bun";
const GATEWAY_JS: &str = "/home/u/.npm-global/lib/node_modules/omnigateway/gateway.js";

fn legacy_unit(root: &Path, extra: &str) -> String {
    format!(
        "[Unit]\nDescription=OmniGateway\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\nWorkingDirectory={r}\nEnvironmentFile={r}/.env\nExecStart={BUN} {GATEWAY_JS}\n{extra}Restart=on-failure\nRestartSec=2\n\n[Install]\nWantedBy=default.target\n",
        r = root.display()
    )
}

/// What `systemctl show` reports, and every side effect, recorded in order.
struct Fake {
    log: RefCell<Vec<String>>,
    unit_file: PathBuf,
    root: PathBuf,
    active: RefCell<bool>,
    main_pid: RefCell<Option<u32>>,
    exec: RefCell<String>,
    environment: String,
    environment_files: Option<String>,
    drop_ins: bool,
    need_reload: bool,
    fragment: Option<PathBuf>,
    /// Another process holds the database: the exclusive lock is refused.
    foreign_open: Cell<bool>,
    /// The TS gateway (MainPID 777) has the database open.
    ts_holds_db: Cell<bool>,
    binary: PathBuf,
    exe_unreadable: bool,
    /// A visible process other than the service has the database open.
    extra_holder: Option<u32>,
    healthy: bool,
    /// The process answering after start is not our binary.
    impostor: bool,
    running_exe: RefCell<Option<PathBuf>>,
    euid_root: bool,
    trusted_binary: bool,
    fail_backup: bool,
    fail_start: bool,
    low_disk: bool,
    binary_runs: bool,
    pidfile_gateway: bool,
    stop_sticks: bool,
    bridge_parent_is_main: bool,
    /// `systemctl show-environment`: the manager's own environment.
    manager_env: Vec<String>,
    /// Something already answers `/health` while our gateway is not running.
    port_taken: bool,
    state_override: Option<&'static str>,
    omit_need_reload: bool,
    working_directory: Option<PathBuf>,
    cleanup_stop_fails: bool,
    stops: Cell<u32>,
    /// A process other than the started gateway holds the DB after start.
    late_holder: bool,
    /// The listener on the port after start is someone else.
    foreign_listener: bool,
    /// The started gateway holds the database that was backed up.
    rust_holds_db: bool,
}

impl Fake {
    fn new(f: &Fixture) -> Self {
        Self {
            log: RefCell::default(),
            unit_file: f.user_unit.clone(),
            root: f.root.clone(),
            active: RefCell::new(true),
            main_pid: RefCell::new(Some(777)),
            exec: RefCell::new(format!("{BUN} {GATEWAY_JS}")),
            environment: String::new(),
            environment_files: None,
            drop_ins: false,
            need_reload: false,
            fragment: None,
            foreign_open: Cell::new(false),
            ts_holds_db: Cell::new(true),
            binary: f.binary.clone(),
            exe_unreadable: false,
            extra_holder: None,
            healthy: true,
            impostor: false,
            running_exe: RefCell::new(None),
            euid_root: false,
            trusted_binary: true,
            fail_backup: false,
            fail_start: false,
            low_disk: false,
            binary_runs: true,
            pidfile_gateway: false,
            stop_sticks: true,
            bridge_parent_is_main: true,
            manager_env: vec!["HOME=/home/u".into(), "PATH=/usr/bin".into()],
            port_taken: false,
            state_override: None,
            omit_need_reload: false,
            working_directory: None,
            cleanup_stop_fails: false,
            stops: Cell::new(0),
            late_holder: false,
            foreign_listener: false,
            rust_holds_db: true,
        }
    }
    fn log(&self) -> Vec<String> {
        self.log.borrow().clone()
    }
    fn did(&self, prefix: &str) -> bool {
        self.log.borrow().iter().any(|l| l.starts_with(prefix))
    }
    fn at(&self, prefix: &str) -> usize {
        let log = self.log.borrow();
        log.iter()
            .position(|l| l.starts_with(prefix))
            .unwrap_or_else(|| panic!("{prefix} missing from {log:?}"))
    }
}

impl Host for Fake {
    fn systemctl(&self, scope: Scope, args: &[&str]) -> Result<String, String> {
        self.log
            .borrow_mut()
            .push(format!("systemctl {} {}", scope.name(), args.join(" ")));
        match args.first().copied() {
            Some("stop") => {
                self.stops.set(self.stops.get() + 1);
                if self.cleanup_stop_fails && self.stops.get() > 1 {
                    return Err("Job failed".into());
                }
                if self.stop_sticks {
                    *self.active.borrow_mut() = false;
                    *self.main_pid.borrow_mut() = None;
                    self.ts_holds_db.set(false);
                }
            }
            Some("start" | "restart") => {
                if self.fail_start {
                    return Err("Job failed".into());
                }
                *self.active.borrow_mut() = true;
                *self.main_pid.borrow_mut() = Some(4242);
                *self.running_exe.borrow_mut() = None;
            }
            Some("show-environment") => return Ok(self.manager_env.join("\n") + "\n"),
            Some("show") => {
                let files = self
                    .environment_files
                    .clone()
                    .unwrap_or_else(|| format!("{}/.env (ignore_errors=no)", self.root.display()));
                let argv = self.exec.borrow().clone();
                let path = argv.split(' ').next().unwrap_or_default().to_owned();
                let reload = if self.omit_need_reload {
                    String::new()
                } else {
                    format!(
                        "NeedDaemonReload={}\n",
                        if self.need_reload { "yes" } else { "no" }
                    )
                };
                return Ok(format!(
                    "ActiveState={}\nUnitFileState=enabled\nMainPID={}\nDropInPaths={}\nFragmentPath={}\n{reload}Environment={}\nEnvironmentFiles={files}\nWorkingDirectory={}\nExecStart={{ path={path} ; argv[]={argv} ; ignore_errors=no ; start_time=[n/a] ; stop_time=[n/a] ; pid=0 ; code=(null) ; status=0/0 }}\n",
                    self.state_override.unwrap_or(if *self.active.borrow() {
                        "active"
                    } else {
                        "inactive"
                    }),
                    self.main_pid.borrow().unwrap_or(0),
                    if self.drop_ins {
                        "/etc/systemd/system/omnigateway.service.d/x.conf"
                    } else {
                        ""
                    },
                    self.fragment.as_ref().unwrap_or(&self.unit_file).display(),
                    self.environment,
                    self.working_directory
                        .as_ref()
                        .unwrap_or(&self.root)
                        .display(),
                ));
            }
            Some("daemon-reload") => {
                if let Ok(text) = fs::read_to_string(&self.unit_file)
                    && let Some(line) = text.lines().find(|l| l.starts_with("ExecStart="))
                {
                    *self.exec.borrow_mut() = line["ExecStart=".len()..].to_owned();
                }
            }
            _ => {}
        }
        Ok(String::new())
    }
    fn holders(&self, _db: &Path) -> Vec<u32> {
        let mut found: Vec<u32> = if self.ts_holds_db.get() {
            vec![777]
        } else {
            vec![]
        };
        found.extend(self.extra_holder);
        if *self.main_pid.borrow() == Some(4242) && self.rust_holds_db {
            found.push(4242);
        }
        if self.late_holder && self.log.borrow().iter().any(|l| l == "unlock") {
            found.push(31337);
        }
        found
    }
    fn lock_exclusive(&self, db: &Path) -> Result<Lock, String> {
        self.log.borrow_mut().push(format!("lock {}", db.display()));
        if self.foreign_open.get() || self.ts_holds_db.get() {
            return Err("database is locked".into());
        }
        Ok(Lock::Fake)
    }
    fn release(&self, lock: Lock) {
        let _ = lock;
        self.log.borrow_mut().push("unlock".into());
    }
    fn process_exe(&self, pid: u32) -> Option<PathBuf> {
        if self.exe_unreadable {
            return None;
        }
        if let Some(exe) = self.running_exe.borrow().clone() {
            return Some(exe);
        }
        match pid {
            4242 if self.impostor => Some(PathBuf::from("/usr/bin/other-server")),
            4242 => Some(self.binary.clone()),
            _ => Some(PathBuf::from(BUN)),
        }
    }
    fn sleep(&self, _: Duration) {}
    fn healthy(&self, base: &str) -> bool {
        self.log.borrow_mut().push(format!("health {base}"));
        self.healthy
    }
    fn occupied(&self, addr: std::net::SocketAddr) -> bool {
        self.log.borrow_mut().push(format!("probe {addr}"));
        self.port_taken
    }
    fn listener_pid(&self, _addr: std::net::SocketAddr) -> Option<u32> {
        if self.foreign_listener {
            return Some(31338);
        }
        // The gateway systemd started (MainPID 4242), when it runs.
        (*self.main_pid.borrow() == Some(4242)).then_some(4242)
    }
    fn preflight_db(&self, _db: &Path, _snapshots: &Path) -> Result<(), String> {
        if self.low_disk {
            Err("not enough free disk space for the backup".into())
        } else {
            Ok(())
        }
    }
    fn binary_runs(&self, _binary: &Path) -> bool {
        self.binary_runs
    }
    fn backup(&self, _lock: &Lock, db: &Path) -> Result<String, String> {
        self.log
            .borrow_mut()
            .push(format!("backup {}", db.display()));
        if self.fail_backup {
            Err("disk full".into())
        } else {
            Ok("db_2026-11-21T00-00-00-000Z_preRust.sqlite".into())
        }
    }
    fn euid_root(&self) -> bool {
        self.euid_root
    }
    fn binary_trusted(&self, _binary: &Path) -> bool {
        self.trusted_binary
    }
    fn foreground_gateway(&self, _state: &Path) -> Option<u32> {
        self.pidfile_gateway.then_some(555)
    }
    fn bridge_invoked_by(&self, main_pid: u32) -> bool {
        self.bridge_parent_is_main && main_pid == 777
    }
}

struct Fixture {
    dir: tempfile::TempDir,
    user_unit: PathBuf,
    system_unit: PathBuf,
    root: PathBuf,
    binary: PathBuf,
}

fn fixture(env: &str) -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("install");
    fs::create_dir_all(&root).unwrap();
    fs::write(root.join(".env"), env).unwrap();
    fs::write(root.join("omnigateway.db"), b"").unwrap();
    let binary = dir.path().join("pkg/omnigateway");
    fs::create_dir_all(binary.parent().unwrap()).unwrap();
    fs::write(&binary, b"").unwrap();
    Fixture {
        user_unit: dir.path().join("user/omnigateway.service"),
        system_unit: dir.path().join("system/omnigateway.service"),
        root,
        binary,
        dir,
    }
}

impl Fixture {
    fn paths(&self) -> Paths {
        Paths {
            user_unit: self.user_unit.clone(),
            system_unit: self.system_unit.clone(),
            state: self.dir.path().join("state"),
            binary: self.binary.clone(),
            version: "1.0.0".into(),
        }
    }
    fn write_user(&self, text: &str) {
        fs::create_dir_all(self.user_unit.parent().unwrap()).unwrap();
        fs::write(&self.user_unit, text).unwrap();
    }
    fn write_system(&self, text: &str) {
        fs::create_dir_all(self.system_unit.parent().unwrap()).unwrap();
        fs::write(&self.system_unit, text).unwrap();
    }
    fn record(&self) -> Value {
        serde_json::from_str(&fs::read_to_string(self.paths().state.join(RECORD)).unwrap()).unwrap()
    }
    fn unit(&self) -> String {
        fs::read_to_string(&self.user_unit).unwrap()
    }
    fn host(&self) -> Fake {
        Fake::new(self)
    }
}

const SINGLE: &str = "OMNI_ENCRYPTION_KEY=kkkkkkkkkkkkkkkkkkkk\nOMNI_PORT=19100\n";

// ---------------------------------------------------------------- happy path

#[test]
fn legacy_user_service_migrates_in_order_and_keeps_operator_lines() {
    let f = fixture(SINGLE);
    let extra = "StandardOutput=append:/var/log/omni.log\n";
    f.write_user(&legacy_unit(&f.root, extra));
    let host = f.host();
    let outcome = migrate(&host, &f.paths(), 1_000);
    assert_eq!(outcome.status, Status::Migrated, "{}", outcome.message);
    assert!(host.at("systemctl user stop") < host.at("lock "));
    assert!(host.at("lock ") < host.at("backup"));
    assert!(host.at("backup") < host.at("systemctl user daemon-reload"));
    assert!(host.at("systemctl user daemon-reload") < host.at("unlock"));
    assert!(host.at("unlock") < host.at("systemctl user start"));
    assert!(host.at("systemctl user start") < host.at("health"));
    assert!(
        host.log()
            .contains(&"health http://127.0.0.1:19100".to_owned())
    );
    assert_eq!(
        f.unit(),
        legacy_unit(&f.root, extra).replace(
            &format!("ExecStart={BUN} {GATEWAY_JS}"),
            &format!("ExecStart={}", f.binary.display())
        )
    );
    let saved = f.paths().state.join("pre-rust/omnigateway.service");
    assert_eq!(
        fs::read_to_string(saved).unwrap(),
        legacy_unit(&f.root, extra)
    );
    let record = f.record();
    assert_eq!(record["status"], "migrated");
    assert_eq!(
        record["backup"],
        "db_2026-11-21T00-00-00-000Z_preRust.sqlite"
    );
    assert_eq!(record["runningVersion"], "1.0.0");
}

#[test]
fn inactive_legacy_service_is_rewritten_but_not_started() {
    let f = fixture(SINGLE);
    f.write_user(&legacy_unit(&f.root, ""));
    let host = f.host();
    *host.active.borrow_mut() = false;
    *host.main_pid.borrow_mut() = None;
    host.ts_holds_db.set(false);
    let outcome = migrate(&host, &f.paths(), 1);
    assert_eq!(outcome.status, Status::Migrated, "{}", outcome.message);
    assert!(!host.did("systemctl user start") && !host.did("health"));
    assert!(host.did("backup"));
}

// ------------------------------------------------- refusals before any stop

fn refused_before_stop(f: &Fixture, host: &Fake, status: Status) -> Outcome {
    let before = fs::read_to_string(&f.user_unit).ok();
    let outcome = migrate(host, &f.paths(), 1);
    assert_eq!(outcome.status, status, "{}", outcome.message);
    assert!(
        !host.did("systemctl user stop") && !host.did("systemctl system stop"),
        "{:?}",
        host.log()
    );
    assert!(!host.did("backup"));
    assert_eq!(fs::read_to_string(&f.user_unit).ok(), before);
    assert_eq!(f.record()["status"], status.name());
    outcome
}

#[test]
fn cluster_settings_in_env_file_or_unit_are_refused() {
    for env in [
        "OMNI_DATABASE_URL=postgres://x/y\n",
        "OMNI_REDIS_URL=redis://x\n",
        "OMNI_CLUSTER_MODE=true\n",
    ] {
        let f = fixture(env);
        f.write_user(&legacy_unit(&f.root, ""));
        refused_before_stop(&f, &f.host(), Status::SkippedCluster);
    }
}

#[test]
fn any_inline_environment_in_the_loaded_unit_is_refused() {
    // `Environment=OMNI_DB_PATH=/srv/live.db` would point Rust at a database
    // the updater never checked or backed up.
    let f = fixture(SINGLE);
    f.write_user(&legacy_unit(
        &f.root,
        "Environment=OMNI_DB_PATH=/srv/live.db\n",
    ));
    refused_before_stop(&f, &f.host(), Status::SkippedUnit);
    let f = fixture(SINGLE);
    f.write_user(&legacy_unit(&f.root, ""));
    let host = Fake {
        environment: "OMNI_DB_PATH=/srv/live.db".into(),
        ..f.host()
    };
    refused_before_stop(&f, &host, Status::SkippedUnit);
}

#[test]
fn environment_files_other_than_root_env_are_refused() {
    for files in [
        "/elsewhere/.env (ignore_errors=no)".to_owned(),
        format!("{}/.env (ignore_errors=yes)", "/x"),
        String::new(),
    ] {
        let f = fixture(SINGLE);
        f.write_user(&legacy_unit(&f.root, ""));
        let host = Fake {
            environment_files: Some(files.clone()),
            ..f.host()
        };
        refused_before_stop(&f, &host, Status::SkippedUnit);
    }
}

#[test]
fn unreadable_env_file_is_refused() {
    let f = fixture(SINGLE);
    f.write_user(&legacy_unit(&f.root, ""));
    fs::remove_file(f.root.join(".env")).unwrap();
    fs::create_dir(f.root.join(".env")).unwrap();
    refused_before_stop(&f, &f.host(), Status::SkippedUnit);
}

#[test]
fn units_this_updater_did_not_write_are_refused() {
    let f0 = fixture(SINGLE);
    let checkout =
        legacy_unit(&f0.root, "").replace(GATEWAY_JS, "/src/omnigateway/apps/gateway/src/index.ts");
    for text in [
        checkout,
        legacy_unit(&f0.root, "ExecStartPre=/bin/true\n"),
        legacy_unit(&f0.root, "").replace("WorkingDirectory=", "WorkingDirectory = "),
        legacy_unit(&f0.root, "").replace(BUN, "/usr/bin/python3"),
        legacy_unit(&f0.root, "ExecStart=\n"),
        legacy_unit(&f0.root, "").replace("[Service]", "[Service]\nUser=other"),
    ] {
        let f = fixture(SINGLE);
        let text = text.replace(
            &f0.root.display().to_string(),
            &f.root.display().to_string(),
        );
        f.write_user(&text);
        let host = f.host();
        if let Some(line) = text
            .lines()
            .find(|l| l.starts_with("ExecStart=") && l.len() > 10)
        {
            *host.exec.borrow_mut() = line["ExecStart=".len()..].to_owned();
        }
        refused_before_stop(&f, &host, Status::SkippedUnit);
    }
}

#[test]
fn loaded_unit_must_be_the_file_on_disk() {
    for (fragment, reload, drop_ins) in [
        (
            Some(PathBuf::from("/run/systemd/other.service")),
            false,
            false,
        ),
        (None, true, false),
        (None, false, true),
    ] {
        let f = fixture(SINGLE);
        f.write_user(&legacy_unit(&f.root, ""));
        let host = Fake {
            fragment: fragment.clone(),
            need_reload: reload,
            drop_ins,
            ..f.host()
        };
        refused_before_stop(&f, &host, Status::SkippedUnit);
    }
    // Loaded ExecStart differs from the file (edited, not reloaded).
    let f = fixture(SINGLE);
    f.write_user(&legacy_unit(&f.root, ""));
    let host = f.host();
    *host.exec.borrow_mut() = "/usr/bin/other".into();
    refused_before_stop(&f, &host, Status::SkippedUnit);
}

#[test]
fn both_or_unreadable_scopes_are_refused() {
    let f = fixture(SINGLE);
    f.write_user(&legacy_unit(&f.root, ""));
    f.write_system(&legacy_unit(&f.root, ""));
    let host = f.host();
    assert_eq!(migrate(&host, &f.paths(), 1).status, Status::SkippedUnit);
    assert!(!host.did("systemctl user stop"));
    let f = fixture(SINGLE);
    f.write_user(&legacy_unit(&f.root, ""));
    fs::create_dir_all(&f.system_unit).unwrap();
    let host = f.host();
    assert_eq!(migrate(&host, &f.paths(), 1).status, Status::SkippedUnit);
    assert!(!host.did("systemctl user stop"));
}

/// A holder visible in `/proc` refuses before stop; holders `/proc` cannot
/// show (another user, a hard link) are caught by the exclusive lock after it.
#[test]
fn a_visible_other_holder_blocks_before_stop() {
    let f = fixture(SINGLE);
    f.write_user(&legacy_unit(&f.root, ""));
    let host = Fake {
        extra_holder: Some(9001),
        ..f.host()
    };
    let outcome = refused_before_stop(&f, &host, Status::SkippedWriter);
    assert!(outcome.message.contains("9001"));
}

#[test]
fn foreground_gateway_is_left_alone() {
    let f = fixture(SINGLE);
    let host = Fake {
        pidfile_gateway: true,
        ..f.host()
    };
    let outcome = migrate(&host, &f.paths(), 1);
    assert_eq!(outcome.status, Status::SkippedForeground);
    assert!(outcome.message.contains("omni start"));
}

#[test]
fn system_scope_needs_root_and_a_root_owned_binary() {
    for (root, trusted) in [(false, true), (true, false)] {
        let f = fixture(SINGLE);
        f.write_system(&legacy_unit(&f.root, ""));
        let host = Fake {
            euid_root: root,
            trusted_binary: trusted,
            unit_file: f.system_unit.clone(),
            ..f.host()
        };
        let outcome = migrate(&host, &f.paths(), 1);
        assert_eq!(outcome.status, Status::SkippedPrivilege);
        assert!(outcome.message.contains("sudo"));
        assert!(!host.did("systemctl system stop"));
    }
    let f = fixture(SINGLE);
    f.write_system(&legacy_unit(&f.root, ""));
    let host = Fake {
        euid_root: true,
        unit_file: f.system_unit.clone(),
        ..f.host()
    };
    let outcome = migrate(&host, &f.paths(), 1);
    assert_eq!(outcome.status, Status::Migrated, "{}", outcome.message);
    assert!(host.did("systemctl system stop omnigateway.service"));
}

#[test]
fn preflight_failures_refuse_before_stop() {
    let f = fixture(SINGLE);
    f.write_user(&legacy_unit(&f.root, ""));
    refused_before_stop(
        &f,
        &Fake {
            low_disk: true,
            ..f.host()
        },
        Status::SkippedDatabase,
    );
    let f = fixture(SINGLE);
    f.write_user(&legacy_unit(&f.root, ""));
    refused_before_stop(
        &f,
        &Fake {
            binary_runs: false,
            ..f.host()
        },
        Status::SkippedBinary,
    );
}

// ------------------------------------------------ after stop: exclusivity

/// npm already replaced the TS files, so a stopped TS cannot be started again:
/// every failure after the stop leaves the service stopped (owner ruling).
#[test]
fn a_foreign_connection_after_stop_changes_nothing_and_stays_stopped() {
    let f = fixture(SINGLE);
    f.write_user(&legacy_unit(&f.root, ""));
    let host = f.host();
    host.foreign_open.set(true);
    let outcome = migrate(&host, &f.paths(), 1);
    assert_eq!(outcome.status, Status::FailedWriter, "{}", outcome.message);
    assert!(!host.did("backup") && !host.did("systemctl user start"));
    assert_eq!(f.unit(), legacy_unit(&f.root, ""));
    assert!(
        outcome.message.contains("npm i -g omnigateway@0.15.5"),
        "{}",
        outcome.message
    );
    assert!(!outcome.message.contains("db restore"));
}

#[test]
fn stop_that_does_not_take_is_reported_without_changes() {
    let f = fixture(SINGLE);
    f.write_user(&legacy_unit(&f.root, ""));
    let host = Fake {
        stop_sticks: false,
        ..f.host()
    };
    let outcome = migrate(&host, &f.paths(), 1);
    // A stop was issued, so this is a failure the operator must see.
    assert_eq!(outcome.status, Status::FailedWriter, "{}", outcome.message);
    assert!(!host.did("backup"));
    assert_eq!(f.unit(), legacy_unit(&f.root, ""));
}

// ------------------------------------------------------ failure recovery

#[test]
fn failed_backup_changes_nothing_and_names_no_restore() {
    let f = fixture(SINGLE);
    f.write_user(&legacy_unit(&f.root, ""));
    let host = Fake {
        fail_backup: true,
        ..f.host()
    };
    let outcome = migrate(&host, &f.paths(), 1);
    assert_eq!(outcome.status, Status::FailedBackup);
    assert!(
        !outcome.message.contains("db restore"),
        "{}",
        outcome.message
    );
    assert!(
        outcome.message.contains("npm i -g omnigateway@0.15.5"),
        "{}",
        outcome.message
    );
    assert_eq!(f.unit(), legacy_unit(&f.root, ""));
    assert!(host.at("backup") < host.at("unlock"));
    assert!(!host.did("systemctl user start"));
    assert_eq!(f.record()["status"], "failed-backup");
}

#[test]
fn unhealthy_rust_is_stopped_confirmed_and_rollback_is_specific() {
    let f = fixture(SINGLE);
    f.write_user(&legacy_unit(&f.root, ""));
    let host = Fake {
        healthy: false,
        ..f.host()
    };
    let outcome = migrate(&host, &f.paths(), 1);
    assert_eq!(outcome.status, Status::FailedStart);
    assert!(
        host.at("health")
            < host
                .log()
                .iter()
                .rposition(|l| l == "systemctl user stop omnigateway.service")
                .unwrap()
    );
    let saved = f.paths().state.join("pre-rust/omnigateway.service");
    for step in [
        "npm i -g omnigateway@0.15.5".to_owned(),
        format!(
            "omni db restore --root {} db_2026-11-21T00-00-00-000Z_preRust.sqlite",
            f.root.display()
        ),
        format!("cp {} {}", saved.display(), f.user_unit.display()),
        "systemctl --user daemon-reload".to_owned(),
        "journalctl --user -u omnigateway.service".to_owned(),
        "left stopped".to_owned(),
    ] {
        assert!(
            outcome.message.contains(&step),
            "{step}: {}",
            outcome.message
        );
    }
}

#[test]
fn failed_start_is_stopped_too() {
    let f = fixture(SINGLE);
    f.write_user(&legacy_unit(&f.root, ""));
    let host = Fake {
        fail_start: true,
        ..f.host()
    };
    let outcome = migrate(&host, &f.paths(), 1);
    assert_eq!(outcome.status, Status::FailedStart);
    assert_eq!(
        host.log().last().unwrap(),
        "systemctl user show omnigateway.service --property=ActiveState,MainPID"
    );
}

#[test]
fn health_from_another_server_is_not_success() {
    let f = fixture(SINGLE);
    f.write_user(&legacy_unit(&f.root, ""));
    let host = Fake {
        impostor: true,
        ..f.host()
    };
    let outcome = migrate(&host, &f.paths(), 1);
    assert_eq!(outcome.status, Status::FailedStart, "{}", outcome.message);
}

// --------------------------------------------------------- Rust → Rust

fn migrated_fixture() -> (Fixture, PathBuf) {
    let f = fixture(SINGLE);
    f.write_user(&legacy_unit(&f.root, ""));
    let outcome = migrate(&f.host(), &f.paths(), 1);
    assert_eq!(outcome.status, Status::Migrated, "{}", outcome.message);
    let bin = f.binary.clone();
    (f, bin)
}

fn rust_host(f: &Fixture, exe: Option<PathBuf>) -> Fake {
    let host = f.host();
    // Rust (4242) holds the database now, not TS.
    host.ts_holds_db.set(false);
    *host.exec.borrow_mut() = f.binary.display().to_string();
    *host.main_pid.borrow_mut() = Some(4242);
    *host.running_exe.borrow_mut() = exe;
    host
}

#[test]
fn migrated_unit_with_current_binary_is_a_no_op() {
    let (f, bin) = migrated_fixture();
    let host = rust_host(&f, Some(bin));
    assert_eq!(migrate(&host, &f.paths(), 2).status, Status::Current);
    assert!(!host.did("systemctl user restart"));
}

#[test]
fn unreadable_running_exe_is_not_a_reason_to_restart() {
    let (f, _) = migrated_fixture();
    let host = Fake {
        exe_unreadable: true,
        ..rust_host(&f, None)
    };
    assert_eq!(migrate(&host, &f.paths(), 2).status, Status::Current);
    assert!(!host.did("systemctl user restart"));
}

#[test]
fn replaced_binary_restarts_an_active_rust_service() {
    let (f, bin) = migrated_fixture();
    let host = rust_host(
        &f,
        Some(PathBuf::from(format!("{} (deleted)", bin.display()))),
    );
    let outcome = migrate(&host, &f.paths(), 2);
    // After restart the new process runs the binary.
    assert_eq!(outcome.status, Status::Restarted, "{}", outcome.message);
    assert!(host.did("systemctl user restart omnigateway.service"));
    assert!(!host.did("backup"));
}

#[test]
fn replaced_binary_failing_health_names_the_last_good_version() {
    let (f, bin) = migrated_fixture();
    let next = Paths {
        version: "1.0.1".into(),
        ..f.paths()
    };
    let host = Fake {
        healthy: false,
        ..rust_host(
            &f,
            Some(PathBuf::from(format!("{} (deleted)", bin.display()))),
        )
    };
    let outcome = migrate(&host, &next, 2);
    assert_eq!(outcome.status, Status::FailedStart);
    assert!(
        outcome.message.contains("npm i -g omnigateway@1.0.0"),
        "{}",
        outcome.message
    );
    // A failed attempt keeps the last good version for the next try.
    assert_eq!(f.record()["runningVersion"], "1.0.0");
}

#[test]
fn unknown_previous_version_says_so() {
    let f = fixture(SINGLE);
    f.write_user(&legacy_unit(&f.root, "").replace(
        &format!("{BUN} {GATEWAY_JS}"),
        &f.binary.display().to_string(),
    ));
    let host = Fake {
        healthy: false,
        ..rust_host(&f, Some(PathBuf::from("/old/omnigateway (deleted)")))
    };
    let outcome = migrate(&host, &f.paths(), 2);
    assert_eq!(outcome.status, Status::FailedStart);
    assert!(
        outcome.message.contains("previous version is not recorded"),
        "{}",
        outcome.message
    );
    assert!(!outcome.message.contains("<the previous version>"));
}

// ------------------------------------------------------------- banner

#[test]
fn no_service_records_nothing_and_banner_stays_quiet() {
    let f = fixture(SINGLE);
    let host = f.host();
    assert_eq!(
        migrate(&host, &f.paths(), 1).status,
        Status::NothingToMigrate
    );
    assert_eq!(banner(&f.paths()), None);
}

#[test]
fn banner_names_the_recorded_reason() {
    let f = fixture(SINGLE);
    f.write_user(&legacy_unit(&f.root, ""));
    let pending = banner(&f.paths()).unwrap();
    assert!(pending.contains("omni service migrate"), "{pending}");
    migrate(
        &Fake {
            healthy: false,
            ..f.host()
        },
        &f.paths(),
        1,
    );
    let failed = banner(&f.paths()).unwrap();
    assert!(
        failed.contains("failed") && failed.contains("/health"),
        "{failed}"
    );
}

#[test]
fn only_doctor_and_status_announce() {
    for command in ["doctor", "status"] {
        assert!(announces(command), "{command}");
    }
    for command in [
        "list",
        "start",
        "stop",
        "db-backup",
        "connect",
        "logs",
        "models-list",
    ] {
        assert!(!announces(command), "{command}");
    }
}

// ------------------------------------------------------------- bridge

/// The bridge migrates under the lock, adds a one-shot verifier to the unit,
/// and asks systemd to restart it: Rust runs as a plain MainPID, never as the
/// bridge's child.
#[test]
fn bridge_migrates_under_lock_and_hands_over_to_systemd() {
    let f = fixture(SINGLE);
    f.write_user(&legacy_unit(&f.root, ""));
    let host = bridge_host(&f);
    assert_eq!(bridge(&host, &f.paths(), 1), 0);
    assert!(!host.did("systemctl user stop") && !host.did("spawn"));
    assert!(host.at("lock ") < host.at("backup"));
    assert!(host.at("backup") < host.at("systemctl user daemon-reload"));
    assert!(host.at("unlock") < host.at("systemctl user restart --no-block omnigateway.service"));
    let unit = f.unit();
    assert!(unit.contains(&format!("ExecStart={}\n", f.binary.display())));
    assert!(
        unit.contains(&format!(
            "ExecStartPost={} omni service migrate --verify-start\n",
            f.binary.display()
        )),
        "{unit}"
    );
    assert_eq!(f.record()["status"], "verifying");
}

/// systemd runs the verifier once Rust is up: success removes the line and
/// records `migrated`.
#[test]
fn verify_start_records_migrated_and_removes_itself() {
    let f = fixture(SINGLE);
    f.write_user(&legacy_unit(&f.root, ""));
    bridge(&bridge_host(&f), &f.paths(), 1);
    let host = rust_host(&f, None);
    assert_eq!(verify_start(&host, &f.paths(), 4242, 2), 0);
    assert!(!f.unit().contains("ExecStartPost="), "{}", f.unit());
    assert!(host.did("systemctl user daemon-reload"));
    let record = f.record();
    assert_eq!(record["status"], "migrated");
    assert_eq!(record["runningVersion"], "1.0.0");
    assert_eq!(
        record["backup"],
        "db_2026-11-21T00-00-00-000Z_preRust.sqlite"
    );
}

/// A failing verifier exits non-zero, so systemd fails and stops the unit,
/// and records the failure with the bridge's rollback.
#[test]
fn verify_start_failure_fails_the_unit_with_rollback() {
    let f = fixture(SINGLE);
    f.write_user(&legacy_unit(&f.root, ""));
    bridge(&bridge_host(&f), &f.paths(), 1);
    let host = Fake {
        healthy: false,
        ..rust_host(&f, None)
    };
    assert_ne!(verify_start(&host, &f.paths(), 4242, 2), 0);
    assert!(!f.unit().contains("ExecStartPost="));
    // Without a stop, Restart=on-failure would start Rust again unverified.
    assert!(host.did("systemctl user stop --no-block omnigateway.service"));
    let record = f.record();
    assert_eq!(record["status"], "failed-start");
    let message = record["message"].as_str().unwrap();
    assert!(message.contains("omni db restore --root"), "{message}");
    assert!(message.contains("npm i -g omnigateway@0.15.5"), "{message}");
    // Not our process on the port either.
    let f = fixture(SINGLE);
    f.write_user(&legacy_unit(&f.root, ""));
    bridge(&bridge_host(&f), &f.paths(), 1);
    let host = Fake {
        foreign_listener: true,
        ..rust_host(&f, None)
    };
    assert_ne!(verify_start(&host, &f.paths(), 4242, 2), 0);
}

/// Without a pending bridge handoff the verifier does nothing (and succeeds).
#[test]
fn verify_start_without_a_handoff_is_a_no_op() {
    let f = fixture(SINGLE);
    let host = rust_host(&f, None);
    assert_eq!(verify_start(&host, &f.paths(), 4242, 1), 0);
    assert!(!host.did("health"));
}

#[test]
fn bridge_refusals_exit_zero_so_systemd_does_not_loop() {
    let f = fixture("OMNI_DATABASE_URL=postgres://x/y\n");
    f.write_user(&legacy_unit(&f.root, ""));
    let host = bridge_host(&f);
    assert_eq!(bridge(&host, &f.paths(), 1), 0);
    assert!(!host.did("systemctl user restart"));
    let none = fixture(SINGLE);
    assert_eq!(bridge(&bridge_host(&none), &none.paths(), 1), 1);
}

#[test]
fn bridge_run_by_hand_with_the_service_active_is_refused() {
    let f = fixture(SINGLE);
    f.write_user(&legacy_unit(&f.root, ""));
    let host = Fake {
        bridge_parent_is_main: false,
        ..bridge_host(&f)
    };
    assert_eq!(bridge(&host, &f.paths(), 1), 1);
    assert!(!host.did("backup") && !host.did("systemctl user restart"));
}

/// A failed restart request leaves the rewritten unit stopped with rollback.
#[test]
fn bridge_restart_refused_by_systemd_is_a_failure() {
    let f = fixture(SINGLE);
    f.write_user(&legacy_unit(&f.root, ""));
    let host = Fake {
        fail_start: true,
        ..bridge_host(&f)
    };
    assert_eq!(bridge(&host, &f.paths(), 1), 0);
    assert_eq!(f.record()["status"], "failed-start");
    assert!(
        f.record()["message"]
            .as_str()
            .unwrap()
            .contains("omni db restore")
    );
}

fn bridge_host(f: &Fixture) -> Fake {
    let host = f.host();
    host.ts_holds_db.set(false);
    host
}

// ------------------------------------------------- rereview (npm-review.md)

/// Finding 1: the user manager's environment reaches the service without
/// appearing in the unit or `.env`.
#[test]
fn manager_environment_with_omni_settings_is_refused() {
    let f = fixture(SINGLE);
    f.write_user(&legacy_unit(&f.root, ""));
    let host = Fake {
        manager_env: vec!["OMNI_DB_PATH=/srv/live.db".into()],
        ..f.host()
    };
    let outcome = refused_before_stop(&f, &host, Status::SkippedUnit);
    assert!(outcome.message.contains("OMNI_DB_PATH") && !outcome.message.contains("/srv/live.db"));
}

/// Finding 1: systemd joins `\`-continued lines; the CLI's parser does not.
#[test]
fn env_file_continuation_lines_are_refused() {
    let f = fixture("OMNI_ENCRYPTION_KEY=kkkkkkkkkkkkkkkkkkkk\nOMNI_DB_PATH=/srv/a\\\nb.db\n");
    f.write_user(&legacy_unit(&f.root, ""));
    refused_before_stop(&f, &f.host(), Status::SkippedUnit);
}

/// Finding 1 (disclosure): a rejected directive's value can be a secret.
#[test]
fn rejected_directive_values_are_never_recorded_or_printed() {
    let f = fixture(SINGLE);
    f.write_user(&legacy_unit(
        &f.root,
        "Environment=OMNI_ENCRYPTION_KEY=s3cr3t-value\n",
    ));
    let outcome = migrate(&f.host(), &f.paths(), 1);
    assert_eq!(outcome.status, Status::SkippedUnit);
    let record = fs::read_to_string(f.paths().state.join(RECORD)).unwrap();
    assert!(
        !record.contains("s3cr3t") && !outcome.message.contains("s3cr3t"),
        "{record}"
    );
    assert!(!banner(&f.paths()).unwrap().contains("s3cr3t"));
    assert!(
        outcome.message.contains("Environment"),
        "{}",
        outcome.message
    );
}

/// Finding 2.
#[test]
fn incomplete_or_mismatched_loaded_facts_are_refused() {
    let f = fixture(SINGLE);
    f.write_user(&legacy_unit(&f.root, ""));
    refused_before_stop(
        &f,
        &Fake {
            omit_need_reload: true,
            ..f.host()
        },
        Status::SkippedUnit,
    );
    let f = fixture(SINGLE);
    f.write_user(&legacy_unit(&f.root, ""));
    let host = Fake {
        working_directory: Some(PathBuf::from("/srv/other")),
        ..f.host()
    };
    refused_before_stop(&f, &host, Status::SkippedUnit);
}

/// Finding 2: an output path inside the package npm replaced.
#[test]
fn a_line_naming_the_old_package_is_refused() {
    let f = fixture(SINGLE);
    let pkg = GATEWAY_JS.trim_end_matches("/gateway.js");
    f.write_user(&legacy_unit(
        &f.root,
        &format!("StandardOutput=append:{pkg}/gateway.log\n"),
    ));
    refused_before_stop(&f, &f.host(), Status::SkippedUnit);
}

/// Finding 3: a pending auto-restart (`activating`, MainPID 0) would start TS
/// in the middle of the conversion.
#[test]
fn transitional_states_are_refused_before_stop() {
    for state in ["activating", "deactivating", "reloading"] {
        let f = fixture(SINGLE);
        f.write_user(&legacy_unit(&f.root, ""));
        let host = Fake {
            state_override: Some(state),
            ..f.host()
        };
        refused_before_stop(&f, &host, Status::SkippedUnit);
    }
}

/// Finding 3: after the start, the database is held by our gateway alone.
#[test]
fn a_late_opener_after_start_fails_the_migration() {
    let f = fixture(SINGLE);
    f.write_user(&legacy_unit(&f.root, ""));
    let host = Fake {
        late_holder: true,
        ..f.host()
    };
    let outcome = migrate(&host, &f.paths(), 1);
    assert_eq!(outcome.status, Status::FailedStart, "{}", outcome.message);
    assert!(outcome.message.contains("31337"), "{}", outcome.message);
}

/// Finding 5: the port is checked free once TS has stopped, before anything
/// is written; a server still answering there is not ours.
#[test]
fn another_server_on_the_port_fails_before_anything_is_written() {
    let f = fixture(SINGLE);
    f.write_user(&legacy_unit(&f.root, ""));
    let host = Fake {
        port_taken: true,
        ..f.host()
    };
    let outcome = migrate(&host, &f.paths(), 1);
    assert_eq!(outcome.status, Status::FailedPort, "{}", outcome.message);
    assert!(host.at("systemctl user stop") < host.at("probe"));
    assert!(!host.did("backup") && !host.did("systemctl user start"));
    assert_eq!(f.unit(), legacy_unit(&f.root, ""));
    let f = fixture(SINGLE);
    f.write_user(&legacy_unit(&f.root, ""));
    let host = Fake {
        port_taken: true,
        ..bridge_host(&f)
    };
    assert_eq!(bridge(&host, &f.paths(), 1), 0);
    assert!(!host.did("backup") && !host.did("spawn"));
    assert_eq!(f.record()["status"], "failed-port");
}

/// Finding 5: health counts only when the listening socket is the started
/// process's own.
#[test]
fn health_with_a_foreign_listener_is_not_success() {
    let f = fixture(SINGLE);
    f.write_user(&legacy_unit(&f.root, ""));
    let host = Fake {
        foreign_listener: true,
        ..f.host()
    };
    assert_eq!(migrate(&host, &f.paths(), 1).status, Status::FailedStart);
}

/// Finding 4: only a confirmed stop is reported as stopped.
#[test]
fn unconfirmed_cleanup_stop_is_not_called_stopped() {
    let f = fixture(SINGLE);
    f.write_user(&legacy_unit(&f.root, ""));
    let host = Fake {
        healthy: false,
        cleanup_stop_fails: true,
        ..f.host()
    };
    let outcome = migrate(&host, &f.paths(), 1);
    assert_eq!(outcome.status, Status::FailedStart);
    assert!(
        !outcome.message.contains("left stopped"),
        "{}",
        outcome.message
    );
    assert!(
        outcome.message.contains("could not be confirmed stopped"),
        "{}",
        outcome.message
    );
    assert!(
        outcome
            .message
            .contains("systemctl --user stop omnigateway.service"),
        "{}",
        outcome.message
    );
}

/// Finding 4: a later run must not erase a recorded failure until the
/// service is verified running this binary.
#[test]
fn a_recorded_failure_survives_until_the_service_runs() {
    let f = fixture(SINGLE);
    f.write_user(&legacy_unit(&f.root, ""));
    migrate(
        &Fake {
            healthy: false,
            ..f.host()
        },
        &f.paths(),
        1,
    );
    let failed = f.record();
    assert_eq!(failed["status"], "failed-start");
    let host = rust_host(&f, None);
    *host.active.borrow_mut() = false;
    *host.main_pid.borrow_mut() = None;
    let outcome = migrate(&host, &f.paths(), 2);
    assert_eq!(outcome.status, Status::FailedStart, "{}", outcome.message);
    let kept = f.record();
    assert_eq!(kept["backup"], failed["backup"]);
    assert_eq!(kept["savedUnit"], failed["savedUnit"]);
    assert!(banner(&f.paths()).is_some());
    let host = rust_host(&f, Some(f.binary.clone()));
    assert_eq!(migrate(&host, &f.paths(), 3).status, Status::Current);
    assert_eq!(banner(&f.paths()), None);
}

/// Finding 6: a unit with no usable MainPID is a recorded refusal, exit 0.
#[test]
fn bridge_without_a_main_pid_is_a_recorded_zero_exit() {
    let f = fixture(SINGLE);
    f.write_user(&legacy_unit(&f.root, ""));
    let host = bridge_host(&f);
    *host.main_pid.borrow_mut() = None;
    assert_eq!(bridge(&host, &f.paths(), 1), 0);
    assert_eq!(f.record()["status"], "skipped-unit");
}

// ------------------------------------------------- second rereview

/// Finding 1: systemd reads `\ `, `$X` and quotes differently from the CLI;
/// a value that could differ for the keys that pick the database or mode is
/// refused rather than guessed.
#[test]
fn values_systemd_could_read_differently_are_refused_for_db_and_mode_keys() {
    for line in [
        "OMNI_DB_PATH=/srv/data\\ store/live.db",
        "OMNI_DB_PATH=$HOME/live.db",
        "OMNI_DB_PATH=\"/srv/a\"b.db",
        "OMNI_DB_PATH='/srv/a",
        "OMNI_CLUSTER_MODE=${MODE}",
    ] {
        let f = fixture(&format!(
            "OMNI_ENCRYPTION_KEY=kkkkkkkkkkkkkkkkkkkk\n{line}\n"
        ));
        f.write_user(&legacy_unit(&f.root, ""));
        refused_before_stop(&f, &f.host(), Status::SkippedUnit);
    }
    // A plain value is fine.
    let f = fixture("OMNI_ENCRYPTION_KEY=kkkkkkkkkkkkkkkkkkkk\nOMNI_DB_PATH=data/live.db\n");
    f.write_user(&legacy_unit(&f.root, ""));
    fs::create_dir_all(f.root.join("data")).unwrap();
    assert_eq!(migrate(&f.host(), &f.paths(), 1).status, Status::Migrated);
}

/// Finding 1: the system manager's DefaultEnvironment reaches system units.
#[test]
fn system_manager_environment_with_omni_settings_is_refused() {
    let f = fixture(SINGLE);
    f.write_system(&legacy_unit(&f.root, ""));
    let host = Fake {
        euid_root: true,
        unit_file: f.system_unit.clone(),
        manager_env: vec!["OMNI_REDIS_URL=redis://x".into()],
        ..f.host()
    };
    let outcome = migrate(&host, &f.paths(), 1);
    assert_eq!(outcome.status, Status::SkippedUnit, "{}", outcome.message);
    assert!(!host.did("systemctl system stop"));
}

/// Finding 1: the started gateway must be holding the database that was
/// backed up, not another one.
#[test]
fn rust_not_holding_the_backed_up_database_fails() {
    let f = fixture(SINGLE);
    f.write_user(&legacy_unit(&f.root, ""));
    let host = Fake {
        rust_holds_db: false,
        ..f.host()
    };
    let outcome = migrate(&host, &f.paths(), 1);
    assert_eq!(outcome.status, Status::FailedStart, "{}", outcome.message);
    assert!(
        outcome.message.contains("does not have"),
        "{}",
        outcome.message
    );
}

/// Finding 4: any later attempt — refused, current, or another failure —
/// keeps the unresolved failure and its rollback until positive recovery.
#[test]
fn an_unresolved_failure_survives_every_later_attempt() {
    let f = fixture(SINGLE);
    f.write_user(&legacy_unit(&f.root, ""));
    migrate(
        &Fake {
            healthy: false,
            ..f.host()
        },
        &f.paths(),
        1,
    );
    let failed = f.record();
    // A refused retry (pending daemon-reload).
    let host = Fake {
        need_reload: true,
        ..rust_host(&f, None)
    };
    assert_eq!(migrate(&host, &f.paths(), 2).status, Status::SkippedUnit);
    assert_eq!(f.record()["pendingFailure"]["backup"], failed["backup"]);
    assert_eq!(
        f.record()["pendingFailure"]["savedUnit"],
        failed["savedUnit"]
    );
    assert!(banner(&f.paths()).unwrap().contains("failed"));
    // An active run whose executable cannot be read is not recovery.
    let host = Fake {
        exe_unreadable: true,
        ..rust_host(&f, None)
    };
    migrate(&host, &f.paths(), 3);
    assert_eq!(f.record()["pendingFailure"]["backup"], failed["backup"]);
    assert!(banner(&f.paths()).unwrap().contains("failed"));
    // Verified running our binary: recovered.
    let host = rust_host(&f, Some(f.binary.clone()));
    assert_eq!(migrate(&host, &f.paths(), 4).status, Status::Current);
    assert!(f.record().get("pendingFailure").is_none_or(Value::is_null));
    assert_eq!(banner(&f.paths()), None);
}

/// Finding 4: an unparseable MainPID is not "stopped".
#[test]
fn stopped_requires_an_explicit_zero_main_pid() {
    let facts: Facts = [("ActiveState", "inactive"), ("MainPID", "")]
        .iter()
        .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
        .collect();
    assert!(!stopped(&facts));
    let facts: Facts = [("ActiveState", "inactive"), ("MainPID", "0")]
        .iter()
        .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
        .collect();
    assert!(stopped(&facts));
}

/// Finding 4: a stop that systemd never confirms gives stop-first steps.
#[test]
fn unconfirmed_ts_stop_gives_the_stop_command_first() {
    let f = fixture(SINGLE);
    f.write_user(&legacy_unit(&f.root, ""));
    let host = Fake {
        stop_sticks: false,
        ..f.host()
    };
    let outcome = migrate(&host, &f.paths(), 1);
    let stop = outcome
        .message
        .find("systemctl --user stop omnigateway.service")
        .unwrap();
    let npm = outcome.message.find("npm i -g omnigateway@0.15.5").unwrap();
    assert!(stop < npm, "{}", outcome.message);
}

// ------------------------------------------------- third rereview

/// Finding 1: the whole file must be in the subset both readers agree on;
/// a quoted value spanning lines can hide or invent an assignment.
#[test]
fn env_files_outside_the_shared_grammar_are_refused() {
    for text in [
        "OMNI_ENCRYPTION_KEY=\"kkkkkkkkkkkkkkkkkkkk\nOMNI_DB_PATH=other.db\nrest\"\nOMNI_DB_PATH=live.db\n",
        "OMNI_ENCRYPTION_KEY='kkkkkkkkkkkkkkkkkkkk\n",
        "OMNI_ENCRYPTION_KEY=kkkkkkkkkkkkkkkkkkkk\nOMNI_NOTE=a\"b\n",
        "OMNI_ENCRYPTION_KEY=kkkkkkkkkkkkkkkkkkkk\nOMNI_NOTE=a\\b\n",
        "OMNI_ENCRYPTION_KEY=kkkkkkkkkkkkkkkkkkkk\nnot an assignment\n",
        "OMNI_ENCRYPTION_KEY=kkkkkkkkkkkkkkkkkkkk\n1BAD=x\n",
        // systemd discards `export NAME` as an invalid name; the CLI strips it.
        "OMNI_ENCRYPTION_KEY=kkkkkkkkkkkkkkkkkkkk\nOMNI_DB_PATH=live.db\nexport OMNI_DB_PATH=other.db\n",
        // Unicode whitespace Rust trims and systemd does not.
        "OMNI_ENCRYPTION_KEY=kkkkkkkkkkkkkkkkkkkk\n\u{a0}OMNI_DB_PATH=other.db\n",
        "OMNI_ENCRYPTION_KEY=kkkkkkkkkkkkkkkkkkkk\nOMNI_DB_PATH=other.db\u{2003}\n",
        // Spaces around `=`: systemd keeps them in name/value differently.
        "OMNI_ENCRYPTION_KEY=kkkkkkkkkkkkkkkkkkkk\nOMNI_DB_PATH = other.db\n",
        "OMNI_ENCRYPTION_KEY=kkkkkkkkkkkkkkkkkkkk\r\nOMNI_DB_PATH=x.db\r\n",
    ] {
        let f = fixture(text);
        f.write_user(&legacy_unit(&f.root, ""));
        refused_before_stop(&f, &f.host(), Status::SkippedUnit);
    }
    // Quoted single-line values, comments, export and base64 keys are fine.
    let f = fixture(
        "# comment\nOMNI_ENCRYPTION_KEY=\"q1w2e3r4t5y6u7i8o9p0+/==\"\nOMNI_PORT='19100'\n\n",
    );
    f.write_user(&legacy_unit(&f.root, ""));
    assert_eq!(migrate(&f.host(), &f.paths(), 1).status, Status::Migrated);
}

/// Finding 4: a later failure keeps the first unresolved failure's rollback.
#[test]
fn a_second_failure_keeps_the_first_failures_rollback() {
    let f = fixture(SINGLE);
    f.write_user(&legacy_unit(&f.root, ""));
    migrate(
        &Fake {
            healthy: false,
            ..f.host()
        },
        &f.paths(),
        1,
    );
    let first = f.record();
    // The operator restores the saved TS unit and retries; it fails again.
    f.write_user(&legacy_unit(&f.root, ""));
    let host = Fake {
        port_taken: true,
        ..f.host()
    };
    assert_eq!(migrate(&host, &f.paths(), 2).status, Status::FailedPort);
    let record = f.record();
    assert_eq!(record["status"], "failed-port");
    assert_eq!(record["pendingFailure"]["backup"], first["backup"]);
    assert_eq!(record["pendingFailure"]["savedUnit"], first["savedUnit"]);
    assert_eq!(record["pendingFailure"]["message"], first["message"]);
}

/// Finding 4: `current` clears a failure only when the gateway serves.
#[test]
fn a_failure_is_cleared_only_by_a_serving_gateway() {
    let f = fixture(SINGLE);
    f.write_user(&legacy_unit(&f.root, ""));
    migrate(
        &Fake {
            healthy: false,
            ..f.host()
        },
        &f.paths(),
        1,
    );
    // Running our binary but not yet answering /health.
    let host = Fake {
        healthy: false,
        ..rust_host(&f, Some(f.binary.clone()))
    };
    migrate(&host, &f.paths(), 2);
    assert!(banner(&f.paths()).unwrap().contains("failed"));
    let host = rust_host(&f, Some(f.binary.clone()));
    migrate(&host, &f.paths(), 3);
    assert_eq!(banner(&f.paths()), None);
}

/// Finding 5: one endpoint for occupancy, health and attribution.
#[test]
fn a_bind_host_that_is_not_an_address_is_refused() {
    let f = fixture("OMNI_ENCRYPTION_KEY=kkkkkkkkkkkkkkkkkkkk\nOMNI_HOST=gateway.internal\n");
    f.write_user(&legacy_unit(&f.root, ""));
    refused_before_stop(&f, &f.host(), Status::SkippedUnit);
    for (host, probed) in [
        ("127.0.0.1", "127.0.0.1:9000"),
        ("0.0.0.0", "127.0.0.1:9000"),
        ("::", "[::1]:9000"),
        ("::1", "[::1]:9000"),
        ("10.1.2.3", "10.1.2.3:9000"),
    ] {
        let env = std::collections::HashMap::from([("OMNI_HOST".to_owned(), host.to_owned())]);
        assert_eq!(probe_addr(&env).to_string(), probed, "{host}");
        assert_eq!(local_base(&env), format!("http://{probed}"), "{host}");
    }
    // localhost resolves as the gateway's bind does: the resolver's first.
    use std::net::ToSocketAddrs as _;
    let first = ("localhost", 9000)
        .to_socket_addrs()
        .unwrap()
        .next()
        .unwrap();
    let env = std::collections::HashMap::from([("OMNI_HOST".to_owned(), "localhost".to_owned())]);
    assert_eq!(probe_addr(&env), first);
}

// ------------------------------------------------- fourth rereview

/// Finding 4: a failure with no backup must not mask the rollback of a later
/// attempt that took one; and a later inactive run must not erase it.
#[test]
fn rollback_data_outranks_an_earlier_artifact_free_failure() {
    let f = fixture(SINGLE);
    f.write_user(&legacy_unit(&f.root, ""));
    // 1. Refused after stop, before any backup.
    assert_eq!(
        migrate(
            &Fake {
                port_taken: true,
                ..f.host()
            },
            &f.paths(),
            1
        )
        .status,
        Status::FailedPort
    );
    // 2. Retry: backup taken, unit rewritten, Rust fails health.
    let host = Fake {
        healthy: false,
        ..f.host()
    };
    assert_eq!(migrate(&host, &f.paths(), 2).status, Status::FailedStart);
    let second = f.record();
    assert!(second["backup"].is_string());
    let shown = banner(&f.paths()).unwrap();
    assert!(shown.contains("failed-start"), "{shown}");
    // 3. An inactive rerun keeps the rollback of attempt 2.
    let host = rust_host(&f, None);
    *host.active.borrow_mut() = false;
    *host.main_pid.borrow_mut() = None;
    migrate(&host, &f.paths(), 3);
    let record = f.record();
    let recovery = &record["pendingFailure"];
    assert_eq!(recovery["backup"], second["backup"], "{record:#}");
    assert_eq!(recovery["savedUnit"], second["savedUnit"]);
    assert!(
        recovery["message"]
            .as_str()
            .unwrap()
            .contains("omni db restore")
    );
    assert!(
        record["message"]
            .as_str()
            .unwrap()
            .contains("omni db restore"),
        "{record:#}"
    );
}

/// Non-ASCII anywhere is outside the shared grammar (systemd's whitespace
/// and the CLI's differ beyond ASCII).
#[test]
fn non_ascii_env_lines_are_refused() {
    let f = fixture("OMNI_ENCRYPTION_KEY=kkkkkkkkkkkkkkkkkkkk\nOMNI_DB_PATH=caf\u{e9}.db\n");
    f.write_user(&legacy_unit(&f.root, ""));
    refused_before_stop(&f, &f.host(), Status::SkippedUnit);
}

/// The reverse order: a failure with rollback, then one without. The first
/// stays the pending failure and the banner shows it.
#[test]
fn a_later_artifact_free_failure_does_not_mask_rollback() {
    let f = fixture(SINGLE);
    f.write_user(&legacy_unit(&f.root, ""));
    migrate(
        &Fake {
            healthy: false,
            ..f.host()
        },
        &f.paths(),
        1,
    );
    let first = f.record();
    assert!(first["backup"].is_string());
    // The operator restores the TS unit; the retry fails before any backup.
    f.write_user(&legacy_unit(&f.root, ""));
    assert_eq!(
        migrate(
            &Fake {
                port_taken: true,
                ..f.host()
            },
            &f.paths(),
            2
        )
        .status,
        Status::FailedPort
    );
    let record = f.record();
    assert_eq!(record["pendingFailure"]["backup"], first["backup"]);
    let shown = banner(&f.paths()).unwrap();
    assert!(shown.contains("failed-start"), "{shown}");
}

/// A verifier line left behind (the verifier never ran) is still our unit.
#[test]
fn a_leftover_verifier_line_is_still_a_rust_unit() {
    let f = fixture(SINGLE);
    f.write_user(&legacy_unit(&f.root, ""));
    bridge(&bridge_host(&f), &f.paths(), 1);
    assert!(f.unit().contains("ExecStartPost="));
    let host = rust_host(&f, None);
    assert_ne!(migrate(&host, &f.paths(), 2).status, Status::SkippedUnit);
}

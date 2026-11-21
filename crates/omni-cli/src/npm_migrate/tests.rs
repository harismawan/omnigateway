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
    child_exits_early: bool,
    pidfile_gateway: bool,
    stop_sticks: bool,
    spawned_code: i32,
    bridge_parent_is_main: bool,
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
            child_exits_early: false,
            pidfile_gateway: false,
            stop_sticks: true,
            spawned_code: 0,
            bridge_parent_is_main: true,
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
            Some("show") => {
                let files = self
                    .environment_files
                    .clone()
                    .unwrap_or_else(|| format!("{}/.env (ignore_errors=no)", self.root.display()));
                let argv = self.exec.borrow().clone();
                let path = argv.split(' ').next().unwrap_or_default().to_owned();
                return Ok(format!(
                    "ActiveState={}\nUnitFileState=enabled\nMainPID={}\nDropInPaths={}\nFragmentPath={}\nNeedDaemonReload={}\nEnvironment={}\nEnvironmentFiles={files}\nWorkingDirectory={}\nExecStart={{ path={path} ; argv[]={argv} ; ignore_errors=no ; start_time=[n/a] ; stop_time=[n/a] ; pid=0 ; code=(null) ; status=0/0 }}\n",
                    if *self.active.borrow() {
                        "active"
                    } else {
                        "inactive"
                    },
                    self.main_pid.borrow().unwrap_or(0),
                    if self.drop_ins {
                        "/etc/systemd/system/omnigateway.service.d/x.conf"
                    } else {
                        ""
                    },
                    self.fragment.as_ref().unwrap_or(&self.unit_file).display(),
                    if self.need_reload { "yes" } else { "no" },
                    self.environment,
                    self.root.display(),
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
    fn run_gateway(&self, binary: &Path, root: &Path) -> Result<Child, String> {
        self.log
            .borrow_mut()
            .push(format!("spawn {} in {}", binary.display(), root.display()));
        Ok(Child::Fake {
            code: self.spawned_code,
            exited_early: self.child_exits_early,
        })
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

#[test]
fn bridge_migrates_under_lock_and_hands_over_to_the_gateway() {
    let f = fixture(SINGLE);
    f.write_user(&legacy_unit(&f.root, ""));
    // systemd started gateway.js; the bridge descends from MainPID 777.
    let host = bridge_host(&f);
    let code = run_bridge(&host, &f.paths());
    assert_eq!(code, 0);
    assert!(!host.did("systemctl user stop") && !host.did("systemctl user start"));
    assert!(host.at("lock ") < host.at("backup"));
    assert!(host.at("unlock") < host.at("spawn"));
    assert!(f.unit().contains(&f.binary.display().to_string()));
    assert_eq!(f.record()["status"], "migrated");
}

#[test]
fn bridge_refusals_exit_zero_so_systemd_does_not_loop() {
    let f = fixture("OMNI_DATABASE_URL=postgres://x/y\n");
    f.write_user(&legacy_unit(&f.root, ""));
    let host = bridge_host(&f);
    assert_eq!(run_bridge(&host, &f.paths()), 0);
    assert!(!host.did("spawn"));
    let none = fixture(SINGLE);
    assert_eq!(run_bridge(&bridge_host(&none), &none.paths()), 1);
}

#[test]
fn bridge_run_by_hand_with_the_service_active_is_refused() {
    let f = fixture(SINGLE);
    f.write_user(&legacy_unit(&f.root, ""));
    let host = Fake {
        bridge_parent_is_main: false,
        ..bridge_host(&f)
    };
    assert_eq!(run_bridge(&host, &f.paths()), 1);
    assert!(!host.did("backup") && !host.did("spawn"));
}

#[test]
fn bridge_child_dying_before_health_is_a_failure() {
    let f = fixture(SINGLE);
    f.write_user(&legacy_unit(&f.root, ""));
    let host = Fake {
        child_exits_early: true,
        ..bridge_host(&f)
    };
    assert_eq!(run_bridge(&host, &f.paths()), 0);
    assert_eq!(f.record()["status"], "failed-start");
}

fn bridge_host(f: &Fixture) -> Fake {
    let host = f.host();
    host.ts_holds_db.set(false);
    host
}

fn run_bridge(host: &Fake, paths: &Paths) -> i32 {
    match bridge(host, paths, 1) {
        Bridge::Exit(code) => code,
        Bridge::Serve(child) => child.wait_fake(),
    }
}

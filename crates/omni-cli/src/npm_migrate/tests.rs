#![allow(clippy::unwrap_used, clippy::expect_used)]
use super::*;
use std::cell::RefCell;

const BUN: &str = "/home/u/.bun/bin/bun";
const GATEWAY_JS: &str = "/home/u/.npm-global/lib/node_modules/omnigateway/gateway.js";

fn legacy_unit(root: &Path, extra: &str) -> String {
    format!(
        "[Unit]\nDescription=OmniGateway\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\nWorkingDirectory={r}\nEnvironmentFile={r}/.env\nExecStart={BUN} {GATEWAY_JS}\n{extra}Restart=on-failure\nRestartSec=2\n\n[Install]\nWantedBy=default.target\n",
        r = root.display()
    )
}

/// Every side effect the migration has, recorded in order.
#[derive(Default)]
struct Fake {
    log: RefCell<Vec<String>>,
    active: RefCell<bool>,
    enabled: bool,
    drop_ins: bool,
    main_pid: RefCell<Option<u32>>,
    holders: RefCell<Vec<u32>>,
    healthy: bool,
    running_exe: RefCell<Option<PathBuf>>,
    euid_root: bool,
    trusted_binary: bool,
    fail_backup: bool,
    low_disk: bool,
    spawned_code: i32,
}

impl Host for Fake {
    fn systemctl(&self, scope: Scope, args: &[&str]) -> Result<String, String> {
        self.log
            .borrow_mut()
            .push(format!("systemctl {} {}", scope.name(), args.join(" ")));
        match args.first().copied() {
            Some("stop") => {
                *self.active.borrow_mut() = false;
                *self.main_pid.borrow_mut() = None;
                self.holders.borrow_mut().clear();
            }
            Some("start" | "restart") => {
                *self.active.borrow_mut() = true;
                *self.main_pid.borrow_mut() = Some(4242);
            }
            Some("show") => {
                return Ok(format!(
                    "ActiveState={}\nUnitFileState={}\nMainPID={}\nDropInPaths={}\n",
                    if *self.active.borrow() {
                        "active"
                    } else {
                        "inactive"
                    },
                    if self.enabled { "enabled" } else { "disabled" },
                    self.main_pid.borrow().unwrap_or(0),
                    if self.drop_ins {
                        "/etc/systemd/system/omnigateway.service.d/x.conf"
                    } else {
                        ""
                    }
                ));
            }
            _ => {}
        }
        Ok(String::new())
    }
    fn holders(&self, _db: &Path) -> Vec<u32> {
        self.holders.borrow().clone()
    }
    fn process_exe(&self, _pid: u32) -> Option<PathBuf> {
        self.running_exe.borrow().clone()
    }
    fn healthy(&self, base: &str) -> bool {
        self.log.borrow_mut().push(format!("health {base}"));
        self.healthy
    }
    fn backup(&self, db: &Path) -> Result<String, String> {
        self.log
            .borrow_mut()
            .push(format!("backup {}", db.display()));
        if self.fail_backup {
            Err("disk full".into())
        } else {
            Ok("db_2026-11-21T00-00-00-000Z_preRust.sqlite".into())
        }
    }
    fn preflight_db(&self, _db: &Path) -> Result<(), String> {
        if self.low_disk {
            Err("not enough free disk space for the backup".into())
        } else {
            Ok(())
        }
    }
    fn euid_root(&self) -> bool {
        self.euid_root
    }
    fn binary_trusted(&self, _binary: &Path) -> bool {
        self.trusted_binary
    }
    fn run_gateway(&self, binary: &Path, root: &Path) -> Result<Child, String> {
        self.log
            .borrow_mut()
            .push(format!("spawn {} in {}", binary.display(), root.display()));
        Ok(Child::Fake(self.spawned_code))
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
    fn record(&self) -> Value {
        serde_json::from_str(&fs::read_to_string(self.paths().state.join(RECORD)).unwrap()).unwrap()
    }
}

const SINGLE: &str = "OMNI_ENCRYPTION_KEY=kkkkkkkkkkkkkkkkkkkk\nOMNI_PORT=19100\n";

fn running_ts() -> Fake {
    Fake {
        active: RefCell::new(true),
        enabled: true,
        main_pid: RefCell::new(Some(777)),
        holders: RefCell::new(vec![777]),
        healthy: true,
        trusted_binary: true,
        ..Fake::default()
    }
}

#[test]
fn legacy_user_service_migrates_in_order_and_keeps_operator_lines() {
    let f = fixture(SINGLE);
    let extra = "StandardOutput=append:/var/log/omni.log\n";
    f.write_user(&legacy_unit(&f.root, extra));
    let host = running_ts();
    let outcome = migrate(&host, &f.paths(), 1_000);
    assert_eq!(outcome.status, Status::Migrated, "{}", outcome.message);
    let log = host.log.borrow().clone();
    let at = |needle: &str| {
        log.iter()
            .position(|l| l.starts_with(needle))
            .unwrap_or_else(|| panic!("{needle} missing from {log:?}"))
    };
    assert!(at("systemctl user stop") < at("backup"));
    assert!(at("backup") < at("systemctl user daemon-reload"));
    assert!(at("systemctl user daemon-reload") < at("systemctl user start"));
    assert!(at("systemctl user start") < at("health"));
    assert!(log.contains(&"health http://127.0.0.1:19100".to_owned()));
    let unit = fs::read_to_string(&f.user_unit).unwrap();
    assert_eq!(
        unit,
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
    assert_eq!(record["version"], "1.0.0");
}

#[test]
fn inactive_legacy_service_is_rewritten_but_not_started() {
    let f = fixture(SINGLE);
    f.write_user(&legacy_unit(&f.root, ""));
    let host = Fake {
        trusted_binary: true,
        healthy: true,
        ..Fake::default()
    };
    let outcome = migrate(&host, &f.paths(), 1);
    assert_eq!(outcome.status, Status::Migrated);
    let log = host.log.borrow();
    assert!(
        !log.iter()
            .any(|l| l.contains(" start") || l.starts_with("health"))
    );
    assert!(log.iter().any(|l| l.starts_with("backup")));
}

#[test]
fn cluster_installation_is_left_running_untouched() {
    for env in [
        "OMNI_DATABASE_URL=postgres://x/y\n",
        "OMNI_REDIS_URL=redis://x\n",
        "OMNI_CLUSTER_MODE=true\n",
    ] {
        let f = fixture(env);
        f.write_user(&legacy_unit(&f.root, ""));
        let host = running_ts();
        let outcome = migrate(&host, &f.paths(), 1);
        assert_eq!(outcome.status, Status::SkippedCluster, "{env}");
        assert!(
            host.log.borrow().iter().all(|l| l.contains(" show ")),
            "{:?}",
            host.log
        );
        assert_eq!(
            fs::read_to_string(&f.user_unit).unwrap(),
            legacy_unit(&f.root, "")
        );
    }
}

#[test]
fn unrecognised_units_are_refused() {
    let f = fixture(SINGLE);
    let checkout =
        legacy_unit(&f.root, "").replace(GATEWAY_JS, "/src/omnigateway/apps/gateway/src/index.ts");
    for (text, drop_ins) in [
        (checkout, false),
        (
            legacy_unit(&f.root, "ExecStartPre=/bin/true\nExecStart=/bin/other\n"),
            false,
        ),
        (
            legacy_unit(&f.root, "").replace("EnvironmentFile=", "EnvironmentFile=/elsewhere"),
            false,
        ),
        (legacy_unit(&f.root, ""), true),
    ] {
        f.write_user(&text);
        let host = Fake {
            drop_ins,
            ..running_ts()
        };
        let outcome = migrate(&host, &f.paths(), 1);
        assert_eq!(outcome.status, Status::SkippedUnit, "{text}");
        assert!(!host.log.borrow().iter().any(|l| l.contains(" stop")));
        assert_eq!(fs::read_to_string(&f.user_unit).unwrap(), text);
    }
}

#[test]
fn both_scopes_are_refused() {
    let f = fixture(SINGLE);
    f.write_user(&legacy_unit(&f.root, ""));
    fs::create_dir_all(f.system_unit.parent().unwrap()).unwrap();
    fs::write(&f.system_unit, legacy_unit(&f.root, "")).unwrap();
    let host = running_ts();
    assert_eq!(migrate(&host, &f.paths(), 1).status, Status::SkippedUnit);
    assert!(host.log.borrow().is_empty());
}

#[test]
fn another_writer_blocks_before_stop() {
    let f = fixture(SINGLE);
    f.write_user(&legacy_unit(&f.root, ""));
    let host = running_ts();
    host.holders.borrow_mut().push(9001);
    let outcome = migrate(&host, &f.paths(), 1);
    assert_eq!(outcome.status, Status::SkippedWriter);
    assert!(outcome.message.contains("9001"));
    assert!(!host.log.borrow().iter().any(|l| l.contains(" stop")));
}

#[test]
fn system_scope_needs_root_and_a_root_owned_binary() {
    for (root, trusted) in [(false, true), (true, false)] {
        let f = fixture(SINGLE);
        fs::create_dir_all(f.system_unit.parent().unwrap()).unwrap();
        fs::write(&f.system_unit, legacy_unit(&f.root, "")).unwrap();
        let host = Fake {
            euid_root: root,
            trusted_binary: trusted,
            ..running_ts()
        };
        let outcome = migrate(&host, &f.paths(), 1);
        assert_eq!(outcome.status, Status::SkippedPrivilege);
        assert!(outcome.message.contains("sudo"));
        assert!(!host.log.borrow().iter().any(|l| l.contains(" stop")));
    }
    let f = fixture(SINGLE);
    fs::create_dir_all(f.system_unit.parent().unwrap()).unwrap();
    fs::write(&f.system_unit, legacy_unit(&f.root, "")).unwrap();
    let host = Fake {
        euid_root: true,
        ..running_ts()
    };
    assert_eq!(migrate(&host, &f.paths(), 1).status, Status::Migrated);
    assert!(
        host.log
            .borrow()
            .iter()
            .any(|l| l == "systemctl system stop omnigateway.service")
    );
}

#[test]
fn low_disk_is_refused_before_stop() {
    let f = fixture(SINGLE);
    f.write_user(&legacy_unit(&f.root, ""));
    let host = Fake {
        low_disk: true,
        ..running_ts()
    };
    assert_eq!(
        migrate(&host, &f.paths(), 1).status,
        Status::SkippedDatabase
    );
    assert!(!host.log.borrow().iter().any(|l| l.contains(" stop")));
}

#[test]
fn failed_backup_leaves_service_stopped_and_unit_untouched() {
    let f = fixture(SINGLE);
    f.write_user(&legacy_unit(&f.root, ""));
    let host = Fake {
        fail_backup: true,
        ..running_ts()
    };
    let outcome = migrate(&host, &f.paths(), 1);
    assert_eq!(outcome.status, Status::FailedBackup);
    assert!(outcome.message.contains("npm i -g omnigateway@0.15.5"));
    assert_eq!(
        fs::read_to_string(&f.user_unit).unwrap(),
        legacy_unit(&f.root, "")
    );
    assert!(!*host.active.borrow());
    assert_eq!(f.record()["status"], "failed-backup");
}

#[test]
fn unhealthy_rust_is_stopped_and_rollback_is_printed() {
    let f = fixture(SINGLE);
    f.write_user(&legacy_unit(&f.root, ""));
    let host = Fake {
        healthy: false,
        ..running_ts()
    };
    let outcome = migrate(&host, &f.paths(), 1);
    assert_eq!(outcome.status, Status::FailedStart);
    let log = host.log.borrow();
    assert_eq!(
        log.last().unwrap(),
        "systemctl user stop omnigateway.service"
    );
    for step in [
        "npm i -g omnigateway@0.15.5",
        "omni db restore db_2026-11-21T00-00-00-000Z_preRust.sqlite",
        "omni service install --force",
        "journalctl --user -u omnigateway.service",
    ] {
        assert!(
            outcome.message.contains(step),
            "{step}: {}",
            outcome.message
        );
    }
    assert_eq!(f.record()["status"], "failed-start");
}

#[test]
fn migrated_unit_with_current_binary_is_a_no_op() {
    let f = fixture(SINGLE);
    f.write_user(&legacy_unit(&f.root, ""));
    migrate(&running_ts(), &f.paths(), 1);
    let host = running_ts();
    *host.running_exe.borrow_mut() = Some(f.binary.clone());
    let outcome = migrate(&host, &f.paths(), 2);
    assert_eq!(outcome.status, Status::Current);
    assert!(host.log.borrow().iter().all(|l| l.contains(" show ")));
}

#[test]
fn replaced_binary_restarts_an_active_rust_service() {
    let f = fixture(SINGLE);
    f.write_user(&legacy_unit(&f.root, ""));
    migrate(&running_ts(), &f.paths(), 1);
    let host = running_ts();
    *host.running_exe.borrow_mut() =
        Some(PathBuf::from(format!("{} (deleted)", f.binary.display())));
    let outcome = migrate(&host, &f.paths(), 2);
    assert_eq!(outcome.status, Status::Restarted, "{}", outcome.message);
    let log = host.log.borrow();
    assert!(
        log.iter()
            .any(|l| l == "systemctl user restart omnigateway.service")
    );
    assert!(!log.iter().any(|l| l.starts_with("backup")));
}

#[test]
fn replaced_binary_failing_health_names_the_previous_version() {
    let f = fixture(SINGLE);
    f.write_user(&legacy_unit(&f.root, ""));
    let first = Paths {
        version: "1.0.0".into(),
        ..f.paths()
    };
    migrate(&running_ts(), &first, 1);
    let host = Fake {
        healthy: false,
        ..running_ts()
    };
    *host.running_exe.borrow_mut() = Some(PathBuf::from("/old/omnigateway (deleted)"));
    let next = Paths {
        version: "1.0.1".into(),
        ..f.paths()
    };
    let outcome = migrate(&host, &next, 2);
    assert_eq!(outcome.status, Status::FailedStart);
    assert!(
        outcome.message.contains("npm i -g omnigateway@1.0.0"),
        "{}",
        outcome.message
    );
}

#[test]
fn no_service_records_nothing_and_banner_stays_quiet() {
    let f = fixture(SINGLE);
    let outcome = migrate(&Fake::default(), &f.paths(), 1);
    assert_eq!(outcome.status, Status::NothingToMigrate);
    assert_eq!(banner(&f.paths()), None);
}

#[test]
fn banner_reports_failures_and_pending_legacy_units() {
    let f = fixture(SINGLE);
    f.write_user(&legacy_unit(&f.root, ""));
    let pending = banner(&f.paths()).unwrap();
    assert!(pending.contains("omni service migrate"), "{pending}");
    migrate(
        &Fake {
            healthy: false,
            ..running_ts()
        },
        &f.paths(),
        1,
    );
    let failed = banner(&f.paths()).unwrap();
    assert!(failed.contains("failed"), "{failed}");
    migrate(&running_ts(), &f.paths(), 2);
    assert_eq!(banner(&f.paths()), None);
}

#[test]
fn bridge_migrates_without_stopping_and_runs_the_gateway() {
    let f = fixture(SINGLE);
    f.write_user(&legacy_unit(&f.root, ""));
    // systemd started gateway.js: the bridge is the unit's MainPID and TS is gone.
    let host = Fake {
        active: RefCell::new(true),
        main_pid: RefCell::new(Some(std::process::id())),
        holders: RefCell::new(vec![]),
        healthy: true,
        trusted_binary: true,
        spawned_code: 0,
        ..Fake::default()
    };
    let code = bridge(&host, &f.paths(), 1);
    assert_eq!(code, 0);
    let log = host.log.borrow();
    assert!(
        !log.iter()
            .any(|l| l.contains(" stop") || l.contains(" start")),
        "{log:?}"
    );
    let spawn = log.iter().position(|l| l.starts_with("spawn")).unwrap();
    let backup = log.iter().position(|l| l.starts_with("backup")).unwrap();
    assert!(backup < spawn);
    assert!(
        fs::read_to_string(&f.user_unit)
            .unwrap()
            .contains(&f.binary.display().to_string())
    );
    assert_eq!(f.record()["status"], "migrated");
}

#[test]
fn bridge_refusal_exits_zero_so_systemd_does_not_loop() {
    let f = fixture("OMNI_DATABASE_URL=postgres://x/y\n");
    f.write_user(&legacy_unit(&f.root, ""));
    let host = running_ts();
    assert_eq!(bridge(&host, &f.paths(), 1), 0);
    assert!(!host.log.borrow().iter().any(|l| l.starts_with("spawn")));
    let none = fixture(SINGLE);
    assert_eq!(bridge(&Fake::default(), &none.paths(), 1), 1);
}

/// Every other command stays byte-identical to the frozen CLI on stderr.
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

//! `omni service migrate`: moves a 0.x (TS) systemd service onto the Rust
//! binary npm just installed, and restarts an already-migrated service whose
//! binary npm replaced. Design: `docs/superpowers/specs/2026-11-21-rust-npm-distribution-design.md`.
//!
//! Every side effect goes through [`Host`], so tests never touch systemd, a
//! real process or the network.
use serde_json::{Value, json};
use std::{
    fs,
    path::{Path, PathBuf},
    time::Duration,
};

/// The last TS release: rollback target and the Windows version.
pub(crate) const LAST_TS_VERSION: &str = "0.15.5";
pub(crate) const RECORD: &str = "npm-migration.json";
const UNIT_NAME: &str = "omnigateway.service";

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Scope {
    User,
    System,
}
impl Scope {
    #[cfg(test)]
    pub(crate) fn name(self) -> &'static str {
        match self {
            Self::User => "user",
            Self::System => "system",
        }
    }
    fn flag(self) -> &'static str {
        match self {
            Self::User => " --user",
            Self::System => "",
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Status {
    NothingToMigrate,
    Migrated,
    Current,
    Restarted,
    SkippedCluster,
    SkippedUnit,
    SkippedWriter,
    SkippedPrivilege,
    SkippedDatabase,
    FailedBackup,
    FailedStart,
}
impl Status {
    fn name(self) -> &'static str {
        match self {
            Self::NothingToMigrate => "nothing-to-migrate",
            Self::Migrated => "migrated",
            Self::Current => "current",
            Self::Restarted => "restarted",
            Self::SkippedCluster => "skipped-cluster",
            Self::SkippedUnit => "skipped-unit",
            Self::SkippedWriter => "skipped-writer",
            Self::SkippedPrivilege => "skipped-privilege",
            Self::SkippedDatabase => "skipped-database",
            Self::FailedBackup => "failed-backup",
            Self::FailedStart => "failed-start",
        }
    }
    /// Outcomes the CLI keeps announcing until a later run clears them.
    fn needs_attention(name: &str) -> bool {
        name.starts_with("failed-") || name.starts_with("skipped-")
    }
}

pub(crate) struct Outcome {
    pub(crate) status: Status,
    pub(crate) message: String,
}

/// Where things are. Production values come from [`Paths::current`].
pub(crate) struct Paths {
    pub(crate) user_unit: PathBuf,
    pub(crate) system_unit: PathBuf,
    pub(crate) state: PathBuf,
    /// The platform package's `omnigateway`, canonical.
    pub(crate) binary: PathBuf,
    pub(crate) version: String,
}
impl Paths {
    /// `None` when no `omnigateway` sits beside this CLI (a standalone build).
    pub(crate) fn current() -> Option<Self> {
        let env = omni_control::config::process_env();
        Some(Self {
            user_unit: crate::service::unit(&std::collections::HashMap::new()),
            system_unit: crate::service::unit(&std::collections::HashMap::from([(
                "system".to_owned(),
                "true".to_owned(),
            )])),
            state: crate::service::state_in(&env),
            binary: crate::service::gateway()?,
            version: option_env!("OMNI_CLI_VERSION")
                .unwrap_or("0.0.0-dev")
                .to_owned(),
        })
    }
}

pub(crate) enum Child {
    Real(std::process::Child),
    #[cfg(test)]
    Fake(i32),
}
impl Child {
    fn wait(self) -> i32 {
        match self {
            Self::Real(mut child) => child.wait().ok().and_then(|s| s.code()).unwrap_or(1),
            #[cfg(test)]
            Self::Fake(code) => code,
        }
    }
    fn kill(self) {
        match self {
            Self::Real(mut child) => {
                let _killed = child.kill();
                let _reaped = child.wait();
            }
            #[cfg(test)]
            Self::Fake(_) => {}
        }
    }
}

pub(crate) trait Host {
    /// `systemctl [--user] <args>`; stdout on success.
    fn systemctl(&self, scope: Scope, args: &[&str]) -> Result<String, String>;
    /// PIDs holding `db` (or its `-wal`/`-shm`) open.
    fn holders(&self, db: &Path) -> Vec<u32>;
    fn process_exe(&self, pid: u32) -> Option<PathBuf>;
    /// `/health` answers 2xx within the deadline.
    fn healthy(&self, base: &str) -> bool;
    /// Space and readability checks before anything is stopped.
    fn preflight_db(&self, db: &Path) -> Result<(), String>;
    /// The `preRust` snapshot; returns its id.
    fn backup(&self, db: &Path) -> Result<String, String>;
    fn euid_root(&self) -> bool;
    /// Root-owned and not group/other writable, up to `/`.
    fn binary_trusted(&self, binary: &Path) -> bool;
    fn run_gateway(&self, binary: &Path, root: &Path) -> Result<Child, String>;
}

struct Unit {
    scope: Scope,
    path: PathBuf,
    text: String,
}

enum Kind {
    Legacy { root: PathBuf },
    Rust { root: PathBuf },
    Unknown(String),
}

fn exec_starts(text: &str) -> Vec<&str> {
    text.lines()
        .filter_map(|l| l.strip_prefix("ExecStart="))
        .collect()
}
fn directive<'a>(text: &'a str, key: &str) -> Option<&'a str> {
    let mut found = text
        .lines()
        .filter_map(|l| l.strip_prefix(key)?.strip_prefix('='));
    let first = found.next()?;
    found.next().is_none().then_some(first)
}

fn classify(text: &str, binary: &Path) -> Kind {
    let execs = exec_starts(text);
    let [exec] = execs.as_slice() else {
        return Kind::Unknown("the unit does not have exactly one ExecStart".into());
    };
    let Some(root) = directive(text, "WorkingDirectory") else {
        return Kind::Unknown("the unit has no single WorkingDirectory".into());
    };
    if directive(text, "EnvironmentFile") != Some(&format!("{root}/.env")) {
        return Kind::Unknown("EnvironmentFile is not <WorkingDirectory>/.env".into());
    }
    let root = PathBuf::from(root);
    if !root.is_absolute() {
        return Kind::Unknown("WorkingDirectory is not absolute".into());
    }
    if Path::new(exec) == binary {
        return Kind::Rust { root };
    }
    let parts: Vec<&str> = exec.split(' ').collect();
    if let [bun, script] = parts.as_slice()
        && bun.starts_with('/')
        && script.starts_with('/')
        && script.ends_with("/node_modules/omnigateway/gateway.js")
    {
        let package = script.trim_end_matches("/gateway.js");
        if text.matches(package).count() == 1 {
            return Kind::Legacy { root };
        }
        return Kind::Unknown("another line names the old package directory".into());
    }
    Kind::Unknown(format!("ExecStart={exec} is not a unit this updater wrote"))
}

fn show(
    host: &dyn Host,
    scope: Scope,
) -> Result<std::collections::HashMap<String, String>, String> {
    let out = host.systemctl(
        scope,
        &[
            "show",
            UNIT_NAME,
            "--property=ActiveState,UnitFileState,MainPID,DropInPaths",
        ],
    )?;
    Ok(out
        .lines()
        .filter_map(|l| l.split_once('='))
        .map(|(k, v)| (k.to_owned(), v.to_owned()))
        .collect())
}

fn find_units(paths: &Paths) -> Vec<Unit> {
    [
        (Scope::User, &paths.user_unit),
        (Scope::System, &paths.system_unit),
    ]
    .into_iter()
    .filter_map(|(scope, path)| {
        Some(Unit {
            scope,
            path: path.clone(),
            text: fs::read_to_string(path).ok()?,
        })
    })
    .collect()
}

/// `OMNI_HOST`/`OMNI_PORT` from the root `.env`, never `OMNI_BASE_URL`, which
/// may name a public proxy rather than this process.
fn local_base(env: &std::collections::HashMap<String, String>) -> String {
    let host = env
        .get("OMNI_HOST")
        .map(|h| h.trim())
        .filter(|h| !h.is_empty())
        .unwrap_or("127.0.0.1");
    let host = match host {
        "0.0.0.0" | "::" | "[::]" => "127.0.0.1",
        h if h.contains(':') && !h.starts_with('[') => {
            return format!("http://[{h}]:{}", port(env));
        }
        h => h,
    };
    format!("http://{host}:{}", port(env))
}
fn port(env: &std::collections::HashMap<String, String>) -> String {
    env.get("OMNI_PORT")
        .map(|p| p.trim().to_owned())
        .filter(|p| !p.is_empty())
        .unwrap_or_else(|| "9000".into())
}

fn database_path(root: &Path, env: &std::collections::HashMap<String, String>) -> PathBuf {
    crate::context::absolute(
        root,
        env.get("OMNI_DB_PATH")
            .map(|p| p.trim())
            .filter(|p| !p.is_empty())
            .unwrap_or("omnigateway.db"),
    )
}

fn clustered(env: &std::collections::HashMap<String, String>) -> bool {
    let set = |k: &str| env.get(k).is_some_and(|v| !v.trim().is_empty());
    set("OMNI_DATABASE_URL")
        || set("OMNI_REDIS_URL")
        || env
            .get("OMNI_CLUSTER_MODE")
            .is_some_and(|v| matches!(v.trim(), "true" | "1"))
}

fn record(paths: &Paths, now: i64, status: Status, extra: Value) {
    let mut value = json!({
        "status": status.name(),
        "at": now,
        "version": paths.version,
        "binary": paths.binary,
    });
    if let (Some(target), Some(extra)) = (value.as_object_mut(), extra.as_object()) {
        target.extend(extra.clone());
    }
    let file = paths.state.join(RECORD);
    let temp = paths.state.join(format!("{RECORD}.tmp"));
    let written = fs::create_dir_all(&paths.state)
        .and_then(|()| fs::write(&temp, format!("{value:#}\n")))
        .and_then(|()| fs::rename(&temp, &file));
    if let Err(e) = written {
        eprintln!("could not write {}: {e}", file.display());
    }
}

fn previous_record(paths: &Paths) -> Option<Value> {
    serde_json::from_str(&fs::read_to_string(paths.state.join(RECORD)).ok()?).ok()
}

fn outcome(paths: &Paths, now: i64, status: Status, message: String, extra: Value) -> Outcome {
    let mut extra = extra;
    if let Some(obj) = extra.as_object_mut() {
        obj.insert("message".into(), json!(message));
    }
    record(paths, now, status, extra);
    Outcome { status, message }
}

fn rollback_steps(scope: Scope, backup: &str) -> String {
    let system = if scope == Scope::System {
        " --system"
    } else {
        ""
    };
    let sudo = if scope == Scope::System { "sudo " } else { "" };
    format!(
        "To go back to the TS gateway:\n  {sudo}npm i -g omnigateway@{LAST_TS_VERSION}\n  omni db restore {backup}\n  {sudo}omni service install --force{system}\n  {sudo}systemctl{} start {UNIT_NAME}\nRows written after the migration are lost by the restore.",
        scope.flag()
    )
}

fn rewrite_exec(unit: &Unit, binary: &Path) -> Result<(), String> {
    let mut out = String::with_capacity(unit.text.len());
    for line in unit.text.split_inclusive('\n') {
        if line.starts_with("ExecStart=") {
            out.push_str(&format!("ExecStart={}\n", binary.display()));
        } else {
            out.push_str(line);
        }
    }
    let temp = unit.path.with_extension("service.omni-tmp");
    fs::write(&temp, out)
        .and_then(|()| fs::rename(&temp, &unit.path))
        .map_err(|e| format!("could not rewrite {}: {e}", unit.path.display()))
}

/// What the migration looked at before deciding.
struct Plan<'a> {
    unit: &'a Unit,
    root: PathBuf,
    env: std::collections::HashMap<String, String>,
    db: PathBuf,
}

/// Every refusal that must happen before anything is stopped.
fn preflight<'a>(
    host: &dyn Host,
    paths: &Paths,
    units: &'a [Unit],
) -> Result<(Plan<'a>, Kind), (Status, String)> {
    let unit = match units {
        [] => return Err((Status::NothingToMigrate, String::new())),
        [unit] => unit,
        _ => {
            return Err((
                Status::SkippedUnit,
                format!(
                    "both {} and {} exist; migrate one by hand (omni service install --force [--system]) and remove the other",
                    paths.user_unit.display(),
                    paths.system_unit.display()
                ),
            ));
        }
    };
    let kind = classify(&unit.text, &paths.binary);
    let root = match &kind {
        Kind::Legacy { root } | Kind::Rust { root } => root.clone(),
        Kind::Unknown(why) => {
            return Err((
                Status::SkippedUnit,
                format!(
                    "{} was left alone: {why}. Point its ExecStart at {} by hand.",
                    unit.path.display(),
                    paths.binary.display()
                ),
            ));
        }
    };
    let env = fs::read_to_string(root.join(".env"))
        .map(|t| crate::context::parse_env(&t))
        .unwrap_or_default();
    if clustered(&env) {
        return Err((
            Status::SkippedCluster,
            format!(
                "{} serves a cluster (Postgres/Redis); cluster nodes are never migrated automatically. Follow the cluster section of docs/rust-cutover-runbook.md.",
                root.display()
            ),
        ));
    }
    let facts = show(host, unit.scope).map_err(|e| (Status::SkippedUnit, e))?;
    if facts
        .get("DropInPaths")
        .is_some_and(|d| !d.trim().is_empty())
    {
        return Err((
            Status::SkippedUnit,
            format!(
                "{} has drop-ins ({}); migrate it by hand.",
                unit.path.display(),
                facts["DropInPaths"].trim()
            ),
        ));
    }
    if unit.scope == Scope::System && (!host.euid_root() || !host.binary_trusted(&paths.binary)) {
        return Err((
            Status::SkippedPrivilege,
            format!(
                "the system service runs as root, so it can only be migrated by root onto a root-owned binary. Install omnigateway as root (sudo npm i -g omnigateway) and run: sudo {} omni service migrate",
                paths.binary.display()
            ),
        ));
    }
    let db = database_path(&root, &env);
    Ok((
        Plan {
            unit,
            root,
            env,
            db,
        },
        kind,
    ))
}

fn active(facts: &std::collections::HashMap<String, String>) -> bool {
    facts.get("ActiveState").is_some_and(|s| s == "active")
}
fn main_pid(facts: &std::collections::HashMap<String, String>) -> Option<u32> {
    facts
        .get("MainPID")
        .and_then(|p| p.trim().parse().ok())
        .filter(|p| *p != 0)
}

fn foreign_writers(host: &dyn Host, db: &Path, allowed: &[u32]) -> Vec<u32> {
    let mut found: Vec<u32> = host
        .holders(db)
        .into_iter()
        .filter(|p| !allowed.contains(p))
        .collect();
    found.sort_unstable();
    found.dedup();
    found
}

pub(crate) fn migrate(host: &dyn Host, paths: &Paths, now: i64) -> Outcome {
    let units = find_units(paths);
    let (plan, kind) = match preflight(host, paths, &units) {
        Ok(found) => found,
        Err((Status::NothingToMigrate, _)) => {
            return outcome(
                paths,
                now,
                Status::NothingToMigrate,
                "no omnigateway systemd service to migrate".into(),
                json!({}),
            );
        }
        Err((status, message)) => return outcome(paths, now, status, message, json!({})),
    };
    let scope = plan.unit.scope;
    let facts = match show(host, scope) {
        Ok(f) => f,
        Err(e) => return outcome(paths, now, Status::SkippedUnit, e, json!({})),
    };
    if let Kind::Rust { .. } = kind {
        return refresh(host, paths, &plan, &facts, now);
    }
    let was_active = active(&facts);
    let allowed: Vec<u32> = main_pid(&facts).into_iter().collect();
    let writers = foreign_writers(host, &plan.db, &allowed);
    if !writers.is_empty() {
        return outcome(
            paths,
            now,
            Status::SkippedWriter,
            format!(
                "{} is open in process {} besides the service; stop it, then run omni service migrate",
                plan.db.display(),
                writers
                    .iter()
                    .map(u32::to_string)
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
            json!({}),
        );
    }
    if let Err(e) = host.preflight_db(&plan.db) {
        return outcome(paths, now, Status::SkippedDatabase, e, json!({}));
    }
    if was_active {
        if let Err(e) = host.systemctl(scope, &["stop", UNIT_NAME]) {
            return outcome(paths, now, Status::SkippedUnit, e, json!({}));
        }
        if let Err(e) = wait_stopped(host, scope, &plan.db) {
            return outcome(
                paths,
                now,
                Status::FailedBackup,
                format!(
                    "{e}. The TS service was stopped and could not be confirmed idle; nothing was changed. {}",
                    rollback_steps(scope, "(none taken)")
                ),
                json!({}),
            );
        }
    }
    convert(host, paths, &plan, was_active, now, None)
}

fn wait_stopped(host: &dyn Host, scope: Scope, db: &Path) -> Result<(), String> {
    for _ in 0..50 {
        let facts = show(host, scope)?;
        if !active(&facts) && main_pid(&facts).is_none() && host.holders(db).is_empty() {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    Err("the old gateway still holds the database after stop".into())
}

/// Backup, save the old unit, rewrite it, and start Rust (by systemd, or as
/// the bridge's child when `bridge` is set).
fn convert(
    host: &dyn Host,
    paths: &Paths,
    plan: &Plan<'_>,
    start: bool,
    now: i64,
    bridge: Option<&mut Option<Child>>,
) -> Outcome {
    let scope = plan.unit.scope;
    let backup = match host.backup(&plan.db) {
        Ok(id) => id,
        Err(e) => {
            return outcome(
                paths,
                now,
                Status::FailedBackup,
                format!(
                    "could not back up {}: {e}. The service is stopped and the database is unchanged; free space or fix the error, then run omni service migrate.\n{}",
                    plan.db.display(),
                    rollback_steps(scope, "(no backup was taken; nothing to restore)")
                ),
                json!({"unit": plan.unit.path}),
            );
        }
    };
    let saved = paths.state.join("pre-rust").join(UNIT_NAME);
    let kept = fs::create_dir_all(paths.state.join("pre-rust"))
        .and_then(|()| fs::write(&saved, &plan.unit.text));
    let fail = |message: String| {
        outcome(
            paths,
            now,
            Status::FailedStart,
            message,
            json!({"backup": backup, "unit": plan.unit.path, "savedUnit": saved}),
        )
    };
    if let Err(e) = kept {
        return fail(format!(
            "could not save the old unit to {}: {e}",
            saved.display()
        ));
    }
    if let Err(e) = rewrite_exec(plan.unit, &paths.binary) {
        return fail(e);
    }
    if let Err(e) = host.systemctl(scope, &["daemon-reload"]) {
        return fail(format!("systemctl daemon-reload failed: {e}"));
    }
    let base = local_base(&plan.env);
    let failed = |why: &str| {
        format!(
            "{why}. The service is left stopped; see journalctl{} -u {UNIT_NAME}.\nBackup: {backup}\n{}",
            scope.flag(),
            rollback_steps(scope, &backup)
        )
    };
    if let Some(slot) = bridge {
        match host.run_gateway(&paths.binary, &plan.root) {
            Ok(child) => {
                if !host.healthy(&base) {
                    child.kill();
                    return fail(failed(
                        "the Rust gateway did not answer /health within 30 s",
                    ));
                }
                *slot = Some(child);
            }
            Err(e) => return fail(failed(&format!("could not start the Rust gateway: {e}"))),
        }
    } else if start {
        if let Err(e) = host.systemctl(scope, &["start", UNIT_NAME]) {
            return fail(failed(&format!("systemctl start failed: {e}")));
        }
        if !host.healthy(&base) {
            let _stopped = host.systemctl(scope, &["stop", UNIT_NAME]);
            return fail(failed(
                "the Rust gateway did not answer /health within 30 s",
            ));
        }
    }
    outcome(
        paths,
        now,
        Status::Migrated,
        format!(
            "migrated {} to the Rust gateway {} ({}).\nBackup: {backup}\nOld unit saved at {}.\nRun omni doctor to see accounts and plugins this release does not serve.",
            plan.unit.path.display(),
            paths.version,
            paths.binary.display(),
            saved.display()
        ),
        json!({"backup": backup, "unit": plan.unit.path, "savedUnit": saved}),
    )
}

/// Rust → Rust: restart an active service whose binary npm replaced.
fn refresh(
    host: &dyn Host,
    paths: &Paths,
    plan: &Plan<'_>,
    facts: &std::collections::HashMap<String, String>,
    now: i64,
) -> Outcome {
    let scope = plan.unit.scope;
    // The version this service ran before npm replaced it: the recorded one,
    // or, when this version was already recorded, the one recorded before it.
    let previous = previous_record(paths).and_then(|r| {
        let recorded = r["version"].as_str()?.to_owned();
        if recorded == paths.version {
            r["previousVersion"].as_str().map(str::to_owned)
        } else {
            Some(recorded)
        }
    });
    let keep = |status: Status, message: String| {
        let mut extra = json!({"unit": plan.unit.path});
        if let Some(previous) = &previous {
            extra["previousVersion"] = json!(previous);
        }
        outcome(paths, now, status, message, extra)
    };
    let Some(pid) = main_pid(facts).filter(|_| active(facts)) else {
        return keep(
            Status::Current,
            format!(
                "{} already runs the Rust gateway; it is not active",
                plan.unit.path.display()
            ),
        );
    };
    if host.process_exe(pid).is_some_and(|exe| exe == paths.binary) {
        return keep(
            Status::Current,
            format!(
                "{} already runs {}",
                plan.unit.path.display(),
                paths.binary.display()
            ),
        );
    }
    if let Err(e) = host.systemctl(scope, &["restart", UNIT_NAME]) {
        return keep(
            Status::FailedStart,
            format!("systemctl restart failed: {e}"),
        );
    }
    if host.healthy(&local_base(&plan.env)) {
        return keep(
            Status::Restarted,
            format!("restarted {UNIT_NAME} on omnigateway {}", paths.version),
        );
    }
    let _stopped = host.systemctl(scope, &["stop", UNIT_NAME]);
    let back = previous.as_deref().unwrap_or("<the previous version>");
    let sudo = if scope == Scope::System { "sudo " } else { "" };
    keep(
        Status::FailedStart,
        format!(
            "omnigateway {} did not answer /health within 30 s; the service is left stopped. See journalctl{} -u {UNIT_NAME}.\nTo go back: {sudo}npm i -g omnigateway@{back} && {sudo}systemctl{} start {UNIT_NAME}",
            paths.version,
            scope.flag(),
            scope.flag()
        ),
    )
}

/// `gateway.js` started by a 0.x unit: migrate in place, then run Rust as
/// this process's child. Refusals exit 0 so `Restart=on-failure` stops.
pub(crate) fn bridge(host: &dyn Host, paths: &Paths, now: i64) -> i32 {
    let units = find_units(paths);
    let (plan, kind) = match preflight(host, paths, &units) {
        Ok(found) => found,
        Err((Status::NothingToMigrate, _)) => {
            eprintln!(
                "gateway.js is the 0.x → Rust migration bridge, run by an old omnigateway systemd unit. No such unit was found; start the gateway with: omni start"
            );
            return 1;
        }
        Err((status, message)) => {
            eprintln!("{message}");
            outcome(paths, now, status, message, json!({}));
            return 0;
        }
    };
    if let Kind::Rust { .. } = kind {
        // Already migrated; the old file path is being run by hand.
        eprintln!(
            "{} already runs the Rust gateway; gateway.js is only a migration bridge",
            plan.unit.path.display()
        );
        return 0;
    }
    let me = std::process::id();
    let mut allowed = vec![me];
    if let Ok(facts) = show(host, plan.unit.scope)
        && let Some(pid) = main_pid(&facts)
    {
        allowed.push(pid);
    }
    let writers = foreign_writers(host, &plan.db, &allowed);
    if !writers.is_empty() {
        let message = format!(
            "{} is open in process {}; the service was not migrated and is left stopped",
            plan.db.display(),
            writers
                .iter()
                .map(u32::to_string)
                .collect::<Vec<_>>()
                .join(", ")
        );
        eprintln!("{message}");
        outcome(paths, now, Status::SkippedWriter, message, json!({}));
        return 0;
    }
    if let Err(e) = host.preflight_db(&plan.db) {
        eprintln!("{e}");
        outcome(paths, now, Status::SkippedDatabase, e, json!({}));
        return 0;
    }
    let mut child = None;
    let result = convert(host, paths, &plan, false, now, Some(&mut child));
    eprintln!("{}", result.message);
    match child {
        Some(child) if result.status == Status::Migrated => child.wait(),
        _ => 0,
    }
}

/// The commands an operator checks a service with. Only they print the
/// banner; every other command's stderr stays identical to the frozen CLI.
pub(crate) fn announces(command: &str) -> bool {
    matches!(command, "doctor" | "status")
}

/// One stderr line while a migration needs attention, or a 0.x unit is
/// still installed. `None` when there is nothing to say.
pub(crate) fn banner(paths: &Paths) -> Option<String> {
    if let Some(record) = previous_record(paths)
        && let Some(status) = record["status"].as_str()
        && Status::needs_attention(status)
    {
        let file = paths.state.join(RECORD);
        return Some(format!(
            "omnigateway: the npm migration to the Rust gateway {} ({status}); see {} or run omni service migrate",
            if status.starts_with("failed-") {
                "failed"
            } else {
                "did not run"
            },
            file.display()
        ));
    }
    find_units(paths)
        .iter()
        .any(|u| matches!(classify(&u.text, &paths.binary), Kind::Legacy { .. }))
        .then(|| {
            "omnigateway: an old 0.x systemd service is still installed; run omni service migrate (or restart the service) to move it to the Rust gateway".to_owned()
        })
}

pub(crate) mod host;
const HELP: &str = "Usage: omni service migrate [--json]

Move a 0.x (TS) omnigateway systemd service onto this Rust gateway: stop it,
back up the database to snapshots/db_<time>_preRust.sqlite, point the unit's
ExecStart at this binary, start it and check /health. An already-migrated
service whose binary was replaced by an npm update is restarted. Cluster
installations, customised units and other writers are left alone.

The npm package runs this after install (--from-npm), and the old unit's
gateway.js runs it on the service's next start (--bridge).
";

/// `omni service migrate [--from-npm|--bridge] [--json]`.
pub(crate) fn command(flags: &[String]) -> std::process::ExitCode {
    use std::process::ExitCode;
    if flags.iter().any(|f| f == "--help" || f == "-h") {
        print!("{HELP}");
        return ExitCode::SUCCESS;
    }
    if let Some(bad) = flags
        .iter()
        .find(|f| !matches!(f.as_str(), "--from-npm" | "--bridge" | "--json"))
    {
        eprintln!("unknown option for omni service migrate: {bad}\n{HELP}");
        return ExitCode::from(2);
    }
    let from_npm = flags.iter().any(|f| f == "--from-npm");
    let json_output = flags.iter().any(|f| f == "--json");
    let now = chrono::Utc::now().timestamp_millis();
    let Some(paths) = Paths::current() else {
        eprintln!("omni service migrate needs the omnigateway binary beside this CLI");
        return if from_npm {
            ExitCode::SUCCESS
        } else {
            ExitCode::FAILURE
        };
    };
    if flags.iter().any(|f| f == "--bridge") {
        let code = bridge(&host::System, &paths, now);
        return ExitCode::from(u8::try_from(code).unwrap_or(1));
    }
    if !cfg!(target_os = "linux") {
        return ExitCode::SUCCESS;
    }
    let result = migrate(&host::System, &paths, now);
    if json_output {
        println!(
            "{:#}",
            json!({"status": result.status.name(), "message": result.message})
        );
    } else if result.status != Status::NothingToMigrate || !from_npm {
        eprintln!("{}", result.message);
    }
    if from_npm || !Status::needs_attention(result.status.name()) {
        ExitCode::SUCCESS
    } else {
        ExitCode::FAILURE
    }
}

#[cfg(test)]
mod tests;

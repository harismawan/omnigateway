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
    SkippedBinary,
    SkippedForeground,
    FailedWriter,
    FailedPort,
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
            Self::SkippedBinary => "skipped-binary",
            Self::SkippedForeground => "skipped-foreground",
            Self::FailedWriter => "failed-writer",
            Self::FailedPort => "failed-port",
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

/// The Rust gateway the bridge started, owned by this process.
pub(crate) enum Child {
    Real(std::process::Child),
    #[cfg(test)]
    Fake {
        pid: u32,
        code: i32,
        exited_early: bool,
    },
}
impl Child {
    fn pid(&self) -> u32 {
        match self {
            Self::Real(child) => child.id(),
            #[cfg(test)]
            Self::Fake { pid, .. } => *pid,
        }
    }
    /// Still running (it did not exit while we waited for /health).
    fn running(&mut self) -> bool {
        match self {
            Self::Real(child) => matches!(child.try_wait(), Ok(None)),
            #[cfg(test)]
            Self::Fake { exited_early, .. } => !*exited_early,
        }
    }
    fn kill(self) {
        match self {
            Self::Real(mut child) => {
                let _killed = child.kill();
                let _reaped = child.wait();
            }
            #[cfg(test)]
            Self::Fake { .. } => {}
        }
    }
    pub(crate) fn into_real(self) -> Option<std::process::Child> {
        match self {
            Self::Real(child) => Some(child),
            #[cfg(test)]
            Self::Fake { .. } => None,
        }
    }
    #[cfg(test)]
    pub(crate) fn wait_fake(self) -> i32 {
        match self {
            Self::Fake { code, .. } => code,
            Self::Real(_) => unreachable!(),
        }
    }
}

/// An SQLite exclusive lock on the database: proof that no other connection,
/// from any user or through any link, has it open (`BEGIN EXCLUSIVE` under
/// `locking_mode=EXCLUSIVE` fails while one does, and holds every later
/// opener off until released).
pub(crate) enum Lock {
    Real(rusqlite::Connection),
    #[cfg(test)]
    Fake,
}
impl Lock {
    pub(crate) fn connection(&self) -> Option<&rusqlite::Connection> {
        match self {
            Self::Real(conn) => Some(conn),
            #[cfg(test)]
            Self::Fake => None,
        }
    }
    pub(crate) fn into_connection(self) -> Option<rusqlite::Connection> {
        match self {
            Self::Real(conn) => Some(conn),
            #[cfg(test)]
            Self::Fake => None,
        }
    }
}

pub(crate) trait Host {
    /// `systemctl [--user] <args>`; stdout on success.
    fn systemctl(&self, scope: Scope, args: &[&str]) -> Result<String, String>;
    /// PIDs `/proc` shows holding `db` (or its `-wal`/`-shm`/`-journal`).
    /// Best effort; the exclusive lock is the proof.
    fn holders(&self, db: &Path) -> Vec<u32>;
    fn lock_exclusive(&self, db: &Path) -> Result<Lock, String>;
    fn release(&self, lock: Lock);
    fn process_exe(&self, pid: u32) -> Option<PathBuf>;
    fn sleep(&self, duration: Duration);
    /// `/health` answers 2xx within the deadline.
    fn healthy(&self, base: &str) -> bool;
    /// Anything answers on `base` right now (one quick probe).
    fn answers_now(&self, base: &str) -> bool;
    /// The process holding the listening TCP socket on `port`, if visible.
    fn listener_pid(&self, port: u16) -> Option<u32>;
    /// A child of `parent` whose executable is (or was, `(deleted)`) `binary`.
    fn native_child(&self, parent: u32, binary: &Path) -> Option<(u32, PathBuf)>;
    /// Free space and writability of the snapshot directory, a readable
    /// ledger this build knows. Nothing is stopped yet.
    fn preflight_db(&self, db: &Path, snapshots: &Path) -> Result<(), String>;
    /// The binary executes (`omni --version`).
    fn binary_runs(&self, binary: &Path) -> bool;
    /// The `preRust` snapshot, taken through the held lock; returns its id.
    fn backup(&self, lock: &Lock, db: &Path) -> Result<String, String>;
    fn euid_root(&self) -> bool;
    /// Root-owned and not group/other writable, up to `/`.
    fn binary_trusted(&self, binary: &Path) -> bool;
    /// A live `omni start` gateway in the CLI's pidfile, if any.
    fn foreground_gateway(&self, state: &Path) -> Option<u32>;
    /// This process descends from `main_pid` (systemd started the bridge).
    fn bridge_invoked_by(&self, main_pid: u32) -> bool;
    fn run_gateway(&self, binary: &Path, root: &Path) -> Result<Child, String>;
}

type Facts = std::collections::HashMap<String, String>;

struct Unit {
    scope: Scope,
    path: PathBuf,
    text: String,
}

#[derive(PartialEq)]
enum Kind {
    Legacy,
    Rust,
}

/// What the migration checked before deciding: the unit as systemd loaded it,
/// and the configuration the service will run with.
struct Plan {
    unit: Unit,
    kind: Kind,
    root: PathBuf,
    env: std::collections::HashMap<String, String>,
    db: PathBuf,
    facts: Facts,
}

fn show(host: &dyn Host, scope: Scope, properties: &str) -> Result<Facts, String> {
    let out = host.systemctl(
        scope,
        &["show", UNIT_NAME, &format!("--property={properties}")],
    )?;
    Ok(out
        .lines()
        .filter_map(|l| l.split_once('='))
        .map(|(k, v)| (k.to_owned(), v.to_owned()))
        .collect())
}
const ALL_FACTS: &str = "ActiveState,UnitFileState,MainPID,DropInPaths,FragmentPath,NeedDaemonReload,Environment,EnvironmentFiles,WorkingDirectory,ExecStart";

fn active(facts: &Facts) -> bool {
    facts.get("ActiveState").is_some_and(|s| s == "active")
}
fn stopped(facts: &Facts) -> bool {
    facts
        .get("ActiveState")
        .is_some_and(|s| s == "inactive" || s == "failed")
        && main_pid(facts).is_none()
}
fn main_pid(facts: &Facts) -> Option<u32> {
    facts
        .get("MainPID")
        .and_then(|p| p.trim().parse().ok())
        .filter(|p| *p != 0)
}
/// `ExecStart={ path=… ; argv[]=a b c ; … }` → the argv words.
fn loaded_argv(facts: &Facts) -> Option<Vec<String>> {
    let exec = facts.get("ExecStart")?;
    let argv = exec.split(" argv[]=").nth(1)?.split(" ; ").next()?;
    Some(argv.split(' ').map(str::to_owned).collect())
}

/// Every line is a section header or `Key=Value` with nothing around `=`, and
/// the keys are exactly the template's. Values are the TS template's except
/// `Description`, `WorkingDirectory`/`EnvironmentFile`, `ExecStart` and the
/// operator additions systemd treats as output wiring.
fn template_shape(text: &str) -> Result<(String, String), String> {
    const FIXED: &[(&str, &str)] = &[
        ("After", "network-online.target"),
        ("Wants", "network-online.target"),
        ("Type", "simple"),
        ("Restart", "on-failure"),
        ("RestartSec", "2"),
        ("WantedBy", "default.target"),
    ];
    const ALLOWED: &[&str] = &["StandardOutput", "StandardError"];
    let mut seen = std::collections::HashMap::new();
    let mut section = "";
    for line in text.lines() {
        if line.is_empty() || line.starts_with('#') || line.starts_with(';') {
            continue;
        }
        if let Some(name) = line.strip_prefix('[').and_then(|l| l.strip_suffix(']')) {
            if !matches!(name, "Unit" | "Service" | "Install") {
                return Err(format!("section [{name}] is not in the template"));
            }
            section = name;
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            return Err("a line is not Key=Value".into());
        };
        if key.is_empty() || key.trim() != key || value.trim() != value || line.ends_with('\\') {
            return Err(format!(
                "the {} line is not in the template's form",
                key.trim()
            ));
        }
        let expected_section = match key {
            "Description" | "After" | "Wants" => "Unit",
            "WantedBy" => "Install",
            _ => "Service",
        };
        if section != expected_section {
            return Err(format!("{key} is not where the template puts it"));
        }
        let allowed = matches!(
            key,
            "Description" | "WorkingDirectory" | "EnvironmentFile" | "ExecStart"
        ) || ALLOWED.contains(&key)
            || FIXED.iter().any(|(k, v)| *k == key && *v == value);
        if !allowed {
            return Err(format!(
                "{key}= is not in the template, or has a value the template does not"
            ));
        }
        if seen.insert(key, value).is_some() {
            return Err(format!("{key} appears twice"));
        }
    }
    for key in ["WorkingDirectory", "EnvironmentFile", "ExecStart"]
        .into_iter()
        .chain(FIXED.iter().map(|(k, _)| *k))
    {
        if !seen.contains_key(key) {
            return Err(format!("{key} is missing"));
        }
    }
    let root = seen["WorkingDirectory"].to_owned();
    if seen["EnvironmentFile"] != format!("{root}/.env") {
        return Err("EnvironmentFile is not <WorkingDirectory>/.env".into());
    }
    if !Path::new(&root).is_absolute() {
        return Err("WorkingDirectory is not absolute".into());
    }
    Ok((root, seen["ExecStart"].to_owned()))
}

fn classify(text: &str, binary: &Path) -> Result<(Kind, PathBuf), String> {
    let (root, exec) = template_shape(text)?;
    if Path::new(&exec) == binary {
        return Ok((Kind::Rust, PathBuf::from(root)));
    }
    if let [interpreter, script] = exec.split(' ').collect::<Vec<_>>().as_slice()
        && text.matches(script.trim_end_matches("/gateway.js")).count() == 1
        && interpreter.starts_with('/')
        && Path::new(interpreter)
            .file_name()
            .is_some_and(|n| n == "bun")
        && script.starts_with('/')
        && script.ends_with("/node_modules/omnigateway/gateway.js")
    {
        return Ok((Kind::Legacy, PathBuf::from(root)));
    }
    let _ = exec;
    Err("its ExecStart is not one this updater wrote".into())
}

/// The two paths the TS CLI wrote. A path that exists but cannot be read
/// (permissions, not UTF-8, a directory) is a refusal, never "absent".
fn find_units(paths: &Paths) -> Result<Vec<Unit>, String> {
    let mut found = vec![];
    for (scope, path) in [
        (Scope::User, &paths.user_unit),
        (Scope::System, &paths.system_unit),
    ] {
        match fs::read_to_string(path) {
            Ok(text) => found.push(Unit {
                scope,
                path: path.clone(),
                text,
            }),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(format!("cannot read {}: {e}", path.display())),
        }
    }
    Ok(found)
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
fn port_number(env: &std::collections::HashMap<String, String>) -> u16 {
    port(env).parse().unwrap_or(9000)
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
            .is_some_and(|v| !matches!(v.trim(), "" | "false" | "0"))
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
    // The last version known to have run healthy survives every attempt.
    let running =
        previous_record(paths).and_then(|r| r["runningVersion"].as_str().map(str::to_owned));
    if let Some(obj) = extra.as_object_mut() {
        obj.insert("message".into(), json!(message));
        if !obj.contains_key("runningVersion")
            && let Some(running) = running
        {
            obj.insert("runningVersion".into(), json!(running));
        }
    }
    record(paths, now, status, extra);
    Outcome { status, message }
}

fn sudo(scope: Scope) -> &'static str {
    if scope == Scope::System { "sudo " } else { "" }
}

/// Back to TS. `backup` is `None` when nothing was changed (no restore step);
/// `saved` is the original unit to copy back when it was rewritten.
fn rollback_steps(plan: &Plan, backup: Option<&str>, saved: Option<&Path>) -> String {
    let scope = plan.unit.scope;
    let s = sudo(scope);
    let mut steps = vec![format!("{s}npm i -g omnigateway@{LAST_TS_VERSION}")];
    if let Some(backup) = backup {
        steps.push(format!(
            "omni db restore --root {} {backup}",
            plan.root.display()
        ));
    }
    if let Some(saved) = saved {
        steps.push(format!(
            "{s}cp {} {}",
            saved.display(),
            plan.unit.path.display()
        ));
    }
    steps.push(format!("{s}systemctl{} daemon-reload", scope.flag()));
    steps.push(format!("{s}systemctl{} start {UNIT_NAME}", scope.flag()));
    let mut text = format!("To go back to the TS gateway:\n  {}", steps.join("\n  "));
    if backup.is_some() {
        text.push_str("\nRows written after the migration are lost by the restore.");
    }
    text
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

/// Every refusal that must happen before anything is stopped. `Err` carries
/// the status to record; `NothingToMigrate` means there is no unit.
fn preflight(host: &dyn Host, paths: &Paths) -> Result<Plan, (Status, String)> {
    let unit = match find_units(paths).map_err(|e| (Status::SkippedUnit, e))? {
        units if units.is_empty() => {
            return Err(match host.foreground_gateway(&paths.state) {
                Some(pid) => (
                    Status::SkippedForeground,
                    format!(
                        "a gateway started with `omni start` is running (pid {pid}); it is not a service, so it was left alone. Stop it with `omni stop`, then run `omni start` again to use the Rust gateway."
                    ),
                ),
                None => (Status::NothingToMigrate, String::new()),
            });
        }
        mut units if units.len() == 1 => units.remove(0),
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
    let left_alone = |why: String| {
        (
            Status::SkippedUnit,
            format!(
                "{} was left alone: {why}. Point its ExecStart at {} by hand.",
                unit.path.display(),
                paths.binary.display()
            ),
        )
    };
    let (kind, root) = classify(&unit.text, &paths.binary).map_err(&left_alone)?;
    // The unit as systemd has it loaded must be this file, unchanged, with no
    // configuration beyond the file and `<root>/.env`.
    let facts = show(host, unit.scope, ALL_FACTS).map_err(|e| (Status::SkippedUnit, e))?;
    let fragment = facts
        .get("FragmentPath")
        .map(String::as_str)
        .unwrap_or_default();
    if Path::new(fragment) != unit.path {
        return Err(left_alone(format!(
            "systemd loaded {UNIT_NAME} from {fragment:?}"
        )));
    }
    // Every fact must be present: a missing one is not evidence of anything.
    for key in [
        "ActiveState",
        "MainPID",
        "NeedDaemonReload",
        "WorkingDirectory",
        "ExecStart",
    ] {
        if !facts.contains_key(key) {
            return Err(left_alone(format!("systemd did not report {key}")));
        }
    }
    if !matches!(
        facts["ActiveState"].as_str(),
        "active" | "inactive" | "failed"
    ) {
        return Err(left_alone(format!(
            "it is {}; run this again once it has settled",
            facts["ActiveState"]
        )));
    }
    if Path::new(&facts["WorkingDirectory"]) != root {
        return Err(left_alone(
            "the WorkingDirectory systemd loaded differs from the file".into(),
        ));
    }
    if facts.get("NeedDaemonReload").is_some_and(|v| v != "no") {
        return Err(left_alone(
            "the file changed since systemd loaded it (run systemctl daemon-reload)".into(),
        ));
    }
    if let Some(drop_ins) = facts.get("DropInPaths").filter(|d| !d.trim().is_empty()) {
        return Err(left_alone(format!("it has drop-ins ({})", drop_ins.trim())));
    }
    if facts
        .get("Environment")
        .is_some_and(|e| !e.trim().is_empty())
    {
        return Err(left_alone("systemd sets Environment= for it".into()));
    }
    let env_file = root.join(".env");
    if facts.get("EnvironmentFiles").map(String::as_str)
        != Some(format!("{} (ignore_errors=no)", env_file.display()).as_str())
    {
        return Err(left_alone(format!(
            "its environment files are not exactly {}",
            env_file.display()
        )));
    }
    let expected_argv: Vec<String> = match kind {
        Kind::Rust => vec![paths.binary.display().to_string()],
        Kind::Legacy => template_shape(&unit.text)
            .map(|(_, exec)| exec.split(' ').map(str::to_owned).collect())
            .unwrap_or_default(),
    };
    if loaded_argv(&facts).as_ref() != Some(&expected_argv) {
        return Err(left_alone(
            "the ExecStart systemd loaded differs from the file".into(),
        ));
    }
    // The user manager's own environment reaches the service too.
    if unit.scope == Scope::User {
        let manager = host
            .systemctl(unit.scope, &["show-environment"])
            .map_err(|e| {
                left_alone(format!(
                    "cannot read the service manager's environment: {e}"
                ))
            })?;
        let names: Vec<&str> = manager
            .lines()
            .filter_map(|l| l.split_once('=').map(|(k, _)| k))
            .filter(|k| k.starts_with("OMNI_"))
            .collect();
        if !names.is_empty() {
            return Err(left_alone(format!(
                "the user service manager exports {} to it",
                names.join(", ")
            )));
        }
    }
    let text = fs::read_to_string(&env_file)
        .map_err(|e| left_alone(format!("cannot read {}: {e}", env_file.display())))?;
    // systemd joins a line ending in `\` with the next; the CLI does not, so
    // the two would read different values.
    if text.lines().any(|l| l.trim_end().ends_with('\\')) {
        return Err(left_alone(format!(
            "{} continues a line with \\, which the CLI reads differently from systemd",
            env_file.display()
        )));
    }
    let env = crate::context::parse_env(&text);
    if clustered(&env) {
        return Err((
            Status::SkippedCluster,
            format!(
                "{} serves a cluster (Postgres/Redis); cluster nodes are never migrated automatically. Follow the cluster section of docs/rust-cutover-runbook.md.",
                root.display()
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
    Ok(Plan {
        unit,
        kind,
        root,
        env,
        db,
        facts,
    })
}

fn snapshots_dir(db: &Path) -> PathBuf {
    db.parent()
        .unwrap_or_else(|| Path::new("."))
        .join("snapshots")
}

/// Checks that need the database but stop nothing: other visible holders,
/// the snapshot destination, the ledger, the binary.
fn preflight_data(
    host: &dyn Host,
    paths: &Paths,
    plan: &Plan,
    allowed: &[u32],
) -> Result<(), (Status, String)> {
    let mut others: Vec<u32> = host
        .holders(&plan.db)
        .into_iter()
        .filter(|p| !allowed.contains(p))
        .collect();
    others.sort_unstable();
    others.dedup();
    if !others.is_empty() {
        return Err((
            Status::SkippedWriter,
            format!(
                "{} is open in process {} besides the service; stop it, then run omni service migrate",
                plan.db.display(),
                others
                    .iter()
                    .map(u32::to_string)
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
        ));
    }
    host.preflight_db(&plan.db, &snapshots_dir(&plan.db))
        .map_err(|e| (Status::SkippedDatabase, e))?;
    if !host.binary_runs(&paths.binary) {
        return Err((
            Status::SkippedBinary,
            format!(
                "{} does not run on this host; reinstall omnigateway",
                paths.binary.display()
            ),
        ));
    }
    Ok(())
}

/// Stop, then confirm through systemd that it stopped.
fn stop_confirmed(host: &dyn Host, scope: Scope) -> Result<(), String> {
    host.systemctl(scope, &["stop", UNIT_NAME])?;
    for _ in 0..50 {
        if stopped(&show(host, scope, "ActiveState,MainPID")?) {
            return Ok(());
        }
        host.sleep(Duration::from_millis(100));
    }
    Err(format!("systemd does not report {UNIT_NAME} stopped"))
}

/// After `/health` answered: the answering socket belongs to `pid`, `pid`
/// runs this binary, and nothing but `pid` has the database open.
fn serving_is(host: &dyn Host, plan: &Plan, pid: u32, binary: &Path) -> Result<(), String> {
    if host.process_exe(pid).is_none_or(|e| e != binary) {
        return Err(format!("process {pid} is not {}", binary.display()));
    }
    let port = port_number(&plan.env);
    match host.listener_pid(port) {
        Some(owner) if owner == pid => {}
        Some(owner) => {
            return Err(format!(
                "port {port} is held by process {owner}, not the gateway"
            ));
        }
        None => {
            return Err(format!(
                "no listener on port {port} could be attributed to the gateway"
            ));
        }
    }
    let others: Vec<String> = host
        .holders(&plan.db)
        .into_iter()
        .filter(|p| *p != pid)
        .map(|p| p.to_string())
        .collect();
    if !others.is_empty() {
        return Err(format!(
            "{} is also open in process {} besides the gateway",
            plan.db.display(),
            others.join(", ")
        ));
    }
    Ok(())
}

/// The systemd-started gateway, checked as [`serving_is`].
fn started_is_ours(host: &dyn Host, plan: &Plan, binary: &Path) -> Result<(), String> {
    let facts = show(host, plan.unit.scope, "ActiveState,MainPID")?;
    match main_pid(&facts).filter(|_| active(&facts)) {
        Some(pid) => serving_is(host, plan, pid, binary),
        None => Err(format!("{UNIT_NAME} is not running after start")),
    }
}

/// With TS stopped, nothing may answer on the gateway's port: a server there
/// would answer the health check in Rust's place.
fn port_free(host: &dyn Host, plan: &Plan) -> Result<(), String> {
    let base = local_base(&plan.env);
    if host.answers_now(&base) {
        Err(format!(
            "something still answers on {base} with the old gateway stopped"
        ))
    } else {
        Ok(())
    }
}

pub(crate) fn migrate(host: &dyn Host, paths: &Paths, now: i64) -> Outcome {
    let plan = match preflight(host, paths) {
        Ok(plan) => plan,
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
    if plan.kind == Kind::Rust {
        return refresh(host, paths, &plan, now);
    }
    let scope = plan.unit.scope;
    let was_active = active(&plan.facts);
    let allowed: Vec<u32> = main_pid(&plan.facts).into_iter().collect();
    if let Err((status, message)) = preflight_data(host, paths, &plan, &allowed) {
        return outcome(paths, now, status, message, json!({}));
    }
    // From here TS cannot be started again (npm replaced its files): every
    // failure leaves the service stopped and says how to go back.
    if was_active && let Err(e) = stop_confirmed(host, scope) {
        return outcome(
            paths,
            now,
            Status::FailedWriter,
            format!(
                "{e}. Nothing was changed.\n{}",
                rollback_steps(&plan, None, None)
            ),
            json!({}),
        );
    }
    if let Err(e) = port_free(host, &plan) {
        return outcome(
            paths,
            now,
            Status::FailedPort,
            format!(
                "{e}; the service is stopped and nothing was changed. Stop whatever listens there, then run omni service migrate.\n{}",
                rollback_steps(&plan, None, None)
            ),
            json!({}),
        );
    }
    let lock = match host.lock_exclusive(&plan.db) {
        Ok(lock) => lock,
        Err(e) => {
            return outcome(
                paths,
                now,
                Status::FailedWriter,
                format!(
                    "another process still has {} open ({e}); the service is stopped and nothing was changed. Stop that process, then run omni service migrate.\n{}",
                    plan.db.display(),
                    rollback_steps(&plan, None, None)
                ),
                json!({}),
            );
        }
    };
    convert(host, paths, &plan, lock, was_active, now).0
}

/// Under the held lock: back up, save and rewrite the unit, reload; then
/// release and start Rust (by systemd unless `bridge`). Returns the bridge's
/// child when it started one.
fn convert(
    host: &dyn Host,
    paths: &Paths,
    plan: &Plan,
    lock: Lock,
    start: bool,
    now: i64,
) -> (Outcome, Option<Child>) {
    convert_as(
        host,
        paths,
        plan,
        lock,
        if start {
            Starter::Systemd
        } else {
            Starter::None
        },
        now,
    )
}

#[derive(PartialEq)]
enum Starter {
    None,
    Systemd,
    Bridge,
}

fn convert_as(
    host: &dyn Host,
    paths: &Paths,
    plan: &Plan,
    lock: Lock,
    starter: Starter,
    now: i64,
) -> (Outcome, Option<Child>) {
    let scope = plan.unit.scope;
    let backup = match host.backup(&lock, &plan.db) {
        Ok(id) => id,
        Err(e) => {
            host.release(lock);
            return (
                outcome(
                    paths,
                    now,
                    Status::FailedBackup,
                    format!(
                        "could not back up {}: {e}. The service is stopped and nothing was changed; fix the error, then run omni service migrate.\n{}",
                        plan.db.display(),
                        rollback_steps(plan, None, None)
                    ),
                    json!({"unit": plan.unit.path}),
                ),
                None,
            );
        }
    };
    let saved = paths.state.join("pre-rust").join(UNIT_NAME);
    let extra = json!({"backup": backup, "unit": plan.unit.path, "savedUnit": saved});
    let journal = format!("journalctl{} -u {UNIT_NAME}", scope.flag());
    let s = sudo(scope);
    // `stopped` is whether the service is confirmed not running; only then
    // does the message say so.
    let fail_as = |why: String, rewritten: bool, stopped: bool| {
        let state = if stopped {
            "The service is left stopped".to_owned()
        } else {
            format!(
                "The service could not be confirmed stopped: run {s}systemctl{} stop {UNIT_NAME} first",
                scope.flag()
            )
        };
        outcome(
            paths,
            now,
            Status::FailedStart,
            format!(
                "{why}. {state}; see {journal}.\nBackup: {backup}\n{}",
                rollback_steps(plan, Some(&backup), rewritten.then_some(saved.as_path()))
            ),
            extra.clone(),
        )
    };
    let fail = |why: String, rewritten: bool| fail_as(why, rewritten, true);
    if let Err(e) = fs::create_dir_all(paths.state.join("pre-rust"))
        .and_then(|()| fs::write(&saved, &plan.unit.text))
    {
        host.release(lock);
        return (
            fail(
                format!("could not save the old unit to {}: {e}", saved.display()),
                false,
            ),
            None,
        );
    }
    if let Err(e) = rewrite_exec(&plan.unit, &paths.binary) {
        host.release(lock);
        return (fail(e, false), None);
    }
    if let Err(e) = host.systemctl(scope, &["daemon-reload"]) {
        host.release(lock);
        return (
            fail(format!("systemctl daemon-reload failed: {e}"), true),
            None,
        );
    }
    host.release(lock);
    let base = local_base(&plan.env);
    let health = "the Rust gateway did not answer /health within 30 s";
    let mut child = None;
    match starter {
        Starter::None => {}
        Starter::Bridge => match host.run_gateway(&paths.binary, &plan.root) {
            Ok(mut started) => {
                let verdict = if !host.healthy(&base) {
                    Err(health.to_owned())
                } else if !started.running() {
                    Err("the Rust gateway exited during startup".to_owned())
                } else {
                    serving_is(host, plan, started.pid(), &paths.binary)
                };
                if let Err(why) = verdict {
                    started.kill();
                    return (fail(why, true), None);
                }
                child = Some(started);
            }
            Err(e) => {
                return (
                    fail(format!("could not start the Rust gateway: {e}"), true),
                    None,
                );
            }
        },
        Starter::Systemd => {
            let verdict = match host.systemctl(scope, &["start", UNIT_NAME]) {
                Err(e) => Err(format!("systemctl start failed: {e}")),
                Ok(_) if !host.healthy(&base) => Err(health.to_owned()),
                Ok(_) => started_is_ours(host, plan, &paths.binary),
            };
            if let Err(why) = verdict {
                return match stop_confirmed(host, scope) {
                    Ok(()) => (fail(why, true), None),
                    Err(e) => (
                        fail_as(format!("{why} (stopping it: {e})"), true, false),
                        None,
                    ),
                };
            }
        }
    }
    let mut done = extra.clone();
    if starter != Starter::None {
        done["runningVersion"] = json!(paths.version);
    }
    (
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
            done,
        ),
        child,
    )
}

/// Rust → Rust: restart an active service only on positive evidence that npm
/// replaced its binary. A recorded failure is kept until the service is seen
/// running this binary.
fn refresh(host: &dyn Host, paths: &Paths, plan: &Plan, now: i64) -> Outcome {
    let scope = plan.unit.scope;
    let previous = previous_record(paths);
    let last_good = previous
        .as_ref()
        .and_then(|r| r["runningVersion"].as_str().map(str::to_owned));
    let mut extra = json!({"unit": plan.unit.path});
    // A failure's recovery details (backup, saved unit) survive later runs.
    let pending_failure = previous.as_ref().filter(|r| {
        r["status"]
            .as_str()
            .is_some_and(|s| s.starts_with("failed-"))
    });
    if let Some(failure) = pending_failure {
        for key in ["backup", "savedUnit"] {
            if let Some(v) = failure.get(key).filter(|v| !v.is_null()) {
                extra[key] = v.clone();
            }
        }
    }
    let running = main_pid(&plan.facts).filter(|_| active(&plan.facts));
    let Some(pid) = running else {
        if let Some(failure) = pending_failure {
            return outcome(
                paths,
                now,
                Status::FailedStart,
                failure["message"].as_str().unwrap_or_default().to_owned(),
                extra,
            );
        }
        return outcome(
            paths,
            now,
            Status::Current,
            format!(
                "{} runs the Rust gateway; it is not active",
                plan.unit.path.display()
            ),
            extra,
        );
    };
    // The first bridge start leaves the launcher as MainPID and the gateway
    // as its child: judge the gateway.
    let (pid, exe) = match host.process_exe(pid) {
        Some(exe) if exe == paths.binary => (pid, Some(exe)),
        other => match host.native_child(pid, &paths.binary) {
            Some((child, exe)) => (child, Some(exe)),
            None => (pid, other),
        },
    };
    let replaced = exe.as_ref().is_some_and(|exe| {
        exe.display().to_string().ends_with(" (deleted)") || *exe != paths.binary
    });
    if !replaced {
        let verified = exe.as_ref().is_some_and(|e| *e == paths.binary);
        if verified && pending_failure.is_some() {
            // Recovered: running our binary. The failure no longer applies.
            extra["runningVersion"] = json!(paths.version);
        }
        let _ = pid;
        return outcome(
            paths,
            now,
            Status::Current,
            format!(
                "{} runs {} (no restart needed, or the running binary could not be inspected)",
                plan.unit.path.display(),
                paths.binary.display()
            ),
            extra,
        );
    }
    let s = sudo(scope);
    let back = match &last_good {
        Some(v) => format!(
            "To go back: {s}npm i -g omnigateway@{v} && {s}systemctl{} start {UNIT_NAME}",
            scope.flag()
        ),
        None => "The previous version is not recorded; reinstall the version you ran before (npm i -g omnigateway@<version>) and start the service.".into(),
    };
    let verdict = match host.systemctl(scope, &["restart", UNIT_NAME]) {
        Err(e) => Err(format!("systemctl restart failed: {e}")),
        Ok(_) if !host.healthy(&local_base(&plan.env)) => Err(format!(
            "omnigateway {} did not answer /health within 30 s",
            paths.version
        )),
        Ok(_) => started_is_ours(host, plan, &paths.binary),
    };
    let Err(mut why) = verdict else {
        let mut done = extra;
        done["runningVersion"] = json!(paths.version);
        return outcome(
            paths,
            now,
            Status::Restarted,
            format!("restarted {UNIT_NAME} on omnigateway {}", paths.version),
            done,
        );
    };
    match stop_confirmed(host, scope) {
        Ok(()) => why.push_str("; the service is left stopped"),
        Err(e) => why.push_str(&format!(
            "; it could not be confirmed stopped ({e}): run {s}systemctl{} stop {UNIT_NAME} first",
            scope.flag()
        )),
    }
    outcome(
        paths,
        now,
        Status::FailedStart,
        format!(
            "{why}. See journalctl{} -u {UNIT_NAME}.\n{back}",
            scope.flag()
        ),
        extra,
    )
}

/// What the bridge does next.
pub(crate) enum Bridge {
    /// Exit with this code (0 for every refusal, so `Restart=on-failure`
    /// does not loop).
    Exit(i32),
    /// Serve: relay signals to this child and exit with its status.
    Serve(Child),
}

/// `gateway.js` started by a 0.x unit: migrate in place under the lock, then
/// run Rust as this process's child for this one start.
pub(crate) fn bridge(host: &dyn Host, paths: &Paths, now: i64) -> Bridge {
    let refuse = |status: Status, message: String| {
        eprintln!("{message}");
        outcome(paths, now, status, message, json!({}));
        Bridge::Exit(0)
    };
    let plan = match preflight(host, paths) {
        Ok(plan) => plan,
        Err((Status::NothingToMigrate | Status::SkippedForeground, _)) => {
            eprintln!(
                "gateway.js is the 0.x → Rust migration bridge, run by an old omnigateway systemd unit. No such unit was found; start the gateway with: omni start"
            );
            return Bridge::Exit(1);
        }
        Err((status, message)) => return refuse(status, message),
    };
    if plan.kind == Kind::Rust {
        eprintln!(
            "{} already runs the Rust gateway; gateway.js is only a migration bridge",
            plan.unit.path.display()
        );
        return Bridge::Exit(0);
    }
    // Only as the unit's own start: systemd's MainPID is our ancestor.
    let Some(main) = main_pid(&plan.facts) else {
        return refuse(
            Status::SkippedUnit,
            format!(
                "systemd reports no main process for {UNIT_NAME}; the service was not migrated and is left stopped"
            ),
        );
    };
    if !host.bridge_invoked_by(main) {
        eprintln!(
            "gateway.js is the migration bridge systemd runs for {UNIT_NAME}; run `omni service migrate` instead"
        );
        return Bridge::Exit(1);
    }
    let allowed = [main, std::process::id()];
    if let Err((status, message)) = preflight_data(host, paths, &plan, &allowed) {
        return refuse(
            status,
            format!("{message}; the service was not migrated and is left stopped"),
        );
    }
    if let Err(e) = port_free(host, &plan) {
        return refuse(
            Status::FailedPort,
            format!("{e}; the service was not migrated and is left stopped"),
        );
    }
    let lock = match host.lock_exclusive(&plan.db) {
        Ok(lock) => lock,
        Err(e) => {
            return refuse(
                Status::FailedWriter,
                format!(
                    "another process has {} open ({e}); the service was not migrated and is left stopped",
                    plan.db.display()
                ),
            );
        }
    };
    let (result, child) = convert_as(host, paths, &plan, lock, Starter::Bridge, now);
    eprintln!("{}", result.message);
    match child {
        Some(child) if result.status == Status::Migrated => Bridge::Serve(child),
        _ => Bridge::Exit(0),
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
        let reason = record["message"]
            .as_str()
            .and_then(|m| m.lines().next())
            .unwrap_or_default();
        return Some(format!(
            "omnigateway: the npm migration to the Rust gateway {} ({status}): {reason}\nSee {} or run omni service migrate.",
            if status.starts_with("failed-") {
                "failed"
            } else {
                "did not run"
            },
            file.display()
        ));
    }
    find_units(paths)
        .unwrap_or_default()
        .iter()
        .any(|u| matches!(classify(&u.text, &paths.binary), Ok((Kind::Legacy, _))))
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
        return match bridge(&host::System, &paths, now) {
            Bridge::Exit(code) => ExitCode::from(u8::try_from(code).unwrap_or(1)),
            Bridge::Serve(child) => host::serve(child),
        };
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

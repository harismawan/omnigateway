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
/// The in-flight bridge handoff, in the install root (the unit's
/// `WorkingDirectory`): the verifier finds it from its working directory and
/// the operator CLI through the unit, so no environment can split them.
pub(crate) const HANDOFF: &str = "npm-handoff.json";
const UNIT_NAME: &str = "omnigateway.service";

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Scope {
    User,
    System,
}
impl Scope {
    pub(crate) fn name(self) -> &'static str {
        match self {
            Self::User => "user",
            Self::System => "system",
        }
    }
    fn parse(name: &str) -> Option<Self> {
        match name {
            "user" => Some(Self::User),
            "system" => Some(Self::System),
            _ => None,
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
    Verifying,
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
    FailedRecord,
    FailedStart,
}
impl Status {
    fn name(self) -> &'static str {
        match self {
            Self::NothingToMigrate => "nothing-to-migrate",
            Self::Verifying => "verifying",
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
            Self::FailedRecord => "failed-record",
            Self::FailedStart => "failed-start",
        }
    }
    /// Outcomes the CLI keeps announcing until a later run clears them; a
    /// handoff whose start was not (yet) verified is one.
    fn needs_attention(name: &str) -> bool {
        name.starts_with("failed-") || name.starts_with("skipped-") || name == "verifying"
    }
}

pub(crate) struct Outcome {
    pub(crate) status: Status,
    pub(crate) message: String,
    /// The record reached disk (written, synced, renamed into place).
    pub(crate) persisted: bool,
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
    /// Anything accepts a TCP connection at `addr` right now.
    fn occupied(&self, addr: std::net::SocketAddr) -> bool;
    /// The single process holding the listening socket that serves `addr`
    /// (bound to it or to its wildcard); `None` when there is none, several,
    /// or one whose owner cannot be seen.
    fn listener_pid(&self, addr: std::net::SocketAddr) -> Option<u32>;
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
        && facts.get("MainPID").is_some_and(|p| p.trim() == "0")
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
    // The bridge's one-shot verifier is ours; the rest is the template.
    let text: String = text
        .split_inclusive('\n')
        .filter(|l| parse_verifier_line(l.trim_end_matches('\n'), binary).is_none())
        .collect();
    let text = text.as_str();
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
    // The same endpoint occupancy and attribution check.
    format!("http://{}", probe_addr(env))
}
/// `OMNI_HOST` as an IP: a literal, or `localhost`; `None` for a name this
/// updater would have to resolve (and could resolve differently).
fn bind_ip(env: &std::collections::HashMap<String, String>) -> Option<std::net::IpAddr> {
    let host = env
        .get("OMNI_HOST")
        .map(|h| h.trim().trim_start_matches('[').trim_end_matches(']'))
        .filter(|h| !h.is_empty())
        .unwrap_or("127.0.0.1");
    if let Ok(ip) = host.parse() {
        return Some(ip);
    }
    if host != "localhost" {
        return None;
    }
    // The gateway binds `(host, port)`, which tries the resolver's addresses
    // in order and keeps the first that binds; with the port free, that is
    // the first one. Resolve the same way and take the same one.
    use std::net::ToSocketAddrs as _;
    ("localhost", 0)
        .to_socket_addrs()
        .ok()?
        .next()
        .map(|a| a.ip())
}
/// The address the health probe, the occupancy check and the listener
/// attribution all use: the bind IP, or loopback for a wildcard bind.
fn probe_addr(env: &std::collections::HashMap<String, String>) -> std::net::SocketAddr {
    let port: u16 = port(env).parse().unwrap_or(9000);
    let ip = match bind_ip(env) {
        Some(ip) if ip.is_unspecified() && ip.is_ipv6() => {
            std::net::IpAddr::from(std::net::Ipv6Addr::LOCALHOST)
        }
        Some(ip) if ip.is_unspecified() => std::net::IpAddr::from([127, 0, 0, 1]),
        Some(ip) => ip,
        None => std::net::IpAddr::from([127, 0, 0, 1]),
    };
    std::net::SocketAddr::new(ip, port)
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

/// `Err(line number)` for the first line outside the grammar both readers
/// agree on: empty, `#`/`;` comment, or `NAME=VALUE` (no `export`) where NAME is
/// `[A-Za-z_][A-Za-z0-9_]*` and VALUE is plain (no whitespace, quotes, `\\`,
/// `$`, backtick) or one whole single-line `"…"`/`'…'` with none of those
/// inside but spaces.
fn shared_env_grammar(text: &str) -> Result<(), usize> {
    // ASCII only, and no whitespace except the space inside a quoted value:
    // systemd trims ASCII whitespace where Rust trims Unicode, and it rejects
    // a name with `export ` in it where the CLI strips the word.
    let plain = |c: char| c.is_ascii_graphic() && !matches!(c, '"' | '\'' | '\\' | '$' | '`');
    for (i, line) in text.split('\n').enumerate() {
        if line.is_empty() || line.starts_with('#') || line.starts_with(';') {
            continue;
        }
        let Some((name, value)) = line.split_once('=') else {
            return Err(i + 1);
        };
        let mut chars = name.chars();
        let name_ok = chars
            .next()
            .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
            && chars.all(|c| c.is_ascii_alphanumeric() || c == '_');
        let value_ok = match value.chars().next() {
            Some(q @ ('"' | '\'')) => {
                value.len() >= 2
                    && value.ends_with(q)
                    && value[1..value.len() - 1]
                        .chars()
                        .all(|c| plain(c) || c == ' ')
            }
            _ => value.chars().all(plain),
        };
        if !name_ok || !value_ok {
            return Err(i + 1);
        }
    }
    Ok(())
}

fn clustered(env: &std::collections::HashMap<String, String>) -> bool {
    let set = |k: &str| env.get(k).is_some_and(|v| !v.trim().is_empty());
    set("OMNI_DATABASE_URL")
        || set("OMNI_REDIS_URL")
        || env
            .get("OMNI_CLUSTER_MODE")
            .is_some_and(|v| !matches!(v.trim(), "" | "false" | "0"))
}

fn record(paths: &Paths, now: i64, status: Status, extra: Value) -> Result<(), String> {
    use std::io::Write as _;
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
    // Per-process temp name: the verifier and an operator's run may overlap.
    let temp = paths
        .state
        .join(format!("{RECORD}.{}.tmp", std::process::id()));
    let written = fs::create_dir_all(&paths.state)
        .and_then(|()| {
            let mut out = fs::File::create(&temp)?;
            out.write_all(format!("{value:#}\n").as_bytes())?;
            out.sync_all()
        })
        .and_then(|()| fs::rename(&temp, &file))
        .and_then(|()| fs::File::open(&paths.state)?.sync_all());
    written.map_err(|e| {
        let _unlinked = fs::remove_file(&temp);
        let e = format!("could not write {}: {e}", file.display());
        eprintln!("{e}");
        e
    })
}
/// The migration record: `Ok(None)` when absent, `Err` when present but
/// unreadable, unparseable or not an object. Every reader uses this rule.
fn read_record_at(file: &Path) -> Result<Option<Value>, String> {
    let text = match fs::read_to_string(file) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("cannot read {}: {e}", file.display())),
    };
    let value: Value =
        serde_json::from_str(&text).map_err(|e| format!("cannot parse {}: {e}", file.display()))?;
    if !value.is_object() {
        return Err(format!("{} is not a migration record", file.display()));
    }
    Ok(Some(value))
}
fn read_record(paths: &Paths) -> Result<Option<Value>, String> {
    read_record_at(&paths.state.join(RECORD))
}
/// The record for callers that only add to it: an unreadable one reads as
/// absent here, and [`outcome`] refuses to overwrite it.
fn previous_record(paths: &Paths) -> Option<Value> {
    read_record(paths).ok().flatten()
}

/// The latest record as a failure summary, if it is one.
fn as_failure(record: &Value) -> Option<Value> {
    let status = record["status"].as_str()?;
    // A handoff with no verdict is unresolved: its rollback stays visible.
    let message = if status == "verifying" {
        json!(format!(
            "the Rust gateway's start after the migration has not been verified.\n{}",
            record["message"].as_str().unwrap_or_default()
        ))
    } else {
        record["message"].clone()
    };
    (status.starts_with("failed-") || status == "verifying").then(|| {
        json!({
            "status": status,
            "at": record["at"],
            "message": message,
            "backup": record["backup"],
            "savedUnit": record["savedUnit"],
            "unit": record["unit"],
            "root": record["root"],
        })
    })
}
fn has_rollback(failure: &Value) -> bool {
    failure["backup"].as_str().is_some_and(|b| !b.is_empty())
}

/// The failure later attempts must not erase, carried as `pendingFailure`:
/// the first failure that left rollback artifacts (a backup, a rewritten
/// unit), which no later failure replaces; until one exists, the latest
/// failure. An artifact-free failure never masks one with rollback.
fn pending_failure(previous: Option<&Value>) -> Option<Value> {
    let previous = previous?;
    let carried = previous
        .get("pendingFailure")
        .filter(|p| !p.is_null())
        .cloned();
    let latest = as_failure(previous);
    match (carried, latest) {
        (Some(carried), _) if has_rollback(&carried) => Some(carried),
        // Neither left artifacts: the latest says what to do now.
        (_, Some(latest)) => Some(latest),
        (carried, None) => carried,
    }
}

/// Records this attempt. The last version known to have run healthy and any
/// unresolved failure survive it; `extra["recovered"] = true` (set only when
/// the gateway is seen serving) clears the failure. When this attempt adds
/// nothing actionable but a carried failure has rollback, the top-level
/// message keeps that rollback visible too.
fn outcome(paths: &Paths, now: i64, status: Status, message: String, extra: Value) -> Outcome {
    let mut extra = extra;
    // Never replace a record we cannot read: it may hold an armed handoff
    // whose verifier would then see none and pass the next start unjudged.
    if let Err(e) = read_record(paths) {
        let message = format!(
            "{e}; it is left untouched (it may hold an unverified migration). Fix or inspect it, then run omni service migrate.\nThis attempt: {message}"
        );
        eprintln!("{message}");
        return Outcome {
            status: Status::FailedRecord,
            message,
            persisted: false,
        };
    }
    let previous = previous_record(paths);
    let running = previous
        .as_ref()
        .and_then(|r| r["runningVersion"].as_str().map(str::to_owned));
    let mut pending = pending_failure(previous.as_ref());
    // This attempt, if it failed with rollback, supersedes an artifact-free
    // failure, and a handoff's verdict supersedes the handoff itself.
    if status.name().starts_with("failed-")
        && extra["backup"].as_str().is_some_and(|b| !b.is_empty())
        && pending
            .as_ref()
            .is_none_or(|p| !has_rollback(p) || p["status"] == "verifying")
    {
        pending = None;
    }
    let mut message = message;
    if let Some(obj) = extra.as_object_mut() {
        let recovered = obj.remove("recovered").is_some_and(|v| v == true);
        if !recovered
            && let Some(p) = pending.as_ref().filter(|p| has_rollback(p))
            && !obj.get("backup").is_some_and(Value::is_string)
        {
            message.push_str(&format!(
                "\nAn earlier attempt is still unresolved:\n{}",
                p["message"].as_str().unwrap_or_default()
            ));
        }
        obj.insert("message".into(), json!(message));
        if !obj.contains_key("runningVersion")
            && let Some(running) = running
        {
            obj.insert("runningVersion".into(), json!(running));
        }
        if !recovered && let Some(pending) = pending {
            obj.insert("pendingFailure".into(), pending);
        }
    }
    let persisted = record(paths, now, status, extra).is_ok();
    Outcome {
        status,
        message,
        persisted,
    }
}

/// `path` as one POSIX shell word.
fn shq(path: &Path) -> String {
    let text = path.display().to_string();
    if !text.is_empty()
        && text
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "/._-+@:,=".contains(c))
    {
        text
    } else {
        format!("'{}'", text.replace('\'', "'\\''"))
    }
}
/// A path systemd puts in a command line verbatim: no whitespace, quoting,
/// escapes, `%` specifiers or `$` expansion.
fn systemd_plain(path: &Path) -> bool {
    path.is_absolute()
        && path
            .display()
            .to_string()
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "/._-+@".contains(c))
}

fn sudo(scope: Scope) -> &'static str {
    if scope == Scope::System { "sudo " } else { "" }
}

/// Back to TS. `backup` is `None` when nothing was changed (no restore step);
/// `saved` is the original unit to copy back when it was rewritten.
fn rollback_steps(plan: &Plan, backup: Option<&str>, saved: Option<&Path>) -> String {
    rollback_for(
        plan.unit.scope,
        &plan.root,
        &plan.db,
        &plan.unit.path,
        backup,
        saved,
    )
}
/// `db` is the database that was backed up: `--db` pins both the file the
/// restore replaces and the `snapshots/` directory beside it, whatever
/// `.env` says by the time the operator runs it.
fn rollback_for(
    scope: Scope,
    root: &Path,
    db: &Path,
    unit: &Path,
    backup: Option<&str>,
    saved: Option<&Path>,
) -> String {
    let s = sudo(scope);
    let mut steps = vec![format!("{s}npm i -g omnigateway@{LAST_TS_VERSION}")];
    if let Some(backup) = backup {
        steps.push(format!(
            "omni db restore --root {} --db {} {backup}",
            shq(root),
            shq(db)
        ));
    }
    if let Some(saved) = saved {
        steps.push(format!("{s}cp {} {}", shq(saved), shq(unit)));
    }
    if backup.is_some() {
        steps.push(format!(
            "# before starting: {} must point OMNI_DB_PATH at {}, as when it was backed up",
            shq(&root.join(".env")),
            shq(db)
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

fn rewrite_exec(unit: &Unit, binary: &Path, post: Option<&str>) -> Result<(), String> {
    let mut out = String::with_capacity(unit.text.len());
    for line in unit.text.split_inclusive('\n') {
        if line.starts_with("ExecStart=") {
            out.push_str(&format!("ExecStart={}\n", binary.display()));
            if let Some(post) = post {
                out.push_str(post);
                out.push('\n');
            }
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
    // The service manager's own environment (user manager exports, or the
    // system manager's DefaultEnvironment) reaches the service too.
    {
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
                "the {} service manager exports {} to it",
                if unit.scope == Scope::User {
                    "user"
                } else {
                    "system"
                },
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
    // The whole file must sit in the subset systemd's EnvironmentFile parser
    // and the CLI's read identically; a quote spanning lines or an escape
    // could otherwise hide or invent the assignment that picks the database.
    if let Err(line) = shared_env_grammar(&text) {
        return Err(left_alone(format!(
            "line {line} of {} uses syntax systemd may read differently from the CLI (multi-line or escaped quoting, $, \\, or a non-assignment); write plain KEY=value lines",
            env_file.display()
        )));
    }
    let env = crate::context::parse_env(&text);
    if bind_ip(&env).is_none() {
        return Err(left_alone(
            "OMNI_HOST is a host name; the updater checks one exact address, so set it to an IP"
                .into(),
        ));
    }
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

/// The binary and root go into the unit verbatim (`ExecStart=`,
/// `ExecStartPost=`, `WorkingDirectory=`); refuse anything systemd would
/// split, unquote or expand, before anything is stopped or written.
fn systemd_safe(plan: &Plan, paths: &Paths) -> Result<(), String> {
    for (what, path) in [("binary", &paths.binary), ("installation root", &plan.root)] {
        if !systemd_plain(path) {
            return Err(format!(
                "{} was left alone: the {what} path {} has characters (whitespace, quotes, %, $, \\) a unit line cannot carry verbatim; move it to a plain path and run omni service migrate",
                plan.unit.path.display(),
                shq(path)
            ));
        }
    }
    Ok(())
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
    serving_at(host, probe_addr(&plan.env), &plan.db, pid, binary)
}
fn serving_at(
    host: &dyn Host,
    addr: std::net::SocketAddr,
    db: &Path,
    pid: u32,
    binary: &Path,
) -> Result<(), String> {
    if host.process_exe(pid).is_none_or(|e| e != binary) {
        return Err(format!("process {pid} is not {}", binary.display()));
    }
    match host.listener_pid(addr) {
        Some(owner) if owner == pid => {}
        Some(owner) => {
            return Err(format!(
                "{addr} is served by process {owner}, not the gateway"
            ));
        }
        None => {
            return Err(format!(
                "the listener on {addr} could not be attributed to the gateway"
            ));
        }
    }
    let holders = host.holders(db);
    if !holders.contains(&pid) {
        return Err(format!(
            "the gateway does not have {} open, so it is not serving the database that was backed up",
            db.display()
        ));
    }
    let others: Vec<String> = holders
        .into_iter()
        .filter(|p| *p != pid)
        .map(|p| p.to_string())
        .collect();
    if !others.is_empty() {
        return Err(format!(
            "{} is also open in process {} besides the gateway",
            db.display(),
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
    let addr = probe_addr(&plan.env);
    if host.occupied(addr) {
        Err(format!(
            "something still listens on {addr} with the old gateway stopped"
        ))
    } else {
        Ok(())
    }
}

pub(crate) fn migrate(host: &dyn Host, paths: &Paths, now: i64) -> Outcome {
    // Nothing is judged, stopped or rewritten over a record we cannot read.
    if let Err(e) = read_record(paths) {
        return outcome(paths, now, Status::FailedRecord, e, json!({}));
    }
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
    if let Err(e) = systemd_safe(&plan, paths) {
        return outcome(paths, now, Status::SkippedUnit, e, json!({}));
    }
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
                "{e}; it could not be confirmed stopped. Nothing was changed. First run: {}systemctl{} stop {UNIT_NAME}\n{}",
                sudo(scope),
                scope.flag(),
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
    convert(
        host,
        paths,
        &plan,
        lock,
        if was_active {
            Starter::Systemd
        } else {
            Starter::None
        },
        now,
    )
}

#[derive(PartialEq, Clone, Copy)]
enum Starter {
    /// It was not running: leave it stopped.
    None,
    /// Start it and verify here.
    Systemd,
    /// We are the bridge, running as the unit: ask systemd to restart it and
    /// let a one-shot `ExecStartPost` verifier judge the start.
    Bridge,
}

/// The line the bridge adds so systemd runs the verifier after Rust starts.
/// It carries no path: the verifier reads the handoff in its working
/// directory, the unit's `WorkingDirectory`. `binary` is `systemd_plain`.
fn verifier_line(binary: &Path, scope: Scope) -> String {
    format!(
        "ExecStartPost={} omni service migrate --verify-start --scope {}",
        binary.display(),
        scope.name()
    )
}
/// The scope of a verifier line for `binary`, if `line` is one.
fn parse_verifier_line(line: &str, binary: &Path) -> Option<Scope> {
    let scope = line
        .strip_prefix("ExecStartPost=")?
        .strip_prefix(&binary.display().to_string())?
        .strip_prefix(" omni service migrate --verify-start --scope ")?;
    Scope::parse(scope)
}

/// Under the held lock: back up, save and rewrite the unit, reload; then
/// release and start Rust as `starter` says.
fn convert(
    host: &dyn Host,
    paths: &Paths,
    plan: &Plan,
    lock: Lock,
    starter: Starter,
    now: i64,
) -> Outcome {
    let scope = plan.unit.scope;
    let backup = match host.backup(&lock, &plan.db) {
        Ok(id) => id,
        Err(e) => {
            host.release(lock);
            return outcome(
                paths,
                now,
                Status::FailedBackup,
                format!(
                    "could not back up {}: {e}. The service is stopped and nothing was changed; fix the error, then run omni service migrate.\n{}",
                    plan.db.display(),
                    rollback_steps(plan, None, None)
                ),
                json!({"unit": plan.unit.path}),
            );
        }
    };
    let saved = paths.state.join("pre-rust").join(UNIT_NAME);
    let extra =
        json!({"backup": backup, "unit": plan.unit.path, "savedUnit": saved, "root": plan.root});
    // A handoff stays armed only when this run armed a verifier on disk.
    let failure = |why: String, rewritten: bool, stopped: bool| {
        start_failure(
            paths,
            plan,
            &backup,
            rewritten.then_some(saved.as_path()),
            why,
            Left {
                stopped,
                armed: rewritten && starter == Starter::Bridge,
            },
            now,
        )
    };
    if let Err(e) = fs::create_dir_all(paths.state.join("pre-rust"))
        .and_then(|()| fs::write(&saved, &plan.unit.text))
    {
        host.release(lock);
        return failure(
            format!("could not save the old unit to {}: {e}", saved.display()),
            false,
            true,
        );
    }
    // The bridge arms a verifier only once the handoff it judges against —
    // the database backed up, the address, the unit — is durably recorded.
    let handoff = Handoff {
        scope,
        unit: plan.unit.path.clone(),
        root: plan.root.clone(),
        db: plan.db.clone(),
        addr: probe_addr(&plan.env),
        backup: backup.clone(),
        saved: saved.clone(),
    };
    if starter == Starter::Bridge {
        // The handoff file is what arms the verifier; the state record is
        // only the operator's log of it.
        if let Err(e) = write_handoff(&handoff) {
            host.release(lock);
            return outcome(
                paths,
                now,
                Status::FailedRecord,
                format!(
                    "{e}, so the start could not be verified; the unit was not changed and the service is left stopped. Fix it, then run omni service migrate.\nBackup: {backup}"
                ),
                json!({"backup": backup, "unit": plan.unit.path, "root": plan.root}),
            );
        }
        outcome(
            paths,
            now,
            Status::Verifying,
            format!(
                "migrated {} to the Rust gateway {}; systemd is restarting it and will verify the start.\nBackup: {backup}\n{}",
                plan.unit.path.display(),
                paths.version,
                rollback_steps(plan, Some(&backup), Some(&saved))
            ),
            extra.clone(),
        );
    }
    let post = (starter == Starter::Bridge).then(|| verifier_line(&paths.binary, scope));
    if let Err(e) = rewrite_exec(&plan.unit, &paths.binary, post.as_deref()) {
        host.release(lock);
        return failure(e, false, true);
    }
    if let Err(e) = host.systemctl(scope, &["daemon-reload"]) {
        host.release(lock);
        return failure(format!("systemctl daemon-reload failed: {e}"), true, true);
    }
    host.release(lock);
    match starter {
        Starter::None => {}
        Starter::Bridge => {
            // We are this unit's main process: the restart stops us and
            // starts Rust; the armed verifier records the outcome. Nothing
            // follows the request, which may end this process at once.
            if let Err(e) = host.systemctl(scope, &["restart", "--no-block", UNIT_NAME]) {
                return failure(format!("systemctl restart failed: {e}"), true, true);
            }
            return Outcome {
                status: Status::Verifying,
                message: format!(
                    "migrated {} to the Rust gateway {}; systemd is restarting it and will verify the start.\nBackup: {backup}",
                    plan.unit.path.display(),
                    paths.version
                ),
                persisted: true,
            };
        }
        Starter::Systemd => {
            let verdict = match host.systemctl(scope, &["start", UNIT_NAME]) {
                Err(e) => Err(format!("systemctl start failed: {e}")),
                Ok(_) if !host.healthy(&local_base(&plan.env)) => Err(HEALTH.to_owned()),
                Ok(_) => started_is_ours(host, plan, &paths.binary),
            };
            if let Err(why) = verdict {
                return match stop_confirmed(host, scope) {
                    Ok(()) => failure(why, true, true),
                    Err(e) => failure(format!("{why} (stopping it: {e})"), true, false),
                };
            }
        }
    }
    let mut done = extra.clone();
    if starter != Starter::None {
        done["runningVersion"] = json!(paths.version);
        done["recovered"] = json!(true);
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
        done,
    )
}

const HEALTH: &str = "the Rust gateway did not answer /health within 30 s";

/// The service's state after a failed start.
#[derive(Clone, Copy)]
struct Left {
    /// systemd confirmed it stopped.
    stopped: bool,
    /// The unit carries an armed verifier for this run's handoff.
    armed: bool,
}

/// A failed start after the unit was (possibly) rewritten.
fn start_failure(
    paths: &Paths,
    plan: &Plan,
    backup: &str,
    saved: Option<&Path>,
    why: String,
    Left { stopped, armed }: Left,
    now: i64,
) -> Outcome {
    let scope = plan.unit.scope;
    let state = if stopped {
        "The service is left stopped".to_owned()
    } else {
        format!(
            "The service could not be confirmed stopped: run {}systemctl{} stop {UNIT_NAME} first",
            sudo(scope),
            scope.flag()
        )
    };
    let saved_unit = paths.state.join("pre-rust").join(UNIT_NAME);
    outcome(
        paths,
        now,
        Status::FailedStart,
        format!(
            "{why}. {state}; see journalctl{} -u {UNIT_NAME}.\nBackup: {backup}\n{}",
            scope.flag(),
            rollback_steps(plan, Some(backup), saved)
        ),
        {
            // A failure that did not arm a verifier leaves no handoff behind.
            if !armed {
                let _cleared = clear_handoff(&plan.root);
            }
            json!({"backup": backup, "unit": plan.unit.path, "savedUnit": saved_unit, "root": plan.root})
        },
    )
}

/// What the bridge backed up and armed a verifier for. The verifier and any
/// later recovery judge against this, never against the current `.env`.
struct Handoff {
    scope: Scope,
    unit: PathBuf,
    root: PathBuf,
    db: PathBuf,
    addr: std::net::SocketAddr,
    backup: String,
    saved: PathBuf,
}
impl Handoff {
    fn to_json(&self) -> Value {
        json!({
            "scope": self.scope.name(),
            "unit": self.unit,
            "root": self.root,
            "db": self.db,
            "addr": self.addr.to_string(),
            "backup": self.backup,
            "savedUnit": self.saved,
        })
    }
    fn read(value: &Value) -> Option<Self> {
        let text = |k: &str| value[k].as_str().filter(|v| !v.is_empty());
        Some(Self {
            scope: Scope::parse(text("scope")?)?,
            unit: PathBuf::from(text("unit")?),
            root: PathBuf::from(text("root")?),
            db: PathBuf::from(text("db")?),
            addr: text("addr")?.parse().ok()?,
            backup: text("backup")?.to_owned(),
            saved: PathBuf::from(text("savedUnit")?),
        })
    }
    fn rollback(&self) -> String {
        rollback_for(
            self.scope,
            &self.root,
            &self.db,
            &self.unit,
            Some(&self.backup),
            Some(&self.saved),
        )
    }
}

/// The armed handoff in `root`: `Ok(None)` only when the file does not
/// exist; any other read error, bad JSON, or a handoff missing a field is
/// `Err` — never "absent".
fn read_handoff(root: &Path) -> Result<Option<Handoff>, String> {
    let file = root.join(HANDOFF);
    let text = match fs::read_to_string(&file) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("cannot read {}: {e}", file.display())),
    };
    let value: Value =
        serde_json::from_str(&text).map_err(|e| format!("cannot parse {}: {e}", file.display()))?;
    Handoff::read(&value)
        .map(Some)
        .ok_or_else(|| format!("{} is not a readable handoff", file.display()))
}
/// Durably write the handoff into `root` (temp + fsync + rename + dir fsync).
fn write_handoff(handoff: &Handoff) -> Result<(), String> {
    use std::io::Write as _;
    let file = handoff.root.join(HANDOFF);
    let temp = handoff
        .root
        .join(format!("{HANDOFF}.{}.tmp", std::process::id()));
    let written = (|| {
        let mut out = fs::File::create(&temp)?;
        out.write_all(format!("{:#}\n", handoff.to_json()).as_bytes())?;
        out.sync_all()?;
        fs::rename(&temp, &file)?;
        fs::File::open(&handoff.root)?.sync_all()
    })();
    written.map_err(|e| {
        let _unlinked = fs::remove_file(&temp);
        format!("could not write {}: {e}", file.display())
    })
}
/// Remove the handoff once a serving verdict is durable.
fn clear_handoff(root: &Path) -> Result<(), String> {
    let file = root.join(HANDOFF);
    match fs::remove_file(&file) {
        Ok(()) => fs::File::open(root)
            .and_then(|d| d.sync_all())
            .map_err(|e| e.to_string()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("could not remove {}: {e}", file.display())),
    }
}

/// `--verify-start`, run by systemd as the bridge-rewritten unit's
/// `ExecStartPost` once Rust is up (`MAINPID` is its pid), on every start
/// until it records a durable verdict. Its working directory is the unit's
/// `WorkingDirectory` (the install root), where the bridge left the handoff.
///
/// - No handoff file: a stale hook, exit 0.
/// - An unreadable handoff, or one for another root or scope: fail closed
///   (stop this scope's unit, exit 1).
/// - Serving the backed-up database on the recorded address: record
///   `migrated`, remove the handoff, then (only once both are done) remove
///   its own line.
/// - Otherwise: record `failed-start` with rollback, then queue a stop and
///   exit 1. The handoff and the line stay, so a `Restart=on-failure`
///   restart (if the stop could not be queued) is judged again rather than
///   trusted. Nothing follows the stop request: systemd may kill this
///   process at once.
pub(crate) fn verify_start(
    host: &dyn Host,
    paths: &Paths,
    hook: &Hook,
    main: u32,
    now: i64,
) -> i32 {
    let handoff = match read_handoff(&hook.root) {
        Ok(None) => return 0,
        Ok(Some(handoff)) => handoff,
        Err(e) => return stop_unjudged(host, hook.scope, &e),
    };
    if handoff.scope != hook.scope || handoff.root != hook.root {
        return stop_unjudged(
            host,
            hook.scope,
            &format!(
                "the handoff in {} is for the {} unit at {}, not this {} one at {}",
                hook.root.join(HANDOFF).display(),
                handoff.scope.name(),
                handoff.root.display(),
                hook.scope.name(),
                hook.root.display()
            ),
        );
    }
    let verdict = if main == 0 {
        Err("systemd did not pass the gateway's MAINPID".to_owned())
    } else if !host.healthy(&format!("http://{}", handoff.addr)) {
        Err(HEALTH.to_owned())
    } else {
        serving_at(host, handoff.addr, &handoff.db, main, &paths.binary)
    };
    let extra = json!({
        "backup": handoff.backup,
        "unit": handoff.unit,
        "savedUnit": handoff.saved,
        "root": handoff.root,
    });
    match verdict {
        Ok(()) => {
            let mut done = extra;
            done["runningVersion"] = json!(paths.version);
            done["recovered"] = json!(true);
            let recorded = outcome(
                paths,
                now,
                Status::Migrated,
                format!(
                    "migrated {} to the Rust gateway {} ({}).\nBackup: {}\nOld unit saved at {}.",
                    handoff.unit.display(),
                    paths.version,
                    paths.binary.display(),
                    handoff.backup,
                    handoff.saved.display()
                ),
                done,
            );
            // Disarm only once the verdict is durable: first the handoff
            // (after which the hook is stale and no-ops), then the line.
            if recorded.persisted {
                resolve_handoff(host, &handoff, &paths.binary);
            } else {
                eprintln!("the verifier stays armed: the verdict was not recorded");
            }
            0
        }
        Err(why) => {
            let s = sudo(handoff.scope);
            let flag = handoff.scope.flag();
            outcome(
                paths,
                now,
                Status::FailedStart,
                format!(
                    "{why}. systemd was asked to stop {UNIT_NAME}; if {s}systemctl{flag} status {UNIT_NAME} still shows it running, run {s}systemctl{flag} stop {UNIT_NAME} first; see journalctl{flag} -u {UNIT_NAME}.\nBackup: {}\n{}",
                    handoff.backup,
                    handoff.rollback()
                ),
                extra,
            );
            let _queued = host.systemctl(handoff.scope, &["stop", "--no-block", UNIT_NAME]);
            1
        }
    }
}

/// The verifier cannot judge: stop the unit that invoked it (its scope is
/// in its own command line), exit 1. Says whether the stop was queued.
fn stop_unjudged(host: &dyn Host, scope: Scope, why: &str) -> i32 {
    let (s, flag) = (sudo(scope), scope.flag());
    eprintln!(
        "omnigateway: {why}; the Rust gateway's start cannot be verified, so {UNIT_NAME} is being stopped. Inspect the record, then run omni service migrate."
    );
    // The last act: systemd may end this process as soon as it acts on it.
    if let Err(e) = host.systemctl(scope, &["stop", "--no-block", UNIT_NAME]) {
        eprintln!(
            "omnigateway: could not ask systemd to stop {UNIT_NAME} ({e}); run {s}systemctl{flag} stop {UNIT_NAME}"
        );
    }
    1
}

/// Where the verifier runs: its scope (from its command line) and the
/// install root (its working directory, set by systemd).
pub(crate) struct Hook {
    pub(crate) root: PathBuf,
    pub(crate) scope: Scope,
}

/// After a durable serving verdict: remove the handoff (from then on the
/// hook is stale and no-ops), then the verifier line. Either failing leaves
/// the verifier armed or harmless, never trusting an unjudged start.
fn resolve_handoff(host: &dyn Host, handoff: &Handoff, binary: &Path) {
    if let Err(e) = clear_handoff(&handoff.root) {
        eprintln!("the verifier stays armed: {e}");
    } else if let Err(e) = disarm(host, handoff, binary) {
        eprintln!(
            "could not remove the verifier from {}: {e}",
            handoff.unit.display()
        );
    }
}

/// Remove the verifier line from the handoff's unit and reload.
fn disarm(host: &dyn Host, handoff: &Handoff, binary: &Path) -> Result<(), String> {
    let text = fs::read_to_string(&handoff.unit).map_err(|e| e.to_string())?;
    let ours = |l: &str| parse_verifier_line(l.trim_end_matches('\n'), binary).is_some();
    if !text.lines().any(ours) {
        return Ok(());
    }
    let without: String = text.split_inclusive('\n').filter(|l| !ours(l)).collect();
    let temp = handoff.unit.with_extension("service.omni-tmp");
    fs::write(&temp, without)
        .and_then(|()| fs::rename(&temp, &handoff.unit))
        .map_err(|e| e.to_string())?;
    host.systemctl(handoff.scope, &["daemon-reload"]).map(drop)
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
    // An unresolved failure's recovery details survive until recovery.
    let failure = pending_failure(previous.as_ref());
    let pending_failure = failure.as_ref();
    if let Some(failure) = pending_failure {
        for key in ["backup", "savedUnit"] {
            if let Some(v) = failure.get(key).filter(|v| !v.is_null()) {
                extra[key] = v.clone();
            }
        }
    }
    // An armed handoff (found through the unit, in its root) is judged
    // against what was backed up, never the current `.env`; an unreadable
    // one is never judged recovered.
    let handoff = read_handoff(&plan.root).transpose();
    let judge = |pid: u32| -> Result<(), String> {
        match &handoff {
            None => {
                if host.healthy(&local_base(&plan.env)) {
                    serving_is(host, plan, pid, &paths.binary)
                } else {
                    Err(HEALTH.to_owned())
                }
            }
            Some(Ok(h)) => {
                if host.healthy(&format!("http://{}", h.addr)) {
                    serving_at(host, h.addr, &h.db, pid, &paths.binary)
                } else {
                    Err(HEALTH.to_owned())
                }
            }
            Some(Err(e)) => Err(e.clone()),
        }
    };
    let unresolved = pending_failure.is_some() || handoff.is_some();
    // An unreadable handoff: nothing is restarted, judged or recorded over
    // it; the operator is told where it is.
    if let Some(Err(e)) = &handoff {
        return outcome(
            paths,
            now,
            Status::FailedRecord,
            format!(
                "{e}; the start after the migration cannot be verified, so nothing was changed. Repair it (do not delete it: that would let the next start pass unverified), or roll back with the service stopped."
            ),
            extra,
        );
    }
    // An armed handoff with no verdict yet is reported as such.
    let verifying = matches!(handoff, Some(Ok(_)));
    let running = main_pid(&plan.facts).filter(|_| active(&plan.facts));
    let Some(pid) = running else {
        if verifying && pending_failure.is_none_or(|f| f["status"] == "verifying") {
            let rollback = handoff
                .as_ref()
                .and_then(|h| h.as_ref().ok())
                .map(Handoff::rollback)
                .unwrap_or_default();
            return outcome(
                paths,
                now,
                Status::Verifying,
                format!(
                    "the Rust gateway's start after the migration has not been verified and {UNIT_NAME} is not running.\n{rollback}"
                ),
                extra,
            );
        }
        if let Some(failure) = pending_failure {
            // Re-reported, not judged: an unverified handoff stays one.
            let status = if failure["status"] == "verifying" {
                Status::Verifying
            } else {
                Status::FailedStart
            };
            return outcome(
                paths,
                now,
                status,
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
    let exe = host.process_exe(pid);
    let replaced = exe.as_ref().is_some_and(|exe| {
        exe.display().to_string().ends_with(" (deleted)") || *exe != paths.binary
    });
    if !replaced {
        // Recovery means serving: answering /health on the probed address
        // from this process, which runs this binary and holds the database.
        let serving =
            exe.as_ref().is_some_and(|e| *e == paths.binary) && unresolved && judge(pid).is_ok();
        if serving || exe.as_ref().is_some_and(|e| *e == paths.binary) && !unresolved {
            extra["runningVersion"] = json!(paths.version);
        }
        if serving {
            extra["recovered"] = json!(true);
        }
        let current = outcome(
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
        if serving
            && verifying
            && current.persisted
            && let Ok(Some(h)) = read_handoff(&plan.root)
        {
            resolve_handoff(host, &h, &paths.binary);
        }
        return current;
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
        Ok(_) => show(host, scope, "ActiveState,MainPID").and_then(|facts| {
            match main_pid(&facts).filter(|_| active(&facts)) {
                Some(pid) => judge(pid),
                None => Err(format!("{UNIT_NAME} is not running after start")),
            }
        }),
    };
    let Err(mut why) = verdict else {
        let mut done = extra;
        done["runningVersion"] = json!(paths.version);
        done["recovered"] = json!(true);
        let restarted = outcome(
            paths,
            now,
            Status::Restarted,
            format!("restarted {UNIT_NAME} on omnigateway {}", paths.version),
            done,
        );
        if verifying
            && restarted.persisted
            && let Ok(Some(h)) = read_handoff(&plan.root)
        {
            resolve_handoff(host, &h, &paths.binary);
        }
        return restarted;
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

/// `gateway.js` started by a 0.x unit: migrate in place under the lock, then
/// ask systemd to restart the unit as Rust. Returns the exit code: 0 for every
/// refusal and for the handoff (so `Restart=on-failure` does not loop), 1 when
/// run by hand outside the unit.
pub(crate) fn bridge(host: &dyn Host, paths: &Paths, now: i64) -> i32 {
    if let Err(e) = read_record(paths) {
        eprintln!(
            "{}",
            outcome(paths, now, Status::FailedRecord, e, json!({})).message
        );
        return 0;
    }
    let refuse = |status: Status, message: String| {
        eprintln!("{message}");
        outcome(paths, now, status, message, json!({}));
        0
    };
    let plan = match preflight(host, paths) {
        Ok(plan) => plan,
        Err((Status::NothingToMigrate | Status::SkippedForeground, _)) => {
            eprintln!(
                "gateway.js is the 0.x → Rust migration bridge, run by an old omnigateway systemd unit. No such unit was found; start the gateway with: omni start"
            );
            return 1;
        }
        Err((status, message)) => return refuse(status, message),
    };
    if plan.kind == Kind::Rust {
        eprintln!(
            "{} already runs the Rust gateway; gateway.js is only a migration bridge",
            plan.unit.path.display()
        );
        return 0;
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
        return 1;
    }
    if let Err(e) = systemd_safe(&plan, paths) {
        return refuse(
            Status::SkippedUnit,
            format!("{e}; the service is left stopped"),
        );
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
    let result = convert(host, paths, &plan, lock, Starter::Bridge, now);
    eprintln!("{}", result.message);
    0
}

/// The commands an operator checks a service with. Only they print the
/// banner; every other command's stderr stays identical to the frozen CLI.
pub(crate) fn announces(command: &str) -> bool {
    matches!(command, "doctor" | "status")
}

/// One stderr line while a migration needs attention, or a 0.x unit is
/// still installed. `None` when there is nothing to say.
pub(crate) fn banner(paths: &Paths) -> Option<String> {
    // Announce an unreadable record only when one is known to exist: every
    // `doctor`/`status` call reads this, and a state directory it cannot
    // search (no migration ever ran there) must stay as quiet as the TS CLI.
    // The verifier and `migrate` still refuse on any read error.
    // An armed handoff lives in the unit's root, whatever state directory
    // this shell uses: announce it (or that it cannot be read) first. With
    // no readable unit or no handoff this says nothing, like the TS CLI.
    for unit in find_units(paths).unwrap_or_default() {
        if let Ok((Kind::Rust, root)) = classify(&unit.text, &paths.binary) {
            let file = root.join(HANDOFF);
            if fs::symlink_metadata(&file).is_err() {
                continue;
            }
            return Some(match read_handoff(&root) {
                Ok(_) => format!(
                    "omnigateway: the npm migration to the Rust gateway is not verified: {} is armed and no verdict was recorded. Run omni service migrate.",
                    file.display()
                ),
                Err(e) => format!(
                    "omnigateway: the npm migration handoff cannot be read ({e}); the start cannot be verified. Repair it, or roll back with the service stopped; do not delete it."
                ),
            });
        }
    }
    let exists = fs::symlink_metadata(paths.state.join(RECORD)).is_ok();
    if exists && let Err(e) = read_record(paths) {
        return Some(format!(
            "omnigateway: the npm migration record cannot be read ({e}); a migration may be unverified. Inspect it, then run omni service migrate."
        ));
    }
    let latest = previous_record(paths);
    // Show what the operator needs to act on: the unresolved failure (the
    // one with rollback when there is one), else the latest attempt.
    let shown = latest
        .as_ref()
        .and_then(|r| pending_failure(Some(r)))
        .or(latest);
    if let Some(record) = shown
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
            } else if status == "verifying" {
                "is not verified"
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
/// `--scope <user|system>` from the hook's command line; the root is the
/// working directory systemd gave it.
fn hook_args(flags: &[String], cwd: Option<PathBuf>) -> Option<Hook> {
    let i = flags.iter().position(|f| f == "--scope")?;
    let root = cwd.filter(|c| c.is_absolute())?;
    Some(Hook {
        root,
        scope: Scope::parse(flags.get(i + 1)?)?,
    })
}

pub(crate) fn command(flags: &[String]) -> std::process::ExitCode {
    use std::process::ExitCode;
    if flags.iter().any(|f| f == "--help" || f == "-h") {
        print!("{HELP}");
        return ExitCode::SUCCESS;
    }
    let values = ["--scope"];
    let mut skip = false;
    if let Some(bad) = flags.iter().find(|f| {
        if std::mem::take(&mut skip) {
            return false;
        }
        skip = values.contains(&f.as_str());
        !matches!(
            f.as_str(),
            "--from-npm" | "--bridge" | "--verify-start" | "--json" | "--scope"
        )
    }) {
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
    if flags.iter().any(|f| f == "--verify-start") {
        // systemd sets MAINPID for ExecStartPost.
        let main = std::env::var("MAINPID")
            .ok()
            .and_then(|p| p.trim().parse::<u32>().ok())
            .unwrap_or(0);
        let Some(hook) = hook_args(flags, std::env::current_dir().ok()) else {
            eprintln!("omni service migrate --verify-start needs --scope user|system");
            return ExitCode::FAILURE;
        };
        let code = verify_start(&host::System, &paths, &hook, main, now);
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

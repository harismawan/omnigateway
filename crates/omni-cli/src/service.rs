//! Local process supervision. Gateway business/lifecycle logic stays in the server.
use crate::context::Context;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::Duration,
};
type Flags = HashMap<String, String>;
pub(crate) fn paint(flags: &Flags, code: &str, text: &str) -> String {
    use std::io::IsTerminal;
    if !flags.contains_key("no-color")
        && std::env::var("NO_COLOR").unwrap_or_default().is_empty()
        && std::io::stdout().is_terminal()
    {
        format!("\x1b[{code}m{text}\x1b[0m")
    } else {
        text.into()
    }
}
pub(crate) fn owns(command: &str) -> bool {
    matches!(
        command,
        "start" | "stop" | "restart" | "doctor" | "service-install" | "service-uninstall"
    )
}
pub(crate) fn unit(flags: &Flags) -> PathBuf {
    if flags.contains_key("system") {
        "/etc/systemd/system/omnigateway.service".into()
    } else {
        std::env::home_dir()
            .unwrap_or_default()
            .join(".config/systemd/user/omnigateway.service")
    }
}
pub(crate) fn state(ctx: &Context) -> PathBuf {
    ctx.env
        .get("XDG_STATE_HOME")
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            std::env::home_dir()
                .unwrap_or_default()
                .join(".local/state")
        })
        .join("omnigateway")
}
pub(crate) fn gateway_at(executable: &Path) -> Option<PathBuf> {
    let canonical = fs::canonicalize(executable).ok()?;
    if canonical.file_name()? == "omnigateway" {
        return Some(canonical);
    }
    let companion = canonical.parent()?.join("omnigateway");
    let companion = fs::canonicalize(companion).ok()?;
    (companion != canonical && companion.is_file() && companion.file_name()? == "omnigateway")
        .then_some(companion)
}
pub(crate) fn gateway() -> Option<PathBuf> {
    gateway_at(&std::env::current_exe().ok()?)
}
fn systemctl(flags: &Flags, args: &[&str]) -> Result<std::process::Output, String> {
    let mut cmd = Command::new("systemctl");
    if !flags.contains_key("system") {
        cmd.arg("--user");
    }
    cmd.args(args).output().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            "Executable not found in $PATH: \"systemctl\"".into()
        } else {
            e.to_string()
        }
    })
}
fn action(flags: &Flags, verb: &str) -> Result<(), String> {
    let output = systemctl(flags, &[verb, "omnigateway.service"])?;
    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr).trim().to_owned();
        return Err(if err.is_empty() {
            format!(
                "systemctl {verb} exited {}",
                output.status.code().unwrap_or(1)
            )
        } else {
            err
        });
    }
    Ok(())
}
/// The systemd unit `omni service install` writes. `MIMALLOC_PURGE_DELAY=1` is
/// the allocator launch policy (`docs/rust-packaging.md`); it must be in the
/// environment before the process starts, and systemd lets `EnvironmentFile=`
/// override `Environment=`, so a value in `.env` still wins.
pub(crate) fn render_unit(root: &Path, executable: &Path) -> String {
    format!(
        "[Unit]\nDescription=OmniGateway\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\nWorkingDirectory={}\nEnvironment=MIMALLOC_PURGE_DELAY=1\nEnvironmentFile={}/.env\nExecStart={}\nRestart=on-failure\nRestartSec=2\n\n[Install]\nWantedBy=default.target\n",
        root.display(),
        root.display(),
        executable.display()
    )
}
fn healthy(base: &str) -> bool {
    let Ok(mut url) = url::Url::parse(base) else {
        return false;
    };
    url.set_path("/health");
    url.set_query(None);
    url.set_fragment(None);
    let Ok(runtime) = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    else {
        return false;
    };
    runtime.block_on(async {
        let client = omni_providers::http::Client::new();
        for _ in 0..50 {
            let request = omni_providers::http::HttpRequest {
                provider: String::new(),
                url: url.to_string(),
                method: "GET".into(),
                headers: vec![],
                body: String::new(),
                body_encoding: None,
                request_id: None,
            };
            if tokio::time::timeout(Duration::from_secs(1), client.send(request))
                .await
                .is_ok_and(|r| r.is_ok_and(|r| (200..300).contains(&r.status)))
            {
                return true;
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
        false
    })
}
fn start(ctx: &Context, flags: &Flags, base: &str) -> Result<Value, String> {
    let status = crate::status::service_status(ctx, flags)?;
    let (supervisor, pid) = if unit(flags).exists() {
        action(flags, "start")?;
        ("systemd", Value::Null)
    } else if status["running"] == true {
        ("pidfile", status["pid"].clone())
    } else {
        let executable = gateway().ok_or_else(|| {
            format!(
                "no gateway to run: no omnigateway executable beside this CLI for {}",
                ctx.root.display()
            )
        })?;
        let state = state(ctx);
        fs::create_dir_all(&state).map_err(|e| e.to_string())?;
        let log = PathBuf::from(status["logFile"].as_str().ok_or("missing log path")?);
        if let Some(parent) = log.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let output = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&log)
            .map_err(|e| e.to_string())?;
        let mut command = Command::new(executable);
        command
            .current_dir(&ctx.root)
            .env_clear()
            .envs(&ctx.env)
            .env("OMNI_LOG_FILE", &log)
            .stdin(Stdio::null())
            .stdout(output.try_clone().map_err(|e| e.to_string())?)
            .stderr(output);
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }
        let mut child = command.spawn().map_err(|e| e.to_string())?;
        let pid = child.id();
        fs::write(state.join("gateway.pid"), format!("{pid}\n")).map_err(|e| e.to_string())?;
        // Reap the child if this process remains alive; no inherited output handles.
        std::thread::spawn(move || {
            let _reaped = child.wait();
        });
        ("pidfile", json!(pid))
    };
    Ok(json!({"supervisor":supervisor,"pid":pid,"healthy":healthy(base)}))
}
fn signal(pid: f64, signal: rustix::process::Signal) -> Result<(), String> {
    let pid = rustix::process::Pid::from_raw(pid as i32).ok_or("invalid pid")?;
    rustix::process::kill_process(pid, signal).map_err(|e| e.to_string())
}
fn terminate(
    pid: f64,
    mut alive: impl FnMut(f64) -> bool,
    mut send: impl FnMut(f64, rustix::process::Signal) -> Result<(), String>,
    mut sleep: impl FnMut(Duration),
) -> Result<(), String> {
    send(pid, rustix::process::Signal::TERM)?;
    for _ in 0..50 {
        if !alive(pid) {
            break;
        }
        sleep(Duration::from_millis(100));
    }
    if alive(pid) {
        send(pid, rustix::process::Signal::KILL)?;
    }
    Ok(())
}
fn stop(ctx: &Context, flags: &Flags) -> Result<Value, String> {
    let status = crate::status::service_status(ctx, flags)?;
    if unit(flags).exists() {
        action(flags, "stop")?;
        return Ok(json!({"supervisor":"systemd","stopped":true}));
    }
    let Some(pid) = status["pid"].as_f64() else {
        return Ok(json!({"supervisor":"none","stopped":false}));
    };
    terminate(pid, crate::process::alive, signal, std::thread::sleep)?;
    fs::remove_file(state(ctx).join("gateway.pid")).map_err(|e| e.to_string())?;
    Ok(json!({"supervisor":"pidfile","stopped":true}))
}
pub(crate) fn run(command: &str, flags: &Flags) -> Result<String, (u8, String)> {
    run_inner(command, flags).map_err(|e| (1, e))?
}
fn run_inner(command: &str, flags: &Flags) -> Result<Result<String, (u8, String)>, String> {
    let ctx = crate::context::resolve(flags)?;
    let json_output = flags.contains_key("json");
    let (value, human) = match command {
        "doctor" => {
            let (value, human) = crate::doctor::report(ctx, flags)?;
            (value, human)
        }
        "start" | "restart" => {
            if command == "restart" {
                stop(&ctx, flags)?;
            }
            let base = ctx.base_url()?;
            if command == "start" && flags.contains_key("foreground") {
                let executable = gateway()
                    .ok_or("no gateway to run: no omnigateway executable beside this CLI")?;
                let code = Command::new(executable)
                    .current_dir(&ctx.root)
                    .env_clear()
                    .envs(&ctx.env)
                    .status()
                    .map_err(|e| e.to_string())?;
                return Ok(if code.success() {
                    Ok(String::new())
                } else {
                    Err((
                        3,
                        format!("gateway exited with code {}", code.code().unwrap_or(1)),
                    ))
                });
            }
            if command != "restart" && !json_output {
                eprintln!("starting gateway at {base}…");
            }
            let value = start(&ctx, flags, &base)?;
            let how = if value["supervisor"] == "systemd" {
                "systemd".into()
            } else {
                format!("pid {}", value["pid"])
            };
            let healthy = value["healthy"] == true;
            let human = if command == "restart" {
                if healthy {
                    "restarted".into()
                } else {
                    paint(flags, "31", "restarted but /health never answered")
                }
            } else if healthy {
                format!("{} ({how}) at {base}", paint(flags, "32", "running"))
            } else {
                format!(
                    "{} ({how}); see {}",
                    paint(flags, "31", "started but /health never answered"),
                    if value["supervisor"] == "systemd" {
                        "journalctl -u omnigateway.service".into()
                    } else {
                        crate::status::service_status(&ctx, flags)?["logFile"]
                            .as_str()
                            .unwrap_or_default()
                            .to_owned()
                    }
                )
            };
            println!(
                "{}",
                if json_output {
                    serde_json::to_string_pretty(&value).map_err(|e| e.to_string())?
                } else {
                    human
                }
            );
            return Ok(if healthy {
                Ok(String::new())
            } else {
                Err((3, "gateway did not become healthy".into()))
            });
        }
        "stop" => {
            let value = stop(&ctx, flags)?;
            let human = if value["stopped"] == true {
                "stopped"
            } else {
                "nothing to stop: the gateway is not running"
            };
            (value, human.into())
        }
        "service-install" => {
            let path = unit(flags);
            if path.exists() && !flags.contains_key("force") {
                return Err(format!(
                    "{} already exists; pass --force to replace it",
                    path.display()
                ));
            }
            let executable = gateway().ok_or_else(|| {
                format!(
                    "no gateway to run for {}: no omnigateway executable beside this CLI",
                    ctx.root.display()
                )
            })?;
            fs::create_dir_all(path.parent().ok_or("missing unit parent")?)
                .map_err(|e| e.to_string())?;
            fs::write(&path, render_unit(&ctx.root, &executable)).map_err(|e| e.to_string())?;
            let reloaded = systemctl(flags, &["daemon-reload"])?.status.success();
            let enabled = flags.contains_key("enable")
                && systemctl(flags, &["enable", "omnigateway.service"])?
                    .status
                    .success();
            let human = format!(
                "unit             {}\nscope            {}\ndaemon-reload    {}\nenabled at boot  {}",
                path.display(),
                if flags.contains_key("system") {
                    "system"
                } else {
                    "user"
                },
                if reloaded { "ok" } else { "failed" },
                if enabled { "yes" } else { "no" }
            );
            (
                json!({"path":path,"reloaded":reloaded,"enabled":enabled}),
                human,
            )
        }
        "service-uninstall" => {
            if !flags.contains_key("yes") {
                crate::database::confirm(&format!(
                    "remove the {} systemd unit for {}?",
                    if flags.contains_key("system") {
                        "system"
                    } else {
                        "user"
                    },
                    ctx.root.display()
                ))?;
            }
            let path = unit(flags);
            let removed = path.exists();
            if removed {
                systemctl(flags, &["disable", "--now", "omnigateway.service"])?;
                fs::remove_file(&path).map_err(|e| e.to_string())?;
                systemctl(flags, &["daemon-reload"])?;
            }
            let human = format!(
                "{} {}",
                if removed { "removed" } else { "no unit at" },
                path.display()
            );
            (json!({"path":path,"removed":removed}), human)
        }
        _ => return Err("unknown service command".into()),
    };
    println!(
        "{}",
        if json_output {
            serde_json::to_string_pretty(&value).map_err(|e| e.to_string())?
        } else {
            human
        }
    );
    Ok(Ok(String::new()))
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    #[test]
    fn frozen_flags() {
        for (command, flag, accepted) in [
            ("start", "system", true),
            ("start", "foreground", true),
            ("stop", "system", false),
            ("restart", "system", false),
            ("doctor", "system", true),
            ("service-install", "enable", true),
            ("service-install", "force", true),
            ("service-uninstall", "force", false),
        ] {
            assert_eq!(
                crate::args::parse_command(&[format!("--{flag}")], command).is_ok(),
                accepted,
                "{command} {flag}"
            );
        }
    }
    #[test]
    fn graceful_stop_and_bounded_escalation_are_injected() {
        use rustix::process::Signal;
        let mut sent = vec![];
        let mut sleeps = 0;
        terminate(
            42.0,
            |_| true,
            |pid, s| {
                assert_eq!(pid, 42.0);
                sent.push(s);
                Ok(())
            },
            |_| sleeps += 1,
        )
        .unwrap();
        assert_eq!(sent, vec![Signal::TERM, Signal::KILL]);
        assert_eq!(sleeps, 50);
        sent.clear();
        terminate(
            42.0,
            |_| false,
            |_, s| {
                sent.push(s);
                Ok(())
            },
            |_| panic!("no grace delay after exit"),
        )
        .unwrap();
        assert_eq!(sent, vec![Signal::TERM]);
    }
    #[test]
    fn required_environment_file_and_canonical_exec() {
        let unit = render_unit(Path::new("/install"), Path::new("/release/omnigateway"));
        assert!(unit.contains("EnvironmentFile=/install/.env\nExecStart=/release/omnigateway\n"));
        // The allocator launch policy (docs/rust-packaging.md).
        assert!(
            unit.contains("Environment=MIMALLOC_PURGE_DELAY=1\nEnvironmentFile=/install/.env\n")
        );
        assert!(unit.contains("Restart=on-failure\nRestartSec=2"));
        assert!(unit.ends_with("WantedBy=default.target\n"));
    }

    #[test]
    fn release_symlink_and_standalone_companion() {
        let root = std::env::temp_dir().join(format!("omni-e4-discovery-{}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        let standalone = root.join("cli");
        fs::write(&standalone, "").unwrap();
        assert_eq!(gateway_at(&standalone), None);
        let server = root.join("omnigateway");
        fs::write(&server, "").unwrap();
        assert_eq!(gateway_at(&standalone), Some(server.clone()));
        #[cfg(unix)]
        {
            let symlink = root.join("omni");
            std::os::unix::fs::symlink("omnigateway", &symlink).unwrap();
            assert_eq!(gateway_at(&symlink), Some(server));
            fs::remove_file(symlink).unwrap();
        }
        fs::remove_file(standalone).unwrap();
        fs::remove_file(root.join("omnigateway")).unwrap();
        fs::remove_dir(root).unwrap();
    }
}

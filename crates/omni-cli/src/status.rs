use serde_json::{Value, json};
use std::{collections::HashMap, io::IsTerminal, process::Command};
pub(crate) fn service_status(
    ctx: &crate::context::Context,
    flags: &HashMap<String, String>,
) -> Result<Value, String> {
    let home = std::env::home_dir().unwrap_or_default();
    let unit = if flags.contains_key("system") {
        std::path::PathBuf::from("/etc/systemd/system/omnigateway.service")
    } else {
        home.join(".config/systemd/user/omnigateway.service")
    };
    let process = if unit.exists() {
        let run = |args: &[&str]| -> Result<std::process::Output, String> {
            let mut c = Command::new("systemctl");
            if !flags.contains_key("system") {
                c.arg("--user");
            }
            c.args(args).output().map_err(|e| {
                if e.kind() == std::io::ErrorKind::NotFound {
                    "Executable not found in $PATH: \"systemctl\"".into()
                } else {
                    e.to_string()
                }
            })
        };
        let a = run(&["is-active", "omnigateway.service"])?;
        let out = String::from_utf8_lossy(&a.stdout);
        let err = String::from_utf8_lossy(&a.stderr);
        let state = if !out.trim().is_empty() {
            out.trim()
        } else if !err.trim().is_empty() {
            err.trim()
        } else {
            "unknown"
        };
        let shown = run(&[
            "show",
            "omnigateway.service",
            "--property=MainPID",
            "--value",
        ])?;
        let pid = pid(&String::from_utf8_lossy(&shown.stdout));
        json!({"supervisor":"systemd","running":state=="active","pid":pid,"state":state,"unitPath":unit,"logFile":null})
    } else {
        let state = ctx
            .env
            .get("XDG_STATE_HOME")
            .filter(|v| !v.is_empty())
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| home.join(".local/state"))
            .join("omnigateway");
        let file = state.join("gateway.pid");
        let mut p = if !file.exists() {
            None
        } else {
            match std::fs::read(&file) {
                Ok(bytes) => pid(&String::from_utf8_lossy(&bytes)),
                Err(error) if error.kind() == std::io::ErrorKind::IsADirectory => {
                    return Err("EISDIR: illegal operation on a directory, read".into());
                }
                Err(error) => return Err(omni_control::fs_error::fs_error(&error, "open", &file)),
            }
        };
        if let Some(id) = p
            && !crate::process::alive(id)
        {
            std::fs::remove_file(&file).map_err(|e| e.to_string())?;
            p = None;
        }
        let log = ctx
            .env
            .get("OMNI_LOG_FILE")
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .map(String::from)
            .unwrap_or_else(|| state.join("gateway.log").display().to_string());
        json!({"supervisor":if p.is_some(){"pidfile"}else{"none"},"running":p.is_some(),"pid":p,"state":null,"unitPath":null,"logFile":log})
    };
    Ok(process)
}

pub fn run(flags: &HashMap<String, String>) -> Result<String, String> {
    let ctx = crate::context::resolve(flags)?;
    let root = ctx.root.display().to_string();
    let process = service_status(&ctx, flags)?;
    let mut credentials = Vec::new();
    let mut lossless_credentials = Vec::new();
    let mut poll = 300_000.0;
    let mut configured = false;
    let mut error = None;
    match ctx.open() {
        Err(e) => error = Some(e),
        Ok(store) => {
            let settings = omni_control::settings_value::read(&store)?;
            if let Some(omni_ir::jsjson::JsValue::Number(n)) =
                omni_control::settings_value::get(&settings, "quotaPollIntervalMs")
            {
                poll = *n;
            }
            configured = omni_control::admin_password::admin_hash(&store)
                .map_err(|e| e.to_string())?
                .is_some();
            let accounts = omni_control::operator_json::parse(
                &omni_control::credentials::list(&store).map_err(|e| e.message)?,
            )
            .map_err(|e| e.to_string())?;
            let quota_rows =
                omni_control::credentials::status_quota(&store).map_err(|e| e.message)?;
            use omni_control::settings_value::get;
            use omni_ir::jsjson::JsValue as J;
            if let Some(J::Array(accounts)) = get(&accounts, "credentials") {
                for c in accounts {
                    let quota = match &quota_rows {
                        J::Array(q) => q
                            .iter()
                            .filter(|q| get(q, "credentialId") == get(c, "id"))
                            .cloned()
                            .collect(),
                        _ => Vec::new(),
                    };
                    let mut fields = ["id", "provider", "label", "enabled"]
                        .into_iter()
                        .map(|key| {
                            (
                                key.encode_utf16().collect(),
                                get(c, key).cloned().unwrap_or(J::Null),
                            )
                        })
                        .collect::<Vec<_>>();
                    fields.push(("quota".encode_utf16().collect(), J::Array(quota)));
                    let projected = J::Object(fields);
                    let raw = omni_ir::jsjson::stringify(&projected)
                        .ok_or("invalid status projection")?;
                    credentials
                        .push(omni_ir::js::parse_json(&raw).ok_or("invalid status projection")?);
                    lossless_credentials.push(projected);
                }
            }
        }
    }
    if flags.contains_key("json") {
        let mut result = omni_ir::jsjson::JsValue::from(
            &json!({"process":process,"adminConfigured":configured,"credentials":[],"storeError":error}),
        );
        omni_control::settings_value::set(
            &mut result,
            "credentials",
            omni_ir::jsjson::JsValue::Array(lossless_credentials),
        );
        return omni_ir::jsjson::stringify_pretty(&result)
            .ok_or("invalid status projection".into());
    }
    let color = !flags.contains_key("no-color")
        && std::env::var("NO_COLOR").unwrap_or_default().is_empty()
        && std::io::stdout().is_terminal();
    let paint = |code: &str, text: &str| {
        if color {
            format!("\x1b[{code}m{text}\x1b[0m")
        } else {
            text.into()
        }
    };
    let running = process["running"] == true;
    let mut out = format!(
        "gateway         {}{}\nroot            {root}\nadmin password  {}",
        paint(
            if running { "32" } else { "31" },
            if running { "running" } else { "stopped" }
        ),
        paint(
            "2",
            &format!(" ({})", process["supervisor"].as_str().unwrap_or("none"))
        ),
        if configured {
            "set".into()
        } else {
            paint("31", "not set")
        }
    );
    out.push_str("\n\n");
    if let Some(e) = error {
        out.push_str(&paint("31", &e));
    } else if credentials.is_empty() {
        out.push_str("no credentials; add one with: omni connect <provider>");
    } else {
        let mut rows = vec![vec![
            "ACCOUNT".into(),
            "PROVIDER".into(),
            "STATE".into(),
            "QUOTA".into(),
        ]];
        for c in &credentials {
            let enabled = c["enabled"] == true;
            rows.push(vec![
                c["label"].as_str().unwrap_or("").into(),
                paint(
                    provider_color(c["provider"].as_str().unwrap_or("")),
                    c["provider"].as_str().unwrap_or(""),
                ),
                paint(
                    if enabled { "32" } else { "31" },
                    if enabled { "enabled" } else { "disabled" },
                ),
                quota_cell(&c["quota"], poll, &paint),
            ]);
        }
        let widths = (0..4)
            .map(|i| rows.iter().map(|r| width(&r[i])).max().unwrap_or(0))
            .collect::<Vec<_>>();
        out.push_str(
            &rows
                .iter()
                .map(|r| {
                    r.iter()
                        .enumerate()
                        .map(|(i, s)| format!("{s}{}", " ".repeat(widths[i] - width(s))))
                        .collect::<Vec<_>>()
                        .join("  ")
                        .trim_end()
                        .to_owned()
                })
                .collect::<Vec<_>>()
                .join("\n"),
        );
    }
    Ok(out)
}
fn pid(s: &str) -> Option<f64> {
    let n = omni_ir::js::string_to_number(s);
    if n.is_finite() && n > 0.0 && n.fract() == 0.0 {
        Some(n)
    } else {
        None
    }
}
fn width(s: &str) -> usize {
    let mut escape = false;
    s.chars()
        .filter(|c| {
            if *c == '\x1b' {
                escape = true;
                return false;
            }
            if escape {
                if *c == 'm' {
                    escape = false;
                }
                return false;
            }
            true
        })
        .map(char::len_utf16)
        .sum()
}
fn quota_cell(q: &Value, poll: f64, paint: &impl Fn(&str, &str) -> String) -> String {
    let mut rows = q
        .as_array()
        .into_iter()
        .flatten()
        .filter(|w| w["limit"].as_f64().is_some_and(|v| v > 0.0))
        .collect::<Vec<_>>();
    rows.sort_by_key(|w| match w["windowType"].as_str() {
        Some("fiveHour") => 0,
        Some("daily") => 1,
        _ => 2,
    });
    if rows.is_empty() {
        return paint("2", "unknown");
    }
    let now = chrono::Utc::now().timestamp_millis() as f64;
    let age = rows
        .iter()
        .filter_map(|w| w["observedAt"].as_f64())
        .fold(f64::INFINITY, f64::min);
    let secs = ((now - age) / 1000.0).round().max(0.0);
    let age = if secs < 60.0 {
        format!("{secs}s")
    } else if secs < 3600.0 {
        format!("{}m", (secs / 60.0).round())
    } else if secs < 86400.0 {
        format!("{}h", (secs / 3600.0).round())
    } else {
        format!("{}d", (secs / 86400.0).round())
    };
    let cells = rows
        .iter()
        .map(|w| {
            let used = (w["used"].as_f64().unwrap_or(0.0) / w["limit"].as_f64().unwrap_or(1.0)
                * 100.0)
                .round();
            let label = match w["windowType"].as_str() {
                Some("fiveHour") => "5h",
                Some("daily") => "24h",
                _ => "7d",
            };
            let cell = paint(
                if used < 90.0 { "32" } else { "31" },
                &format!("{label} {used}%"),
            );
            let observed = w["observedAt"].as_f64().unwrap_or(0.0);
            let reset = w["resetsAt"].as_f64();
            if observed <= 0.0
                || now - observed > poll.max(60000.0) * 3.0
                || reset.is_some_and(|r| r <= now)
            {
                return cell;
            }
            let Some(reset) = reset else {
                return cell;
            };
            let duration = w["windowMs"]
                .as_f64()
                .filter(|n| *n > 0.0)
                .unwrap_or(match label {
                    "5h" => 18000000.0,
                    "24h" => 86400000.0,
                    _ => 604800000.0,
                });
            let elapsed = observed - (reset - duration);
            let amount = w["used"].as_f64().unwrap_or(0.0);
            let rate = if elapsed <= 0.0 || amount == 0.0 {
                0.0
            } else {
                amount / elapsed
            };
            let exhaustion = if rate <= 0.0 {
                None
            } else {
                Some(observed + (w["limit"].as_f64().unwrap_or(0.0) - amount).max(0.0) / rate)
            };
            let note = if let Some(at) = exhaustion.filter(|at| *at < reset) {
                format!("~{}", span(at - now))
            } else {
                "ok".into()
            };
            format!("{cell} {}", paint("2", &note))
        })
        .collect::<Vec<_>>()
        .join(" · ");
    format!("{cells} {}", paint("2", &format!("({age} ago)")))
}
fn span(ms: f64) -> String {
    let s = (ms / 1000.0).round().max(0.0);
    if s < 60.0 {
        format!("{s}s")
    } else if s < 3600.0 {
        format!("{}m", (s / 60.0).floor())
    } else if s < 86400.0 {
        format!(
            "{}h{:02}m",
            (s / 3600.0).floor(),
            (s / 60.0).floor() as u64 % 60
        )
    } else {
        format!(
            "{}d{:02}h",
            (s / 86400.0).floor(),
            (s / 3600.0).floor() as u64 % 24
        )
    }
}
fn provider_color(id: &str) -> &'static str {
    use omni_control::settings_value::get;
    let tone = omni_control::catalog::descriptor(id)
        .and_then(|d| get(d, "presentation"))
        .and_then(|p| get(p, "tone"))
        .and_then(|v| omni_control::operator_json::string(v).ok());
    match tone.as_deref() {
        Some("green") => "32",
        Some("yellow") => "33",
        Some("blue") => "34",
        Some("magenta") => "35",
        Some("orange") => "38;5;208",
        Some("violet") => "38;5;99",
        Some("azure") => "38;5;33",
        Some("dim") => "2",
        Some("red") => "31",
        _ => "36",
    }
}

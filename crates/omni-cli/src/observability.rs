//! Local operator reports. Streaming commands write directly, never collect a whole export.
use serde_json::Value;
use std::{
    collections::HashMap,
    io::{IsTerminal, Write},
};
pub type Flags = HashMap<String, String>;
pub type Error = (u8, String);
pub fn owns(command: &str) -> bool {
    matches!(
        command,
        "logs"
            | "logs-export"
            | "usage"
            | "bodies"
            | "console"
            | "quota"
            | "quota-refresh"
            | "quota-resets"
            | "quota-reset"
    )
}
pub fn string_option(command: &str, name: &str) -> bool {
    (matches!(command, "logs" | "logs-export")
        && matches!(
            name,
            "since"
                | "until"
                | "state"
                | "provider"
                | "model"
                | "requested-model"
                | "resolved-model"
                | "account"
                | "key"
                | "error-code"
        ))
        || (command == "logs" && matches!(name, "number" | "cursor"))
        || (command == "logs-export" && name == "format")
        || (command == "usage"
            && matches!(
                name,
                "grain" | "by" | "split" | "since" | "until" | "account" | "key"
            ))
        || (command == "console" && matches!(name, "number" | "level"))
        || (command == "quota-reset" && name == "credit")
}
pub fn bool_option(command: &str, name: &str) -> bool {
    (matches!(command, "logs" | "logs-export") && name == "failed")
        || (command == "logs" && matches!(name, "follow" | "service" | "system"))
        || (command == "console" && matches!(name, "follow" | "system"))
        || (command == "bodies" && name == "full")
        || (command == "quota-refresh" && name == "all")
}
pub fn fail(e: impl ToString) -> Error {
    (1, e.to_string())
}
pub fn control(e: omni_control::api::Failure) -> Error {
    fail(if let Some(code) = e.code {
        format!("{code}: {}", e.message)
    } else {
        e.message
    })
}
pub fn usage(e: impl ToString) -> Error {
    (2, e.to_string())
}
pub fn write(text: &str) -> Result<(), Error> {
    let mut out = std::io::stdout().lock();
    out.write_all(text.as_bytes())
        .and_then(|()| out.flush())
        .map_err(fail)
}
pub fn emit(
    flags: &Flags,
    data: &Value,
    human: impl FnOnce() -> Result<String, Error>,
) -> Result<(), Error> {
    let text = if flags.contains_key("json") {
        omni_ir::jsjson::stringify_pretty(&omni_ir::jsjson::JsValue::from(data)).unwrap_or_default()
    } else {
        human()?
    };
    write(&format!("{text}\n"))
}
pub fn color(flags: &Flags, code: &str, text: &str) -> String {
    if !flags.contains_key("no-color")
        && std::env::var("NO_COLOR").unwrap_or_default().is_empty()
        && std::io::stdout().is_terminal()
    {
        format!("\x1b[{code}m{text}\x1b[0m")
    } else {
        text.into()
    }
}
pub fn text(v: &Value) -> String {
    v.as_str()
        .map_or_else(|| omni_ir::jsjson::to_string(v), str::to_owned)
}
pub fn usd(v: &Value) -> String {
    let n = v.as_f64().unwrap_or(0.0);
    if n < 1.0 {
        format!("${n:.4}")
    } else {
        format!("${n:.2}")
    }
}
pub fn table(headers: &[&str], rows: Vec<Vec<String>>, right: &[usize]) -> String {
    let mut rows = rows;
    rows.insert(0, headers.iter().map(|s| (*s).into()).collect());
    let widths = (0..headers.len())
        .map(|i| {
            rows.iter()
                .map(|r| crate::output::width(&r[i]))
                .max()
                .unwrap_or(0)
        })
        .collect::<Vec<_>>();
    rows.iter()
        .map(|r| {
            r.iter()
                .enumerate()
                .map(|(i, c)| {
                    let pad = " ".repeat(widths[i].saturating_sub(crate::output::width(c)));
                    if right.contains(&i) {
                        format!("{pad}{c}")
                    } else {
                        format!("{c}{pad}")
                    }
                })
                .collect::<Vec<_>>()
                .join("  ")
                .trim_end()
                .to_owned()
        })
        .collect::<Vec<_>>()
        .join("\n")
}
pub fn number(flags: &Flags, name: &str, default: f64) -> Result<f64, Error> {
    flags
        .get(name)
        .filter(|s| !s.trim().is_empty())
        .map_or(Ok(default), |s| {
            let n = omni_ir::js::string_to_number(s);
            if n.is_finite() {
                Ok(n)
            } else {
                Err(usage(format!("--{name} must be a number, got \"{s}\"")))
            }
        })
}
fn instant(raw: &str) -> Result<String, Error> {
    if !raw.is_empty() && raw.bytes().all(|b| b.is_ascii_digit()) {
        return Ok(raw.into());
    }
    crate::date::parse(raw)
        .map(|n| n.to_string())
        .ok_or_else(|| usage(format!("could not read \"{raw}\" as a time")))
}
fn query(flags: &Flags) -> Result<String, Error> {
    let mut q = url::form_urlencoded::Serializer::new(String::new());
    for (flag, key) in [
        ("since", "since"),
        ("until", "until"),
        ("state", "state"),
        ("provider", "provider"),
        ("model", "model"),
        ("requested-model", "requestedModel"),
        ("resolved-model", "resolvedModel"),
        ("account", "credentialId"),
        ("key", "apiKeyId"),
        ("error-code", "errorCode"),
        ("cursor", "cursor"),
        ("grain", "grain"),
        ("by", "groupBy"),
        ("split", "splitBy"),
        ("format", "format"),
    ] {
        if let Some(v) = flags.get(flag) {
            q.append_pair(
                key,
                &if matches!(flag, "since" | "until") {
                    instant(v)?
                } else {
                    v.clone()
                },
            );
        }
    }
    if flags.contains_key("failed") {
        q.append_pair("failed", "true");
    }
    Ok(q.finish())
}
fn parsed(raw: String) -> Result<Value, Error> {
    serde_json::from_str(&raw).map_err(fail)
}
fn log_table(flags: &Flags, rows: &[Value]) -> String {
    table(
        &["AT", "MODEL", "RESOLVED", "STATUS", "TOKENS", "COST", "MS"],
        rows.iter()
            .map(|r| {
                vec![
                    color(flags, "2", &crate::output::time(&r["at"])),
                    text(&r["requestedModel"]),
                    format!(
                        "{}/{}",
                        text(&r["resolvedProvider"]),
                        text(&r["resolvedModel"])
                    ),
                    color(
                        flags,
                        if r["status"].as_f64().unwrap_or(0.0) < 400.0 {
                            "32"
                        } else {
                            "31"
                        },
                        &text(&r["status"]),
                    ),
                    format!("{}+{}", text(&r["inputTokens"]), text(&r["outputTokens"])),
                    usd(&r["costUsd"]),
                    text(&r["durationMs"]),
                ]
            })
            .collect(),
        &[3, 4, 5, 6],
    )
}
pub fn run(command: &str, flags: &Flags, positional: &[String]) -> Result<String, Error> {
    match command {
        "console" => crate::console::run(flags, false)?,
        "logs" if flags.contains_key("service") => crate::console::run(flags, true)?,
        "bodies" => crate::bodies::run(flags, positional)?,
        c if c.starts_with("quota") => crate::quota::run(command, flags, positional)?,
        _ => {
            let store = crate::context::open(flags).map_err(fail)?;
            let raw = query(flags)?;
            if command == "logs-export" {
                let (raw, jsonl) = omni_control::logs::export_query(&raw).map_err(control)?;
                let mut q = omni_control::logs::parse_query(&raw).map_err(control)?;
                if !jsonl {
                    write(omni_control::logs::CSV_HEADER)?;
                }
                loop {
                    let (chunk, next) =
                        omni_control::logs::export_page(&store, &q, jsonl).map_err(control)?;
                    write(&chunk)?;
                    let Some(next) = next else { break };
                    q = next;
                }
            } else if command == "usage" {
                let data = parsed(
                    omni_control::reports::usage(
                        &store,
                        &raw,
                        chrono::Utc::now().timestamp_millis() as f64,
                    )
                    .map_err(control)?,
                )?;
                emit(flags, &data, || {
                    let rows = data["rows"]
                        .as_array()
                        .ok_or_else(|| fail("invalid usage rows"))?;
                    if rows.is_empty() {
                        return Ok("no usage in this window".into());
                    }
                    let split = rows.iter().any(|r| !r["split"].is_null());
                    let mut headers = vec!["KEY"];
                    if split {
                        headers.push("SPLIT");
                    }
                    headers.extend(["REQUESTS", "INPUT", "OUTPUT", "COST"]);
                    let right = (headers.len() - 4..headers.len()).collect::<Vec<_>>();
                    Ok(table(
                        &headers,
                        rows.iter()
                            .map(|r| {
                                let mut cells = vec![text(&r["key"])];
                                if split {
                                    cells.push(if r["split"].is_null() {
                                        "—".into()
                                    } else {
                                        text(&r["split"])
                                    });
                                }
                                cells.extend([
                                    text(&r["requests"]),
                                    text(&r["inputTokens"]),
                                    text(&r["outputTokens"]),
                                    usd(&r["costUsd"]),
                                ]);
                                cells
                            })
                            .collect(),
                        &right,
                    ))
                })?;
            } else {
                let limit = number(flags, "number", 20.0)?;
                let raw = format!("{raw}&limit={limit}");
                let first = parsed(omni_control::logs::page(&store, &raw).map_err(control)?)?;
                let rows = first["logs"]
                    .as_array()
                    .ok_or_else(|| fail("invalid log page"))?;
                emit(flags, &first, || {
                    Ok(if rows.is_empty() {
                        "no requests match".into()
                    } else if first["nextCursor"].is_null() {
                        log_table(flags, rows)
                    } else {
                        format!(
                            "{}\n{}",
                            log_table(flags, rows),
                            color(
                                flags,
                                "2",
                                &format!("older: --cursor {}", text(&first["nextCursor"]))
                            )
                        )
                    })
                })?;
                if flags.contains_key("follow") && !flags.contains_key("json") {
                    // A supplied cursor selects only the initial page; follow
                    // always starts each poll at the head of the same filters.
                    let mut follow_flags = flags.clone();
                    follow_flags.remove("cursor");
                    let raw = format!("{}&limit={limit}", query(&follow_flags)?);
                    let mut mark = rows.first().cloned();
                    loop {
                        std::thread::sleep(std::time::Duration::from_secs(2));
                        let mut cursor = None;
                        let mut fresh = Vec::new();
                        let mut skipped = true;
                        for _ in 0..10 {
                            let q = if let Some(c) = &cursor {
                                format!("{raw}&cursor={c}")
                            } else {
                                raw.clone()
                            };
                            let page =
                                parsed(omni_control::logs::page(&store, &q).map_err(control)?)?;
                            let rows = page["logs"]
                                .as_array()
                                .ok_or_else(|| fail("invalid log page"))?;
                            let kept = rows
                                .iter()
                                .filter(|r| mark.as_ref().is_none_or(|m| after(r, m)))
                                .cloned()
                                .collect::<Vec<_>>();
                            let done = mark.is_none()
                                || kept.len() < rows.len()
                                || page["nextCursor"].is_null();
                            fresh.extend(kept);
                            if done {
                                skipped = false;
                                break;
                            }
                            cursor = page["nextCursor"].as_str().map(str::to_owned);
                        }
                        if fresh.is_empty() {
                            continue;
                        }
                        mark = fresh.first().cloned();
                        if skipped {
                            write(&format!(
                                "{}\n",
                                color(
                                    flags,
                                    "2",
                                    &format!(
                                        "more than {} requests arrived since the last poll; older ones are not shown",
                                        10.0 * limit
                                    )
                                )
                            ))?;
                        }
                        fresh.reverse();
                        write(&format!("{}\n", log_table(flags, &fresh)))?;
                    }
                }
            }
        }
    }
    Ok(String::new())
}
fn after(row: &Value, mark: &Value) -> bool {
    row["at"].as_f64() > mark["at"].as_f64()
        || (row["at"] == mark["at"] && row["id"].as_str() > mark["id"].as_str())
}

#[cfg(test)]
mod tests {
    #[test]
    fn watermark_keeps_same_millisecond_ids() {
        use serde_json::json;
        assert!(super::after(
            &json!({"at":1,"id":"b"}),
            &json!({"at":1,"id":"a"})
        ));
        assert!(!super::after(
            &json!({"at":1,"id":"a"}),
            &json!({"at":1,"id":"a"})
        ));
    }
}

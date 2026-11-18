//! Bounded reverse-tail reader, independent of gateway/lifecycle ownership.
use crate::observability::{Error, Flags, color, emit, fail, number, usage, write};
use serde_json::{Value, json};
use std::{
    io::{Read, Seek, SeekFrom},
    path::PathBuf,
    process::Command,
};
enum Source {
    File(PathBuf),
    Journal(bool),
    None,
}
fn source(ctx: &crate::context::Context, flags: &Flags) -> Source {
    let home = std::env::home_dir().unwrap_or_default();
    let system = flags.contains_key("system");
    let installed = if system {
        PathBuf::from("/etc/systemd/system/omnigateway.service")
    } else {
        home.join(".config/systemd/user/omnigateway.service")
    }
    .exists();
    if let Some(file) = ctx
        .env
        .get("OMNI_LOG_FILE")
        .map(|s| s.trim())
        .filter(|s| !s.is_empty() && PathBuf::from(s).exists())
    {
        return Source::File(file.into());
    }
    if installed {
        return Source::Journal(system);
    }
    let file = ctx
        .env
        .get("XDG_STATE_HOME")
        .filter(|s| !s.is_empty())
        .map_or_else(|| home.join(".local/state"), PathBuf::from)
        .join("omnigateway/gateway.log");
    if file.exists() {
        Source::File(file)
    } else {
        Source::None
    }
}
fn hint(source: &Source) -> String {
    match source {
        Source::File(p) => format!("{} (named by OMNI_LOG_FILE)", p.display()),
        Source::Journal(_) => "systemd journal for omnigateway.service".into(),
        Source::None => "not captured — run under systemd, or start it with `omni start`".into(),
    }
}
fn tail(path: &PathBuf, lines: usize) -> Result<String, Error> {
    let mut file = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(String::new()),
        Err(e) => return Err(fail(omni_control::fs_error::fs_error(&e, "open", path))),
    };
    let mut at = file.seek(SeekFrom::End(0)).map_err(fail)?;
    let mut chunks = Vec::new();
    let mut count = 0;
    while at > 0 && count <= lines {
        let size = at.min(8192) as usize;
        at -= size as u64;
        file.seek(SeekFrom::Start(at)).map_err(fail)?;
        let mut chunk = vec![0; size];
        file.read_exact(&mut chunk).map_err(fail)?;
        count += chunk.iter().filter(|b| **b == b'\n').count();
        chunks.push(chunk);
    }
    chunks.reverse();
    let bytes = chunks.concat();
    let text = String::from_utf8_lossy(&bytes);
    let rows = text.split('\n').collect::<Vec<_>>();
    let trailing = usize::from(rows.last() == Some(&""));
    Ok(rows[rows.len().saturating_sub(lines + trailing)..].join("\n"))
}
fn strip_ansi(raw: &str) -> String {
    let mut result = String::new();
    let mut chars = raw.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\x1b' && chars.peek() == Some(&'[') {
            chars.next();
            for c in chars.by_ref() {
                if c == 'm' {
                    break;
                }
            }
        } else {
            result.push(c)
        }
    }
    result
}
fn line(raw: &str) -> Value {
    let plain = strip_ansi(raw);
    let absent = json!({"raw":raw,"at":null,"level":null,"msg":null});
    let Some((instant, rest)) = plain.split_once(' ') else {
        return absent;
    };
    let Some((level, tail)) = rest.split_once(' ') else {
        return absent;
    };
    if !matches!(level, "DEBUG" | "INFO" | "WARN" | "ERROR") {
        return absent;
    }
    let Some(at) = crate::date::parse(instant) else {
        return absent;
    };
    let tail = tail.strip_prefix(' ').unwrap_or(tail);
    let mut end = tail.len();
    for (i, _) in tail.match_indices("  ") {
        let candidate = &tail[i + 2..];
        let letters = candidate
            .bytes()
            .take_while(u8::is_ascii_alphabetic)
            .count();
        if letters > 0 && candidate.as_bytes().get(letters) == Some(&b'=') {
            end = i;
            break;
        }
    }
    json!({"raw":raw,"at":at,"level":level.to_lowercase(),"msg":&tail[..end]})
}
fn rank(s: &str) -> usize {
    match s {
        "debug" => 10,
        "info" => 20,
        "warn" => 30,
        "error" => 40,
        _ => 0,
    }
}
fn read(
    source: &Source,
    lines: usize,
    level: Option<&str>,
    since: Option<f64>,
) -> Result<Value, Error> {
    let scan = if level.is_some() || since.is_some() {
        (lines * 20).min(5000)
    } else {
        lines
    };
    let text = match source {
        Source::None => String::new(),
        Source::File(p) => tail(p, scan)?,
        Source::Journal(system) => {
            let mut c = Command::new("journalctl");
            if *system {
                c.args(["-u", "omnigateway.service"]);
            } else {
                c.arg("--user-unit=omnigateway.service");
            }
            c.args(["-n", &scan.to_string(), "--no-pager", "--output=cat"]);
            match c.output() {
                Ok(out) if out.status.success() => {
                    String::from_utf8_lossy(&out.stdout).into_owned()
                }
                _ => String::new(),
            }
        }
    };
    let mut rows = text
        .split('\n')
        .filter(|s| !s.trim().is_empty())
        .map(line)
        .filter(|r| {
            since.is_none_or(|s| r["at"].as_f64().is_some_and(|at| at > s))
                && level.is_none_or(|l| r["level"].as_str().is_none_or(|got| rank(got) >= rank(l)))
        })
        .collect::<Vec<_>>();
    if rows.len() > lines {
        rows.drain(..rows.len() - lines);
    }
    Ok(match source {
        Source::File(p) => json!({"source":"file","path":p,"lines":rows}),
        Source::Journal(_) => json!({"source":"journal","lines":rows}),
        Source::None => json!({"source":"none","lines":rows}),
    })
}
fn render(flags: &Flags, rows: &[Value]) -> String {
    rows.iter()
        .map(|r| {
            let raw = r["raw"].as_str().unwrap_or("");
            match r["level"].as_str() {
                Some("debug") => color(flags, "2", raw),
                Some("warn") => color(flags, "33", raw),
                Some("error") => color(flags, "31", raw),
                _ => raw.into(),
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}
pub fn run(flags: &Flags, alias: bool) -> Result<(), Error> {
    let lines = number(flags, "number", if alias { 20.0 } else { 50.0 })?
        .clamp(1.0, 500.0)
        .floor() as usize;
    let level = flags.get("level").map(|s| s.trim().to_lowercase());
    if let Some(l) = &level
        && rank(l) == 0
    {
        return Err(usage(format!(
            "unknown level \"{}\"; use debug, info, warn or error",
            flags["level"]
        )));
    }
    let ctx = crate::context::resolve(flags).map_err(fail)?;
    let source = source(&ctx, flags);
    let first = read(&source, lines, level.as_deref(), None)?;
    let rows = first["lines"]
        .as_array()
        .ok_or_else(|| fail("invalid console lines"))?;
    if alias {
        let text = rows
            .iter()
            .map(|r| r["raw"].as_str().unwrap_or(""))
            .collect::<Vec<_>>()
            .join("\n");
        return emit(flags, &json!({"log":text}), || {
            Ok(if text.is_empty() {
                "no service output yet".into()
            } else {
                text
            })
        });
    }
    emit(flags, &first, || {
        Ok(if rows.is_empty() {
            match &source{Source::None=>"this gateway's output is not being captured, so there is nothing to show.\nrun it in the foreground and its output goes to your terminal instead.\nto capture it: `omni service install`, or `omni start`, which redirects\noutput to a file and points OMNI_LOG_FILE at it.".into(),_=>format!("no output yet in {}",hint(&source))}
        } else {
            render(flags, rows)
        })
    })?;
    if !flags.contains_key("json") && !rows.is_empty() {
        eprintln!(
            "{}",
            color(flags, "2", &format!("reading {}", hint(&source)))
        );
    }
    if flags.contains_key("follow") && !flags.contains_key("json") {
        let mut seen = rows.last().and_then(|r| r["at"].as_f64()).unwrap_or(0.0);
        loop {
            std::thread::sleep(std::time::Duration::from_secs(2));
            let next = read(&source, lines, level.as_deref(), Some(seen))?;
            let rows = next["lines"]
                .as_array()
                .ok_or_else(|| fail("invalid console lines"))?;
            if rows.is_empty() {
                continue;
            }
            seen = rows.last().and_then(|r| r["at"].as_f64()).unwrap_or(seen);
            write(&format!("{}\n", render(flags, rows)))?;
        }
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    #[test]
    fn parses_fields_and_preserves_crash() {
        assert_eq!(
            super::line("runtime stack")["level"],
            serde_json::Value::Null
        );
        let row = super::line("2026-01-01T00:00:00.000Z INFO  ready  port=1");
        assert_eq!(row["msg"], "ready");
        assert_eq!(row["level"], "info");
    }
    #[test]
    fn reverse_tail_returns_requested_lines_with_or_without_final_newline() {
        let path = std::env::temp_dir().join(format!("e3-tail-{}", std::process::id()));
        for ending in ["", "\n"] {
            std::fs::write(&path, format!("old\nsecond\nnew{ending}")).expect("fixture");
            assert_eq!(
                super::tail(&path, 2).expect("tail"),
                format!("second\nnew{ending}")
            );
        }
        std::fs::remove_file(path).expect("remove own fixture");
    }
}

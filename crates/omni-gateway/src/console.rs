//! Captured stdout reader. The logger itself is deliberately unchanged.
use serde_json::{Value, json};
use std::io::{Read, Seek, SeekFrom};
use std::sync::Arc;

const MAX_BYTES: u64 = 8 * 1024 * 1024;
#[derive(Clone, Debug, Default)]
pub enum Source {
    #[default]
    None,
    File(String),
    Journal {
        user: bool,
    },
}
impl Source {
    pub fn resolve() -> Self {
        if let Ok(path) = std::env::var("OMNI_LOG_FILE") {
            let path = path.trim();
            if !path.is_empty() {
                return Self::File(path.into());
            }
        }
        if std::env::var_os("JOURNAL_STREAM").is_some() {
            Self::Journal {
                user: std::env::var_os("MANAGERPID").is_some(),
            }
        } else {
            Self::None
        }
    }
    pub fn read(&self, query: &Query) -> Value {
        let width = if query.level.is_some() || query.since.is_some() {
            (query.lines * 20).min(5000)
        } else {
            query.lines
        };
        let text = match self {
            Self::None => String::new(),
            Self::File(path) => tail(path, width).unwrap_or_default(),
            Self::Journal { user } => {
                let mut command = std::process::Command::new("journalctl");
                if *user {
                    command.arg("--user-unit=omnigateway.service");
                } else {
                    command.args(["-u", "omnigateway.service"]);
                }
                command.args(["-n", &width.to_string(), "--no-pager", "--output=cat"]);
                command
                    .output()
                    .ok()
                    .filter(|o| o.status.success())
                    .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
                    .unwrap_or_default()
            }
        };
        let lines = parse(&text, query);
        match self {
            Self::File(path) => json!({"source":"file","path":path,"lines":lines}),
            Self::Journal { .. } => json!({"source":"journal","lines":lines}),
            Self::None => json!({"source":"none","lines":lines}),
        }
    }
}

#[derive(Debug)]
pub struct Query {
    lines: usize,
    level: Option<usize>,
    since: Option<f64>,
}
fn number(s: &str) -> Option<f64> {
    if s.trim().is_empty() {
        return None;
    }
    let n = omni_ir::js::string_to_number(s);
    n.is_finite().then_some(n)
}
impl Query {
    pub fn from_query(raw: &str) -> Self {
        let pairs: Vec<_> = url::form_urlencoded::parse(raw.as_bytes()).collect();
        let get = |key| {
            pairs
                .iter()
                .find(|(k, _)| k == key)
                .map(|(_, v)| v.as_ref())
        };
        Self {
            lines: get("lines")
                .and_then(number)
                .unwrap_or(200.)
                .clamp(1., 500.)
                .floor() as usize,
            level: get("level").and_then(|s| level(&s.trim().to_lowercase())),
            since: get("since").and_then(number).filter(|n| *n > 0.),
        }
    }
}
fn level(s: &str) -> Option<usize> {
    ["debug", "info", "warn", "error"]
        .iter()
        .position(|v| *v == s)
}

fn parse_line(raw: &str) -> Value {
    let absent = || json!({"raw":raw,"at":null,"level":null,"msg":null});
    // Only SGR escapes are stripped by the frozen parser.
    let mut clean = String::new();
    let mut rest = raw;
    while let Some(i) = rest.find('\u{1b}') {
        clean.push_str(&rest[..i]);
        let suffix = &rest[i + 1..];
        if let Some(suffix) = suffix.strip_prefix('[') {
            let n = suffix
                .bytes()
                .take_while(|b| b.is_ascii_digit() || *b == b';')
                .count();
            if suffix.as_bytes().get(n) == Some(&b'm') {
                rest = &suffix[n + 1..];
                continue;
            }
        }
        clean.push('\u{1b}');
        rest = suffix;
    }
    clean.push_str(rest);
    let Some((instant, tail)) = clean.split_once(' ') else {
        return absent();
    };
    let Some((label, tail)) = tail.split_once(' ') else {
        return absent();
    };
    if !matches!(label, "DEBUG" | "INFO" | "WARN" | "ERROR") {
        return absent();
    }
    let Ok(at) = chrono::DateTime::parse_from_rfc3339(instant) else {
        return absent();
    };
    let tail = tail.strip_prefix(' ').unwrap_or(tail);
    let mut msg = tail;
    for (i, _) in tail.match_indices("  ") {
        let after = &tail[i + 2..];
        let n = after.bytes().take_while(u8::is_ascii_alphabetic).count();
        if n > 0 && after.as_bytes().get(n) == Some(&b'=') {
            msg = &tail[..i];
            break;
        }
    }
    json!({"raw":raw,"at":at.timestamp_millis(),"level":label.to_lowercase(),"msg":msg})
}
fn parse(text: &str, q: &Query) -> Vec<Value> {
    let mut lines: Vec<_> = text
        .split('\n')
        .filter(|raw| !raw.trim().is_empty())
        .map(parse_line)
        .filter(|line| {
            q.since
                .is_none_or(|since| line["at"].as_f64().is_some_and(|at| at > since))
        })
        .filter(|line| {
            q.level.is_none_or(|min| {
                line["level"]
                    .as_str()
                    .and_then(level)
                    .is_none_or(|v| v >= min)
            })
        })
        .collect();
    if lines.len() > q.lines {
        lines.drain(..lines.len() - q.lines);
    }
    lines
}
fn tail(path: &str, lines: usize) -> Option<String> {
    let mut file = std::fs::File::open(path).ok()?;
    let size = file.metadata().ok()?.len();
    let budget = size.min(MAX_BYTES);
    let mut read = 0;
    let mut newlines = 0;
    let mut chunks = Vec::new();
    while read < budget && newlines <= lines {
        let span = (budget - read).min(65536);
        let mut chunk = vec![0; span as usize];
        file.seek(SeekFrom::Start(size - read - span)).ok()?;
        file.read_exact(&mut chunk).ok()?;
        newlines += chunk.iter().filter(|b| **b == b'\n').count();
        chunks.push(chunk);
        read += span;
    }
    let bytes: Vec<_> = chunks.into_iter().rev().flatten().collect();
    Some(String::from_utf8_lossy(&bytes).into_owned())
}

fn publish(hub: &crate::stream_transport::Hub, topics: &[String], lines: Vec<Value>, reset: bool) {
    if !lines.is_empty() {
        let payload = json!({"lines":lines});
        for topic in topics {
            hub.publish(topic, payload.clone(), None);
        }
    }
    if reset {
        for topic in topics {
            hub.reset(topic);
        }
    }
}

pub fn start(hub: Arc<crate::stream_transport::Hub>, node: &str) -> tokio::task::JoinHandle<()> {
    let topics = vec!["stream:console".into(), format!("stream:console:{node}")];
    tokio::spawn(async move {
        match hub.console.clone() {
            Source::None => {}
            Source::Journal { .. } => {
                for topic in &topics {
                    hub.declare(topic);
                }
                let mut cursor = crate::clock::now_ms() as f64;
                let mut seen = std::collections::HashSet::new();
                loop {
                    tokio::time::sleep(std::time::Duration::from_millis(1000)).await;
                    let source = hub.console.clone();
                    let q = Query {
                        lines: 500,
                        level: None,
                        since: Some(cursor - 1.),
                    };
                    let Ok(read) = tokio::task::spawn_blocking(move || source.read(&q)).await
                    else {
                        continue;
                    };
                    let lines: Vec<_> = read["lines"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter(|l| {
                            l["at"].as_f64() != Some(cursor)
                                || !seen.contains(l["raw"].as_str().unwrap_or(""))
                        })
                        .cloned()
                        .collect();
                    let newest = lines
                        .iter()
                        .filter_map(|l| l["at"].as_f64())
                        .fold(cursor, f64::max);
                    if newest > cursor {
                        seen.clear();
                        cursor = newest;
                    }
                    for line in &lines {
                        if line["at"].as_f64() == Some(cursor) {
                            seen.insert(line["raw"].as_str().unwrap_or("").to_owned());
                        }
                    }
                    publish(&hub, &topics, lines, false);
                }
            }
            Source::File(path) => file_stream(hub, topics, path).await,
        }
    })
}

#[cfg(target_os = "linux")]
async fn file_stream(hub: Arc<crate::stream_transport::Hub>, topics: Vec<String>, path: String) {
    use nix::sys::inotify::{AddWatchFlags as F, InitFlags, Inotify};
    use std::os::fd::{AsFd, AsRawFd};
    struct Watch(Inotify);
    impl AsRawFd for Watch {
        fn as_raw_fd(&self) -> std::os::fd::RawFd {
            self.0.as_fd().as_raw_fd()
        }
    }
    impl AsFd for Watch {
        fn as_fd(&self) -> std::os::fd::BorrowedFd<'_> {
            self.0.as_fd()
        }
    }
    let watch = || -> Option<_> {
        let io = Inotify::init(InitFlags::IN_NONBLOCK | InitFlags::IN_CLOEXEC).ok()?;
        io.add_watch(
            path.as_str(),
            F::IN_MODIFY | F::IN_MOVE_SELF | F::IN_DELETE_SELF | F::IN_ATTRIB,
        )
        .ok()?;
        // Watch owns its descriptor for the full AsyncFd lifetime. The newer
        // register API requires unsafe; keep this safe owning adapter instead.
        #[allow(deprecated)]
        tokio::io::unix::AsyncFd::new(Watch(io)).ok()
    };
    let mut offset = std::fs::metadata(&path).map_or(0, |m| m.len());
    let Some(mut watcher) = watch() else {
        return;
    };
    for topic in &topics {
        hub.declare(topic);
    }
    let mut next = tokio::time::Instant::now();
    let mut rotated = false;
    loop {
        let Ok(mut ready) = watcher.readable().await else {
            return;
        };
        let events =
            match ready.try_io(|io| io.get_ref().0.read_events().map_err(std::io::Error::from)) {
                Ok(Ok(events)) => events,
                Ok(Err(_)) => return,
                Err(_) => continue,
            };
        if events
            .iter()
            .any(|e| e.mask.intersects(F::IN_MOVE_SELF | F::IN_DELETE_SELF))
        {
            offset = 0;
            rotated = true;
            let mut replacement = watch();
            for _ in 0..5 {
                if replacement.is_some() {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(250)).await;
                replacement = watch();
            }
            let Some(replacement) = replacement else {
                tracing::warn!("console stream ended");
                return;
            };
            watcher = replacement;
        }
        tokio::time::sleep_until(next).await;
        let target = path.clone();
        let read = tokio::task::spawn_blocking(move || -> Option<_> {
            let mut file = std::fs::File::open(target).ok()?;
            let size = file.metadata().ok()?.len();
            let shrank = size < offset;
            let from = if shrank { 0 } else { offset };
            let start = from.max(size.saturating_sub(MAX_BYTES));
            file.seek(SeekFrom::Start(start)).ok()?;
            let mut bytes = vec![0; (size - start) as usize];
            let n = file.read(&mut bytes).ok()?;
            bytes.truncate(n);
            Some((
                String::from_utf8_lossy(&bytes).into_owned(),
                start + n as u64,
                shrank || start > from,
            ))
        })
        .await;
        if let Ok(Some((text, end, gap))) = read {
            offset = end;
            publish(
                &hub,
                &topics,
                parse(
                    &text,
                    &Query {
                        lines: 500,
                        level: None,
                        since: None,
                    },
                ),
                gap || rotated,
            );
            rotated = false;
        }
        next = tokio::time::Instant::now() + std::time::Duration::from_millis(250);
    }
}
#[cfg(not(target_os = "linux"))]
async fn file_stream(_: Arc<crate::stream_transport::Hub>, _: Vec<String>, _: String) {}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn console_query_parse_and_tail() {
        let q = Query::from_query("lines=1.9&level=error&since=1");
        let lines = parse(
            "unparsed\n2026-11-18T00:00:00.000Z INFO  skip\n2026-11-18T00:00:00.001Z ERROR failed  reason=x\n",
            &q,
        );
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0]["msg"], "failed");
        assert_eq!(Query::from_query("lines=oops").lines, 200);
        assert_eq!(Query::from_query("lines=%20").lines, 200);
        assert_eq!(Query::from_query("lines=0").lines, 1);
        assert_eq!(Query::from_query("lines=999").lines, 500);
        assert_eq!(Source::None.read(&q), json!({"source":"none","lines":[]}));
    }
}

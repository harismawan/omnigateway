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

#[derive(Debug, Clone)]
pub struct Query {
    lines: usize,
    level: Option<usize>,
    since: Option<f64>,
}

/// Addressed console reads over the shared coordinator. Inbound work is bounded;
/// absent nodes time out instead of silently returning this process's source.
pub struct Fleet {
    coord: Arc<dyn omni_coord::Coord>,
    node: String,
    source: Source,
    subscription: std::sync::Mutex<Option<omni_coord::Subscription>>,
    worker: tokio::task::JoinHandle<()>,
}

impl Fleet {
    pub fn new(coord: Arc<dyn omni_coord::Coord>, node: String, source: Source) -> Self {
        let (tx, mut rx) = tokio::sync::mpsc::channel::<(String, Query)>(32);
        let target = node.clone();
        let subscription = coord.subscribe(
            "console:read",
            Arc::new(move |_, raw| {
                let Ok(ask) = serde_json::from_str::<Value>(raw) else {
                    return;
                };
                if ask["nodeId"].as_str() != Some(target.as_str()) {
                    return;
                }
                let Some(id) = ask["id"].as_str() else {
                    return;
                };
                let query = &ask["query"];
                let lines = query["lines"].as_u64().unwrap_or(200).clamp(1, 500) as usize;
                let level = query["level"].as_str().and_then(level);
                let since = query["since"]
                    .as_f64()
                    .filter(|v| v.is_finite() && *v > 0.0);
                let _queued = tx.try_send((
                    id.to_owned(),
                    Query {
                        lines,
                        level,
                        since,
                    },
                ));
            }),
        );
        let worker_coord = coord.clone();
        let worker_source = source.clone();
        let worker = tokio::spawn(async move {
            while let Some((id, query)) = rx.recv().await {
                let source = worker_source.clone();
                if let Ok(read) = tokio::task::spawn_blocking(move || source.read(&query)).await {
                    worker_coord
                        .publish(&format!("console:answer:{id}"), &read.to_string())
                        .await;
                }
            }
        });
        Self {
            coord,
            node,
            source,
            subscription: std::sync::Mutex::new(Some(subscription)),
            worker,
        }
    }

    pub async fn read(
        &self,
        node: &str,
        query: Query,
    ) -> Result<Value, omni_ir::error::GatewayError> {
        self.read_with_timeout(node, query, std::time::Duration::from_secs(3))
            .await
    }

    pub async fn read_with_timeout(
        &self,
        node: &str,
        query: Query,
        timeout: std::time::Duration,
    ) -> Result<Value, omni_ir::error::GatewayError> {
        self.read_before(node, query, tokio::time::Instant::now() + timeout)
            .await
    }

    async fn read_before(
        &self,
        node: &str,
        query: Query,
        deadline: tokio::time::Instant,
    ) -> Result<Value, omni_ir::error::GatewayError> {
        if node == self.node {
            let source = self.source.clone();
            return tokio::task::spawn_blocking(move || source.read(&query))
                .await
                .map_err(|_| {
                    omni_ir::error::GatewayError::new(
                        omni_ir::error::ErrorCode::Internal,
                        "console read failed",
                    )
                });
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(remote_timeout());
        }
        let id = crate::clock::uuid_v4();
        let (tx, mut rx) = tokio::sync::mpsc::channel(1);
        let _subscription = self.coord.subscribe(
            &format!("console:answer:{id}"),
            Arc::new(move |_, raw| {
                if let Ok(value) = serde_json::from_str::<Value>(raw) {
                    let _sent = tx.try_send(value);
                }
            }),
        );
        let level = query.level.map(|i| ["debug", "info", "warn", "error"][i]);
        let ask = json!({"id":id,"nodeId":node,"query":{"lines":query.lines,"level":level,"since":query.since}});
        tokio::time::timeout_at(deadline, async {
            let payload = ask.to_string();
            tokio::select! {
                answer = rx.recv() => answer,
                () = self.coord.publish("console:read", &payload) => rx.recv().await,
            }
        })
        .await
        .ok()
        .flatten()
        .ok_or_else(remote_timeout)
    }

    pub async fn read_all_with_timeout(
        &self,
        nodes: &[String],
        query: Query,
        timeout: std::time::Duration,
    ) -> Result<Value, omni_ir::error::GatewayError> {
        use futures_util::{StreamExt as _, stream};
        let deadline = tokio::time::Instant::now() + timeout;
        // Keep the local read out of the remote fanout queue. A fleet with
        // many unreachable peers must still return the local answer.
        let requests = nodes
            .iter()
            .filter(|node| **node != self.node)
            .map(|node| (node.clone(), query.clone()))
            .collect::<Vec<_>>();
        let remote = stream::iter(requests)
            .map(|(node, query)| async move {
                let read = self.read_before(&node, query, deadline).await;
                (node, read)
            })
            .buffer_unordered(16)
            .collect::<Vec<_>>();
        let local = async {
            if nodes.contains(&self.node) {
                Some((
                    self.node.clone(),
                    self.read_before(&self.node, query.clone(), deadline).await,
                ))
            } else {
                None
            }
        };
        let (reads, local) = tokio::join!(remote, local);
        let mut lines = Vec::new();
        let mut unreachable = Vec::new();
        let mut answered = 0;
        let mut captured = false;
        for (node, read) in reads.into_iter().chain(local) {
            match read {
                Err(_) => unreachable.push(node),
                Ok(read) => {
                    answered += 1;
                    captured |= read["source"] != "none";
                    if let Some(rows) = read["lines"].as_array() {
                        for line in rows {
                            let mut line = line.clone();
                            line["nodeId"] = json!(node);
                            lines.push(line);
                        }
                    }
                }
            }
        }
        if answered == 0 {
            return Err(omni_ir::error::GatewayError::new(
                omni_ir::error::ErrorCode::Timeout,
                "no process in the fleet answered a console read",
            ));
        }
        lines.sort_by(|a, b| match (a["at"].as_f64(), b["at"].as_f64()) {
            (Some(a), Some(b)) => a.total_cmp(&b),
            (Some(_), None) => std::cmp::Ordering::Less,
            (None, Some(_)) => std::cmp::Ordering::Greater,
            (None, None) => std::cmp::Ordering::Equal,
        });
        if lines.len() > query.lines {
            lines.drain(..lines.len() - query.lines);
        }
        unreachable.sort();
        let mut result = json!({"source":if captured { "fleet" } else { "none" },"lines":lines});
        if !unreachable.is_empty() {
            result["unreachable"] = json!(unreachable);
        }
        Ok(result)
    }

    pub fn stop(&self) {
        self.subscription
            .lock()
            .expect("console subscription")
            .take();
        self.worker.abort();
    }
}

fn remote_timeout() -> omni_ir::error::GatewayError {
    omni_ir::error::GatewayError::new(
        omni_ir::error::ErrorCode::Timeout,
        "that gateway process did not answer",
    )
}
impl Drop for Fleet {
    fn drop(&mut self) {
        self.stop();
    }
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
    // Only SGR escapes are stripped by the parser.
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
    if clean.contains(['\r', '\n', '\u{2028}', '\u{2029}']) {
        return absent();
    }
    let Some((instant, tail)) = clean.split_once(' ') else {
        return absent();
    };
    if instant.is_empty()
        || instant
            .chars()
            .any(|c| omni_ir::js::trim(&c.to_string()).is_empty())
    {
        return absent();
    }
    let Some((label, tail)) = tail.split_once(' ') else {
        return absent();
    };
    if !matches!(label, "DEBUG" | "INFO" | "WARN" | "ERROR") {
        return absent();
    }
    let Some(at) = omni_control::date::parse(instant) else {
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
    json!({"raw":raw,"at":at,"level":label.to_lowercase(),"msg":msg})
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
async fn file_stream(hub: Arc<crate::stream_transport::Hub>, topics: Vec<String>, path: String) {
    portable_file_stream(hub, topics, path).await;
}

// Safe fallback for macOS release targets. Metadata polling costs one stat per
// floor when quiet; unlike a no-op it preserves declaration, deltas and replay.
#[cfg(any(not(target_os = "linux"), test))]
async fn portable_file_stream(
    hub: Arc<crate::stream_transport::Hub>,
    topics: Vec<String>,
    path: String,
) {
    use std::os::unix::fs::MetadataExt;
    let Ok(mut previous) = std::fs::metadata(&path) else {
        return;
    };
    let mut offset = previous.len();
    let mut rotated = false;
    let mut failures = 0;
    for topic in &topics {
        hub.declare(topic);
    }
    loop {
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
        let current = match std::fs::metadata(&path) {
            Ok(metadata) => metadata,
            Err(_) => {
                offset = 0;
                rotated = true;
                failures += 1;
                if failures > 5 {
                    tracing::warn!("console stream ended");
                    return;
                }
                continue;
            }
        };
        failures = 0;
        if current.ino() != previous.ino() || current.dev() != previous.dev() {
            offset = 0;
            rotated = true;
        }
        let changed = rotated
            || current.len() != previous.len()
            || current.mtime() != previous.mtime()
            || current.mtime_nsec() != previous.mtime_nsec();
        previous = current;
        if !changed {
            continue;
        }
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
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn portable_source_append_rotation_truncation() {
        let dir = tempfile::tempdir().expect("scratch");
        let path = dir.path().join("console");
        std::fs::write(&path, "boot\n").expect("seed");
        let hub = Arc::new(crate::stream_transport::Hub::default());
        let topic = "stream:console".to_owned();
        let task = tokio::spawn(portable_file_stream(
            hub.clone(),
            vec![topic.clone()],
            path.to_string_lossy().into_owned(),
        ));
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        std::fs::write(&path, "boot\nappended\n").expect("append");
        tokio::time::sleep(std::time::Duration::from_millis(350)).await;
        assert_eq!(
            hub.replay_for_test(&topic, 0.)["frames"][0]["payload"]["lines"][0]["raw"],
            "appended"
        );
        std::fs::rename(&path, dir.path().join("old")).expect("rotate");
        std::fs::write(&path, "replacement\n").expect("replace");
        tokio::time::sleep(std::time::Duration::from_millis(350)).await;
        assert_eq!(hub.replay_for_test(&topic, 0.)["kind"], "gap");
        std::fs::write(&path, "x\n").expect("truncate");
        tokio::time::sleep(std::time::Duration::from_millis(350)).await;
        assert_eq!(hub.replay_for_test(&topic, 0.)["kind"], "gap");
        task.abort();
        drop(task.await);
    }
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

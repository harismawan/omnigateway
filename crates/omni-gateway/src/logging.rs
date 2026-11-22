//! The stdout logger: `tracing` events rendered as TS's `formatLine`
//! (`packages/ir/src/logger.ts`) writes them:
//!
//! `ISO-INSTANT LEVEL message  key=value key=value`
//!
//! The level is padded to five characters. Fields render in TS's fixed
//! `FIELD_ORDER`, which is also the allowlist: any other field (another
//! crate's diagnostics, or anything that could carry a header or a body) is
//! dropped, as `LogFields` refuses it at the TS API boundary. A string value containing whitespace, `=`
//! or `"` is written as a JSON string. `reason` is capped at 200 UTF-16 units,
//! `model`/`requestedModel` at 120, each with a trailing `…`.

use std::io::Write as _;

use tracing::field::{Field, Visit};
use tracing::{Event, Level, Subscriber};
use tracing_subscriber::Layer;
use tracing_subscriber::layer::Context;

/// TS's `FIELD_ORDER`.
pub const FIELD_ORDER: [&str; 37] = [
    "requestId",
    "surface",
    "status",
    "provider",
    "model",
    "requestedModel",
    "credentialId",
    "apiKeyId",
    "plugin",
    "coord",
    "coordFallback",
    "snapshotId",
    "attempt",
    "attempts",
    "code",
    "retryable",
    "stream",
    "inputTokens",
    "outputTokens",
    "cacheReadTokens",
    "cacheWriteTokens",
    "costUsd",
    "ttftMs",
    "durationMs",
    "retryAfterMs",
    "count",
    "rawCount",
    "dailyCount",
    "quotaSampleCount",
    "cloakedTools",
    "sizeBytes",
    "host",
    "port",
    "dayOffsetMinutes",
    "path",
    "supervisor",
    "reason",
];

fn cap_of(name: &str) -> Option<usize> {
    match name {
        "reason" => Some(200),
        "model" | "requestedModel" => Some(120),
        _ => None,
    }
}

/// A recorded value: strings are quoted when ambiguous, the rest verbatim.
enum Rendered {
    Str(String),
    Raw(String),
}

#[derive(Default)]
struct Fields {
    message: String,
    values: Vec<(&'static str, Rendered)>,
}

impl Visit for Fields {
    fn record_str(&mut self, field: &Field, value: &str) {
        if field.name() == "message" {
            self.message = value.to_owned();
        } else {
            self.values
                .push((field.name(), Rendered::Str(value.to_owned())));
        }
    }

    fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
        let text = format!("{value:?}");
        if field.name() == "message" {
            self.message = text;
        } else {
            self.values.push((field.name(), Rendered::Str(text)));
        }
    }

    fn record_i64(&mut self, field: &Field, value: i64) {
        self.values
            .push((field.name(), Rendered::Raw(value.to_string())));
    }

    fn record_u64(&mut self, field: &Field, value: u64) {
        self.values
            .push((field.name(), Rendered::Raw(value.to_string())));
    }

    fn record_f64(&mut self, field: &Field, value: f64) {
        let mut s = String::new();
        omni_ir::jsjson::write_number(value, &mut s);
        self.values.push((field.name(), Rendered::Raw(s)));
    }

    fn record_bool(&mut self, field: &Field, value: bool) {
        self.values
            .push((field.name(), Rendered::Raw(value.to_string())));
    }
}

fn render_value(name: &str, value: &Rendered, out: &mut String) {
    match value {
        Rendered::Raw(s) => out.push_str(s),
        Rendered::Str(s) => {
            let capped = match cap_of(name) {
                Some(cap) if omni_ir::js::utf16_len(s) > cap => {
                    let mut c = omni_ir::js::utf16_prefix(s, cap).into_owned();
                    c.push('…');
                    c
                }
                _ => s.clone(),
            };
            if capped
                .chars()
                .any(|c| c == '=' || c == '"' || omni_ir::js::is_js_whitespace(c))
            {
                omni_ir::jsjson::write_str(&capped, out);
            } else {
                out.push_str(&capped);
            }
        }
    }
}

/// Renders one line, without the trailing newline. `at_ms` is epoch ms.
pub fn format_line(level: Level, at_ms: i64, message: &str, fields: &[(&str, String)]) -> String {
    let mut f = Fields {
        message: message.to_owned(),
        values: Vec::new(),
    };
    for (k, v) in fields {
        // Leak-free: test helper path only uses static-like names.
        let name: &'static str = FIELD_ORDER
            .iter()
            .find(|n| **n == *k)
            .copied()
            .unwrap_or("unknown");
        f.values.push((name, Rendered::Str(v.clone())));
    }
    render(level, at_ms, &f)
}

fn level_label(level: Level) -> &'static str {
    match level {
        Level::ERROR => "ERROR",
        Level::WARN => "WARN ",
        Level::INFO => "INFO ",
        _ => "DEBUG",
    }
}

fn iso(at_ms: i64) -> String {
    chrono::DateTime::<chrono::Utc>::from_timestamp_millis(at_ms)
        .map(|t| t.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string())
        .unwrap_or_default()
}

fn render(level: Level, at_ms: i64, f: &Fields) -> String {
    let mut line = String::with_capacity(128);
    line.push_str(&iso(at_ms));
    line.push(' ');
    line.push_str(level_label(level));
    line.push(' ');
    line.push_str(&f.message);
    let mut parts = String::new();
    let mut emit = |name: &str, value: &Rendered| {
        if !parts.is_empty() {
            parts.push(' ');
        }
        parts.push_str(name);
        parts.push('=');
        render_value(name, value, &mut parts);
    };
    for name in FIELD_ORDER {
        for (n, v) in &f.values {
            if *n == name {
                emit(n, v);
            }
        }
    }
    if !parts.is_empty() {
        line.push_str("  ");
        line.push_str(&parts);
    }
    line
}

/// Where rendered lines go.
type Sink = Box<dyn Fn(&str) + Send + Sync>;

/// The `tracing` layer writing TS-format lines to stdout at `max` and above.
pub struct TsFormat {
    max: Level,
    sink: Option<Sink>,
}

impl TsFormat {
    pub fn new(max: Level) -> Self {
        Self { max, sink: None }
    }

    /// Lines go to `sink` instead of stdout (tests).
    pub fn with_sink(max: Level, sink: impl Fn(&str) + Send + Sync + 'static) -> Self {
        Self {
            max,
            sink: Some(Box::new(sink)),
        }
    }
}

impl<S: Subscriber> Layer<S> for TsFormat {
    fn enabled(&self, metadata: &tracing::Metadata<'_>, _ctx: Context<'_, S>) -> bool {
        *metadata.level() <= self.max
    }

    fn on_event(&self, event: &Event<'_>, _ctx: Context<'_, S>) {
        let level = *event.metadata().level();
        if level > self.max {
            return;
        }
        let mut f = Fields::default();
        event.record(&mut f);
        let mut line = render(level, crate::clock::now_ms(), &f);
        if let Some(sink) = &self.sink {
            sink(&line);
            return;
        }
        line.push('\n');
        // One write per line; a failed stdout write must never fail the work.
        let stdout = std::io::stdout();
        let mut lock = stdout.lock();
        if lock.write_all(line.as_bytes()).is_err() {
            return;
        }
        if lock.flush().is_err() {
            // Nothing to do: logging never fails the caller.
        }
    }
}

/// `OMNI_LOG_LEVEL` → the `tracing` level.
pub fn level_of(level: omni_gateway_core::config::LogLevel) -> Level {
    use omni_gateway_core::config::LogLevel;
    match level {
        LogLevel::Debug => Level::DEBUG,
        LogLevel::Info => Level::INFO,
        LogLevel::Warn => Level::WARN,
        LogLevel::Error => Level::ERROR,
    }
}

/// Installs the global subscriber. Safe to call once.
pub fn install(max: Level) {
    use tracing_subscriber::layer::SubscriberExt as _;
    let subscriber = tracing_subscriber::registry().with(TsFormat::new(max));
    if tracing::subscriber::set_global_default(subscriber).is_err() {
        // Already installed (tests): keep the first.
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fields_outside_the_allowlist_never_reach_the_line() {
        use tracing_subscriber::layer::SubscriberExt as _;
        let lines = std::sync::Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
        let seen = lines.clone();
        let layer = TsFormat::with_sink(Level::DEBUG, move |l| {
            seen.lock().expect("lines").push(l.to_owned());
        });
        let subscriber = tracing_subscriber::registry().with(layer);
        tracing::subscriber::with_default(subscriber, || {
            tracing::warn!(
                authorization = "Bearer sk-secret",
                body = "prompt text",
                requestId = "req_1",
                "request rejected"
            );
        });
        let lines = lines.lock().expect("lines");
        assert_eq!(lines.len(), 1);
        assert!(
            lines[0].ends_with("WARN  request rejected  requestId=req_1"),
            "{}",
            lines[0]
        );
        assert!(!lines[0].contains("sk-secret") && !lines[0].contains("prompt"));
    }

    #[test]
    fn lines_render_like_ts_format_line() {
        let line = format_line(
            Level::WARN,
            1_794_136_149_464,
            "request rejected",
            &[
                ("reason", "connect ECONNREFUSED 127.0.0.1:18111".into()),
                ("requestId", "req_1".into()),
                ("status", "503".into()),
                ("code", "ALL_CANDIDATES_FAILED".into()),
            ],
        );
        assert_eq!(
            line,
            "2026-11-08T11:09:09.464Z WARN  request rejected  requestId=req_1 status=503 \
             code=ALL_CANDIDATES_FAILED reason=\"connect ECONNREFUSED 127.0.0.1:18111\""
        );
        assert_eq!(
            format_line(Level::INFO, 0, "booting", &[]),
            "1970-01-01T00:00:00.000Z INFO  booting"
        );
        let long = "x".repeat(250);
        let capped = format_line(Level::ERROR, 0, "m", &[("reason", long)]);
        assert!(capped.ends_with(&format!("reason={}…", "x".repeat(200))));
    }
}

#[cfg(test)]
mod mapped {
    use super::*;
    use tracing_subscriber::layer::SubscriberExt as _;

    /// The lines the writer's busy-retry and drop warnings render.
    #[test]
    fn mapped_diagnostic_fields_render_their_values() {
        let lines = std::sync::Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
        let seen = lines.clone();
        let layer = TsFormat::with_sink(Level::DEBUG, move |l| {
            seen.lock().expect("lines").push(l.to_owned());
        });
        tracing::subscriber::with_default(tracing_subscriber::registry().with(layer), || {
            tracing::warn!(
                count = 3u64,
                attempt = 1u32,
                retryAfterMs = 100u64,
                reason = "database is locked",
                "request log batch hit a busy database; retrying (count events)"
            );
            tracing::warn!(
                apiKeyId = "k1",
                reason = "x",
                "rate limit counters unavailable"
            );
        });
        let lines = lines.lock().expect("lines");
        assert!(
            lines[0].ends_with("attempt=1 retryAfterMs=100 count=3 reason=\"database is locked\""),
            "{}",
            lines[0]
        );
        assert!(lines[1].ends_with("apiKeyId=k1 reason=x"), "{}", lines[1]);
    }
}

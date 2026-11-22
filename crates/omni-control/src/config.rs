//! Shared configuration: every `OMNI_*` variable, with its validation and
//! exact error text.
//!
//! A pure function of an env map (plus the host offset, injected).
//! The gateway passes only the process environment; the CLI caller explicitly
//! merges its selected root's `.env` before calling this pure parser.

use omni_ir::js::{string_to_number, trim, utf16_len};
use std::collections::HashMap;

const MIN_KEY_LENGTH: usize = 16;
const TRUTHY: [&str; 4] = ["1", "true", "yes", "on"];

/// `LogLevel`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum LogLevel {
    Debug,
    Info,
    Warn,
    Error,
}

impl LogLevel {
    pub fn as_str(self) -> &'static str {
        match self {
            LogLevel::Debug => "debug",
            LogLevel::Info => "info",
            LogLevel::Warn => "warn",
            LogLevel::Error => "error",
        }
    }

    /// `parseLogLevel`: trimmed, lowercased, own keys only.
    pub fn parse(value: Option<&str>) -> Option<Self> {
        match trim(value?).to_lowercase().as_str() {
            "debug" => Some(LogLevel::Debug),
            "info" => Some(LogLevel::Info),
            "warn" => Some(LogLevel::Warn),
            "error" => Some(LogLevel::Error),
            _ => None,
        }
    }
}

/// `Config`.
#[derive(Debug, Clone, PartialEq)]
pub struct Config {
    pub port: u16,
    pub host: String,
    pub database_path: String,
    pub encryption_key: String,
    pub base_url: String,
    pub static_dir: Option<String>,
    pub body_logging_allowed: bool,
    pub log_level: LogLevel,
    pub log_file: Option<String>,
    pub cluster_mode: bool,
    pub database_url: Option<String>,
    pub redis_url: Option<String>,
    pub day_offset_minutes: i64,
    pub day_offset_fallback_from: Option<String>,
    pub log_level_fallback_from: Option<String>,
    pub metrics_token: Option<String>,
    pub metrics_max_series: f64,
    pub otlp_endpoint: Option<String>,
    pub otlp_headers: Option<String>,
    pub trace_sample: f64,
}

/// A refusal to boot, carrying the exact error text.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct ConfigError(pub String);

fn decimal_integer(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit())
}

fn signed_integer(s: &str) -> bool {
    decimal_integer(s.strip_prefix('-').unwrap_or(s))
}

/// `value?.trim() || fallback`.
fn optional_text(value: Option<&String>, fallback: &str) -> String {
    match value.map(|v| trim(v)) {
        Some(t) if !t.is_empty() => t.to_owned(),
        _ => fallback.to_owned(),
    }
}

/// `value?.trim()` that is neither absent nor empty.
fn non_empty(value: Option<&String>) -> Option<String> {
    value
        .map(|v| trim(v))
        .filter(|t| !t.is_empty())
        .map(str::to_owned)
}

fn flag(value: Option<&String>) -> bool {
    let v = value.map_or(String::new(), |v| trim(v).to_lowercase());
    TRUTHY.contains(&v.as_str())
}

/// `.replace(/\/+$/, "")`.
fn strip_trailing_slashes(s: &str) -> &str {
    s.trim_end_matches('/')
}

/// The process environment, as `process.env` holds it (non-UTF-8 entries
/// lossily converted).
pub fn process_env() -> HashMap<String, String> {
    std::env::vars_os()
        .map(|(k, v)| {
            (
                k.to_string_lossy().into_owned(),
                v.to_string_lossy().into_owned(),
            )
        })
        .collect()
}

/// `loadConfig`. `host_offset` is `hostDayOffsetMinutes`, called only when
/// `OMNI_DAY_OFFSET_MINUTES` is absent or invalid.
pub fn load_config(
    env: &HashMap<String, String>,
    host_offset: impl FnOnce() -> i64,
) -> Result<Config, ConfigError> {
    let get = |k: &str| env.get(k);

    let encryption_key = match get("OMNI_ENCRYPTION_KEY") {
        Some(k) if utf16_len(k) >= MIN_KEY_LENGTH => k.clone(),
        _ => {
            return Err(ConfigError(format!(
                "OMNI_ENCRYPTION_KEY must be set to at least {MIN_KEY_LENGTH} characters. \
                 Generate one with: openssl rand -base64 32"
            )));
        }
    };

    let host = optional_text(get("OMNI_HOST"), "127.0.0.1");

    let raw_port = get("OMNI_PORT").map_or("9000", String::as_str);
    let port_n = string_to_number(raw_port);
    if !decimal_integer(raw_port) || !(1.0..=65_535.0).contains(&port_n) {
        return Err(ConfigError(format!(
            "OMNI_PORT must be an integer between 1 and 65535, got \"{raw_port}\""
        )));
    }
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    let port = port_n as u16;

    let derived = format!("http://{host}:{port}");
    let base = optional_text(get("OMNI_BASE_URL"), &derived);
    let stripped = strip_trailing_slashes(&base);
    let base_url = if stripped.is_empty() {
        derived
    } else {
        stripped.to_owned()
    };

    let static_dir = non_empty(get("OMNI_STATIC_DIR"));
    let log_file = non_empty(get("OMNI_LOG_FILE"));
    let cluster_mode = flag(get("OMNI_CLUSTER_MODE"));
    let database_url = non_empty(get("OMNI_DATABASE_URL"));
    let redis_url = non_empty(get("OMNI_REDIS_URL"));
    if cluster_mode {
        if !database_url
            .as_deref()
            .is_some_and(|u| u.starts_with("postgres"))
        {
            return Err(ConfigError(
                "OMNI_CLUSTER_MODE=true needs OMNI_DATABASE_URL to be a postgres:// URL".into(),
            ));
        }
        if redis_url.is_none() {
            return Err(ConfigError(
                "OMNI_CLUSTER_MODE=true needs OMNI_REDIS_URL".into(),
            ));
        }
    } else if database_url.is_some() || redis_url.is_some() {
        return Err(ConfigError(
            "OMNI_DATABASE_URL and OMNI_REDIS_URL are cluster-mode settings; set OMNI_CLUSTER_MODE=true or unset them".into(),
        ));
    }

    let raw_offset = get("OMNI_DAY_OFFSET_MINUTES").map(|v| trim(v).to_owned());
    let valid_offset = raw_offset.as_deref().and_then(|r| {
        let n = string_to_number(r);
        (signed_integer(r) && (-1440.0..=1440.0).contains(&n)).then_some(n)
    });
    #[allow(clippy::cast_possible_truncation)]
    let day_offset_minutes = match valid_offset {
        // `-0` is a valid offset and is zero minutes.
        Some(n) => n as i64,
        None => host_offset(),
    };
    let day_offset_fallback_from = match (&raw_offset, valid_offset) {
        (Some(r), None) => Some(r.clone()),
        _ => None,
    };

    let body_logging_allowed = flag(get("OMNI_BODY_LOGGING_ALLOWED"));

    let raw_level = get("OMNI_LOG_LEVEL").map(|v| trim(v).to_owned());
    let level = LogLevel::parse(raw_level.as_deref());
    let metrics_token = non_empty(get("OMNI_METRICS_TOKEN"));

    let raw_series = get("OMNI_METRICS_MAX_SERIES").map_or("5000", String::as_str);
    let metrics_max_series = string_to_number(raw_series);
    if !decimal_integer(raw_series) || metrics_max_series < 1.0 {
        return Err(ConfigError(format!(
            "OMNI_METRICS_MAX_SERIES must be a positive integer, got \"{raw_series}\""
        )));
    }

    let otlp_endpoint = get("OMNI_OTLP_ENDPOINT")
        .map(|v| strip_trailing_slashes(trim(v)).to_owned())
        .filter(|v| !v.is_empty());
    let otlp_headers = non_empty(get("OMNI_OTLP_HEADERS"));
    let raw_sample = get("OMNI_TRACE_SAMPLE").map_or("1.0", String::as_str);
    let trace_sample = string_to_number(raw_sample);
    if !trace_sample.is_finite() || !(0.0..=1.0).contains(&trace_sample) {
        return Err(ConfigError(format!(
            "OMNI_TRACE_SAMPLE must be between 0 and 1, got \"{raw_sample}\""
        )));
    }

    Ok(Config {
        log_level: level.unwrap_or(LogLevel::Info),
        log_level_fallback_from: match (&level, raw_level) {
            (None, Some(r)) if !r.is_empty() => Some(r),
            _ => None,
        },
        port,
        host,
        database_path: optional_text(get("OMNI_DB_PATH"), "./omnigateway.db"),
        encryption_key,
        base_url,
        static_dir,
        body_logging_allowed,
        log_file,
        database_url: database_url.filter(|_| cluster_mode),
        redis_url: redis_url.filter(|_| cluster_mode),
        cluster_mode,
        day_offset_minutes,
        day_offset_fallback_from,
        metrics_token,
        metrics_max_series,
        otlp_endpoint,
        otlp_headers,
        trace_sample,
    })
}

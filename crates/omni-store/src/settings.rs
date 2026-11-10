//! Routing and retention settings, read as `getSettings` in
//! `packages/store/src/sqlite/config.ts` reads them.
//!
//! `json` is the object TS returns, built by the same spread: the defaults,
//! then every stored key on top (unknown keys included, with whatever value
//! they hold), then the fields TS re-validates. `JSON.stringify` of it equals
//! TS's byte for byte. The typed fields are read from `json`; a field TS does
//! not re-validate and that holds a non-number reads as its default.

use crate::error::StoreError;
use crate::js;
use rusqlite::{Connection, OptionalExtension as _};
use serde_json::{Map, Value, json};

/// `DEFAULT_SMART_ROUTER_POLICY`.
pub const DEFAULT_SMART_ROUTER_POLICY: &str = "Personal data: names together with ID numbers, addresses, phone numbers, emails, \
national ID (NIK), passport, bank or card numbers. \
Credentials and secrets: passwords, API keys, tokens, private keys, connection strings. \
Salaries and HR records. Customer or patient records. Non-public financial figures. \
Internal documents marked confidential or internal. Source code marked proprietary.";

pub const GUARDRAIL_TIMEOUT_MAX_MS: f64 = 60_000.0;
pub const GUARDRAIL_HISTORY_TURNS_MAX: f64 = 10.0;
pub const SMART_ROUTER_POLICY_MAX_CHARS: usize = 4_000;
pub const SMART_ROUTER_TIMEOUT_MAX_MS: f64 = 60_000.0;

/// `DEFAULT_SETTINGS`, in its declaration order (which is `JSON.stringify`'s).
pub fn default_settings_json() -> Value {
    json!({
        "weights": { "tier": 10, "health": 3, "quota": 2, "load": 2, "cost": 1, "latency": 1 },
        "maxAttempts": 3,
        "requestDeadlineMs": 0,
        "breakerThreshold": 3,
        "breakerCooldownMs": 30_000,
        "logRetentionDays": 30,
        "bodyRetentionDays": 1,
        "quotaPollIntervalMs": 300_000,
        "rtkEnabled": false,
        "autoCacheEnabled": true,
        "ponytailMode": "off",
        "bodyLoggingEnabled": false,
        "bodyLoggingCaptureStreamChunks": false,
        "snapshotKeepLatest": 5,
        "snapshotMaxAgeDays": 30,
        "guardrailModel": null,
        "guardrailTimeoutMs": 10_000,
        "guardrailHistoryTurns": 3,
        "smartRouterEnabled": false,
        "smartRouterClassifierModel": null,
        "smartRouterLocalModel": null,
        "smartRouterPolicy": DEFAULT_SMART_ROUTER_POLICY,
        "smartRouterTimeoutMs": 10_000,
    })
}

/// `PonytailMode`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PonytailMode {
    Off,
    Lite,
    Full,
    Ultra,
}

impl PonytailMode {
    /// `isPonytailMode`, mapping anything else to `Off`.
    fn read(value: Option<&Value>) -> Option<Self> {
        match value?.as_str()? {
            "off" => Some(Self::Off),
            "lite" => Some(Self::Lite),
            "full" => Some(Self::Full),
            "ultra" => Some(Self::Ultra),
            _ => None,
        }
    }
}

/// `ScoringWeights`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ScoringWeights {
    pub tier: f64,
    pub health: f64,
    pub quota: f64,
    pub cost: f64,
    pub latency: f64,
    pub load: f64,
}

/// `Settings`. Numbers are JS numbers.
#[derive(Debug, Clone, PartialEq)]
pub struct Settings {
    pub weights: ScoringWeights,
    pub max_attempts: f64,
    pub request_deadline_ms: f64,
    pub breaker_threshold: f64,
    pub breaker_cooldown_ms: f64,
    pub log_retention_days: f64,
    pub body_retention_days: f64,
    pub quota_poll_interval_ms: f64,
    pub rtk_enabled: bool,
    pub auto_cache_enabled: bool,
    pub ponytail_mode: PonytailMode,
    pub body_logging_enabled: bool,
    pub body_logging_capture_stream_chunks: bool,
    pub snapshot_keep_latest: f64,
    pub snapshot_max_age_days: f64,
    pub guardrail_model: Option<String>,
    pub guardrail_timeout_ms: f64,
    pub guardrail_history_turns: f64,
    pub smart_router_enabled: bool,
    pub smart_router_classifier_model: Option<String>,
    pub smart_router_local_model: Option<String>,
    pub smart_router_policy: String,
    pub smart_router_timeout_ms: f64,
    /// The whole object as TS returns it, unknown stored keys included.
    pub json: Value,
}

fn default_of(key: &str) -> Value {
    default_settings_json()
        .get(key)
        .cloned()
        .unwrap_or(Value::Null)
}

/// `inRange`: an integer inside `1..=max`.
fn in_range(value: Option<&Value>, max: f64) -> Option<f64> {
    let n = value?.as_f64()?;
    (js::is_integer(n) && (1.0..=max).contains(&n)).then_some(n)
}

/// `modelOrNull` / the guardrail model rule: a string that is not blank,
/// kept untrimmed.
fn model_or_null(value: Option<&Value>) -> Value {
    match value {
        Some(Value::String(s)) if !js::trim(s).is_empty() => Value::String(s.clone()),
        _ => Value::Null,
    }
}

fn exactly_true(value: Option<&Value>) -> bool {
    value == Some(&Value::Bool(true))
}

/// `knownWeights`: only the weights the router still scores, each a finite
/// number or its default.
fn known_weights(stored: Option<&Value>) -> Value {
    let defaults = default_of("weights");
    let mut out = Map::new();
    for key in ["tier", "health", "quota", "load", "cost", "latency"] {
        let picked = stored
            .and_then(Value::as_object)
            .and_then(|w| w.get(key))
            .filter(|v| v.as_f64().is_some_and(f64::is_finite))
            .or_else(|| defaults.get(key))
            .cloned()
            .unwrap_or(Value::Null);
        out.insert(key.to_owned(), picked);
    }
    Value::Object(out)
}

/// The object `getSettings` returns for a stored `settings` value.
pub fn settings_json(raw: Option<&str>) -> Value {
    let Some(raw) = raw else {
        return default_settings_json();
    };
    let Ok(parsed) = serde_json::from_str::<Value>(raw) else {
        return default_settings_json();
    };
    let stored = match parsed {
        Value::Object(map) => map,
        _ => Map::new(),
    };
    let get = |k: &str| stored.get(k);

    let mut out = match default_settings_json() {
        Value::Object(map) => map,
        _ => Map::new(),
    };
    // `...stored`: an existing key keeps its place, a new one is appended.
    for (k, v) in &stored {
        out.insert(k.clone(), v.clone());
    }
    let mut set = |k: &str, v: Value| {
        out.insert(k.to_owned(), v);
    };
    set("rtkEnabled", Value::Bool(exactly_true(get("rtkEnabled"))));
    set(
        "autoCacheEnabled",
        Value::Bool(get("autoCacheEnabled").is_none() || exactly_true(get("autoCacheEnabled"))),
    );
    set(
        "ponytailMode",
        match PonytailMode::read(get("ponytailMode")) {
            Some(_) => get("ponytailMode").cloned().unwrap_or(Value::Null),
            None => Value::String("off".to_owned()),
        },
    );
    set(
        "bodyRetentionDays",
        match in_range(get("bodyRetentionDays"), 3_650.0) {
            Some(_) => get("bodyRetentionDays").cloned().unwrap_or(Value::Null),
            None => default_of("bodyRetentionDays"),
        },
    );
    set(
        "bodyLoggingEnabled",
        Value::Bool(exactly_true(get("bodyLoggingEnabled"))),
    );
    set(
        "bodyLoggingCaptureStreamChunks",
        Value::Bool(exactly_true(get("bodyLoggingCaptureStreamChunks"))),
    );
    set("weights", known_weights(get("weights")));
    // `readGuardrailSettings`.
    set("guardrailModel", model_or_null(get("guardrailModel")));
    let ranged = |k: &str, max: f64| match in_range(get(k), max) {
        Some(_) => get(k).cloned().unwrap_or(Value::Null),
        None => default_of(k),
    };
    set(
        "guardrailTimeoutMs",
        ranged("guardrailTimeoutMs", GUARDRAIL_TIMEOUT_MAX_MS),
    );
    set(
        "guardrailHistoryTurns",
        ranged("guardrailHistoryTurns", GUARDRAIL_HISTORY_TURNS_MAX),
    );
    // `readSmartRouterSettings`.
    set(
        "smartRouterEnabled",
        Value::Bool(exactly_true(get("smartRouterEnabled"))),
    );
    set(
        "smartRouterClassifierModel",
        model_or_null(get("smartRouterClassifierModel")),
    );
    set(
        "smartRouterLocalModel",
        model_or_null(get("smartRouterLocalModel")),
    );
    let trimmed = get("smartRouterPolicy")
        .and_then(Value::as_str)
        .map(js::trim)
        .unwrap_or("");
    set(
        "smartRouterPolicy",
        Value::String(
            if !trimmed.is_empty() && js::utf16_len(trimmed) <= SMART_ROUTER_POLICY_MAX_CHARS {
                trimmed
            } else {
                DEFAULT_SMART_ROUTER_POLICY
            }
            .to_owned(),
        ),
    );
    set(
        "smartRouterTimeoutMs",
        ranged("smartRouterTimeoutMs", SMART_ROUTER_TIMEOUT_MAX_MS),
    );
    Value::Object(out)
}

impl Settings {
    /// The typed view of a `getSettings` object.
    pub fn from_json(json: Value) -> Self {
        let defaults = default_settings_json();
        let num = |v: &Value, k: &str| {
            v.get(k)
                .and_then(Value::as_f64)
                .or_else(|| defaults.get(k).and_then(Value::as_f64))
                .unwrap_or(f64::NAN)
        };
        let string = |k: &str| json.get(k).and_then(Value::as_str).map(str::to_owned);
        let flag = |k: &str| json.get(k) == Some(&Value::Bool(true));
        let w = json.get("weights").cloned().unwrap_or(Value::Null);
        let dw = defaults.get("weights").cloned().unwrap_or(Value::Null);
        let weight = |k: &str| {
            w.get(k)
                .and_then(Value::as_f64)
                .or_else(|| dw.get(k).and_then(Value::as_f64))
                .unwrap_or(f64::NAN)
        };
        Self {
            weights: ScoringWeights {
                tier: weight("tier"),
                health: weight("health"),
                quota: weight("quota"),
                cost: weight("cost"),
                latency: weight("latency"),
                load: weight("load"),
            },
            max_attempts: num(&json, "maxAttempts"),
            request_deadline_ms: num(&json, "requestDeadlineMs"),
            breaker_threshold: num(&json, "breakerThreshold"),
            breaker_cooldown_ms: num(&json, "breakerCooldownMs"),
            log_retention_days: num(&json, "logRetentionDays"),
            body_retention_days: num(&json, "bodyRetentionDays"),
            quota_poll_interval_ms: num(&json, "quotaPollIntervalMs"),
            rtk_enabled: flag("rtkEnabled"),
            auto_cache_enabled: flag("autoCacheEnabled"),
            ponytail_mode: PonytailMode::read(json.get("ponytailMode"))
                .unwrap_or(PonytailMode::Off),
            body_logging_enabled: flag("bodyLoggingEnabled"),
            body_logging_capture_stream_chunks: flag("bodyLoggingCaptureStreamChunks"),
            snapshot_keep_latest: num(&json, "snapshotKeepLatest"),
            snapshot_max_age_days: num(&json, "snapshotMaxAgeDays"),
            guardrail_model: string("guardrailModel"),
            guardrail_timeout_ms: num(&json, "guardrailTimeoutMs"),
            guardrail_history_turns: num(&json, "guardrailHistoryTurns"),
            smart_router_enabled: flag("smartRouterEnabled"),
            smart_router_classifier_model: string("smartRouterClassifierModel"),
            smart_router_local_model: string("smartRouterLocalModel"),
            smart_router_policy: string("smartRouterPolicy")
                .unwrap_or_else(|| DEFAULT_SMART_ROUTER_POLICY.to_owned()),
            smart_router_timeout_ms: num(&json, "smartRouterTimeoutMs"),
            json,
        }
    }
}

/// `ConfigRepo.putSettings`: merge the validated patch and commit one row.
pub fn operator_raw(conn: &Connection) -> Result<Option<String>, StoreError> {
    Ok(conn
        .query_row("SELECT value FROM settings WHERE key='settings'", [], |r| {
            Ok(match r.get_ref(0)? {
                rusqlite::types::ValueRef::Text(t) => Some(String::from_utf8_lossy(t).into_owned()),
                _ => None,
            })
        })
        .optional()?
        .flatten())
}

pub fn write_operator_raw(conn: &Connection, raw: &str) -> Result<(), StoreError> {
    conn.execute("INSERT INTO settings(key,value) VALUES ('settings',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [raw])?;
    Ok(())
}

/// `ConfigRepo.putSettings`: merge the validated patch and commit one row.
pub fn put(conn: &Connection, patch: &Value) -> Result<Value, StoreError> {
    let mut next = get(conn)?.json;
    if let (Some(current), Some(patch)) = (next.as_object_mut(), patch.as_object()) {
        for (key, value) in patch {
            if key == "weights" {
                if let (Some(weights), Some(update)) = (
                    current.get_mut(key).and_then(Value::as_object_mut),
                    value.as_object(),
                ) {
                    weights.extend(update.clone());
                }
            } else {
                current.insert(key.clone(), value.clone());
            }
        }
    }
    let raw =
        omni_ir::jsjson::stringify(&omni_ir::jsjson::JsValue::from(&next)).expect("settings JSON");
    conn.execute("INSERT INTO settings(key,value) VALUES ('settings',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [&raw])?;
    Ok(next)
}

/// `ConfigRepo.getSettings`.
pub fn get(conn: &Connection) -> Result<Settings, StoreError> {
    // A non-text value (only a hand edit writes one) parses in TS to a
    // non-object, which reads as the defaults; `None` here reads the same.
    let raw: Option<String> = conn
        .prepare_cached("SELECT value FROM settings WHERE key = ?")?
        .query_row(["settings"], |r| {
            Ok(match r.get_ref(0)? {
                rusqlite::types::ValueRef::Text(t) => Some(String::from_utf8_lossy(t).into_owned()),
                _ => None,
            })
        })
        .optional()?
        .flatten();
    Ok(Settings::from_json(settings_json(raw.as_deref())))
}

//! Qoder CLI client identity. Constructed from shipped CLI code, not captured
//! live traffic. The env overrides (`OMNI_QODER_CLI_VERSION`, `OMNI_ORDER_QODER`)
//! make a stale value an operator fix rather than a release.
use std::{collections::HashMap, sync::OnceLock};

use serde_json::{Map, Value};

static ENV: OnceLock<HashMap<String, String>> = OnceLock::new();

/// Capture before serving; library consumers capture on first use.
pub fn initialize() {
    capture(|| {
        std::env::vars_os()
            .filter_map(|(k, v)| Some((k.into_string().ok()?, v.into_string().ok()?)))
            .filter(|(k, _)| matches!(k.as_str(), "OMNI_QODER_CLI_VERSION" | "OMNI_ORDER_QODER"))
            .collect()
    });
}
fn capture(read: impl FnOnce() -> HashMap<String, String>) {
    ENV.get_or_init(read);
}
fn raw(name: &str) -> Option<&'static str> {
    initialize();
    ENV.get()?.get(name).map(String::as_str)
}
fn safe(s: &str) -> bool {
    !s.is_empty() && s.len() <= 200 && s.bytes().all(|b| (32..=126).contains(&b))
}
fn env(name: &str, fallback: &str) -> String {
    raw(name).filter(|s| safe(s)).unwrap_or(fallback).into()
}

/// `QODER_VERSION`: the CLI version every Cosy header claims.
pub(crate) fn version() -> &'static str {
    static VERSION: OnceLock<String> = OnceLock::new();
    VERSION.get_or_init(|| env("OMNI_QODER_CLI_VERSION", "1.1.82"))
}

/// `qoderProfile.headers` merged with the caller's protocol headers, then
/// ordered by `qoderProfile.order`. A replaced header keeps the base position
/// but takes the override's value and casing; unlisted names append.
pub(crate) fn headers(extra: Vec<(String, String)>) -> Vec<(String, String)> {
    let base = vec![
        ("User-Agent".into(), format!("qoder/{}", version())),
        ("Accept".into(), "application/json".into()),
    ];
    ordered(
        base,
        extra,
        &[
            "Host",
            "Content-Type",
            "Authorization",
            "Accept",
            "User-Agent",
            "Content-Length",
        ],
    )
}

fn ordered(
    mut base: Vec<(String, String)>,
    extra: Vec<(String, String)>,
    default: &[&str],
) -> Vec<(String, String)> {
    for pair in extra {
        if let Some(i) = base
            .iter()
            .position(|(k, _): &(String, String)| k.eq_ignore_ascii_case(&pair.0))
        {
            if let Some(slot) = base.get_mut(i) {
                *slot = pair;
            }
        } else {
            base.push(pair);
        }
    }
    static ORDER_PARTS: OnceLock<Vec<String>> = OnceLock::new();
    let parts = ORDER_PARTS.get_or_init(|| {
        raw("OMNI_ORDER_QODER")
            .unwrap_or("")
            .split(',')
            .map(omni_ir::js::trim)
            .filter(|s| safe(s))
            .map(str::to_owned)
            .collect()
    });
    let order: Vec<&str> = if parts.is_empty() {
        default.to_vec()
    } else {
        parts.iter().map(String::as_str).collect()
    };
    let mut out = Vec::new();
    for name in order {
        if let Some(i) = base.iter().position(|(k, _)| k.eq_ignore_ascii_case(name)) {
            out.push(base.remove(i));
        }
    }
    out.extend(base);
    out
}

/// `qoderBodyOrder`: the chat envelope's field vocabulary in the order the
/// CLI writes it.
pub(crate) const BODY_ORDER: &[&str] = &[
    "request_id",
    "chat_record_id",
    "request_set_id",
    "session_id",
    "stream",
    "chat_task",
    "is_reply",
    "is_retry",
    "source",
    "version",
    "agent_id",
    "aliyun_user_type",
    "chat_context",
    "session_type",
    "task_id",
    "system",
    "messages",
    "tools",
    "parameters",
    "model_config",
];

/// `orderFields`: listed keys first (present only), unlisted keys append in
/// their original order. Only top-level keys are ordered.
pub(crate) fn order_fields(mut obj: Map<String, Value>, order: &[&str]) -> Map<String, Value> {
    let mut out = Map::new();
    for key in order {
        if let Some(v) = obj.shift_remove(*key) {
            omni_ir::deep::insert(&mut out, (*key).into(), v);
        }
    }
    for (k, v) in obj {
        omni_ir::deep::insert(&mut out, k, v);
    }
    out
}

#[cfg(test)]
mod tests {
    #[test]
    fn capture_is_once() {
        super::initialize();
        let before = super::headers(vec![]);
        super::capture(|| panic!("must not re-read environment after initialization"));
        assert_eq!(before, super::headers(vec![]));
    }
}

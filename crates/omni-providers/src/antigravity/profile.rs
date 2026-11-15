//! IDE identity, captured once as in the frozen module's import-time profile.
use std::{collections::HashMap, sync::OnceLock};

static ENV: OnceLock<HashMap<String, String>> = OnceLock::new();

/// Capture before serving; library consumers capture on first use.
pub fn initialize() {
    capture(|| {
        std::env::vars_os()
            .filter_map(|(k, v)| Some((k.into_string().ok()?, v.into_string().ok()?)))
            .filter(|(k, _)| {
                matches!(
                    k.as_str(),
                    "OMNI_ANTIGRAVITY_IDE_VERSION"
                        | "OMNI_UA_ANTIGRAVITY"
                        | "OMNI_ORDER_ANTIGRAVITY"
                )
            })
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

pub fn headers(extra: Vec<(String, String)>) -> Vec<(String, String)> {
    let version = env("OMNI_ANTIGRAVITY_IDE_VERSION", "2.12.2");
    let mut base = vec![
        (
            "User-Agent".into(),
            env(
                "OMNI_UA_ANTIGRAVITY",
                &format!("antigravity/ide/{version} darwin/arm64"),
            ),
        ),
        ("Content-Type".into(), "application/json".into()),
        ("Accept".into(), "text/event-stream".into()),
    ];
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
    let parts: Vec<_> = raw("OMNI_ORDER_ANTIGRAVITY")
        .unwrap_or("")
        .split(',')
        .map(omni_ir::js::trim)
        .filter(|s| safe(s))
        .collect();
    let default = [
        "Host",
        "Content-Type",
        "Authorization",
        "User-Agent",
        "X-Goog-Api-Client",
        "Accept",
        "Accept-Encoding",
        "Content-Length",
    ];
    let order = if parts.is_empty() {
        default.as_slice()
    } else {
        parts.as_slice()
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

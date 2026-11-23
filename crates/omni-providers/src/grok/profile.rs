//! Grok CLI identity, captured once before serving.
//!
//! The version is the weakest constant here: xAI resolves it from a build-time
//! env var, and 0.2.120 is the newest value observed on the wire rather than a
//! quote from a shipped manifest. The proxy gates on this header, so the env
//! override (`OMNI_GROK_CLI_VERSION`) is what makes a stale value an operator
//! fix rather than a release. Only the header order is operator-overridable
//! (`OMNI_ORDER_GROK`); the body order is a fixed constant, as in the TS
//! profile.
use std::{collections::HashMap, sync::OnceLock};

use serde_json::{Map, Value};

static ENV: OnceLock<HashMap<String, String>> = OnceLock::new();

/// Capture before serving; library consumers capture on first use.
pub fn initialize() {
    capture(|| {
        std::env::vars_os()
            .filter_map(|(k, v)| Some((k.into_string().ok()?, v.into_string().ok()?)))
            .filter(|(k, _)| {
                matches!(
                    k.as_str(),
                    "OMNI_GROK_CLI_VERSION" | "OMNI_UA_GROK" | "OMNI_ORDER_GROK"
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

/// `grokHost`: the platform lowercased as Node spells it, and `arm64` renamed
/// to the Rust spelling xAI's own client reports.
fn host() -> (&'static str, &'static str) {
    let os = match std::env::consts::OS {
        "macos" => "darwin",
        "windows" => "win32",
        other => other,
    };
    let arch = match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "aarch64",
        "x86" => "ia32",
        other => other,
    };
    (os, arch)
}

/// `grokProfile.headers` merged with the caller's protocol headers, then
/// ordered by `grokProfile.order`. A replaced header keeps the base position
/// but takes the override's value and casing; unlisted names append.
pub(crate) fn headers(extra: Vec<(String, String)>) -> Vec<(String, String)> {
    let version = env("OMNI_GROK_CLI_VERSION", "0.2.120");
    let (os, arch) = host();
    let base = vec![
        (
            "User-Agent".into(),
            env(
                "OMNI_UA_GROK",
                &format!("grok-shell/{version} ({os}; {arch})"),
            ),
        ),
        // `grok-shell`, not `grok-cli`: no `grok-cli/<version>` identity
        // exists anywhere in xAI's own source.
        ("x-grok-client-identifier".into(), "grok-shell".into()),
        ("x-grok-client-version".into(), version),
        ("x-grok-client-mode".into(), "headless".into()),
        ("Accept".into(), "text/event-stream".into()),
    ];
    ordered(
        base,
        extra,
        &[
            "Host",
            "Content-Type",
            "Authorization",
            "X-XAI-Token-Auth",
            "x-authenticateresponse",
            "x-grok-client-identifier",
            "x-grok-client-version",
            "x-grok-client-mode",
            "x-grok-agent-id",
            "x-grok-req-id",
            "x-grok-conv-id",
            "x-grok-session-id",
            "x-grok-model-override",
            "User-Agent",
            "Accept",
            "Accept-Encoding",
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
    let parts: Vec<_> = raw("OMNI_ORDER_GROK")
        .unwrap_or("")
        .split(',')
        .map(omni_ir::js::trim)
        .filter(|s| safe(s))
        .collect();
    let order = if parts.is_empty() {
        default
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

/// `grokBodyOrder`: xAI's Responses surface takes the same field vocabulary
/// as OpenAI's, so the order mirrors it rather than inventing a second
/// spelling of the same body.
pub(super) const BODY_ORDER: &[&str] = &[
    "model",
    "stream",
    "input",
    "instructions",
    "store",
    "reasoning",
    "prompt_cache_key",
    "tools",
    "tool_choice",
    "include",
    "service_tier",
    "client_metadata",
    "parallel_tool_calls",
    "metadata",
];

/// `orderFields`: listed keys first (present only), unlisted keys append in
/// their original order. Only top-level keys are ordered.
pub(super) fn order_fields(mut obj: Map<String, Value>, order: &[&str]) -> Map<String, Value> {
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

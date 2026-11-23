//! Muse Code client identity, captured once before serving.
//!
//! **Constructed, not captured.** The launcher shell script sends
//! `muse-code/launcher-<n>` and the agent binary builds its own from a version
//! constant that does not survive as a readable string, so the shape here is
//! modelled on the launcher's rather than quoted from a live request. The
//! env overrides (`OMNI_UA_MUSE`, `OMNI_MUSE_CLI_VERSION`,
//! `OMNI_MUSE_API_VERSION`, `OMNI_ORDER_MUSE`) make a stale value an operator
//! fix rather than a release.
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
                    "OMNI_MUSE_CLI_VERSION"
                        | "OMNI_UA_MUSE"
                        | "OMNI_MUSE_API_VERSION"
                        | "OMNI_ORDER_MUSE"
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

/// `museProfile.headers` merged with the caller's protocol headers, then
/// ordered by `museProfile.order`. A replaced header keeps the base position
/// but takes the override's value and casing; unlisted names append.
pub(crate) fn headers(extra: Vec<(String, String)>) -> Vec<(String, String)> {
    let version = env("OMNI_MUSE_CLI_VERSION", "1.0.3");
    let base = vec![
        (
            "User-Agent".into(),
            env("OMNI_UA_MUSE", &format!("muse-code/{version}")),
        ),
        // Quoted from the binary's auth calls, sent on every request: one
        // value per client, not one per endpoint.
        (
            "x-api-version".into(),
            env("OMNI_MUSE_API_VERSION", "1.0.0"),
        ),
        ("Accept".into(), "text/event-stream".into()),
    ];
    ordered(
        base,
        extra,
        &[
            "Host",
            "Content-Type",
            "Authorization",
            // Not a profile header: the codec supplies it per request. Listed
            // so it keeps its place rather than appending after `User-Agent`.
            "x-meta-ai-gateway-session-id",
            "x-api-version",
            "Accept",
            "User-Agent",
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
    let parts: Vec<_> = raw("OMNI_ORDER_MUSE")
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

/// `museBodyOrder`: the Responses field vocabulary in the order Muse's own
/// client writes it.
pub(super) const BODY_ORDER: &[&str] = &[
    "model",
    "stream",
    "input",
    "instructions",
    "store",
    "reasoning",
    "prompt_cache_key",
    "max_output_tokens",
    "temperature",
    "tools",
    "tool_choice",
    "include",
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

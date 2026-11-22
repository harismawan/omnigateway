//! Kilo Code editor identity, captured once before serving.
//!
//! No traffic capture exists for the Kilo Code extension either: the header
//! order is constructed to be plausible, not verified. `X-KILOCODE-EDITORNAME`
//! is the one header the gateway is documented to require, and it names the
//! editor hosting the extension rather than the machine it runs on — there is
//! no device fingerprint to mint here. It reads from the environment so a
//! value Kilo starts rejecting is an operator fix rather than a release.
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
                    "OMNI_KILO_CLI_VERSION"
                        | "OMNI_UA_KILO"
                        | "OMNI_KILO_EDITOR_NAME"
                        | "OMNI_ORDER_KILO"
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

/// `kiloProfile.headers` merged with the caller's protocol headers, then
/// ordered by `kiloProfile.order`. A replaced header keeps the base position
/// but takes the override's value and casing; unlisted names append.
/// `X-Kilocode-OrganizationID` sits with `Authorization` because it qualifies
/// it; a header the caller does not send is simply skipped.
pub(crate) fn headers(extra: Vec<(String, String)>) -> Vec<(String, String)> {
    let version = env("OMNI_KILO_CLI_VERSION", "4.140.0");
    let base = vec![
        (
            "User-Agent".into(),
            env("OMNI_UA_KILO", &format!("Kilo-Code/{version}")),
        ),
        (
            "X-KILOCODE-EDITORNAME".into(),
            env("OMNI_KILO_EDITOR_NAME", "vscode"),
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
            "X-Kilocode-OrganizationID",
            "X-KILOCODE-EDITORNAME",
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
    // The operator override is applied here rather than where the table is
    // assembled, so a direct read and the ordered table never disagree.
    let parts: Vec<_> = raw("OMNI_ORDER_KILO")
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

/// `kiloBodyOrder`. Constructed, not captured. `reasoning` is OpenRouter's
/// field, which Kilo's surface takes; `stream_options` is absent because the
/// gateway adds it for usage reporting rather than copying it from the CLI.
/// Unlisted keys append in insertion order.
pub(super) const BODY_ORDER: &[&str] = &[
    "model",
    "messages",
    "tools",
    "tool_choice",
    "max_tokens",
    "temperature",
    "reasoning",
    "stream",
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

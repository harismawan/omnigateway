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

/// Token exchange and userinfo: not in the 2026-11-21 capture, so they keep
/// the omniroute 3.8.49 identity.
pub fn headers(extra: Vec<(String, String)>) -> Vec<(String, String)> {
    let version = env("OMNI_ANTIGRAVITY_IDE_VERSION", "2.12.2");
    let base = vec![
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
    ordered(
        base,
        extra,
        &[
            "Host",
            "Content-Type",
            "Authorization",
            "User-Agent",
            "X-Goog-Api-Client",
            "Accept",
            "Accept-Encoding",
            "Content-Length",
        ],
    )
}

pub(super) const INFERENCE_HOST: &str = "daily-cloudcode-pa.googleapis.com";

fn hub_user_agent() -> String {
    let version = env("OMNI_ANTIGRAVITY_IDE_VERSION", "2.34.0");
    env(
        "OMNI_UA_ANTIGRAVITY",
        &format!(
            "antigravity/hub/{version} (aidev_client; os_type=linux; arch=amd64; cl=1026637980)"
        ),
    )
}

/// Bootstrap (`loadCodeAssist`, `onboardUser`) and quota
/// (`retrieveUserQuotaSummary`) as App 2.34 / CLI 1.5.13 send them in the
/// 2026-11-21 capture: on [`INFERENCE_HOST`], the Hub UA, and
/// `Host, User-Agent, Content-Length, Authorization, Content-Type,
/// Accept-Encoding`. No `Accept` or `X-Goog-Api-Client`; `Accept-Encoding: gzip`
/// is not adopted (the readers do not decompress it). `Host` and
/// `Content-Length` are written by the transport. Offline capture only: live
/// acceptance is not yet measured. Same profile as the TS
/// `antigravityBootstrapProfile`.
pub(crate) fn bootstrap_headers(token: &str) -> Vec<(String, String)> {
    ordered(
        vec![
            ("User-Agent".into(), hub_user_agent()),
            ("Content-Type".into(), "application/json".into()),
        ],
        vec![("Authorization".into(), format!("Bearer {token}"))],
        &[
            "Host",
            "User-Agent",
            "Content-Length",
            "Authorization",
            "Content-Type",
            "Accept-Encoding",
        ],
    )
}

/// App 2.34.0 Linux Hub identity, from the same fixture as the TS profile.
/// omniroute reported that Google refused a non-Mac identity; this offline
/// capture neither confirms nor disproves that report. Live acceptance of the
/// Linux Hub default is untested. Set `OMNI_UA_ANTIGRAVITY` to
/// `antigravity/ide/2.12.2 darwin/arm64` to restore the old UA only, not the old
/// header order, framing, or envelope.
pub(super) fn inference_headers(token: &str) -> Vec<(String, String)> {
    ordered(
        vec![
            ("Host".into(), INFERENCE_HOST.into()),
            ("User-Agent".into(), hub_user_agent()),
            ("Transfer-Encoding".into(), "chunked".into()),
            ("Content-Type".into(), "application/json".into()),
        ],
        vec![("Authorization".into(), format!("Bearer {token}"))],
        &[
            "Host",
            "User-Agent",
            "Transfer-Encoding",
            "Authorization",
            "Content-Type",
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
    let parts: Vec<_> = raw("OMNI_ORDER_ANTIGRAVITY")
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

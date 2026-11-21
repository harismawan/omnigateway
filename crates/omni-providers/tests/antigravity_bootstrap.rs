//! Bootstrap (`loadCodeAssist`, `onboardUser`) and quota
//! (`retrieveUserQuotaSummary`) in the App 2.34 / CLI 1.5.13 shape captured on
//! 2026-11-21 (`scripts/antigravity-capture`): `daily-cloudcode-pa`, the Hub UA,
//! no `Accept`, and `tierId`. The same contract as
//! `packages/control/test/oauth/antigravity.test.ts`.
use omni_providers::antigravity::oauth::{load_request, onboard_request};
use omni_providers::oauth::AuthRequest;
use serde_json::json;

const HOST: &str = "https://daily-cloudcode-pa.googleapis.com/v1internal:";
const UA: &str = "antigravity/hub/2.34.0 (aidev_client; os_type=linux; arch=amd64; cl=1026637980)";

fn names(r: &AuthRequest) -> Vec<&str> {
    r.headers.iter().map(|(n, _)| n.as_str()).collect()
}
fn header<'a>(r: &'a AuthRequest, name: &str) -> &'a str {
    r.headers
        .iter()
        .find(|(n, _)| n == name)
        .map_or("", |(_, v)| v.as_str())
}

fn assert_captured_shape(r: &AuthRequest, operation: &str) {
    assert_eq!(r.url, format!("{HOST}{operation}"));
    assert_eq!(r.method, "POST");
    // Host and Content-Length are the transport's; the rest is the request's.
    assert_eq!(
        names(r),
        ["User-Agent", "Authorization", "Content-Type"],
        "{operation}"
    );
    assert_eq!(header(r, "User-Agent"), UA, "{operation}");
    assert_eq!(header(r, "Authorization"), "Bearer test-token-1");
    assert_eq!(header(r, "Content-Type"), "application/json");
}

#[test]
fn load_code_assist_wears_the_captured_app_shape() {
    let r = load_request("test-token-1");
    assert_captured_shape(&r, "loadCodeAssist");
    assert_eq!(r.body, r#"{"metadata":{"ideType":"ANTIGRAVITY"}}"#);
}

#[test]
fn onboard_user_sends_tier_id_as_the_app_spells_it() {
    let r = onboard_request("test-token-1", "free-tier");
    assert_captured_shape(&r, "onboardUser");
    assert_eq!(
        r.body,
        r#"{"tierId":"free-tier","metadata":{"ideType":"ANTIGRAVITY"}}"#
    );
    // A tier containing JSON metacharacters stays one string.
    let r = onboard_request("test-token-1", "a\"b");
    assert_eq!(
        r.body,
        r#"{"tierId":"a\"b","metadata":{"ideType":"ANTIGRAVITY"}}"#
    );
}

#[test]
fn quota_summary_wears_the_same_shape() {
    let q = omni_providers::quota::request(
        "antigravity",
        "usage",
        "test-token-1",
        &json!({"projectId": "projects/p-1"}),
        json!({}),
    )
    .expect("a project means a probe");
    assert_captured_shape(&q.http, "retrieveUserQuotaSummary");
    assert_eq!(q.http.body, r#"{"project":"projects/p-1"}"#);
    assert_eq!(q.timeout, std::time::Duration::from_secs(15));
}

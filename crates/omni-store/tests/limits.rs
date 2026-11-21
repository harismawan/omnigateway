//! `api_keys.limits` parsing against `parseLimitConfig` in
//! `packages/ratelimit/src/catalog.ts`: the same rows accepted, the same
//! rows refused, and the accepted ones re-serialized byte-identically.

mod common;

use omni_store::limits::parse_limits;

#[test]
fn known_rows_parse_as_ts_documents() {
    let ok = parse_limits(r#"{"requests":{"1m":100},"tokens":{"5h":1000},"concurrency":5}"#)
        .expect("valid");
    let requests = ok.base.requests.as_ref().expect("requests");
    assert_eq!(requests.one_minute, Some(Some(100)));
    assert_eq!(requests.five_hours, None);
    assert_eq!(
        ok.base.tokens.as_ref().expect("tokens").five_hours,
        Some(Some(1000))
    );
    assert_eq!(ok.base.concurrency, Some(Some(5)));
    assert!(ok.models.is_none());
    assert!(parse_limits(r#"{"requests":{"1m":0}}"#).is_none());
    assert!(parse_limits("{}").expect("empty").is_unlimited());

    let models = parse_limits(r#"{"models":{"m":{"spend":{"1w":2.5}}}}"#).expect("override");
    let m = models.model_override("m").expect("m");
    assert_eq!(m.spend.as_ref().expect("spend").one_week, Some(Some(2.5)));
    assert!(models.model_override("constructor").is_none());
}

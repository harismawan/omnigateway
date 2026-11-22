//! Subjects and the limit predicates: which counters a request is judged
//! against (`subjects_of`, `model_subject_id`, `bucket_key`,
//! `any_request_limit`, `any_long_limit`, `requests_only`, `grain_ms`).

use omni_ratelimit::Window;
use omni_ratelimit::limits::{CountWindows, LimitConfig, LimitScope};

/// The long windows, shortest first.
pub const LONG: [Window; 2] = [Window::H5, Window::W1];

/// `GRAIN_MS`: a minute of five hours, an hour of a week.
pub fn grain_ms(window: Window) -> f64 {
    if window == Window::W1 {
        3_600_000.0
    } else {
        60_000.0
    }
}

/// `encodeURIComponent` keeps `/` and `:` out of the
/// model part, so no model name can spell another subject's key.
pub fn model_subject_id(key_id: &str, model: &str) -> String {
    let mut out = String::with_capacity(key_id.len() + 3 + model.len());
    out.push_str(key_id);
    out.push_str("/m/");
    for b in model.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
            out.push(char::from(b));
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// `lim:<subject>:<window>` (the coordinator adds `omni:b:`).
pub fn bucket_key(subject: &str, window: Window) -> String {
    format!("lim:{subject}:{}", window.as_str())
}

/// One set of counters a request is judged against.
#[derive(Debug, Clone, PartialEq)]
pub struct Subject {
    /// What the coordinator is asked about.
    pub id: String,
    pub key_id: String,
    /// `None` for the key-wide subject, whose store reads span every model.
    pub model: Option<String>,
    pub limits: LimitScope,
}

fn count_set(w: Option<&CountWindows>, f: fn(&CountWindows) -> Option<Option<u64>>) -> bool {
    w.and_then(f).flatten().is_some()
}

/// Whether any `requests` window sets a ceiling.
pub fn any_request_limit(l: &LimitScope) -> bool {
    let r = l.requests.as_ref();
    count_set(r, |w| w.one_minute) || count_set(r, |w| w.five_hours) || count_set(r, |w| w.one_week)
}

/// Whether any long window (`5h`, `1w`) sets a ceiling.
pub fn any_long_limit(l: &LimitScope) -> bool {
    let long =
        |w: Option<&CountWindows>| count_set(w, |w| w.five_hours) || count_set(w, |w| w.one_week);
    long(l.requests.as_ref())
        || long(l.tokens.as_ref())
        || l.spend
            .as_ref()
            .is_some_and(|s| s.five_hours.flatten().is_some() || s.one_week.flatten().is_some())
}

/// What `count_tokens` is judged against.
pub fn requests_only(l: &LimitScope) -> LimitScope {
    LimitScope {
        requests: l.requests.clone(),
        ..LimitScope::default()
    }
}

/// Key-wide first (when it limits anything), then the model's
/// override.
pub fn subjects_of(key_id: &str, limits: &LimitConfig, model: &str) -> Vec<Subject> {
    let mut out = Vec::with_capacity(2);
    if limits.base.sets_any_limit() {
        out.push(Subject {
            id: key_id.to_owned(),
            key_id: key_id.to_owned(),
            model: None,
            limits: limits.base.clone(),
        });
    }
    if let Some(o) = limits.model_override(model) {
        out.push(Subject {
            id: model_subject_id(key_id, model),
            key_id: key_id.to_owned(),
            model: Some(model.to_owned()),
            limits: o.clone(),
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn model_subject_id_is_encode_uri_component() {
        // `encodeURIComponent("a/m/b:c d~é")` in JS.
        assert_eq!(
            model_subject_id("k1", "a/m/b:c d~é"),
            "k1/m/a%2Fm%2Fb%3Ac%20d~%C3%A9"
        );
        assert_eq!(
            model_subject_id("k", "claude-3.5_(x)!*'"),
            "k/m/claude-3.5_(x)!*'"
        );
    }

    #[test]
    fn bucket_keys_follow_the_ts_schema() {
        assert_eq!(bucket_key("k1", Window::H5), "lim:k1:5h");
        assert_eq!(bucket_key("k1/m/opus", Window::W1), "lim:k1/m/opus:1w");
    }
}

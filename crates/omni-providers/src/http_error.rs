//! A failed upstream response as a `GatewayError`.

use omni_ir::error::{ErrorCode, GatewayError};
use omni_ir::js::{self, prop, utf16_prefix};
use serde_json::Value;

use crate::http::Headers;

/// The error code for an upstream status.
fn code_for_status(status: u16) -> ErrorCode {
    match status {
        401 | 403 => ErrorCode::Auth,
        402 => ErrorCode::QuotaExhausted,
        404 => ErrorCode::ModelUnavailable,
        400 | 413 | 422 => ErrorCode::BadRequest,
        429 => ErrorCode::RateLimit,
        529 => ErrorCode::Overloaded,
        _ => ErrorCode::Upstream,
    }
}

/// `Retry-After` as milliseconds, from seconds or an HTTP date.
///
/// Seconds follow `Number()` exactly. Dates accept what `Date.parse` accepts
/// for the forms upstreams send — IMF-fixdate, RFC 850, asctime, RFC 2822 with
/// a zone, ISO 8601 — with one stated difference: a zoneless date-time is read
/// as UTC, where JS reads local time. JSC also accepts free-form strings
/// (`"5, 7"` is a date in 2001); those are `None` here.
pub fn parse_retry_after(header: Option<&str>, now_ms: f64) -> Option<f64> {
    let header = header?;
    let seconds = js::string_to_number(header);
    if seconds.is_finite() {
        return Some(js::max0(seconds * 1000.0));
    }
    let at = parse_date_ms(header)?;
    Some(js::max0(at - now_ms))
}

fn parse_date_ms(raw: &str) -> Option<f64> {
    let s = js::trim(raw);
    #[allow(clippy::cast_precision_loss)]
    let from_millis = |ms: i64| ms as f64;
    // RFC 9110 §5.6.7: IMF-fixdate, then the obsolete RFC 850 and asctime forms.
    for format in [
        "%a, %d %b %Y %H:%M:%S GMT",
        "%A, %d-%b-%y %H:%M:%S GMT",
        "%a %b %e %H:%M:%S %Y",
    ] {
        if let Ok(t) = chrono::NaiveDateTime::parse_from_str(s, format) {
            return Some(from_millis(t.and_utc().timestamp_millis()));
        }
    }
    if let Ok(t) = chrono::DateTime::parse_from_rfc2822(&title_case_words(s)) {
        return Some(from_millis(t.timestamp_millis()));
    }
    if let Ok(t) = chrono::DateTime::parse_from_rfc3339(s) {
        return Some(from_millis(t.timestamp_millis()));
    }
    if let Ok(t) = chrono::NaiveDateTime::parse_from_str(s, "%Y-%m-%dT%H:%M:%S%.f") {
        return Some(from_millis(t.and_utc().timestamp_millis()));
    }
    if let Ok(d) = chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d") {
        return Some(from_millis(
            d.and_hms_opt(0, 0, 0)?.and_utc().timestamp_millis(),
        ));
    }
    None
}

/// `"sat, 07 nov 2026 04:36:32 gmt"` → `"Sat, 07 Nov 2026 04:36:32 GMT"`:
/// `Date.parse` is case-insensitive and chrono's RFC 2822 reader is not.
fn title_case_words(s: &str) -> String {
    s.split(' ')
        .map(|w| {
            if w.eq_ignore_ascii_case("gmt")
                || w.eq_ignore_ascii_case("ut")
                || w.eq_ignore_ascii_case("utc")
            {
                w.to_ascii_uppercase()
            } else {
                let mut cs = w.chars();
                cs.next().map_or_else(String::new, |first| {
                    first.to_ascii_uppercase().to_string() + &cs.as_str().to_ascii_lowercase()
                })
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// `httpError`: classifies a non-2xx response from its status and body.
///
/// The message is the body's `error.message`, else a string `detail`, else
/// the body itself — each cut to 500 UTF-16 units — else `"<provider> returned
/// <status>"`. Never gateway-authored: it quotes the upstream.
pub fn http_error(
    status: u16,
    headers: &Headers,
    text: &str,
    provider: &str,
    now_ms: f64,
) -> GatewayError {
    let mut message = utf16_prefix(text, 500).into_owned();
    let mut code = code_for_status(status);

    // `JSON.parse` succeeded and reading `.error` did not throw (it does on null).
    if let Some(parsed) = js::parse_json(text).filter(|v| !v.is_null()) {
        let error = prop(Some(&parsed), "error");
        if let Some(Value::String(m)) = prop(error, "message") {
            message = utf16_prefix(m, 500).into_owned();
        } else if let Some(Value::String(d)) = prop(Some(&parsed), "detail") {
            message = utf16_prefix(d, 500).into_owned();
        }
        let kind = js::nullish_or(prop(error, "type"), prop(error, "code"));
        match kind.and_then(Value::as_str) {
            Some("overloaded_error") => code = ErrorCode::Overloaded,
            Some("insufficient_quota") => code = ErrorCode::QuotaExhausted,
            Some("context_length_exceeded") => code = ErrorCode::BadRequest,
            Some("content_policy_violation") => code = ErrorCode::ContentFilter,
            _ => {}
        }
    }

    let retry_after_ms = parse_retry_after(headers.get("retry-after").as_deref(), now_ms);
    if message.is_empty() {
        message = format!("{provider} returned {status}");
    }
    GatewayError::new(code, message)
        .with_provider(provider)
        .with_status(status)
        .with_retry_after_ms(retry_after_ms)
}

/// Epoch milliseconds now, as `Date.now()`.
pub fn now_ms() -> f64 {
    #[allow(clippy::cast_precision_loss)]
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0.0, |d| d.as_millis() as f64)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The three HTTP-date forms (RFC 9110 §5.6.7) a Retry-After may carry,
    /// all naming 1994-11-06 08:49:37 UTC.
    #[test]
    fn retry_after_reads_every_http_date_form() {
        let at = 784_111_777_000.0;
        for form in [
            "Sun, 06 Nov 1994 08:49:37 GMT",
            "Sunday, 06-Nov-94 08:49:37 GMT",
            "Sun Nov  6 08:49:37 1994",
        ] {
            assert_eq!(
                parse_retry_after(Some(form), at - 5_000.0),
                Some(5_000.0),
                "{form}"
            );
        }
        assert_eq!(parse_retry_after(Some("120"), 0.0), Some(120_000.0));
        assert_eq!(
            parse_retry_after(Some("Sun, 06 Nov 1994 08:49:37 GMT"), at + 1.0),
            Some(0.0)
        );
        assert_eq!(parse_retry_after(Some("not a date"), 0.0), None);
    }

    fn headers() -> Headers {
        Headers::new()
    }

    #[test]
    fn reads_the_usual_envelope_and_a_bare_detail() {
        let e = http_error(
            400,
            &headers(),
            r#"{"error":{"type":"invalid_request_error","message":"bad tool"}}"#,
            "anthropic",
            0.0,
        );
        assert_eq!(
            (e.message.as_str(), e.code),
            ("bad tool", ErrorCode::BadRequest)
        );
        let e = http_error(
            400,
            &headers(),
            r#"{"detail":"System messages are not allowed"}"#,
            "kimi",
            0.0,
        );
        assert_eq!(e.message, "System messages are not allowed");
    }

    #[test]
    fn a_non_string_detail_keeps_the_raw_body() {
        let body = r#"{"detail":[{"loc":["body"],"msg":"nope"}]}"#;
        assert_eq!(http_error(422, &headers(), body, "kimi", 0.0).message, body);
    }

    #[test]
    fn a_non_json_body_keeps_the_status_code() {
        let e = http_error(502, &headers(), "<html>bad gateway</html>", "openai", 0.0);
        assert_eq!(e.message, "<html>bad gateway</html>");
        assert_eq!(e.code, ErrorCode::Upstream);
        assert!(!e.gateway_authored);
    }
}

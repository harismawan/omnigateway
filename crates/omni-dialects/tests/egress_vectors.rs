//! Egress parity: every IR event sequence in `dialects.json` was rendered by
//! the real TS `anthropicStream` / `openaiStream` / `responsesStream` (frames
//! serialized exactly as `sseResponse` in `routes/proxy.ts` writes them) and by
//! the buffered renderers over TS `collect()`, recorded as the exact bytes TS
//! sends. The Rust encoders and renderers must write the same bytes.

use omni_dialects::egress::{self, AnthropicStream, StreamEncoder};
use omni_ir::error::{ErrorCode, GatewayError};
use omni_ir::stream::StreamEvent;
#[test]
fn frames_are_written_one_event_at_a_time_into_the_callers_buffer() {
    // The encoder appends; it never clears or reallocates what is already there.
    let mut enc = StreamEncoder::Anthropic(AnthropicStream::new("r"));
    let mut buf = String::from("prefix|");
    enc.push(
        &StreamEvent::Start {
            id: "u".into(),
            model: "m".into(),
        },
        &mut buf,
    );
    assert!(buf.starts_with("prefix|event: message_start\ndata: {"));
    assert!(buf.ends_with("}\n\n"));
}

#[test]
fn retry_after_is_rendered_on_429s_only_in_whole_seconds_rounded_up() {
    let e = |code, ms| GatewayError::new(code, "x").with_retry_after_ms(ms);
    assert_eq!(
        egress::retry_after(&e(ErrorCode::RateLimit, Some(1500.0))).as_deref(),
        Some("2")
    );
    assert_eq!(
        egress::retry_after(&e(ErrorCode::QuotaExhausted, Some(1000.0))).as_deref(),
        Some("1")
    );
    assert_eq!(
        egress::retry_after(&e(ErrorCode::RateLimit, Some(-5.0))).as_deref(),
        Some("0")
    );
    assert_eq!(
        egress::retry_after(&e(ErrorCode::RateLimit, Some(0.4))).as_deref(),
        Some("1")
    );
    assert_eq!(egress::retry_after(&e(ErrorCode::RateLimit, None)), None);
    assert_eq!(
        egress::retry_after(&e(ErrorCode::Upstream, Some(1000.0))),
        None
    );
    assert_eq!(
        egress::retry_after(&e(ErrorCode::Overloaded, Some(1000.0))),
        None
    );
}

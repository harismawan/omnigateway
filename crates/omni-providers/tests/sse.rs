//! The incremental SSE parser against conformance vectors and the edge-case
//! suite; the vectors pin the exact parse results, so regenerating them is a
//! deliberate wire change.

mod common;

use omni_providers::sse::{MAX_RECORD_CHARS, SseMessage, SseParser};
/// Runs the parser over `chunks` the way a streaming body is consumed.
fn run(chunks: &[&[u8]]) -> (Vec<SseMessage>, Option<omni_ir::error::GatewayError>) {
    let mut parser = SseParser::new();
    let mut out = Vec::new();
    for chunk in chunks {
        if let Err(e) = parser.push(chunk, &mut out) {
            return (out, Some(e));
        }
    }
    out.extend(parser.finish());
    (out, None)
}

fn msg(event: &str, data: &str) -> SseMessage {
    SseMessage {
        event: event.into(),
        data: data.into(),
    }
}

fn text(chunks: &[&str]) -> Vec<SseMessage> {
    let bytes: Vec<&[u8]> = chunks.iter().map(|c| c.as_bytes()).collect();
    let (out, err) = run(&bytes);
    assert!(err.is_none(), "unexpected error {err:?}");
    out
}

#[test]
fn parses_event_and_data_pairs() {
    assert_eq!(
        text(&["event: message_start\ndata: {\"a\":1}\n\nevent: ping\ndata: {}\n\n"]),
        [msg("message_start", "{\"a\":1}"), msg("ping", "{}")]
    );
}

#[test]
fn handles_messages_split_across_chunk_boundaries() {
    assert_eq!(
        text(&["event: msg\nda", "ta: {\"x\":", "2}\n\n"]),
        [msg("msg", "{\"x\":2}")]
    );
}

#[test]
fn ignores_comments_and_defaults_the_event_name() {
    assert_eq!(
        text(&[": keep-alive\n\ndata: real\n\n"]),
        [msg("message", "real")]
    );
}

#[test]
fn recognises_a_blank_line_in_every_crlf_lf_spelling() {
    for sep in ["\n\n", "\r\n\r\n", "\n\r\n", "\r\n\n"] {
        let stream = format!("data: one{sep}data: two{sep}");
        assert_eq!(
            text(&[&stream]),
            [msg("message", "one"), msg("message", "two")],
            "{sep:?}"
        );
    }
}

#[test]
fn splitting_a_crlf_record_at_any_single_point_parses_it_identically() {
    let whole = "event: message_start\r\ndata: {\"a\":1}\r\n\r\nevent: ping\r\ndata: {}\r\n\r\n";
    let expected = [msg("message_start", "{\"a\":1}"), msg("ping", "{}")];
    for cut in 1..whole.len() {
        assert_eq!(text(&[&whole[..cut], &whole[cut..]]), expected, "cut {cut}");
    }
}

#[test]
fn splitting_a_crlf_record_at_any_two_points_parses_it_identically() {
    let whole = "data: one\r\n\r\ndata: two\r\n\r\n";
    let expected = [msg("message", "one"), msg("message", "two")];
    for a in 1..whole.len() {
        for b in a + 1..whole.len() {
            assert_eq!(
                text(&[&whole[..a], &whole[a..b], &whole[b..]]),
                expected,
                "cuts {a},{b}"
            );
        }
    }
}

#[test]
fn keeps_a_bare_carriage_return_and_treats_a_final_one_as_a_terminator() {
    assert_eq!(text(&["data: a\r", "b\n\n"]), [msg("message", "a\rb")]);
    assert_eq!(text(&["data: a", "\r"]), [msg("message", "a")]);
}

#[test]
fn reassembles_a_record_split_inside_a_utf8_sequence_at_every_byte() {
    let whole = "data: 日本😀é\n\n".as_bytes();
    for cut in 1..whole.len() {
        let (out, err) = run(&[&whole[..cut], &whole[cut..]]);
        assert!(err.is_none());
        assert_eq!(out, [msg("message", "日本😀é")], "cut {cut}");
    }
}

#[test]
fn refuses_a_record_that_grows_past_the_cap_without_a_separator() {
    let piece = vec![b'x'; 1024 * 1024];
    let mut parser = SseParser::new();
    let mut out = Vec::new();
    parser.push(b"data: ", &mut out).expect("prefix");
    let mut refused = None;
    for _ in 0..=MAX_RECORD_CHARS / piece.len() {
        if let Err(e) = parser.push(&piece, &mut out) {
            refused = Some(e);
            break;
        }
    }
    let error = refused.expect("refused");
    assert_eq!(error.code, omni_ir::error::ErrorCode::Upstream);
    assert!(error.retryable);
    assert!(error.gateway_authored);
    assert_eq!(
        error.message,
        format!("upstream SSE record exceeded {MAX_RECORD_CHARS} characters")
    );
    assert!(out.is_empty());
}

#[test]
fn the_cap_is_per_record_not_per_stream() {
    let half = "z".repeat(64 * 1024);
    let mut parser = SseParser::new();
    let mut out = Vec::new();
    let records = MAX_RECORD_CHARS / half.len() + 5;
    for _ in 0..records {
        parser
            .push(format!("data: {half}").as_bytes(), &mut out)
            .expect("first half");
        parser
            .push(format!("{half}\n\n").as_bytes(), &mut out)
            .expect("second half");
    }
    assert_eq!(out.len(), records);
}

#[test]
fn many_small_chunks_of_one_large_record_stay_linear() {
    // 10,000 one-KiB chunks: quadratic re-scanning would take minutes here.
    let piece = vec![b'x'; 1024];
    let mut parser = SseParser::new();
    let mut out = Vec::new();
    parser.push(b"data: ", &mut out).expect("prefix");
    let started = std::time::Instant::now();
    for _ in 0..10_000 {
        parser.push(&piece, &mut out).expect("piece");
    }
    parser.push(b"\n\n", &mut out).expect("end");
    assert_eq!(out.len(), 1);
    assert_eq!(out[0].data.len(), 10_000 * 1024);
    assert!(started.elapsed() < std::time::Duration::from_secs(5));
}

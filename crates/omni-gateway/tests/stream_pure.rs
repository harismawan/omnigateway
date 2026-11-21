#[test]
fn transport_text_keeps_valid_discarded_json() {
    for extra in [
        "1e999".to_owned(),
        format!("{}0{}", "[".repeat(150), "]".repeat(150)),
    ] {
        let text = format!(r#"{{"type":"subscribe","topic":"res:logs","extra":{extra}}}"#);
        assert_eq!(
            omni_gateway::stream_transport::parse_text(&text)["topic"],
            "res:logs"
        );
    }
}

#[test]
fn text_utf16_topic_length_boundary() {
    for (n, valid) in [(124, true), (125, false)] {
        let text = format!(
            r#"{{"type":"subscribe","topic":"res:{}"}}"#,
            "\\ud800".repeat(n)
        );
        let raw = omni_gateway::stream_transport::parse_text(&text);
        assert_eq!(
            !omni_gateway::stream::parse_client_frame(&raw).is_null(),
            valid
        );
    }
}

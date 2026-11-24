#[test]
fn x1_lone_surrogate_text_retained_red() {
    let input = r#"{"model":"m","stream":true,"messages":[{"role":"user","content":[{"type":"text","text":"\ud800"}]}]}"#;
    let request = omni_ir::request::CanonicalRequest::parse(input).expect("canonical request");
    let built = omni_providers::antigravity::codec::AntigravityCodec
        .build_canonical(&request, "m", "t", &"p".into(), Some(&"r".into()))
        .expect("wire");
    assert!(built.request.body.contains(r#""text":"\ud800""#));
}

fn build_with_system(system: &str) -> (String, Vec<String>) {
    let input = serde_json::json!({
        "model": "m",
        "stream": true,
        "system": [{"type": "text", "text": system}],
        "messages": [{"role": "user", "content": [{"type": "text", "text": "hi"}]}],
    })
    .to_string();
    let request = omni_ir::request::CanonicalRequest::parse(&input).expect("canonical request");
    let built = omni_providers::antigravity::codec::AntigravityCodec
        .build_canonical(&request, "m", "t", &"p".into(), Some(&"r".into()))
        .expect("wire");
    (built.request.body, built.degradations)
}

#[test]
fn agent_identity_paragraphs_are_dropped() {
    let (body, notes) = build_with_system(
        "You are OpenCode, an agent.\n\nSee github.com/anomalyco/opencode for docs.\n\nKeep this rule.",
    );
    assert!(body.contains("Keep this rule."));
    assert!(!body.contains("OpenCode"));
    assert!(!body.contains("opencode"));
    assert!(notes.contains(&"antigravity:agent-identity-dropped".to_string()));
}

#[test]
fn opencode_phrases_are_rewritten() {
    let (body, notes) = build_with_system("Answer if OpenCode honestly can.");
    assert!(body.contains("if the assistant honestly"));
    assert!(!body.contains("OpenCode"));
    assert!(notes.contains(&"antigravity:agent-text-rewritten".to_string()));
}

#[test]
fn rewrite_keeps_lone_surrogates_lossless() {
    let input = r#"{"model":"m","stream":true,"system":[{"type":"text","text":"if OpenCode honestly\n\n\ud800"}],"messages":[{"role":"user","content":[{"type":"text","text":"hi"}]}]}"#;
    let request = omni_ir::request::CanonicalRequest::parse(input).expect("canonical request");
    let built = omni_providers::antigravity::codec::AntigravityCodec
        .build_canonical(&request, "m", "t", &"p".into(), Some(&"r".into()))
        .expect("wire");
    assert!(built.request.body.contains("if the assistant honestly"));
    assert!(built.request.body.contains(r#"\ud800"#));
}

#[test]
fn clean_system_is_untouched() {
    let (body, notes) = build_with_system("Be helpful.\n\nFollow the rules.");
    assert!(body.contains("Be helpful.\\n\\nFollow the rules."));
    assert!(!notes.iter().any(|n| n.starts_with("antigravity:agent-")));
}

#[test]
fn all_paragraphs_dropped_omits_system_instruction() {
    let (body, notes) = build_with_system("You are OpenCode, an agent.");
    assert!(!body.contains("systemInstruction"));
    assert!(notes.contains(&"antigravity:agent-identity-dropped".to_string()));
}

#[test]
fn hermes_prefix_is_dropped() {
    let (body, _) = build_with_system("You are Hermes Agent, be nice.\n\nKeep this rule.");
    assert!(!body.contains("Hermes"));
    assert!(body.contains("Keep this rule."));
}

#[test]
fn environment_header_is_rewritten() {
    let (body, notes) = build_with_system(
        "Here is some useful information about the environment you are running in:",
    );
    assert!(body.contains("Environment context you are running in:"));
    assert!(!body.contains("Here is some useful information"));
    assert!(notes.contains(&"antigravity:agent-text-rewritten".to_string()));
}

#[test]
fn crlf_runs_normalize_only_on_the_changed_path() {
    let (body, _) = build_with_system("You are OpenCode.\r\n\r\n\r\nKeep \r\n this.");
    assert!(!body.contains("OpenCode"));
    assert!(body.contains("Keep \\r\\n this."));
    let (clean, _) = build_with_system("Keep \r\n\r\n\r\nthis.");
    assert!(clean.contains("Keep \\r\\n\\r\\n\\r\\nthis."));
}

#[test]
fn dropped_paragraph_may_contain_lone_surrogates() {
    let input = r#"{"model":"m","stream":true,"system":[{"type":"text","text":"You are OpenCode \ud800.\n\nKeep this rule."}],"messages":[{"role":"user","content":[{"type":"text","text":"hi"}]}]}"#;
    let request = omni_ir::request::CanonicalRequest::parse(input).expect("canonical request");
    let built = omni_providers::antigravity::codec::AntigravityCodec
        .build_canonical(&request, "m", "t", &"p".into(), Some(&"r".into()))
        .expect("wire");
    assert!(built.request.body.contains("Keep this rule."));
    assert!(!built.request.body.contains(r#"\ud800"#));
}

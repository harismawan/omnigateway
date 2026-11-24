//! System prompt rewriting and billing block preparation before serialization.
use crate::agent_identity::{AGENT_PREAMBLE, REWRITES, banned};
use serde_json::{Value, json};

pub fn apply_system(system: &[Value], first_user_text: &str) -> Vec<Value> {
    let version = super::profile::env(
        "OMNI_ANTHROPIC_CLI_VERSION",
        omni_crypto::cch::DEFAULT_CLI_VERSION,
    );
    let suffix = omni_crypto::cch::cc_version_suffix(
        &first_user_text.encode_utf16().collect::<Vec<_>>(),
        &version,
    );
    let billing = format!(
        "{} cc_version={version}.{suffix}; cc_entrypoint=cli; cch=00000;",
        omni_crypto::cch::BILLING_PREFIX
    );
    let mut out = vec![
        json!({"type":"text","text":billing}),
        json!({"type":"text","text":AGENT_PREAMBLE}),
    ];
    for block in system {
        let text = block["text"].as_str().unwrap_or("");
        // split(/\n{2,}/): consume the entire run, retaining lone newlines.
        let mut paragraphs = Vec::new();
        let mut start = 0;
        let mut at = 0;
        let bytes = text.as_bytes();
        while at < bytes.len() {
            if bytes[at] == b'\n' && bytes.get(at + 1) == Some(&b'\n') {
                paragraphs.push(&text[start..at]);
                while bytes.get(at) == Some(&b'\n') {
                    at += 1;
                }
                start = at;
            } else {
                at += 1;
            }
        }
        paragraphs.push(&text[start..]);
        let kept: Vec<_> = paragraphs
            .into_iter()
            .filter(|p| {
                !banned(p)
                    && !p.contains(omni_crypto::cch::BILLING_PREFIX)
                    && omni_ir::js::trim(p) != AGENT_PREAMBLE
            })
            .collect();
        let mut rewritten = kept.join("\n\n");
        for (from, to) in REWRITES {
            rewritten = rewritten.replace(from, to);
        }
        if !omni_ir::js::trim(&rewritten).is_empty() {
            let mut value = json!({"type":"text","text":rewritten});
            if let Some(cache) = block.get("cache_control") {
                omni_ir::deep::replace(&mut value["cache_control"], cache.clone());
            }
            out.push(value);
        }
    }
    out
}

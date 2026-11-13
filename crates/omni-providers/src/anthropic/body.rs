//! System prompt rewriting and billing block preparation before serialization.
use serde_json::{Value, json};
pub const AGENT_PREAMBLE: &str = "You are a Claude agent, built on Anthropic's Claude Agent SDK.";
const BANNED: &[&str] = &[
    "github.com/anomalyco/opencode",
    "opencode.ai/docs",
    "github.com/cline/cline",
    "github.com/getcursor/cursor",
    "continue.dev",
    "hermes-agent.nousresearch.com",
];

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
                !BANNED.iter().any(|s| p.contains(s))
                    && !["You are OpenCode", "You are Hermes Agent"]
                        .iter()
                        .any(|s| omni_ir::js::trim(p).starts_with(s))
                    && !p.contains(omni_crypto::cch::BILLING_PREFIX)
                    && omni_ir::js::trim(p) != AGENT_PREAMBLE
            })
            .collect();
        let rewritten = kept
            .join("\n\n")
            .replace("if OpenCode honestly", "if the assistant honestly")
            .replace(
                "Here is some useful information about the environment you are running in:",
                "Environment context you are running in:",
            );
        if !omni_ir::js::trim(&rewritten).is_empty() {
            let mut value = json!({"type":"text","text":rewritten});
            if let Some(cache) = block.get("cache_control") {
                value["cache_control"] = cache.clone();
            }
            out.push(value);
        }
    }
    out
}

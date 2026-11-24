//! Agent-identity cloaking for system prompts, shared across providers.

pub const AGENT_PREAMBLE: &str = "You are a Claude agent, built on Anthropic's Claude Agent SDK.";

const BANNED: &[&str] = &[
    "github.com/anomalyco/opencode",
    "opencode.ai/docs",
    "github.com/cline/cline",
    "github.com/getcursor/cursor",
    "continue.dev",
    "hermes-agent.nousresearch.com",
];

pub const REWRITES: &[(&str, &str)] = &[
    ("if OpenCode honestly", "if the assistant honestly"),
    (
        "Here is some useful information about the environment you are running in:",
        "Environment context you are running in:",
    ),
];

pub fn banned(paragraph: &str) -> bool {
    BANNED.iter().any(|s| paragraph.contains(s))
        || ["You are OpenCode", "You are Hermes Agent"]
            .iter()
            .any(|s| omni_ir::js::trim(paragraph).starts_with(s))
}

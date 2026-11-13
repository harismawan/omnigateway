//! Claude CLI identity captured once by gateway startup, as TS captures on import.
use std::{collections::HashMap, sync::OnceLock};
static ENV: OnceLock<HashMap<String, String>> = OnceLock::new();

/// Call before serving requests. Library consumers initialize on first use.
pub fn initialize() {
    ENV.get_or_init(|| {
        std::env::vars()
            .filter(|(k, _)| k.starts_with("OMNI_"))
            .collect()
    });
}
fn raw_env(name: &str) -> Option<&'static String> {
    initialize();
    ENV.get().and_then(|env| env.get(name))
}
pub fn env(name: &str, fallback: &str) -> String {
    raw_env(name)
        .filter(|s| safe(s))
        .cloned()
        .unwrap_or_else(|| fallback.into())
}
fn safe(s: &str) -> bool {
    !s.is_empty() && s.len() <= 200 && s.bytes().all(|b| (32..=126).contains(&b))
}

pub fn headers(extra: Vec<(String, String)>) -> Vec<(String, String)> {
    let version = env("OMNI_ANTHROPIC_CLI_VERSION", "2.1.296");
    let os = match std::env::consts::OS {
        "linux" => "Linux",
        "macos" => "MacOS",
        "windows" => "Windows",
        _ => "Unknown",
    };
    let arch = match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        "x86" => "ia32",
        other => other,
    };
    let mut base: Vec<(String, String)> = vec![
        (
            "User-Agent",
            env(
                "OMNI_UA_ANTHROPIC",
                &format!("claude-cli/{version} (external, cli)"),
            ),
        ),
        ("x-app", "cli".into()),
        ("anthropic-dangerous-direct-browser-access", "true".into()),
        ("X-Stainless-Lang", "js".into()),
        (
            "X-Stainless-Package-Version",
            env("OMNI_ANTHROPIC_STAINLESS_PACKAGE_VERSION", "0.128.0"),
        ),
        ("X-Stainless-OS", env("OMNI_ANTHROPIC_STAINLESS_OS", os)),
        (
            "X-Stainless-Arch",
            env("OMNI_ANTHROPIC_STAINLESS_ARCH", arch),
        ),
        ("X-Stainless-Runtime", "node".into()),
        (
            "X-Stainless-Runtime-Version",
            env("OMNI_ANTHROPIC_STAINLESS_RUNTIME_VERSION", "v26.3.0"),
        ),
        ("X-Stainless-Retry-Count", "0".into()),
        ("Accept", "application/json".into()),
    ]
    .into_iter()
    .map(|(k, v)| (k.into(), v))
    .collect();
    for pair in extra {
        if let Some(i) = base
            .iter()
            .position(|(k, _)| k.eq_ignore_ascii_case(&pair.0))
        {
            base[i] = pair;
        } else {
            base.push(pair);
        }
    }
    let default = "Accept,Authorization,Content-Type,User-Agent,X-Stainless-Arch,X-Stainless-Lang,X-Stainless-OS,X-Stainless-Package-Version,X-Stainless-Retry-Count,X-Stainless-Runtime,X-Stainless-Runtime-Version,X-Stainless-Timeout,anthropic-beta,anthropic-dangerous-direct-browser-access,anthropic-version,x-api-key,x-app,Connection,Host,Accept-Encoding,Content-Length";
    let raw = raw_env("OMNI_ORDER_ANTHROPIC").map_or("", String::as_str);
    let parts: Vec<_> = raw
        .split(',')
        .map(omni_ir::js::trim)
        .filter(|s| safe(s))
        .collect();
    let order: Vec<_> = if parts.is_empty() {
        default.split(',').collect()
    } else {
        parts
    };
    let mut out = Vec::new();
    for name in order {
        if let Some(i) = base.iter().position(|(k, _)| k.eq_ignore_ascii_case(name)) {
            out.push(base.remove(i));
        }
    }
    out.extend(base);
    out
}

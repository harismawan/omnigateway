use std::{collections::HashMap, sync::OnceLock};
static ENV: OnceLock<HashMap<String, String>> = OnceLock::new();
/// Capture the profile before serving requests, like the frozen module import.
pub(super) fn initialize() {
    let _ = raw("OMNI_OPENAI_CLI_VERSION");
}
fn raw(name: &str) -> Option<&'static String> {
    capture(|| {
        std::env::vars_os()
            .filter_map(|(k, v)| Some((k.into_string().ok()?, v.into_string().ok()?)))
            .filter(|(k, _)| {
                k.starts_with("OMNI_OPENAI_") || k == "OMNI_UA_OPENAI" || k == "OMNI_ORDER_OPENAI"
            })
            .collect()
    });
    ENV.get().and_then(|env| env.get(name))
}
fn capture(source: impl FnOnce() -> HashMap<String, String>) {
    ENV.get_or_init(source);
}
fn safe(s: &str) -> bool {
    !s.is_empty() && s.len() <= 200 && s.bytes().all(|b| (32..=126).contains(&b))
}
fn env(name: &str, fallback: &str) -> String {
    raw(name)
        .filter(|s| safe(s))
        .cloned()
        .unwrap_or_else(|| fallback.into())
}
pub(crate) fn sandbox() -> &'static str {
    let platform = env("OMNI_OPENAI_UA_PLATFORM", "Windows 10.0.26200");
    if platform.starts_with("Windows") {
        "windows_elevated"
    } else if platform.starts_with("Mac OS") || platform.starts_with("macOS") {
        "seatbelt"
    } else {
        "seccomp"
    }
}
pub(super) fn originator() -> String {
    env("OMNI_OPENAI_ORIGINATOR", "codex-tui")
}

pub(crate) fn headers(extra: Vec<(String, String)>) -> Vec<(String, String)> {
    initialize();
    let version = env("OMNI_OPENAI_CLI_VERSION", "0.165.0");
    let origin = originator();
    let platform = env("OMNI_OPENAI_UA_PLATFORM", "Windows 10.0.26200");
    let arch = env("OMNI_OPENAI_UA_ARCH", "x86_64");
    let terminal = env("OMNI_OPENAI_UA_TERMINAL", "WindowsTerminal");
    let ua = env(
        "OMNI_UA_OPENAI",
        &format!("{origin}/{version} ({platform}; {arch}) {terminal} ({origin}; {version})"),
    );
    let mut base: Vec<(String, String)> = vec![
        ("user-agent", ua),
        ("originator", origin),
        ("version", version),
        ("x-codex-beta-features", "remote_compaction_v2".into()),
        ("accept", "text/event-stream".into()),
    ]
    .into_iter()
    .map(|(k, v)| (k.into(), v))
    .collect();
    for pair in extra {
        if let Some(slot) = base
            .iter_mut()
            .find(|(k, _)| k.eq_ignore_ascii_case(&pair.0))
        {
            *slot = pair;
        } else {
            base.push(pair);
        }
    }
    let parts: Vec<_> = raw("OMNI_ORDER_OPENAI")
        .map_or("", String::as_str)
        .split(',')
        .map(omni_ir::js::trim)
        .filter(|s| safe(s))
        .collect();
    let default = "version,x-codex-beta-features,x-codex-window-id,x-codex-turn-metadata,x-openai-internal-codex-responses-lite,x-codex-routing-hint,x-client-request-id,session-id,thread-id,accept,content-encoding,content-type,authorization,chatgpt-account-id,originator,user-agent,host,content-length";
    let order = if parts.is_empty() {
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

#[cfg(test)]
mod tests {
    #[test]
    fn environment_oracle_subprocess() {
        if std::env::var_os("OPENAI_PROFILE_CHILD").is_some() {
            crate::openai::initialize();
            let before = super::headers(vec![]);
            // Rust 2024 set_var requires unsafe. Change the environment source
            // at the same capture boundary instead, without process mutation.
            super::capture(|| {
                std::collections::HashMap::from([
                    ("OMNI_OPENAI_CLI_VERSION".into(), "later".into()),
                    ("OMNI_UA_OPENAI".into(), "later-agent".into()),
                    ("OMNI_ORDER_OPENAI".into(), "user-agent".into()),
                ])
            });
            assert_eq!(super::headers(vec![]), before);
            let extra = vec![
                ("Accept".into(), "application/json".into()),
                ("X-Extra".into(), "extra".into()),
            ];
            let actual = super::headers(extra);
            let out=std::process::Command::new("bun").args(["-e",r#"const {openaiProfile:p}=await import('./packages/providers/src/openai/profile.ts');const {mergeHeaders,orderHeaders}=await import('./packages/providers/src/headers.ts');process.env.OMNI_OPENAI_CLI_VERSION='later';console.log(JSON.stringify(orderHeaders(mergeHeaders(p.headers,[['Accept','application/json'],['X-Extra','extra']]),p.order)))"#]).current_dir(concat!(env!("CARGO_MANIFEST_DIR"),"/../..")).output().expect("oracle");
            assert!(out.status.success());
            let expected: serde_json::Value = serde_json::from_slice(&out.stdout).expect("headers");
            assert_eq!(serde_json::json!(actual), expected);
            return;
        }
        for value in ["startup", "", "bad\r\nvalue", "日本語"] {
            let out = std::process::Command::new(std::env::current_exe().expect("exe"))
                .args([
                    "--exact",
                    "openai::profile::tests::environment_oracle_subprocess",
                ])
                .env("OPENAI_PROFILE_CHILD", "1")
                .env("OMNI_OPENAI_CLI_VERSION", value)
                .env("OMNI_OPENAI_UA_PLATFORM", "Linux")
                .env(
                    "OMNI_ORDER_OPENAI",
                    " X-Extra, ACCEPT, user-agent, version,accept ",
                )
                .output()
                .expect("child");
            assert!(
                out.status.success(),
                "{}",
                String::from_utf8_lossy(&out.stderr)
            );
        }
    }
}

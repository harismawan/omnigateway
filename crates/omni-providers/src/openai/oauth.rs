pub use super::oauth_lifecycle::{exchange_request, refresh_request, token_result};
pub use super::oauth_start::start;
use omni_crypto::codex;
use omni_ir::jsjson;
use serde_json::{Value, json};
pub(crate) struct Catalog {
    pub lite: bool,
    pub effort: &'static str,
    pub verbosity: &'static str,
    pub review: bool,
    pub updates: bool,
}
pub(crate) fn catalog(model: &str) -> Catalog {
    Catalog {
        lite: model != "gpt-5.5",
        effort: if matches!(
            model,
            "gpt-6-sol"
                | "gpt-6-luna"
                | "gpt-5.6-terra"
                | "gpt-5.6-luna"
                | "gpt-daybreak-red-latest"
                | "gpt-5.5"
                | "codex-auto-review"
        ) {
            "medium"
        } else {
            "low"
        },
        verbosity: if model == "gpt-daybreak-red-latest" {
            "high"
        } else {
            "low"
        },
        review: matches!(
            model,
            "gpt-6-astra" | "gpt-6.1-sol" | "gpt-6.1-terra" | "gpt-6-sol"
        ),
        updates: matches!(model, "gpt-6-astra" | "gpt-6.1-sol" | "gpt-6.1-terra"),
    }
}
pub(crate) fn is_effort(e: &str) -> bool {
    matches!(
        e,
        "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra" | "persistent"
    )
}
pub(crate) fn turn(
    opts: &crate::codec::CodecInput<'_>,
    key: &str,
    seed: &str,
    built: &Value,
    effort: &str,
) -> (Value, Vec<(String, String)>) {
    let secrets = super::identity::secrets_from_map(&opts.credentials.provider_data);
    let account = opts
        .credentials
        .provider_data
        .get("accountId")
        .and_then(Value::as_str);
    let installation = secrets.installation_id.unwrap_or_else(|| {
        codex::uuid_v4_from(&format!("installation:{}", account.unwrap_or(seed)))
    });
    let window = format!("{key}:0");
    let turn = &built["turnId"];
    let started = built["startedAt"].as_f64().unwrap_or(0.0);
    let c = catalog(opts.model);
    let meta = json!({"installation_id":installation,"session_id":key,"thread_id":key,"agent_name":"/root","turn_id":turn,"window_id":window,"window_number":0,"context_window_id":codex::uuid_v7_from(&codex::keyed(secrets.id_salt.as_deref(),&format!("{key}:context-window")),codex::thread_instant(key,started)),"request_kind":"turn","history_initialization":"new","root_turn_id":turn,"thread_source":"user","turn_trigger":"user","sandbox":super::profile::sandbox(),"sandbox_mode":"workspace-write","auto_review_enabled":false,"node_repl_auto_review_required":c.review,"node_repl_disabled":false,"turn_started_at_unix_ms":started,"analytics_enabled":false,"model":opts.model,"reasoning_effort":effort});
    let mut ascii = String::new();
    for unit in jsjson::to_string(&meta).encode_utf16() {
        if (32..=126).contains(&unit) {
            ascii.push(char::from_u32(u32::from(unit)).unwrap_or('?'));
        } else {
            ascii.push_str(&format!("\\u{unit:04x}"));
        }
    }
    let metadata = json!({"turn_id":turn,"thread_id":key,"x-codex-turn-metadata":ascii,"mcp_attribution":"{\"status\":\"none\"}","guardian_credits_requested":"true","x-codex-installation-id":installation,"x-codex-window-id":window,"root_turn_id":turn,"session_id":key});
    let mut headers = vec![
        ("x-codex-window-id".into(), window),
        ("x-codex-turn-metadata".into(), ascii),
    ];
    if c.lite {
        headers.push((
            "x-openai-internal-codex-responses-lite".into(),
            "true".into(),
        ));
    }
    (metadata, headers)
}

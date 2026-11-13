//! `@omni/testkit` fixtures: `credential`, `target`, `health`, `quota`,
//! `snapshot`, `recent`.

#![allow(dead_code)]

use omni_ir::request::ChatRequest;
use omni_router::{RankInput, RecentUse, Snapshot, health_key};
use omni_store::credentials::{Credential, CredentialHealth, CredentialSecrets, Secret};
use omni_store::models::{Capabilities, Target, TargetPricing};
use omni_store::settings::{Settings, default_settings_json};
use omni_store::{AuthType, BreakerState, QuotaWindow, Strategy, VirtualModel, WindowType};
use serde_json::{Map, Value, json};
use std::collections::HashMap;

pub const NOW: f64 = 1_000_000.0;

pub fn req() -> ChatRequest {
    request(json!({
        "model": "fast",
        "messages": [{ "role": "user", "content": [{ "type": "text", "text": "hi" }] }],
        "stream": true
    }))
}

pub fn request(v: Value) -> ChatRequest {
    serde_json::from_value(v).expect("request")
}

/// `req` with fields merged over it.
pub fn req_with(extra: Value) -> ChatRequest {
    let mut base = json!({
        "model": "fast",
        "messages": [{ "role": "user", "content": [{ "type": "text", "text": "hi" }] }],
        "stream": true
    });
    for (k, v) in extra.as_object().expect("object") {
        base[k] = v.clone();
    }
    request(base)
}

pub fn portable_tool() -> Value {
    json!([{ "kind": "portable", "name": "f", "inputSchema": {} }])
}

#[derive(Clone)]
pub struct Cred(pub Credential);

pub fn credential(id: &str) -> Credential {
    Credential {
        lone_endpoint: None,
        id: id.to_owned(),
        provider: "anthropic".to_owned(),
        label: id.to_owned(),
        auth_type: AuthType::OAuth,
        enabled: true,
        tier: 1.0,
        weight: 1.0,
        expires_at: None,
        account_email: None,
        provider_data: Value::Object(Map::new()),
        disabled_reason: None,
        disabled_at: None,
        has_refresh_token: true,
        token_version: 0,
        created_at: 0,
        updated_at: 0,
        secrets: CredentialSecrets {
            access_token: Secret::Present(format!("test-token-{id}")),
            refresh_token: Secret::Present(format!("test-refresh-{id}")),
            api_key: Secret::Absent,
            id_token: Secret::Absent,
        },
    }
}

pub fn cred_with(id: &str, f: impl FnOnce(&mut Credential)) -> Credential {
    let mut c = credential(id);
    f(&mut c);
    c
}

pub fn cred_of(id: &str, provider: &str) -> Credential {
    cred_with(id, |c| c.provider = provider.to_owned())
}

pub fn custom_cred(id: &str, endpoint: Value) -> Credential {
    cred_with(id, |c| {
        c.provider = "custom".to_owned();
        c.auth_type = AuthType::ApiKey;
        c.provider_data = json!({ "endpointId": endpoint });
    })
}

pub fn target() -> Target {
    Target {
        lone_identity: Default::default(),
        provider: "anthropic".to_owned(),
        endpoint_id: None,
        model: "claude-opus-4".to_owned(),
        tier: 1.0,
        weight: 1.0,
        cost_per_m_tok: pricing(15.0, 75.0),
        context_window: None,
        max_output_tokens: None,
        capabilities: Capabilities {
            tools: true,
            images: true,
            reasoning: true,
        },
        credential_id: None,
        extra: Map::new(),
    }
}

pub fn target_with(f: impl FnOnce(&mut Target)) -> Target {
    let mut t = target();
    f(&mut t);
    t
}

pub fn target_of(provider: &str, model: &str) -> Target {
    target_with(|t| {
        t.provider = provider.to_owned();
        t.model = model.to_owned();
    })
}

pub fn pricing(input: f64, output: f64) -> TargetPricing {
    TargetPricing {
        input,
        output,
        cache_read: None,
        cache_write_5m: None,
        cache_write_1h: None,
        extra: Map::new(),
    }
}

pub fn health(credential_id: &str) -> CredentialHealth {
    CredentialHealth {
        credential_id: credential_id.to_owned(),
        model: "claude-opus-4".to_owned(),
        breaker_state: BreakerState::Closed,
        consecutive_failures: 0,
        opened_at: None,
        rate_limited_until: None,
    }
}

pub fn health_with(credential_id: &str, f: impl FnOnce(&mut CredentialHealth)) -> CredentialHealth {
    let mut h = health(credential_id);
    f(&mut h);
    h
}

pub fn quota(credential_id: &str, used: f64, limit: Option<f64>) -> QuotaWindow {
    QuotaWindow {
        credential_id: credential_id.to_owned(),
        window_type: WindowType::FiveHour,
        starts_at: 0.0,
        used,
        limit,
        resets_at: None,
        observed_at: 0.0,
        window_ms: None,
    }
}

pub fn quota_with(
    credential_id: &str,
    used: f64,
    limit: Option<f64>,
    f: impl FnOnce(&mut QuotaWindow),
) -> QuotaWindow {
    let mut q = quota(credential_id, used, limit);
    f(&mut q);
    q
}

pub fn model(targets: Vec<Target>, strategy: Strategy) -> VirtualModel {
    VirtualModel {
        id: "fast".to_owned(),
        targets,
        strategy,
        is_alias: false,
    }
}

pub fn score_model(targets: Vec<Target>) -> VirtualModel {
    model(targets, Strategy::Score)
}

#[derive(Default)]
pub struct Snap {
    pub credentials: Vec<Credential>,
    pub health: Vec<CredentialHealth>,
    pub quota: Vec<QuotaWindow>,
    pub models: Vec<VirtualModel>,
    /// Merged over `DEFAULT_SETTINGS`, `weights` merged too.
    pub settings: Value,
}

pub fn snapshot(parts: Snap) -> Snapshot {
    let mut settings = default_settings_json();
    if let Value::Object(over) = parts.settings {
        for (k, v) in over {
            if k == "weights" {
                for (wk, wv) in v.as_object().expect("weights") {
                    settings["weights"][wk] = wv.clone();
                }
            } else {
                settings[k] = v;
            }
        }
    }
    Snapshot::new(
        parts.credentials,
        parts.health,
        parts.quota,
        parts.models,
        Settings::from_json(settings),
        NOW,
    )
}

pub fn creds(credentials: Vec<Credential>) -> Snapshot {
    snapshot(Snap {
        credentials,
        ..Snap::default()
    })
}

/// Only the named term carries weight.
pub fn only(term: &str) -> Value {
    let mut w = json!({ "tier": 0, "health": 0, "quota": 0, "cost": 0, "latency": 0, "load": 0 });
    w[term] = json!(1);
    json!({ "weights": w })
}

pub fn recent(entries: &[(&str, Option<f64>, Option<f64>)]) -> HashMap<String, RecentUse> {
    entries
        .iter()
        .map(|(id, released, ewma)| {
            (
                health_key(id, "claude-opus-4"),
                RecentUse {
                    last_released_at: released.unwrap_or(0.0),
                    ewma_ttft_ms: *ewma,
                },
            )
        })
        .collect()
}

pub fn input<'a>(
    request: &'a ChatRequest,
    model: &'a VirtualModel,
    snapshot: &'a Snapshot,
) -> RankInput<'a> {
    RankInput {
        request,
        model,
        snapshot,
        now: NOW,
        rand: 0.0,
        load: None,
        recent: None,
        providers: None,
    }
}

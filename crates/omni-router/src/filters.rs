//! Eligibility (`packages/router/src/filters.ts`, and `servesTarget` /
//! `credentialExpired` from `@omni/store/types`).

use crate::providers::Providers;
use crate::quota::rolled_over;
use crate::rank::RankInput;
use omni_ir::js::{math_max, math_min};
use omni_ir::request::{ChatRequest, ContentBlock, ReasoningConfig, ToolDef};
use omni_store::models::Target;
use omni_store::{AuthType, BreakerState, Credential};
use serde_json::Value;
use std::collections::BTreeSet;
use std::sync::OnceLock;

/// A (credential, target) the request may be sent to.
#[derive(Debug, Clone, Copy)]
pub struct Pair<'a> {
    pub credential: &'a Credential,
    pub target: &'a omni_store::Target,
    /// An open breaker past cooldown, or `halfOpen`. Dispatch makes the claim.
    pub probe: bool,
}

/// Whether an exclusion is a fact about the target or about the account.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExcludedKind {
    Target,
    Account,
}

impl ExcludedKind {
    pub fn as_str(self) -> &'static str {
        match self {
            ExcludedKind::Target => "target",
            ExcludedKind::Account => "account",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Excluded {
    pub kind: ExcludedKind,
    /// `""` for a target-kind row naming no account.
    pub credential_id: String,
    pub model: String,
    pub reason: String,
}

#[derive(Debug, Clone, Default)]
pub struct Eligible<'a> {
    pub pairs: Vec<Pair<'a>>,
    pub excluded: Vec<Excluded>,
}

/// What the request needs of a target.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Required {
    pub tools: bool,
    pub images: bool,
    pub reasoning: bool,
}

/// `requiredProviders`: every provider whose own dialect the request carries.
/// More than one means nothing can serve it.
pub fn required_providers(request: &ChatRequest) -> BTreeSet<String> {
    let mut owners = BTreeSet::new();
    for tool in request.tools.iter().flatten() {
        if let ToolDef::Provider(t) = tool {
            owners.insert(t.provider.clone());
        }
    }
    // `system`: top-level native blocks only. A tool result's own native
    // parts are read inside messages alone, as TS reads them.
    for block in request.system.iter().flatten() {
        if let ContentBlock::ProviderNative(b) = block {
            owners.insert(b.provider.clone());
        }
    }
    for message in &request.messages {
        for block in &message.content {
            match block {
                ContentBlock::ProviderNative(b) => {
                    owners.insert(b.provider.clone());
                }
                ContentBlock::ToolResult(b) => {
                    for n in b.native.iter().flatten() {
                        owners.insert(n.provider.clone());
                    }
                }
                _ => {}
            }
        }
    }
    owners
}

/// `requiredCapabilities`, reading every position a block can sit in.
pub fn required_capabilities(request: &ChatRequest) -> Required {
    let has_image = |blocks: &[ContentBlock]| {
        blocks.iter().any(|b| match b {
            ContentBlock::Image(_) => true,
            ContentBlock::ToolResult(r) => r.images.is_some() || r.files.is_some(),
            _ => false,
        })
    };
    let images = request.system.as_deref().is_some_and(has_image)
        || request.messages.iter().any(|m| has_image(&m.content));
    Required {
        tools: request.tools.as_ref().is_some_and(|t| !t.is_empty()),
        images,
        reasoning: matches!(
            request.reasoning,
            Some(ReasoningConfig::Adaptive { .. } | ReasoningConfig::Budget { .. })
        ),
    }
}

/// `servesTarget`: provider, custom endpoint and pin, as one question.
///
/// `""` names no endpoint on the target side only. On the account side a
/// present value that is not a non-empty string matches nothing at all.
pub fn serves_target(target: &Target, account: &Credential) -> bool {
    if target.lone_identity.contains_key("provider")
        || target.lone_identity.contains_key("credentialId")
    {
        return false;
    }
    if account.provider != target.provider {
        return false;
    }
    enum Named<'a> {
        None,
        Id(&'a str),
        Unusable,
    }
    let by_target = match &target.endpoint_id {
        None => Named::None,
        Some(Value::String(s)) if s.is_empty() => Named::None,
        Some(Value::String(s)) => Named::Id(s),
        // A target value is compared raw in TS; a non-string never equals an
        // account's string or `undefined`, and never equals the symbol.
        Some(_) => Named::Unusable,
    };
    let by_account = match account.provider_data.get("endpointId") {
        None => Named::None,
        Some(Value::String(s)) if !s.is_empty() => Named::Id(s),
        Some(_) => Named::Unusable,
    };
    let same = match (by_target, by_account) {
        (Named::None, Named::None) => true,
        (Named::Id(a), Named::Id(b)) => a == b,
        _ => false,
    };
    let same = match (
        target.lone_identity.get("endpointId"),
        account.lone_endpoint.as_ref(),
    ) {
        (None, None) => same,
        (Some(a), Some(b)) => a == b,
        _ => false,
    };
    same && target
        .credential_id
        .as_ref()
        .is_none_or(|pin| *pin == account.id)
}

/// `credentialExpired`: an OAuth token past expiry with no way to refresh.
#[allow(clippy::cast_precision_loss)]
fn credential_expired(c: &Credential, now: f64) -> bool {
    c.auth_type == AuthType::OAuth
        && c.expires_at.is_some_and(|at| at as f64 <= now)
        && !c.has_refresh_token
}

/// Base cooldown doubled per failure past the threshold, capped at an hour.
fn cooldown_ms(failures: f64, threshold: f64, base: f64) -> f64 {
    let over = math_max(0.0, failures - threshold);
    math_min(base * 2f64.powf(over), 3_600_000.0)
}

fn builtin() -> &'static Providers {
    static BUILTIN: OnceLock<Providers> = OnceLock::new();
    BUILTIN.get_or_init(Providers::builtin)
}

pub(crate) fn providers_of<'a>(input: &RankInput<'a>) -> &'a Providers {
    match input.providers {
        Some(p) => p,
        None => builtin(),
    }
}

/// `eligible`.
#[allow(clippy::cast_precision_loss)]
pub fn eligible<'a>(input: &RankInput<'a>) -> Eligible<'a> {
    let snapshot = input.snapshot;
    let now = input.now;
    let providers = providers_of(input);
    let threshold = snapshot.settings.breaker_threshold;
    let base_cooldown = snapshot.settings.breaker_cooldown_ms;
    let need = required_capabilities(input.request);
    let required = required_providers(input.request);

    let mut out = Eligible::default();
    for target in &input.model.targets {
        if !providers.has(&target.provider) {
            out.excluded.push(Excluded {
                kind: ExcludedKind::Target,
                credential_id: String::new(),
                model: target.model.clone(),
                reason: "provider:missing".to_owned(),
            });
            continue;
        }

        let missing: Option<&str> = if required.len() > 1
            || (required.len() == 1 && !required.contains(&target.provider))
        {
            Some("providerNative")
        } else if need.tools && !target.capabilities.tools {
            Some("tools")
        } else if need.images && !target.capabilities.images {
            Some("images")
        } else if need.reasoning && !target.capabilities.reasoning {
            Some("reasoning")
        } else {
            None
        };
        let missing_kind = if missing == Some("providerNative") {
            ExcludedKind::Target
        } else {
            ExcludedKind::Account
        };

        let mut pin_seen = false;
        let mut provider_seen = false;
        let mut served_any = false;

        for credential in &snapshot.credentials {
            if credential.provider == target.provider {
                provider_seen = true;
            }
            if !serves_target(target, credential) {
                continue;
            }
            served_any = true;
            pin_seen = target.credential_id.is_some();

            let mut drop = |reason: String, kind: ExcludedKind| {
                out.excluded.push(Excluded {
                    kind,
                    credential_id: credential.id.clone(),
                    model: target.model.clone(),
                    reason,
                });
            };

            if let Some(m) = missing {
                drop(format!("capability:{m}"), missing_kind);
                continue;
            }
            if !credential.enabled {
                drop("disabled".to_owned(), ExcludedKind::Account);
                continue;
            }
            if credential_expired(credential, now) {
                drop("expired".to_owned(), ExcludedKind::Account);
                continue;
            }

            let mut probe = false;
            if let Some(h) = snapshot.health_of(&credential.id, &target.model) {
                if h.rate_limited_until.is_some_and(|u| u > now) {
                    drop("rateLimited".to_owned(), ExcludedKind::Account);
                    continue;
                }
                if h.breaker_state == BreakerState::Open {
                    let elapsed = now - h.opened_at.unwrap_or(now);
                    let cooldown =
                        cooldown_ms(h.consecutive_failures as f64, threshold, base_cooldown);
                    if elapsed < cooldown {
                        drop("breaker:open".to_owned(), ExcludedKind::Account);
                        continue;
                    }
                    probe = true;
                } else if h.breaker_state == BreakerState::HalfOpen {
                    probe = true;
                }
            }

            let spent = snapshot
                .quota_of(&credential.id)
                .iter()
                .find(|w| w.limit.is_some_and(|l| w.used >= l) && !rolled_over(w, now));
            if let Some(w) = spent {
                drop(
                    format!("quota:{}", w.window_type.as_str()),
                    ExcludedKind::Account,
                );
                continue;
            }

            out.pairs.push(Pair {
                credential,
                target,
                probe,
            });
        }

        if target.credential_id.is_none() && provider_seen && !served_any {
            out.excluded.push(Excluded {
                kind: ExcludedKind::Target,
                credential_id: String::new(),
                model: target.model.clone(),
                reason: "endpoint:unmatched".to_owned(),
            });
        }
        if let Some(pin) = &target.credential_id
            && !pin_seen
        {
            out.excluded.push(Excluded {
                kind: ExcludedKind::Account,
                credential_id: pin.clone(),
                model: target.model.clone(),
                reason: "pin:missing".to_owned(),
            });
        }
    }
    out
}

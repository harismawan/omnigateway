//! Frozen `modelDisplayName` and `resolveModelLimits`: pure snapshot projections.
use crate::{Providers, serves_target};
use omni_store::{AuthType, Credential, VirtualModel};
use std::collections::HashMap;

/// Request-local serving facts. Auths retain frozen Set insertion order, but
/// collapse every non-OAuth spelling to its identical API-limit behavior.
/// Pin buckets retain snapshot order even for duplicate ids in synthetic input.
#[derive(Default)]
pub struct ServingCredentials<'a> {
    auths: HashMap<&'a str, Vec<bool>>,
    pins: HashMap<&'a str, Vec<&'a Credential>>,
    #[cfg(test)]
    auth_visits: std::cell::Cell<usize>,
    #[cfg(test)]
    pin_comparisons: std::cell::Cell<usize>,
}

impl<'a> ServingCredentials<'a> {
    pub fn new(credentials: impl IntoIterator<Item = &'a Credential>) -> Self {
        let mut index = Self::default();
        for c in credentials {
            if !c.enabled {
                continue;
            }
            let auths = index.auths.entry(&c.provider).or_default();
            let oauth = c.auth_type == AuthType::OAuth;
            if !auths.contains(&oauth) {
                auths.push(oauth);
            }
            index.pins.entry(&c.id).or_default().push(c);
        }
        index
    }
}

/// Catalog label only when one target tells the whole story.
pub fn model_display_name<'a>(model: &'a VirtualModel, providers: &'a Providers) -> &'a str {
    if let [target] = model.targets.as_slice()
        && let Some(choice) = providers
            .get(&target.provider)
            .and_then(|d| d.catalog.iter().find(|c| c.id == target.model))
    {
        return &choice.label;
    }
    &model.id
}

fn narrower(a: Option<f64>, b: Option<f64>) -> Option<f64> {
    match (a, b) {
        (Some(a), Some(b)) => Some(omni_ir::js::math_min(a, b)),
        (a, b) => a.or(b),
    }
}

/// Smallest known context/output across serving auths and targets. Saved
/// figures override catalog figures, including zero; unknown is no constraint.
pub fn resolve_model_limits(
    model: &VirtualModel,
    credentials: &ServingCredentials<'_>,
    providers: &Providers,
) -> (Option<f64>, Option<f64>) {
    let mut limits = (None, None);
    for target in &model.targets {
        let pinned = target.credential_id.as_ref().and_then(|id| {
            credentials.pins.get(id.as_str()).and_then(|bucket| {
                bucket.iter().find(|c| {
                    #[cfg(test)]
                    credentials
                        .pin_comparisons
                        .set(credentials.pin_comparisons.get() + 1);
                    serves_target(target, c)
                })
            })
        });
        let pinned_auth;
        let auths: &[bool] = match pinned {
            Some(c) => {
                pinned_auth = [c.auth_type == AuthType::OAuth];
                &pinned_auth
            }
            None => credentials
                .auths
                .get(target.provider.as_str())
                .map_or(&[], Vec::as_slice),
        };
        let mut listed = (None, None);
        if let Some(choice) = providers
            .get(&target.provider)
            .and_then(|d| d.catalog.iter().find(|c| c.id == target.model))
        {
            let api = (choice.context_window, choice.max_output_tokens);
            if auths.is_empty() {
                listed = api;
            } else {
                for auth in auths {
                    #[cfg(test)]
                    credentials
                        .auth_visits
                        .set(credentials.auth_visits.get() + 1);
                    let next = if *auth {
                        choice.oauth_limits.unwrap_or(api)
                    } else {
                        api
                    };
                    listed = (narrower(listed.0, next.0), narrower(listed.1, next.1));
                }
            }
        }
        limits = (
            narrower(limits.0, target.context_window.or(listed.0)),
            narrower(limits.1, target.max_output_tokens.or(listed.1)),
        );
    }
    limits
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    #[test]
    fn one_request_pass_then_two_auths_or_one_pin_per_target() {
        let credentials: Vec<_> = (0..5000)
            .map(|i| {
                use omni_store::credentials::{CredentialSecrets, Secret};
                let mut c = Credential {
                    lone_endpoint: None,
                    id: format!("c{i}"),
                    provider: "openai".into(),
                    label: String::new(),
                    auth_type: AuthType::ApiKey,
                    enabled: true,
                    tier: 1.0,
                    weight: 1.0,
                    expires_at: None,
                    account_email: None,
                    provider_data: serde_json::json!({}),
                    disabled_reason: None,
                    disabled_at: None,
                    has_refresh_token: false,
                    token_version: 0,
                    created_at: 0,
                    updated_at: 0,
                    secrets: CredentialSecrets {
                        access_token: Secret::Absent,
                        refresh_token: Secret::Absent,
                        api_key: Secret::Absent,
                        id_token: Secret::Absent,
                    },
                };
                c.auth_type = if i % 2 == 0 {
                    AuthType::ApiKey
                } else {
                    AuthType::OAuth
                };
                c
            })
            .collect();
        let visited = Cell::new(0);
        let index = ServingCredentials::new(
            credentials
                .iter()
                .inspect(|_| visited.set(visited.get() + 1)),
        );
        assert_eq!(visited.get(), 5000);
        assert_eq!(index.auths["openai"], [false, true]);
        let providers = Providers::builtin();
        let target: omni_store::Target = serde_json::from_value(serde_json::json!({
            "provider":"openai", "model":"gpt-6.1-sol", "tier":1, "weight":1,
            "costPerMTok":{"input":0,"output":0},
            "capabilities":{"tools":true,"images":true,"reasoning":true}
        }))
        .expect("target");
        let mut model = VirtualModel {
            id: "pool".into(),
            targets: vec![target; 4],
            strategy: omni_store::Strategy::Priority,
            is_alias: false,
        };
        for _ in 0..500 {
            assert_eq!(
                resolve_model_limits(&model, &index, &providers),
                (Some(272000.0), Some(128000.0))
            );
        }
        assert_eq!(visited.get(), 5000);
        assert_eq!(index.auth_visits.get(), 4000);
        assert_eq!(index.pin_comparisons.get(), 0);
        for t in &mut model.targets {
            t.credential_id = Some("c4998".into());
        }
        for _ in 0..500 {
            assert_eq!(
                resolve_model_limits(&model, &index, &providers),
                (Some(922000.0), Some(128000.0))
            );
        }
        assert_eq!(index.auth_visits.get(), 6000);
        assert_eq!(index.pin_comparisons.get(), 2000);
    }

    #[test]
    fn narrowing_order_and_dedup_do_not_change_special_number_bytes() {
        use omni_ir::jsjson::write_number;
        let bytes = |v: Option<f64>| {
            let mut s = String::new();
            if let Some(v) = v {
                write_number(v, &mut s);
            }
            s
        };
        let values = [
            None,
            Some(f64::NAN),
            Some(f64::INFINITY),
            Some(f64::NEG_INFINITY),
            Some(-0.0),
            Some(0.0),
            Some(1.5),
        ];
        for a in values {
            for b in values {
                assert_eq!(bytes(narrower(a, b)), bytes(narrower(b, a)));
                assert_eq!(bytes(narrower(a, b)), bytes(narrower(narrower(a, b), a)));
            }
        }
    }
}

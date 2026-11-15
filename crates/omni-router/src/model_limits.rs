//! Frozen `modelDisplayName` and `resolveModelLimits`: pure snapshot projections.
use crate::{Providers, serves_target};
use omni_store::{AuthType, Credential, VirtualModel};

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
    credentials: &[Credential],
    providers: &Providers,
) -> (Option<f64>, Option<f64>) {
    let mut limits = (None, None);
    for target in &model.targets {
        let pinned = target.credential_id.as_ref().and_then(|_| {
            credentials
                .iter()
                .find(|c| c.enabled && serves_target(target, c))
        });
        let auths: Vec<_> = match pinned {
            Some(c) => vec![&c.auth_type],
            None => credentials
                .iter()
                .filter(|c| c.enabled && c.provider == target.provider)
                .map(|c| &c.auth_type)
                .collect(),
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
                    let next = if *auth == AuthType::OAuth {
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

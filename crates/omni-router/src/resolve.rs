//! Model resolution (`packages/router/src/resolve.ts`).

use crate::providers::{Descriptor, Providers};
use crate::snapshot::Snapshot;
use omni_ir::error::{ErrorCode, GatewayError};
use omni_ir::js::safe_token;
use omni_store::models::{Target, TargetPricing};
use omni_store::{Strategy, VirtualModel};
use serde_json::Map;
use std::borrow::Cow;

fn synthesize(provider: &str, model: &str, d: &Descriptor) -> VirtualModel {
    let listed = d.catalog.iter().find(|c| c.id == model);
    let target = Target {
        lone_identity: Default::default(),
        provider: provider.to_owned(),
        endpoint_id: None,
        model: model.to_owned(),
        tier: 1.0,
        weight: 1.0,
        cost_per_m_tok: listed.map_or_else(
            || TargetPricing {
                input: 0.0,
                output: 0.0,
                cache_read: None,
                cache_write_5m: None,
                cache_write_1h: None,
                extra: Map::new(),
            },
            |c| c.pricing.clone(),
        ),
        context_window: listed.and_then(|c| c.context_window),
        max_output_tokens: listed.and_then(|c| c.max_output_tokens),
        capabilities: d.capabilities,
        credential_id: None,
        extra: Map::new(),
    };
    VirtualModel {
        id: format!("{provider}/{model}"),
        targets: vec![target],
        strategy: Strategy::Score,
        is_alias: true,
    }
}

fn no_candidates(message: String) -> GatewayError {
    // The message quotes only `safeToken` output, so it is ours to print.
    GatewayError::new(ErrorCode::NoCandidates, message).gateway_authored()
}

/// `resolveModel`: a configured virtual model, a `provider/model` (or
/// `provider:model`) shorthand, or a bare name inferred by longest prefix.
pub fn resolve_model<'a>(
    name: &str,
    snapshot: &'a Snapshot,
    providers: &Providers,
) -> Result<Cow<'a, VirtualModel>, GatewayError> {
    if let Some(configured) = snapshot.models.get(name) {
        return Ok(Cow::Borrowed(configured));
    }
    // `name.search(/[/:]/)`, then `sep > 0`: a leading separator falls through
    // to prefix inference.
    if let Some(sep) = name.find(['/', ':'])
        && sep > 0
    {
        let prefix = &name[..sep];
        let rest = &name[sep + 1..];
        if prefix != "custom"
            && !rest.is_empty()
            && let Some(d) = providers.get(prefix)
        {
            return Ok(Cow::Owned(synthesize(prefix, rest, d)));
        }
        return Err(no_candidates(format!(
            "unknown provider \"{}\" in model \"{}\"",
            safe_token(prefix),
            safe_token(name)
        )));
    }
    let mut prefixed: Vec<(&str, &str, &Descriptor)> = providers
        .iter()
        .flat_map(|(id, d)| d.model_prefixes.iter().map(move |p| (p.as_str(), id, d)))
        .collect();
    // Stable, so equal lengths keep registry order, as JS `sort` does.
    // `b.length - a.length`: UTF-16 code units, as JS measures a string.
    prefixed.sort_by_key(|p| std::cmp::Reverse(p.0.encode_utf16().count()));
    for (prefix, provider, d) in prefixed {
        if name.starts_with(prefix) {
            return Ok(Cow::Owned(synthesize(provider, name, d)));
        }
    }
    Err(no_candidates(format!(
        "model \"{}\" is not a configured virtual model and its provider could not be inferred",
        safe_token(name)
    )))
}

/// `localOnlyModel`: a configured model whose every target is `custom`.
pub fn local_only_model<'a>(
    name: &str,
    snapshot: &'a Snapshot,
    providers: &Providers,
) -> Option<Cow<'a, VirtualModel>> {
    let model = resolve_model(name, snapshot, providers).ok()?;
    (!model.targets.is_empty() && model.targets.iter().all(|t| t.provider == "custom"))
        .then_some(model)
}

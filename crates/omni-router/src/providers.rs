//! The provider registry the router reads: `PROVIDER_DESCRIPTORS`, narrowed
//! to what routing uses (capabilities, model prefixes, catalog prices).

use omni_store::models::{Capabilities, TargetPricing};

/// One catalog entry: what a synthesised target is priced and sized from.
#[derive(Debug, Clone, PartialEq)]
pub struct CatalogModel {
    pub id: String,
    pub label: String,
    pub oauth_limits: Option<(Option<f64>, Option<f64>)>,
    pub pricing: TargetPricing,
    /// `limits` (the API-key figures; `entryLimits` defaults to `apiKey`).
    pub context_window: Option<f64>,
    pub max_output_tokens: Option<f64>,
}

#[cfg(test)]
mod tests {
    #[test]
    fn openai_catalog_matches_generated_descriptor() {
        let generated: serde_json::Value = serde_json::from_str(include_str!(
            "../../omni-control/data/provider-catalog.json"
        ))
        .expect("generated catalog");
        let registry = super::Providers::builtin();
        let actual = registry.get("openai").expect("registered");
        let expected = generated["openai"]["catalog"]["models"]
            .as_array()
            .expect("models");
        assert!(!expected.is_empty());
        assert_eq!(actual.catalog.len(), expected.len());
        for (actual, expected) in actual.catalog.iter().zip(expected) {
            assert_eq!(actual.id, expected["id"]);
            assert_eq!(
                actual.pricing,
                serde_json::from_value(expected["pricing"].clone()).expect("pricing")
            );
            assert_eq!(
                actual.context_window,
                expected["limits"]["contextWindow"].as_f64()
            );
            assert_eq!(
                actual.max_output_tokens,
                expected["limits"]["maxOutputTokens"].as_f64()
            );
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Descriptor {
    pub capabilities: Capabilities,
    pub model_prefixes: Vec<String>,
    pub catalog: Vec<CatalogModel>,
}

/// Registry in insertion order, which is `Object.entries` order and so the
/// tie order of the longest-prefix sort. A lookup is an own-key lookup, so
/// `constructor` is never a provider.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Providers {
    entries: Vec<(String, Descriptor)>,
}

fn caps(tools: bool, images: bool, reasoning: bool) -> Capabilities {
    Capabilities {
        tools,
        images,
        reasoning,
    }
}

fn descriptor(capabilities: Capabilities, prefixes: &[&str]) -> Descriptor {
    Descriptor {
        capabilities,
        model_prefixes: prefixes.iter().map(|p| (*p).to_owned()).collect(),
        catalog: Vec::new(),
    }
}

impl Providers {
    /// The built-in registry.
    ///
    /// Anthropic, OpenAI, Antigravity, Kimi, Kilo, Grok and Muse use the generated
    /// catalog. Qoder's catalog is account-derived (`providerData.modelCatalog`)
    /// and `custom` has none, so both stay empty here.
    pub fn builtin() -> Self {
        let all = caps(true, true, true);
        let mut p = Self::default();
        let generated: serde_json::Value = serde_json::from_str(include_str!(
            "../../omni-control/data/provider-catalog.json"
        ))
        .expect("generated provider catalog");
        let catalog = |id: &str| {
            generated[id]["catalog"]["models"]
                .as_array()
                .expect("models")
                .iter()
                .map(|m| CatalogModel {
                    id: m["id"].as_str().expect("model id").into(),
                    label: m["label"].as_str().expect("model label").into(),
                    oauth_limits: m
                        .get("oauthLimits")
                        .map(|l| (l["contextWindow"].as_f64(), l["maxOutputTokens"].as_f64())),
                    pricing: serde_json::from_value(m["pricing"].clone()).expect("catalog pricing"),
                    context_window: m["limits"]["contextWindow"].as_f64(),
                    max_output_tokens: m["limits"]["maxOutputTokens"].as_f64(),
                })
                .collect()
        };
        let mut anthropic = descriptor(all, &["claude-"]);
        anthropic.catalog = catalog("anthropic");
        p.register("anthropic", anthropic);
        let mut openai = descriptor(all, &["gpt-", "o1", "o3", "o4"]);
        openai.catalog = catalog("openai");
        p.register("openai", openai);
        let mut kimi = descriptor(caps(true, false, false), &["kimi-", "moonshot"]);
        kimi.catalog = catalog("kimi");
        p.register("kimi", kimi);
        let mut kilo = descriptor(all, &[]);
        kilo.catalog = catalog("kilo");
        p.register("kilo", kilo);
        let mut grok = descriptor(all, &["grok-"]);
        grok.catalog = catalog("grok");
        p.register("grok", grok);
        let mut antigravity = descriptor(all, &["gemini-"]);
        antigravity.catalog = catalog("antigravity");
        p.register("antigravity", antigravity);
        let mut muse = descriptor(all, &["muse-", "muse-spark"]);
        muse.catalog = catalog("muse");
        p.register("muse", muse);
        p.register("qoder", descriptor(all, &[]));
        p.register("custom", descriptor(all, &[]));
        p
    }

    /// Adds or replaces a provider, keeping its original position on replace.
    pub fn register(&mut self, id: &str, d: Descriptor) {
        if let Some(slot) = self.entries.iter_mut().find(|(k, _)| k == id) {
            slot.1 = d;
        } else {
            self.entries.push((id.to_owned(), d));
        }
    }

    pub fn get(&self, id: &str) -> Option<&Descriptor> {
        self.entries.iter().find(|(k, _)| k == id).map(|(_, d)| d)
    }

    pub fn has(&self, id: &str) -> bool {
        self.get(id).is_some()
    }

    pub fn iter(&self) -> impl Iterator<Item = (&str, &Descriptor)> {
        self.entries.iter().map(|(k, d)| (k.as_str(), d))
    }
}

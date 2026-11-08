//! `Snapshot` and `healthKey` (`packages/router/src/snapshot.ts`, `types.ts`).

use omni_store::settings::Settings;
use omni_store::{Credential, CredentialHealth, QuotaWindow, VirtualModel};
use std::collections::HashMap;

/// Health is per (credential, model); this is the composite key.
pub fn health_key(credential_id: &str, model: &str) -> String {
    let mut key = String::with_capacity(credential_id.len() + 2 + model.len());
    key.push_str(credential_id);
    key.push_str("::");
    key.push_str(model);
    key
}

/// Everything the router needs, immutable for the life of a request.
#[derive(Debug, Clone)]
pub struct Snapshot {
    /// By tier then label, as the store lists them.
    pub credentials: Vec<Credential>,
    /// Keyed by [`health_key`].
    pub health: HashMap<String, CredentialHealth>,
    /// Keyed by credential id, rows in store order.
    pub quota: HashMap<String, Vec<QuotaWindow>>,
    pub models: HashMap<String, VirtualModel>,
    pub settings: Settings,
    pub built_at: f64,
}

impl Snapshot {
    /// `buildSnapshot`, from rows already read.
    pub fn new(
        credentials: Vec<Credential>,
        health: Vec<CredentialHealth>,
        quota: Vec<QuotaWindow>,
        models: Vec<VirtualModel>,
        settings: Settings,
        built_at: f64,
    ) -> Self {
        let health = health
            .into_iter()
            .map(|h| (health_key(&h.credential_id, &h.model), h))
            .collect();
        let mut by_credential: HashMap<String, Vec<QuotaWindow>> = HashMap::new();
        for row in quota {
            by_credential
                .entry(row.credential_id.clone())
                .or_default()
                .push(row);
        }
        Self {
            credentials,
            health,
            quota: by_credential,
            // `new Map(models.map(...))`: a later duplicate id wins.
            models: models.into_iter().map(|m| (m.id.clone(), m)).collect(),
            settings,
            built_at,
        }
    }

    pub fn health_of(&self, credential_id: &str, model: &str) -> Option<&CredentialHealth> {
        self.health.get(&health_key(credential_id, model))
    }

    pub fn quota_of(&self, credential_id: &str) -> &[QuotaWindow] {
        self.quota.get(credential_id).map_or(&[], Vec::as_slice)
    }
}

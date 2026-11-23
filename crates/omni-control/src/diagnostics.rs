//! Doctor rules, independent of CLI rendering and process supervision.
use serde_json::{Value, json};
pub fn report(store: &omni_store::SqliteStore) -> Result<Value, String> {
    let conn = store.connection();
    let models = omni_store::models::list(conn)
        .map_err(|e| e.to_string())?
        .into_iter()
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    let accounts = omni_store::models::operator_credentials(conn).map_err(|e| e.to_string())?;
    let credentials = accounts
        .into_iter()
        .map(
            |(id, provider, label, _auth, data)| omni_store::Credential {
                id,
                provider,
                label,
                lone_endpoint: None,
                auth_type: omni_store::AuthType::ApiKey,
                enabled: true,
                tier: 1.0,
                weight: 1.0,
                expires_at: None,
                account_email: None,
                provider_data: serde_json::from_str(&data).unwrap_or(Value::Null),
                disabled_reason: None,
                disabled_at: None,
                has_refresh_token: false,
                token_version: 0,
                created_at: 0,
                updated_at: 0,
                secrets: omni_store::CredentialSecrets {
                    access_token: omni_store::Secret::Absent,
                    refresh_token: omni_store::Secret::Absent,
                    api_key: omni_store::Secret::Absent,
                    id_token: omni_store::Secret::Absent,
                },
            },
        )
        .collect::<Vec<_>>();
    // The routing catalog retains deferred provider metadata for compatibility;
    // doctor must diagnose what this binary can actually serve.
    let catalog = omni_router::Providers::builtin();
    let mut providers = omni_router::Providers::default();
    for id in [
        "openai",
        "anthropic",
        "antigravity",
        "kimi",
        "kilo",
        "grok",
        "custom",
    ] {
        if let Some(descriptor) = catalog.get(id) {
            providers.register(id, descriptor.clone());
        }
    }
    let mut pins = vec![];
    let mut missing = vec![];
    for model in &models {
        for target in &model.targets {
            if let Some(pin) = &target.credential_id
                && !credentials
                    .iter()
                    .any(|c| &c.id == pin && omni_router::serves_target(target, c))
            {
                pins.push(format!("{}/{} → {pin}", model.id, target.model));
            }
            if providers.get(&target.provider).is_none() {
                missing.push(format!(
                    "{}/{} → {}",
                    model.id, target.model, target.provider
                ));
            }
        }
    }
    let stranded = credentials
        .iter()
        .filter(|c| providers.get(&c.provider).is_none())
        .map(|c| format!("{} → {}", c.label, c.provider))
        .collect::<Vec<_>>();
    let settings = omni_store::settings::get(conn).map_err(|e| e.to_string())?;
    let policy: i64 = conn.query_row("SELECT COUNT(*) FROM api_keys WHERE revoked_at IS NULL AND guardrail_policy IS NOT NULL",[],|r|r.get(0)).map_err(|e|e.to_string())?;
    let smart: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM api_keys WHERE revoked_at IS NULL AND smart_routing = 1",
            [],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    let snapshot =
        omni_router::Snapshot::new(vec![], vec![], vec![], models, settings.clone(), 0.0);
    let resolves = |name: &str| omni_router::resolve_model(name, &snapshot, &providers).ok();
    let guard_problem = if policy == 0 {
        None
    } else if settings.guardrail_model.is_none() {
        Some("unconfigured")
    } else if settings
        .guardrail_model
        .as_deref()
        .and_then(resolves)
        .is_none()
    {
        Some("unresolved")
    } else {
        None
    };
    let smart_problem = if smart == 0 || !settings.smart_router_enabled {
        None
    } else if settings.smart_router_classifier_model.is_none()
        || settings.smart_router_local_model.is_none()
    {
        Some("unconfigured")
    } else {
        let a = settings
            .smart_router_classifier_model
            .as_deref()
            .and_then(resolves);
        let b = settings
            .smart_router_local_model
            .as_deref()
            .and_then(resolves);
        if a.is_none() || b.is_none() {
            Some("unresolved")
        } else if a
            .iter()
            .chain(b.iter())
            .any(|m| m.targets.is_empty() || m.targets.iter().any(|t| t.provider != "custom"))
        {
            Some("notLocal")
        } else {
            None
        }
    };
    Ok(
        json!({"danglingPins":pins,"missingProviders":missing,"danglingCredentials":stranded,
        "guardrail":{"keysWithPolicy":policy,"model":settings.guardrail_model,"problem":guard_problem},
        "smartRouter":{"enabled":settings.smart_router_enabled,"keysWithFlag":smart,"classifierModel":settings.smart_router_classifier_model,"localModel":settings.smart_router_local_model,"problem":smart_problem}}),
    )
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    #[test]
    fn fresh_database_checked_empty_and_idle_readiness() {
        let store = omni_store::SqliteStore::open(":memory:", 0).unwrap();
        let result = super::report(&store).unwrap();
        assert_eq!(result["danglingPins"], serde_json::json!([]));
        assert_eq!(result["missingProviders"], serde_json::json!([]));
        assert_eq!(result["guardrail"]["keysWithPolicy"], 0);
        assert_eq!(result["smartRouter"]["problem"], serde_json::Value::Null);
    }

    #[test]
    fn supported_registry_pins_and_readiness() {
        let store = omni_store::SqliteStore::open(":memory:", 0).unwrap();
        let c = store.connection();
        c.execute("INSERT INTO virtual_models(id,targets,strategy,is_alias) VALUES ('saved',?1,'score',0)", [r#"[{"provider":"absent","model":"remote","credentialId":"missing","tier":1,"weight":1,"costPerMTok":{"input":0,"output":0},"capabilities":{"tools":true,"images":true,"reasoning":true}}]"#]).unwrap();
        c.execute("INSERT INTO api_keys(id,label,prefix,hash,created_at,guardrail_policy,smart_routing) VALUES ('key','test','p','h',0,'policy',1)",[]).unwrap();
        let report = super::report(&store).unwrap();
        assert_eq!(
            report["danglingPins"],
            serde_json::json!(["saved/remote → missing"])
        );
        assert_eq!(
            report["missingProviders"],
            serde_json::json!(["saved/remote → absent"])
        );
        assert_eq!(report["guardrail"]["problem"], "unconfigured");
        omni_store::settings::put(c,&serde_json::json!({"guardrailModel":"absent","smartRouterEnabled":true,"smartRouterClassifierModel":"openai/gpt-test","smartRouterLocalModel":"openai/gpt-test"})).unwrap();
        let report = super::report(&store).unwrap();
        assert_eq!(report["guardrail"]["problem"], "unresolved");
        assert_eq!(report["smartRouter"]["problem"], "notLocal");
        c.execute("INSERT INTO credentials(id,provider,label,auth_type,provider_data,created_at,updated_at) VALUES ('c','custom','private','apiKey','{\"endpointId\":\"one\"}',0,0)",[]).unwrap();
        let target = r#"[{"provider":"custom","model":"local","endpointId":"two","credentialId":"c","tier":1,"weight":1,"costPerMTok":{"input":0,"output":0},"capabilities":{"tools":true,"images":true,"reasoning":true}}]"#;
        c.execute(
            "UPDATE virtual_models SET targets=?1 WHERE id='saved'",
            [target],
        )
        .unwrap();
        assert_eq!(
            super::report(&store).unwrap()["danglingPins"],
            serde_json::json!(["saved/local → c"])
        );
        c.execute(
            "UPDATE credentials SET provider_data='{\"endpointId\":\"two\"}' WHERE id='c'",
            [],
        )
        .unwrap();
        assert_eq!(
            super::report(&store).unwrap()["danglingPins"],
            serde_json::json!([])
        );
    }
}

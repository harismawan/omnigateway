//! `GET /v1/models` (`routes/models.ts`, `resolveModelLimits` and
//! `modelDisplayName` from `@omni/control/modelLimits.ts`).
//!
//! Catalog labels and limits use the same held snapshot as routing.

use omni_ir::jsjson::{write_number, write_str};
use omni_store::{Credential, VirtualModel};

/// `modelListBody(models, credentials)`, as `JSON.stringify` writes it.
pub fn list_body(models: &[&VirtualModel], credentials: &[Credential]) -> String {
    static PROVIDERS: std::sync::OnceLock<omni_router::Providers> = std::sync::OnceLock::new();
    let providers = PROVIDERS.get_or_init(omni_router::Providers::builtin);
    let mut out = String::from("{\"object\":\"list\",\"data\":[");
    for (i, m) in models.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        out.push_str("{\"id\":");
        write_str(&m.id, &mut out);
        out.push_str(",\"object\":\"model\",\"type\":\"model\",\"display_name\":");
        write_str(omni_router::model_display_name(m, providers), &mut out);
        out.push_str(
            ",\"created\":0,\"created_at\":\"1970-01-01T00:00:00.000Z\",\"owned_by\":\"omnigateway\"",
        );
        let (context, output) = omni_router::resolve_model_limits(m, credentials, providers);
        if let Some(n) = context {
            out.push_str(",\"max_input_tokens\":");
            write_number(n, &mut out);
        }
        if let Some(n) = output {
            out.push_str(",\"max_tokens\":");
            write_number(n, &mut out);
        }
        out.push('}');
    }
    out.push_str("],\"has_more\":false,\"first_id\":");
    let id_or_null = |m: Option<&&VirtualModel>, out: &mut String| match m {
        Some(m) => write_str(&m.id, out),
        None => out.push_str("null"),
    };
    id_or_null(models.first(), &mut out);
    out.push_str(",\"last_id\":");
    id_or_null(models.last(), &mut out);
    out.push('}');
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_empty_listing_has_null_cursors() {
        assert_eq!(
            list_body(&[], &[]),
            "{\"object\":\"list\",\"data\":[],\"has_more\":false,\"first_id\":null,\"last_id\":null}"
        );
    }

    #[test]
    fn frozen_listing_corpus() {
        let output = std::process::Command::new("bun")
            .current_dir(concat!(env!("CARGO_MANIFEST_DIR"), "/../.."))
            .args(["--no-env-file", "conformance/models-listing.ts"])
            .output()
            .expect("Bun oracle");
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let rows: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
        let mut failures = 0;
        for row in rows.as_array().unwrap() {
            let models: Vec<VirtualModel> = row["models"]
                .as_array()
                .unwrap()
                .iter()
                .map(|m| VirtualModel {
                    id: m["id"].as_str().unwrap().into(),
                    targets: serde_json::from_value(m["targets"].clone()).unwrap(),
                    strategy: omni_store::Strategy::Priority,
                    is_alias: false,
                })
                .collect();
            let refs: Vec<_> = models.iter().collect();
            let credentials: Vec<_> = row["credentials"]
                .as_array()
                .unwrap()
                .iter()
                .map(|c| {
                    use omni_store::credentials::{CredentialSecrets, Secret};
                    Credential {
                        lone_endpoint: None,
                        id: c["id"].as_str().unwrap().into(),
                        provider: c["provider"].as_str().unwrap().into(),
                        label: String::new(),
                        auth_type: omni_store::AuthType::parse(c["authType"].as_str().unwrap()),
                        enabled: c["enabled"].as_bool().unwrap(),
                        tier: 1.0,
                        weight: 1.0,
                        expires_at: None,
                        account_email: None,
                        provider_data: c["providerData"].clone(),
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
                    }
                })
                .collect();
            if list_body(&refs, &credentials) != row["expected"].as_str().unwrap() {
                failures += 1;
            }
        }
        eprintln!(
            "listing corpus: {} rows, {failures} failing",
            rows.as_array().unwrap().len()
        );
        assert_eq!(failures, 0);
    }
}

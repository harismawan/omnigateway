//! `GET /v1/models`: the model listing with resolved limits and display
//! names.
//!
//! Catalog labels and limits use the same held snapshot as routing.

use omni_ir::jsjson::{write_number, write_str};
use omni_store::{Credential, VirtualModel};

/// The model-list JSON body; the byte layout is a wire contract.
pub fn list_body(models: &[&VirtualModel], credentials: &[Credential]) -> String {
    static PROVIDERS: std::sync::OnceLock<omni_router::Providers> = std::sync::OnceLock::new();
    let providers = PROVIDERS.get_or_init(omni_router::Providers::builtin);
    let credentials = omni_router::ServingCredentials::new(credentials);
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
        let (context, output) = omni_router::resolve_model_limits(m, &credentials, providers);
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
}

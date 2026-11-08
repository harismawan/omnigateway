//! `GET /v1/models` (`routes/models.ts`, `resolveModelLimits` and
//! `modelDisplayName` from `@omni/control/modelLimits.ts`).
//!
//! Slice 1 has no provider catalogs (ruling 15), so a target's limits are the
//! figures the operator saved on it and the display name is the model's id.
//! With catalogs empty the credential-dependent narrowing has nothing to
//! narrow, so the listing does not read credentials.

use omni_ir::jsjson::{write_number, write_str};
use omni_store::VirtualModel;

/// The narrowest defined figure across the model's targets.
fn narrowest(
    model: &VirtualModel,
    pick: impl Fn(&omni_store::Target) -> Option<f64>,
) -> Option<f64> {
    model
        .targets
        .iter()
        .filter_map(pick)
        .reduce(omni_ir::js::math_min)
}

/// `modelListBody(models, credentials)`, as `JSON.stringify` writes it.
pub fn list_body(models: &[&VirtualModel]) -> String {
    let mut out = String::from("{\"object\":\"list\",\"data\":[");
    for (i, m) in models.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        out.push_str("{\"id\":");
        write_str(&m.id, &mut out);
        out.push_str(",\"object\":\"model\",\"type\":\"model\",\"display_name\":");
        write_str(&m.id, &mut out);
        out.push_str(
            ",\"created\":0,\"created_at\":\"1970-01-01T00:00:00.000Z\",\"owned_by\":\"omnigateway\"",
        );
        if let Some(n) = narrowest(m, |t| t.context_window) {
            out.push_str(",\"max_input_tokens\":");
            write_number(n, &mut out);
        }
        if let Some(n) = narrowest(m, |t| t.max_output_tokens) {
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
            list_body(&[]),
            "{\"object\":\"list\",\"data\":[],\"has_more\":false,\"first_id\":null,\"last_id\":null}"
        );
    }
}

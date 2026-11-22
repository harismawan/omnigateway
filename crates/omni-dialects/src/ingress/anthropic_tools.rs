//! `ingress/anthropicTools.ts` and the tool table it reads
//! (`packages/providers/src/anthropic/tools.ts`).

use std::collections::HashSet;

use omni_ir::error::GatewayError;
use omni_ir::js::safe_token;
use omni_ir::request::{CustomToolDef, ProviderToolDef, ToolDef};
use serde_json::{Map, Value};

use omni_ir::deep::Owned;

use super::zod::{self, Z};
use super::{bad, ir_cache_control, js_keys};

const TOOL_CALLERS: &[&str] = &[
    "direct",
    "code_execution_20250825",
    "code_execution_20260120",
    "code_execution_20260521",
];

const CUSTOM_TOOL_OPTIONS: &[&str] = &[
    "strict",
    "defer_loading",
    "allowed_callers",
    "input_examples",
    "eager_input_streaming",
];

/// `TOOL_FIELDS`: what each field may contain.
fn tool_field(name: &str) -> Option<Z> {
    use zod::{arr, int, nullable, one_of, opt, pos_int, rec, str, str_min};
    let boolean = || nullable(Z::Bool);
    Some(match name {
        "cache_control" | "caching" => nullable(zod::cache_control()),
        "strict" | "defer_loading" | "eager_input_streaming" | "enable_zoom" | "use_cache" => {
            boolean()
        }
        "allowed_callers" => nullable(arr(one_of(TOOL_CALLERS))),
        "input_examples" => nullable(arr(rec())),
        "max_uses" | "max_content_tokens" | "max_characters" | "max_tokens" => nullable(pos_int()),
        "allowed_domains" | "blocked_domains" => nullable(arr(str())),
        "user_location" => nullable(zod::obj(vec![
            ("type", one_of(&["approximate"])),
            ("city", opt(str())),
            ("region", opt(str())),
            ("country", opt(str())),
            ("timezone", opt(str())),
        ])),
        "citations" => nullable(zod::obj(vec![("enabled", Z::Bool)])),
        "response_inclusion" => nullable(one_of(&["full", "excluded"])),
        "display_width_px" | "display_height_px" => pos_int(),
        "display_number" => nullable(int()),
        "model" | "mcp_server_name" => str_min(1),
        "configs" | "default_config" => nullable(rec()),
        _ => return None,
    })
}

struct Spec {
    family: &'static str,
    name: Option<&'static str>,
    required: &'static [&'static str],
    optional: Vec<&'static str>,
}

const COMMON: &[&str] = &[
    "cache_control",
    "strict",
    "defer_loading",
    "allowed_callers",
];
const SEARCH_DOMAINS: &[&str] = &["max_uses", "allowed_domains", "blocked_domains"];

fn with(base: &[&'static str], more: &[&'static str]) -> Vec<&'static str> {
    base.iter().chain(more).copied().collect()
}

/// `anthropicToolSpec`: exact lookup in `ANTHROPIC_TOOL_SPECS`.
fn tool_spec(t: &str) -> Option<Spec> {
    let common_ex = with(COMMON, &["input_examples"]);
    let search = with(COMMON, SEARCH_DOMAINS);
    let spec = |family, name, optional| Spec {
        family,
        name: Some(name),
        required: &[],
        optional,
    };
    Some(match t {
        "web_search_20250305" | "web_search_20260209" => {
            spec("webSearch", "web_search", with(&search, &["user_location"]))
        }
        "web_search_20260318" => spec(
            "webSearch",
            "web_search",
            with(&search, &["user_location", "response_inclusion"]),
        ),
        "web_fetch_20250910" | "web_fetch_20260209" => spec(
            "webFetch",
            "web_fetch",
            with(&search, &["citations", "max_content_tokens"]),
        ),
        "web_fetch_20260309" => spec(
            "webFetch",
            "web_fetch",
            with(&search, &["citations", "max_content_tokens", "use_cache"]),
        ),
        "web_fetch_20260318" => spec(
            "webFetch",
            "web_fetch",
            with(
                &search,
                &[
                    "citations",
                    "max_content_tokens",
                    "use_cache",
                    "response_inclusion",
                ],
            ),
        ),
        "code_execution_20250522"
        | "code_execution_20250825"
        | "code_execution_20260120"
        | "code_execution_20260521" => spec("codeExecution", "code_execution", COMMON.to_vec()),
        "bash_20241022" | "bash_20250124" => spec("bash", "bash", common_ex),
        "text_editor_20241022" | "text_editor_20250124" => {
            spec("textEditor", "str_replace_editor", common_ex)
        }
        "text_editor_20250429" => spec("textEditor", "str_replace_based_edit_tool", common_ex),
        "text_editor_20250728" => spec(
            "textEditor",
            "str_replace_based_edit_tool",
            with(&common_ex, &["max_characters"]),
        ),
        "computer_20241022" | "computer_20250124" | "computer_20251124" => Spec {
            family: "computer",
            name: Some("computer"),
            required: &["display_width_px", "display_height_px"],
            optional: if t == "computer_20251124" {
                with(&common_ex, &["display_number", "enable_zoom"])
            } else {
                with(&common_ex, &["display_number"])
            },
        },
        "memory_20250818" => spec("memory", "memory", common_ex),
        "tool_search_tool_regex_20251119" | "tool_search_tool_regex" => {
            spec("toolSearchRegex", "tool_search_tool_regex", COMMON.to_vec())
        }
        "tool_search_tool_bm25_20251119" | "tool_search_tool_bm25" => {
            spec("toolSearchBm25", "tool_search_tool_bm25", COMMON.to_vec())
        }
        "advisor_20260301" => Spec {
            family: "advisor",
            name: Some("advisor"),
            required: &["model"],
            optional: with(COMMON, &["caching", "max_uses", "max_tokens"]),
        },
        "mcp_toolset" => Spec {
            family: "mcpToolset",
            name: None,
            required: &["mcp_server_name"],
            optional: vec!["cache_control", "configs", "default_config"],
        },
        _ => return None,
    })
}

fn fail(path: &str, message: &str) -> GatewayError {
    bad(format!("{path}: {message}"))
}

/// `field`: runs one field's schema at that field's path.
fn field(path: &str, name: &str, value: &Value) -> Result<Value, GatewayError> {
    let Some(schema) = tool_field(name) else {
        let t = safe_token(name);
        return Err(fail(
            &format!("{path}.{t}"),
            &format!("unsupported field \"{t}\""),
        ));
    };
    zod::parse(&schema, value)
        .map(Owned::into_inner)
        .map_err(|issue| {
            fail(
                &format!("{path}.{}", safe_token(name)),
                &super::zod_detail(&issue),
            )
        })
}

fn parse_anthropic_tool(
    raw: &Map<String, Value>,
    t: &str,
    path: &str,
    servers: &HashSet<String>,
) -> Result<ToolDef, GatewayError> {
    let Some(spec) = tool_spec(t) else {
        return Err(fail(
            &format!("{path}.type"),
            &format!("unrecognized tool type \"{}\"", safe_token(t)),
        ));
    };
    match spec.name {
        Some(name) if raw.get("name").and_then(Value::as_str) != Some(name) => {
            return Err(fail(
                &format!("{path}.name"),
                &format!("{t} must be declared with name \"{name}\""),
            ));
        }
        None if raw.contains_key("name") => {
            return Err(fail(
                &format!("{path}.name"),
                &format!("{t} does not take a name"),
            ));
        }
        _ => {}
    }
    for required in spec.required {
        if !raw.contains_key(*required) {
            return Err(fail(
                &format!("{path}.{required}"),
                &format!("{t} requires {required}"),
            ));
        }
    }

    let mut wire = Map::new();
    let mut cache_control = None;
    for key in js_keys(raw) {
        if key == "type" || key == "name" {
            continue;
        }
        if !spec.required.contains(&key) && !spec.optional.contains(&key) {
            let k = safe_token(key);
            return Err(fail(
                &format!("{path}.{k}"),
                &format!("{t} does not accept \"{k}\""),
            ));
        }
        let parsed = field(path, key, &raw[key])?;
        if key == "cache_control" {
            cache_control = ir_cache_control(Some(&parsed));
            continue;
        }
        if !parsed.is_null() {
            omni_ir::deep::insert(&mut wire, key.to_string(), parsed);
        }
    }

    if wire.contains_key("allowed_domains") && wire.contains_key("blocked_domains") {
        return Err(fail(
            &format!("{path}.blocked_domains"),
            "allowed_domains and blocked_domains are mutually exclusive",
        ));
    }
    if spec.family == "mcpToolset"
        && let Some(server) = wire.get("mcp_server_name").and_then(Value::as_str)
        && !servers.contains(server)
    {
        return Err(fail(
            &format!("{path}.mcp_server_name"),
            &format!("no mcp_servers entry named \"{}\"", safe_token(server)),
        ));
    }

    Ok(ToolDef::Provider(ProviderToolDef {
        provider: "anthropic".into(),
        tool_type: t.to_string(),
        name: spec.name.unwrap_or("").to_string(),
        wire,
        cache_control,
        family: Some(spec.family.to_string()),
    }))
}

/// The schema, built once: it is immutable, and building it per request
/// allocated a few hundred nodes.
fn custom_tool_schema_cached() -> &'static Z {
    static SCHEMA: std::sync::OnceLock<Z> = std::sync::OnceLock::new();
    SCHEMA.get_or_init(custom_tool_schema)
}

fn custom_tool_schema() -> Z {
    use zod::{nullish, one_of, opt, rec, str, str_min};
    zod::obj(vec![
        ("type", nullish(one_of(&["custom"]))),
        ("name", str_min(1)),
        ("description", opt(str())),
        ("input_schema", rec()),
        ("cache_control", nullish(zod::cache_control())),
    ])
}

fn parse_custom_tool(raw: &Map<String, Value>, path: &str) -> Result<ToolDef, GatewayError> {
    // The schema runs on a borrowed view: `raw` is the tool object itself.
    let parsed = zod::parse_map(custom_tool_schema_cached(), raw).map_err(|issue| {
        let p = super::raw_path(&issue);
        let at = if p.is_empty() {
            path.to_string()
        } else {
            format!("{path}.{p}")
        };
        fail(&at, &issue.message())
    })?;

    let mut options = Map::new();
    for key in js_keys(raw) {
        if [
            "type",
            "name",
            "description",
            "input_schema",
            "cache_control",
        ]
        .contains(&key)
        {
            continue;
        }
        if !CUSTOM_TOOL_OPTIONS.contains(&key) {
            let k = safe_token(key);
            return Err(fail(
                &format!("{path}.{k}"),
                &format!("unsupported field \"{k}\""),
            ));
        }
        let v = field(path, key, &raw[key])?;
        if !v.is_null() {
            omni_ir::deep::insert(&mut options, key.to_string(), v);
        }
    }

    Ok(ToolDef::Portable(CustomToolDef {
        name: parsed["name"].as_str().unwrap_or_default().to_string(),
        description: parsed
            .get("description")
            .and_then(Value::as_str)
            .map(str::to_string),
        input_schema: parsed
            .get("input_schema")
            .map_or(Value::Null, omni_ir::deep::clone),
        cache_control: ir_cache_control(parsed.get("cache_control")),
        options: (!options.is_empty()).then_some(options),
    }))
}

/// `parseTools`.
pub(crate) fn parse_tools(
    raw: &[Value],
    servers: &HashSet<String>,
) -> Result<Vec<ToolDef>, GatewayError> {
    raw.iter()
        .enumerate()
        .map(|(index, entry)| {
            let path = format!("tools.{index}");
            let Some(tool) = entry.as_object() else {
                return Err(fail(&path, "expected a tool definition object"));
            };
            match tool.get("type") {
                None | Some(Value::Null) => parse_custom_tool(tool, &path),
                Some(Value::String(t)) if t == "custom" => parse_custom_tool(tool, &path),
                Some(Value::String(t)) => parse_anthropic_tool(tool, t, &path, servers),
                Some(_) => Err(fail(&format!("{path}.type"), "expected a string")),
            }
        })
        .collect()
}

/// `mcpServerNames`.
pub(crate) fn mcp_server_names(body: &Map<String, Value>) -> HashSet<String> {
    let mut names = HashSet::new();
    if let Some(servers) = body.get("mcp_servers").and_then(Value::as_array) {
        for server in servers {
            if let Some(name) = server.get("name").and_then(Value::as_str) {
                names.insert(name.to_string());
            }
        }
    }
    names
}

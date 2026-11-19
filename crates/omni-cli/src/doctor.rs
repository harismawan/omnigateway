use crate::{
    console::{Source, hint, source},
    context::Context,
};
use serde_json::{Value, json};
use std::collections::HashMap;
fn array(value: &Value) -> String {
    match value.as_array() {
        None => "not checked".into(),
        Some(v) if v.is_empty() => "none".into(),
        Some(v) => format!(
            "{}: {}",
            v.len(),
            v.iter()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>()
                .join(", ")
        ),
    }
}
pub(crate) fn report(
    ctx: Context,
    flags: &HashMap<String, String>,
) -> Result<(Value, String), String> {
    let process = crate::status::service_status(&ctx, flags)?;
    let source = source(&ctx, flags);
    let console_hint = hint(&source);
    let console = match source {
        Source::File(path) => json!({"kind":"file","path":path}),
        Source::Journal(system) => {
            json!({"kind":"journal","unit":"omnigateway.service","scope":if system{"system"}else{"user"}})
        }
        Source::None => json!({"kind":"none"}),
    };
    let env_file = ctx.root.join(".env");
    let exists = ctx.path.exists();
    let version = option_env!("OMNI_CLI_VERSION").unwrap_or("0.0.0-dev");
    let encryption = ctx
        .env
        .get("OMNI_ENCRYPTION_KEY")
        .filter(|s| !s.is_empty())
        .map_or("missing".into(), |s| {
            format!("present ({} chars)", s.chars().count())
        });
    let mut warnings = ctx.warnings.clone();
    warnings.push("plugins are not supported in this release; plugin execution and orphan plugin tables are not checked".into());
    let mut value = json!({"version":version,"root":ctx.root,"rootSource":ctx.root_source,"envFile":if env_file.exists(){Some(env_file)}else{None},"databasePath":ctx.path,"databaseExists":exists,"encryptionKey":encryption,"configError":ctx.config.as_ref().err().map(ToString::to_string),"gatewayEntrypoint":crate::service::gateway(),"usageRollup":null,"unitInstalled":crate::service::unit(flags).exists(),"supervisor":process["supervisor"],"running":process["running"],"consoleSource":console,"pluginsDir":ctx.root.join("plugins"),"plugins":null,"orphanPluginTables":null,"danglingPins":null,"missingProviders":null,"danglingCredentials":null,"guardrail":null,"smartRouter":null,"warnings":warnings});
    value["plugins"] = omni_control::plugins::doctor_metadata(&ctx.root).unwrap_or(Value::Null);
    if exists
        && ctx.config.is_ok()
        && let Ok(store) = ctx.open()
    {
        if let Ok((buckets, mismatched)) = omni_store::diagnostics::audit_rollup(store.connection())
        {
            value["usageRollup"] = json!(if mismatched == 0 {
                format!("ok ({buckets} hourly buckets)")
            } else {
                format!("{mismatched} of {buckets} hourly buckets disagree with request_logs")
            });
        }
        if let Ok(report) = omni_control::diagnostics::report(&store) {
            for key in [
                "danglingPins",
                "missingProviders",
                "danglingCredentials",
                "guardrail",
                "smartRouter",
            ] {
                value[key] = report[key].clone();
            }
        }
    }
    let text = |key: &str| value[key].as_str().unwrap_or("not found").to_owned();
    let mut rows = vec![
        (
            "root",
            format!("{} (from {})", text("root"), text("rootSource")),
        ),
        (
            "env file",
            value["envFile"].as_str().unwrap_or("none").into(),
        ),
        (
            "database",
            format!(
                "{} {}",
                text("databasePath"),
                if exists { "exists" } else { "missing" }
            ),
        ),
        ("encryption key", text("encryptionKey")),
        (
            "config",
            value["configError"].as_str().unwrap_or("ok").into(),
        ),
        ("entrypoint", text("gatewayEntrypoint")),
        (
            "usage rollup",
            value["usageRollup"]
                .as_str()
                .unwrap_or("not checked")
                .into(),
        ),
        (
            "systemd unit",
            if value["unitInstalled"] == true {
                if flags.contains_key("system") {
                    "system"
                } else {
                    "user"
                }
            } else {
                "none"
            }
            .into(),
        ),
        (
            "gateway",
            if value["running"] == true {
                "running"
            } else {
                "stopped"
            }
            .into(),
        ),
        ("console log", console_hint),
        (
            "plugins",
            value["plugins"].as_array().map_or_else(
                || "not checked (unsupported)".into(),
                |plugins| {
                    if plugins.is_empty() {
                        "none (plugins unsupported)".into()
                    } else {
                        plugins
                            .iter()
                            .map(|plugin| {
                                format!(
                                    "{}: unsupported (metadata only)",
                                    plugin["id"].as_str().unwrap_or("unknown")
                                )
                            })
                            .collect::<Vec<_>>()
                            .join(", ")
                    }
                },
            ),
        ),
        ("orphan plugin tables", array(&value["orphanPluginTables"])),
        ("dangling pins", array(&value["danglingPins"])),
        ("missing providers", array(&value["missingProviders"])),
        ("stranded credentials", array(&value["danglingCredentials"])),
        ("usage policies", readiness(&value["guardrail"], false)),
        ("smart routing", readiness(&value["smartRouter"], true)),
    ];
    for warning in value["warnings"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
    {
        rows.push(("ignored", warning.into()));
    }
    let width = rows.iter().map(|(k, _)| k.len()).max().unwrap_or(0);
    for (key, text) in &mut rows {
        if matches!(*key, "config" | "gateway" | "usage rollup") {
            let ok = match *key {
                "config" => value["configError"].is_null(),
                "gateway" => value["running"] == true,
                _ => text.starts_with("ok"),
            };
            if *key != "usage rollup" || !value["usageRollup"].is_null() {
                *text = crate::service::paint(flags, if ok { "32" } else { "31" }, text);
            }
        }
    }
    let human = format!(
        "omni {version}\n{}",
        rows.iter()
            .map(|(k, v)| format!("{k:width$}  {v}"))
            .collect::<Vec<_>>()
            .join("\n")
    );
    Ok((value, human))
}
fn readiness(value: &Value, smart: bool) -> String {
    if value.is_null() {
        return "not checked".into();
    }
    let n = value[if smart {
        "keysWithFlag"
    } else {
        "keysWithPolicy"
    }]
    .as_i64()
    .unwrap_or(0);
    if n == 0 {
        return if smart {
            "no key uses it"
        } else {
            "no key carries one"
        }
        .into();
    }
    if smart {
        if value["enabled"] != true {
            return "off (smartRouterEnabled)".into();
        }
        let keys = format!(
            "{n} {} smart routing",
            if n == 1 { "key uses" } else { "keys use" }
        );
        let models = "smartRouterClassifierModel/smartRouterLocalModel";
        return match value["problem"].as_str() {
            Some("unconfigured") => {
                format!("{keys} and {models} is unset; their requests are refused")
            }
            Some("unresolved") => {
                format!("{keys} and {models} does not resolve; their requests are refused")
            }
            Some("notLocal") => format!(
                "{keys} and {models} is not a local-only model (every target must be a custom provider); their requests are refused"
            ),
            _ => format!(
                "{n} key{}, kept local by {}",
                if n == 1 { "" } else { "s" },
                value["localModel"].as_str().unwrap_or_default()
            ),
        };
    }
    let keys = format!("{n} key{}", if n == 1 { "" } else { "s" });
    let model = value["model"].as_str().unwrap_or_default();
    match value["problem"].as_str() {
        Some("unconfigured") => format!(
            "{keys} carry a policy and no classifier is set (guardrailModel); their requests are refused"
        ),
        Some("unresolved") => format!(
            "{keys} carry a policy and classifier \"{model}\" does not resolve; their requests are refused"
        ),
        _ => format!("{keys}, judged by {model}"),
    }
}

use std::{collections::HashMap, io::IsTerminal};

pub fn usage(command: &str) -> &'static str {
    match command {
        "models" => "keys models <id> [--allow <model> ...] [--all] [--none]",
        "guardrail" => "keys guardrail <id> [--policy <text> | --policy-file <path> | --clear]",
        "smart-routing" => "keys smart-routing <id> (--on | --off)",
        "revoke" => "keys revoke <id>",
        _ => "keys list",
    }
}

pub fn run(
    command: &str,
    flags: &HashMap<String, String>,
    positional: &[String],
    allow: &[String],
) -> Result<String, (u8, String)> {
    let fail = |s: String| (1, s);
    let usage = |s: &str| (2, s.to_owned());
    let id = positional
        .first()
        .ok_or_else(|| usage("key id is required"))?;
    let has = |k: &str| flags.contains_key(k);
    if command == "smart-routing" && has("on") == has("off") {
        return Err(usage("pass exactly one of --on or --off"));
    }
    let given = [has("policy"), has("policy-file"), has("clear")]
        .into_iter()
        .filter(|b| *b)
        .count();
    if command == "guardrail" && given > 1 {
        return Err(usage("pass one of --policy, --policy-file or --clear"));
    }
    let store = crate::context::open(flags).map_err(fail)?;
    let now = chrono::Utc::now().timestamp_millis();
    let mut listing = omni_control::keys::list_keys(&store, now).map_err(fail)?;
    let index = listing.data["keys"]
        .as_array()
        .expect("key listing array")
        .iter()
        .position(|k| k["id"] == *id)
        .ok_or_else(|| fail(format!("no api key \"{id}\"")))?;
    let key = &listing.data["keys"][index];
    match command {
        "smart-routing" => {
            omni_control::keys::set_smart_routing(&store, id, has("on")).map_err(fail)?
        }
        "models" if has("all") || has("none") || has("allow") => {
            if [has("all"), has("none"), has("allow")]
                .into_iter()
                .filter(|b| *b)
                .count()
                > 1
            {
                return Err(usage("--all, --none, and --allow cannot be combined"));
            }
            omni_control::keys::set_models(
                &store,
                id,
                if has("all") {
                    None
                } else {
                    Some(if has("none") { &[] } else { allow })
                },
            )
            .map_err(fail)?;
        }
        "guardrail" if given == 1 => {
            let policy = if let Some(file) = flags.get("policy-file") {
                String::from_utf8_lossy(
                    &std::fs::read(file).map_err(|_| fail(format!("could not read {file}")))?,
                )
                .into_owned()
            } else {
                flags.get("policy").cloned().unwrap_or_default()
            };
            omni_control::keys::set_guardrail(
                &store,
                id,
                if has("clear") { None } else { Some(&policy) },
            )
            .map_err(fail)?;
        }
        "revoke" => {
            let question = format!(
                "revoke key \"{}\" ({}…)?",
                key["label"].as_str().expect("stored label"),
                key["prefix"].as_str().expect("stored prefix")
            );
            if !has("yes") {
                if !std::io::stdin().is_terminal() {
                    return Err(fail(format!("{question} — refusing without --yes")));
                }
                eprintln!("{question} [y/N] ");
                let mut line = String::new();
                std::io::stdin()
                    .read_line(&mut line)
                    .map_err(|e| fail(e.to_string()))?;
                if !matches!(line.trim().to_lowercase().as_str(), "y" | "yes") {
                    return Err(fail("cancelled".into()));
                }
            }
            omni_control::keys::revoke(&store, id, chrono::Utc::now().timestamp_millis())
                .map_err(fail)?;
            return Ok(if has("json") {
                format!(
                    "{{\n  \"id\": {},\n  \"revoked\": true\n}}",
                    serde_json::to_string(id).expect("string id")
                )
            } else {
                format!("{id} revoked")
            });
        }
        _ => {}
    }
    listing = omni_control::keys::list_keys(&store, now).map_err(fail)?;
    let index = listing.data["keys"]
        .as_array()
        .expect("key listing array")
        .iter()
        .position(|key| key["id"] == *id)
        .ok_or_else(|| fail(format!("no api key \"{id}\"")))?;
    if has("json") {
        return Ok(listing.one_json(index));
    }
    let key = &listing.data["keys"][index];
    let width = if command == "smart-routing" { 13 } else { 6 };
    let head = format!(
        "{:<width$}  {}\n{:<width$}  {}\n{:<width$}  {}…",
        "id",
        id,
        "label",
        key["label"].as_str().expect("stored label"),
        "prefix",
        key["prefix"].as_str().expect("stored prefix")
    );
    Ok(match command {
        "smart-routing" => format!(
            "{head}\nsmart routing  {}",
            if key["smartRouting"] == true {
                "on"
            } else {
                "off"
            }
        ),
        "guardrail" => match key["guardrailPolicy"].as_str() {
            None => format!("{head}\npolicy: none; requests are not judged"),
            Some(p) => format!("{head}\npolicy:\n{p}"),
        },
        "models" => {
            let models = omni_control::operator_json::models_detail(&listing.allowlists[index])
                .map_err(fail)?;
            format!("{head}\nmodels: {models}")
        }
        _ => unreachable!(),
    })
}

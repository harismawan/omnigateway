use std::collections::HashMap;

pub fn resolve(args: &[String]) -> Option<(String, Vec<String>)> {
    let mut i = 0;
    while i < args.len() && args[i].starts_with('-') {
        let valued = matches!(args[i].as_str(), "--root" | "--db");
        i += 1;
        if valued && i < args.len() {
            i += 1;
        }
    }
    if args.get(i).map(String::as_str) == Some("models")
        && args
            .get(i + 1)
            .is_some_and(|s| matches!(s.as_str(), "list" | "show"))
    {
        return Some((
            format!("models-{}", args[i + 1]),
            args[..i].iter().chain(&args[i + 2..]).cloned().collect(),
        ));
    }
    if args.get(i).map(String::as_str) == Some("settings")
        && args
            .get(i + 1)
            .is_some_and(|s| matches!(s.as_str(), "get" | "set"))
    {
        return Some((
            format!("settings-{}", args[i + 1]),
            args[..i].iter().chain(&args[i + 2..]).cloned().collect(),
        ));
    }
    if args.get(i).map(String::as_str) == Some("keys")
        && args.get(i + 1).is_some_and(|s| {
            matches!(
                s.as_str(),
                "list"
                    | "models"
                    | "guardrail"
                    | "smart-routing"
                    | "revoke"
                    | "expiry"
                    | "limits"
                    | "create"
            )
        })
    {
        Some((
            args[i + 1].clone(),
            args[..i].iter().chain(&args[i + 2..]).cloned().collect(),
        ))
    } else {
        None
    }
}

pub fn parse(args: &[String]) -> Result<HashMap<String, String>, String> {
    parse_command(args, "list").map(|p| p.0)
}

type ParsedCommand = (HashMap<String, String>, Vec<String>, Vec<String>);

pub fn parse_command(args: &[String], command: &str) -> Result<ParsedCommand, String> {
    let mut flags = HashMap::new();
    let mut positional = Vec::new();
    let mut allow = Vec::new();
    let mut i = 0;
    while i < args.len() {
        let token = &args[i];
        i += 1;
        if token == "--" {
            positional.extend_from_slice(&args[i..]);
            break;
        }
        if !token.starts_with('-') || token == "-" {
            positional.push(token.clone());
            continue;
        }
        if !token.starts_with("--") {
            for c in token[1..].chars() {
                if matches!(c, 'y' | 'h') {
                    flags.insert(if c == 'y' { "yes" } else { "help" }.into(), "true".into());
                } else {
                    return Err(unknown(&format!("-{c}")));
                }
            }
            continue;
        }
        let (name, inline) = token[2..]
            .split_once('=')
            .map_or((&token[2..], None), |(k, v)| (k, Some(v)));
        match name {
            name if matches!(name, "root" | "db")
                || (command == "create"
                    && matches!(
                        name,
                        "label" | "allow" | "limit" | "model-limit" | "expires" | "policy"
                    ))
                || (command == "expiry" && name == "at")
                || (command == "limits"
                    && matches!(name, "set" | "unset" | "model-limit" | "unset-model-limit"))
                || (command == "models" && name == "allow")
                || (command == "guardrail" && matches!(name, "policy" | "policy-file")) =>
            {
                let value = if let Some(v) = inline {
                    v.to_owned()
                } else {
                    let v = args
                        .get(i)
                        .ok_or_else(|| format!("Option '--{name} <value>' argument missing"))?;
                    if v.starts_with('-') && v != "-" {
                        return Err(format!(
                            "Option '--{name}' argument is ambiguous.\nDid you forget to specify the option argument for '--{name}'?\nTo specify an option argument starting with a dash use '--{name}=-XYZ'."
                        ));
                    }
                    i += 1;
                    v.clone()
                };
                if name == "allow" {
                    allow.push(value.clone());
                }
                if command == "create" && matches!(name, "limit" | "model-limit") {
                    allow.push(format!("{name}\0{value}"));
                }
                if command == "limits"
                    && matches!(name, "set" | "unset" | "model-limit" | "unset-model-limit")
                {
                    allow.push(format!("{name}\0{value}"));
                }
                flags.insert(name.into(), value);
            }
            name if matches!(name, "json" | "no-color" | "yes" | "help" | "version")
                || (command == "create" && matches!(name, "smart-routing" | "no-bodies"))
                || (command == "expiry" && name == "never")
                || (command == "models" && matches!(name, "all" | "none"))
                || (command == "guardrail" && name == "clear")
                || (command == "smart-routing" && matches!(name, "on" | "off")) =>
            {
                if inline.is_some() {
                    return Err(format!("Option '--{name}' does not take an argument"));
                }
                flags.insert(name.into(), "true".into());
            }
            _ => return Err(unknown(&format!("--{name}"))),
        }
    }
    Ok((flags, positional, allow))
}
fn unknown(token: &str) -> String {
    format!(
        "Unknown option '{token}'. To specify a positional argument starting with a '-', place it at the end of the command after '--', as in '-- \"{token}\""
    )
}

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
    let count = args[i..]
        .iter()
        .take_while(|s| !s.starts_with('-'))
        .take(3)
        .count();
    for length in (1..=count).rev() {
        let name = args[i..i + length].join(" ");
        if crate::registry::COMMANDS.iter().any(|(n, _, _)| *n == name) {
            return Some((
                name,
                args[..i]
                    .iter()
                    .chain(&args[i + length..])
                    .cloned()
                    .collect(),
            ));
        }
    }
    None
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
            let file_at = token
                .char_indices()
                .skip(1)
                .find(|(_, c)| *c == 'f')
                .map(|(i, _)| i);
            if command == "models-put"
                && let Some(at) = file_at
            {
                for c in token[1..at].chars() {
                    if matches!(c, 'y' | 'h') {
                        flags.insert(if c == 'y' { "yes" } else { "help" }.into(), "true".into());
                    } else {
                        return Err(unknown(&c.to_string()));
                    }
                }
                let value = if token.len() > at + 1 {
                    token[at + 1..].to_owned()
                } else {
                    let v = args
                        .get(i)
                        .ok_or("Option '-f, --file <value>' argument missing")?;
                    if v.starts_with('-') && v != "-" {
                        let alias = if at == 1 { "-f" } else { "f" };
                        return Err(format!(
                            "Option '{alias}' argument is ambiguous.\nDid you forget to specify the option argument for '{alias}'?\nTo specify an option argument starting with a dash use '--file=-XYZ' or '{alias}-XYZ'."
                        ));
                    }
                    i += 1;
                    v.clone()
                };
                flags.insert("file".into(), value);
                continue;
            }
            // Node names a lone short option with its dash, and an unknown
            // character inside a cluster without one.
            let cluster = token[1..].chars().count() > 1;
            for c in token[1..].chars() {
                if matches!(c, 'y' | 'h') {
                    flags.insert(if c == 'y' { "yes" } else { "help" }.into(), "true".into());
                } else {
                    return Err(unknown(&if cluster {
                        c.to_string()
                    } else {
                        format!("-{c}")
                    }));
                }
            }
            continue;
        }
        let (name, inline) = token[2..]
            .split_once('=')
            .map_or((&token[2..], None), |(k, v)| (k, Some(v)));
        match name {
            name if matches!(name, "root" | "db")
                || (command == "db-migrate" && name == "to")
                || (command.starts_with("setup-") && matches!(name, "dir" | "key"))
                || (command == "models-put"
                    && matches!(name, "file" | "from-catalog" | "strategy"))
                || (command == "models-catalog" && name == "provider")
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
                    let v = args.get(i).ok_or_else(|| {
                        format!(
                            "Option '{} <value>' argument missing",
                            if command == "models-put" && name == "file" {
                                "-f, --file".into()
                            } else {
                                format!("--{name}")
                            }
                        )
                    })?;
                    if v.starts_with('-') && v != "-" {
                        return Err(format!(
                            "Option '--{name}' argument is ambiguous.\nDid you forget to specify the option argument for '--{name}'?\nTo specify an option argument starting with a dash use '--{name}=-XYZ'."
                        ));
                    }
                    i += 1;
                    v.clone()
                };
                if name == "allow" || name == "from-catalog" {
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
                || (command == "status" && name == "system")
                || ((command.starts_with("setup-") || command == "db-restore")
                    && name == "dry-run")
                || (command == "models-put" && name == "alias")
                || (command == "models-dry-run"
                    && matches!(name, "tools" | "images" | "reasoning"))
                || (command == "create" && matches!(name, "smart-routing" | "no-bodies"))
                || (command == "expiry" && name == "never")
                || (command == "models" && matches!(name, "all" | "none"))
                || (command == "guardrail" && name == "clear")
                || (command == "smart-routing" && matches!(name, "on" | "off")) =>
            {
                if inline.is_some() {
                    // Global short aliases are named in every command's diagnostic.
                    return Err(format!(
                        "Option '{}' does not take an argument",
                        match name {
                            "yes" => "-y, --yes".into(),
                            "help" => "-h, --help".into(),
                            _ => format!("--{name}"),
                        }
                    ));
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

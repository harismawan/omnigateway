use std::collections::HashMap;

pub fn resolve(args: &[String]) -> Option<Vec<String>> {
    let mut i = 0;
    while i < args.len() && args[i].starts_with('-') {
        let valued = matches!(args[i].as_str(), "--root" | "--db");
        i += 1;
        if valued && i < args.len() {
            i += 1;
        }
    }
    if args.get(i).map(String::as_str) == Some("keys")
        && args.get(i + 1).map(String::as_str) == Some("list")
    {
        Some(args[..i].iter().chain(&args[i + 2..]).cloned().collect())
    } else {
        None
    }
}

pub fn parse(args: &[String]) -> Result<HashMap<String, String>, String> {
    let mut flags = HashMap::new();
    let mut i = 0;
    while i < args.len() {
        let token = &args[i];
        i += 1;
        if token == "--" {
            break;
        }
        if !token.starts_with('-') || token == "-" {
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
            "root" | "db" => {
                let value = if let Some(v) = inline {
                    v.to_owned()
                } else {
                    let v = args
                        .get(i)
                        .ok_or_else(|| format!("Option '--{name} <value>' argument missing"))?;
                    if v.starts_with('-') {
                        return Err(format!(
                            "Option '--{name}' argument is ambiguous.\nDid you forget to specify the option argument for '--{name}'?\nTo specify an option argument starting with a dash use '--{name}=-XYZ'."
                        ));
                    }
                    i += 1;
                    v.clone()
                };
                flags.insert(name.into(), value);
            }
            "json" | "no-color" | "yes" | "help" | "version" => {
                if inline.is_some() {
                    return Err(format!("Option '--{name}' does not take an argument"));
                }
                flags.insert(name.into(), "true".into());
            }
            _ => return Err(unknown(&format!("--{name}"))),
        }
    }
    Ok(flags)
}
fn unknown(token: &str) -> String {
    format!(
        "Unknown option '{token}'. To specify a positional argument starting with a '-', place it at the end of the command after '--', as in '-- \"{token}\""
    )
}

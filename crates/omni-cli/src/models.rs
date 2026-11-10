use omni_control::{operator_json, settings_value::get};
use omni_ir::jsjson::{self, JsValue};
use std::{collections::HashMap, io::IsTerminal};

fn prop<'a>(v: &'a JsValue, k: &str) -> &'a JsValue {
    static UNDEFINED: JsValue = JsValue::Undefined;
    get(v, k).unwrap_or(&UNDEFINED)
}
fn text(v: &JsValue) -> Result<String, String> {
    if matches!(v, JsValue::Undefined) {
        Ok("undefined".into())
    } else {
        operator_json::string(v)
    }
}
fn truthy(v: &JsValue) -> bool {
    match v {
        JsValue::Null | JsValue::Undefined => false,
        JsValue::Bool(b) => *b,
        JsValue::Number(n) => *n != 0.0 && !n.is_nan(),
        JsValue::String(s) => !s.is_empty(),
        _ => true,
    }
}
fn targets(v: &JsValue, show: bool) -> Result<&[JsValue], String> {
    match prop(v, "targets") {
        JsValue::Array(a) => {
            if !show && a.iter().any(|v| matches!(v, JsValue::Null)) {
                return Err(format!("null is not an object (evaluating '{}')", if show { "target.credentialId" } else { "t.provider" }));
            }
            Ok(a)
        },
        JsValue::Null => Err(format!("null is not an object (evaluating 'model.targets.{}')", if show { "some" } else { "length" })),
        _ if !show => Err("model.targets.map is not a function. (In 'model.targets.map((t) => t.provider)', 'model.targets.map' is undefined)".into()),
        _ => Err("model.targets.some is not a function. (In 'model.targets.some((target) => target.credentialId !== void 0)', 'model.targets.some' is undefined)".into()),
    }
}
fn provider(v: &JsValue, color: bool) -> Result<String, String> {
    let s = text(v)?;
    let code = match s.as_str() {
        "anthropic" => "35",
        "openai" => "32",
        "kimi" => "34",
        "grok" => "33",
        "kilo" => "38;5;208",
        "antigravity" | "qoder" => "38;5;99",
        "muse" => "38;5;33",
        _ => "36",
    };
    Ok(if color {
        format!("\x1b[{code}m{s}\x1b[0m")
    } else {
        s
    })
}
fn table(headers: &[&str], right: &[usize], rows: Vec<Vec<String>>) -> String {
    let rows: Vec<Vec<String>> = std::iter::once(headers.iter().map(|s| (*s).into()).collect())
        .chain(rows)
        .collect();
    let widths: Vec<_> = (0..headers.len())
        .map(|i| {
            rows.iter()
                .map(|r| crate::output::width(&r[i]))
                .max()
                .unwrap_or(0)
        })
        .collect();
    rows.iter()
        .map(|row| {
            row.iter()
                .enumerate()
                .map(|(i, c)| {
                    let pad = " ".repeat(widths[i] - crate::output::width(c));
                    if right.contains(&i) {
                        format!("{pad}{c}")
                    } else {
                        format!("{c}{pad}")
                    }
                })
                .collect::<Vec<_>>()
                .join("  ")
                .trim_end()
                .to_owned()
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// Number.toFixed(2): round the exact binary significand, ties away from zero.
fn fixed(n: f64) -> String {
    if !n.is_finite() || n.abs() >= 1e21 {
        return text(&JsValue::Number(n)).expect("number");
    }
    let bits = n.abs().to_bits();
    let exp = ((bits >> 52) & 2047) as i32;
    let mantissa = (bits & ((1_u64 << 52) - 1)) | if exp == 0 { 0 } else { 1_u64 << 52 };
    let shift = if exp == 0 { -1074 } else { exp - 1023 - 52 };
    let scaled = u128::from(mantissa) * 100;
    let rounded = if shift >= 0 {
        scaled << shift
    } else if -shift >= 128 {
        0
    } else {
        let shift = (-shift) as u32;
        (scaled >> shift)
            + u128::from((scaled & ((1_u128 << shift) - 1)) >= (1_u128 << (shift - 1)))
    };
    format!(
        "{}{}.{:02}",
        if n < 0.0 { "-" } else { "" },
        rounded / 100,
        rounded % 100
    )
}
fn price(v: &JsValue) -> Result<String, String> {
    match v { JsValue::Undefined => Ok("—".into()), JsValue::Number(n) => Ok(fixed(*n)), JsValue::Null => Err("null is not an object (evaluating 'value.toFixed')".into()), _ => Err("value.toFixed is not a function. (In 'value.toFixed(2)', 'value.toFixed' is undefined)".into()) }
}
fn tokens(v: &JsValue) -> Result<String, String> {
    let JsValue::Number(n) = v else {
        return match v {
            JsValue::Undefined => Ok("—".into()),
            JsValue::Null => {
                Err("null is not an object (evaluating 'value.toLocaleString')".into())
            }
            _ => text(v),
        };
    };
    if n.is_infinite() {
        return Ok(if *n < 0.0 { "-∞" } else { "∞" }.into());
    }
    // Intl rounds the shortest decimal representation, rather than toFixed's binary value.
    let s = text(&JsValue::Number(n.abs()))?;
    let (base, exponent) = s.split_once('e').map_or((s.as_str(), 0), |(b, e)| {
        (b, e.parse::<i32>().expect("exponent"))
    });
    let point = base.find('.').unwrap_or(base.len()) as i32 + exponent;
    let mut digits = base.replace('.', "");
    let mut point = point;
    if point < 0 {
        digits = format!("{}{}", "0".repeat((-point) as usize), digits);
        point = 0;
    }
    let keep = point as usize + 3;
    while digits.len() <= keep {
        digits.push('0');
    }
    let round = digits.as_bytes()[keep] >= b'5';
    digits.truncate(keep);
    if round {
        let mut bytes = digits.into_bytes();
        let mut carry = true;
        for d in bytes.iter_mut().rev() {
            if *d == b'9' {
                *d = b'0';
            } else {
                *d += 1;
                carry = false;
                break;
            }
        }
        if carry {
            bytes.insert(0, b'1');
            point += 1;
        }
        digits = String::from_utf8(bytes).expect("digits");
    }
    let (int, frac) = digits.split_at(point as usize);
    let mut out = String::new();
    if n.is_sign_negative() {
        out.push('-');
    }
    if int.is_empty() {
        out.push('0');
    }
    for (i, c) in int.chars().enumerate() {
        if i > 0 && (int.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(c);
    }
    let frac = frac.trim_end_matches('0');
    if !frac.is_empty() {
        out.push('.');
        out.push_str(frac);
    }
    Ok(out)
}
fn capabilities(v: &JsValue) -> Result<String, String> {
    if let JsValue::String(s) = v {
        return Ok(if s.is_empty() {
            "—".into()
        } else {
            (0..s.len())
                .map(|i| i.to_string())
                .collect::<Vec<_>>()
                .join(",")
        });
    }
    let mut entries: Vec<(String, &JsValue)> = match v {
        JsValue::Object(o) => o
            .iter()
            .map(|(k, v)| (String::from_utf16_lossy(k), v))
            .collect(),
        JsValue::Array(a) => a
            .iter()
            .enumerate()
            .map(|(i, v)| (i.to_string(), v))
            .collect(),
        JsValue::Null | JsValue::Undefined => {
            return Err(
                "Object.entries requires that input parameter not be null or undefined".into(),
            );
        }
        _ => vec![],
    };
    entries.sort_by_key(|(k, _)| jsjson::array_index(k).map_or((1, 0), |n| (0, n)));
    let names = entries
        .into_iter()
        .filter(|(_, v)| truthy(v))
        .map(|(k, _)| k)
        .collect::<Vec<_>>();
    Ok(if names.is_empty() {
        "—".into()
    } else {
        names.join(",")
    })
}
fn pinned(targets: &[JsValue]) -> Result<bool, String> {
    for target in targets {
        if matches!(target, JsValue::Null) {
            return Err("null is not an object (evaluating 'target.credentialId')".into());
        }
        if !matches!(prop(target, "credentialId"), JsValue::Undefined) {
            return Ok(true);
        }
    }
    Ok(false)
}

fn human(model: &JsValue, color: bool) -> Result<String, String> {
    let targets = targets(model, true)?;
    let pinned = pinned(targets)?;
    let mut headers = vec!["PROVIDER", "MODEL"];
    if pinned {
        headers.push("ACCOUNT");
    }
    headers.extend([
        "TIER",
        "WEIGHT",
        "IN $/MTOK",
        "OUT $/MTOK",
        "CACHE R",
        "CACHE W 5M",
        "CACHE W 1H",
        "CONTEXT",
        "MAX OUT",
        "CAPABILITIES",
    ]);
    let mut rows = Vec::new();
    for t in targets {
        if matches!(t, JsValue::Null) {
            return Err("null is not an object (evaluating 'target.provider')".into());
        }
        let mut row = vec![
            provider(prop(t, "provider"), color)?,
            text(prop(t, "model"))?,
        ];
        if pinned {
            row.push(match prop(t, "credentialId") {
                JsValue::Null | JsValue::Undefined => "any".into(),
                v => text(v)?,
            });
        }
        row.extend([text(prop(t, "tier"))?, text(prop(t, "weight"))?]);
        let cost = prop(t, "costPerMTok");
        if matches!(cost, JsValue::Null | JsValue::Undefined) {
            return Err(format!(
                "{} is not an object (evaluating 'target.costPerMTok.input')",
                text(cost)?
            ));
        }
        for key in [
            "input",
            "output",
            "cacheRead",
            "cacheWrite5m",
            "cacheWrite1h",
        ] {
            let value = prop(cost, key);
            if matches!(key, "input" | "output") {
                let path = format!("target.costPerMTok.{key}");
                match value {
                    JsValue::Null | JsValue::Undefined => {
                        return Err(format!(
                            "{} is not an object (evaluating '{path}.toFixed')",
                            text(value)?
                        ));
                    }
                    JsValue::Number(_) => {}
                    _ => {
                        return Err(format!(
                            "{path}.toFixed is not a function. (In '{path}.toFixed(2)', '{path}.toFixed' is undefined)"
                        ));
                    }
                }
            }
            row.push(price(value)?);
        }
        row.extend([
            tokens(prop(t, "contextWindow"))?,
            tokens(prop(t, "maxOutputTokens"))?,
            capabilities(prop(t, "capabilities"))?,
        ]);
        rows.push(row);
    }
    for t in targets {
        for value in [
            Some(prop(t, "model")),
            (!color).then(|| prop(t, "provider")),
            pinned
                .then(|| prop(t, "credentialId"))
                .filter(|v| !matches!(v, JsValue::Null | JsValue::Undefined)),
        ]
        .into_iter()
        .flatten()
        {
            match value {
                JsValue::String(_) => {},
                JsValue::Null | JsValue::Undefined => return Err(format!("{} is not an object (evaluating 'text.replace')", text(value)?)),
                _ => return Err("text.replace is not a function. (In 'text.replace(/\\u001b\\[[0-9;]*m/g, \"\")', 'text.replace' is undefined)".into()),
            }
        }
    }
    Ok(format!(
        "id        {}\nstrategy  {}\nalias     {}\n\n{}",
        text(prop(model, "id"))?,
        text(prop(model, "strategy"))?,
        if truthy(prop(model, "isAlias")) {
            "yes"
        } else {
            "no"
        },
        table(
            &headers,
            &(if pinned { 3 } else { 2 }..headers.len() - 1).collect::<Vec<_>>(),
            rows
        )
    ))
}
pub fn run(
    command: &str,
    flags: &HashMap<String, String>,
    args: &[String],
) -> Result<String, (u8, String)> {
    let show = command == "models-show";
    if show && args.first().is_none_or(String::is_empty) {
        return Err((2, "model id is required".into()));
    }
    let run = || -> Result<String, String> {
        let store = crate::context::open(flags)?;
        let color = !flags.contains_key("no-color")
            && std::env::var("NO_COLOR").unwrap_or_default().is_empty()
            && std::io::stdout().is_terminal();
        let models = if show {
            vec![omni_control::models::get(&store, &args[0])?]
        } else {
            omni_control::models::list(&store)?
        };
        // TS checks pins before emit, including JSON mode.
        if show {
            pinned(targets(&models[0], true)?)?;
        }
        if flags.contains_key("json") {
            return Ok(jsjson::stringify_pretty(&JsValue::Object(vec![(
                if show { "model" } else { "models" }
                    .encode_utf16()
                    .collect(),
                if show {
                    models.into_iter().next().expect("model")
                } else {
                    JsValue::Array(models)
                },
            )]))
            .expect("json"));
        }
        if show {
            return human(&models[0], color);
        }
        if models.is_empty() {
            return Ok("no virtual models configured".into());
        }
        let mut rows = Vec::new();
        for m in &models {
            let targets = targets(m, false)?;
            if matches!(prop(m, "id"), JsValue::Null) {
                return Err("null is not an object (evaluating 'text.replace')".into());
            }
            let mut providers = Vec::new();
            let mut seen: Vec<&JsValue> = Vec::new();
            for t in targets {
                let value = prop(t, "provider");
                if seen.iter().any(|old| match value {
                    JsValue::Array(_) | JsValue::Object(_) => std::ptr::eq(*old, value),
                    _ => *old == value,
                }) {
                    continue;
                }
                seen.push(value);
                let p = if !color
                    && matches!(prop(t, "provider"), JsValue::Null | JsValue::Undefined)
                {
                    String::new()
                } else {
                    provider(prop(t, "provider"), color)?
                };
                providers.push(p);
            }
            rows.push(vec![
                text(prop(m, "id"))?,
                text(prop(m, "strategy"))?,
                if truthy(prop(m, "isAlias")) {
                    "yes"
                } else {
                    "no"
                }
                .into(),
                targets.len().to_string(),
                providers.join(" "),
            ]);
        }
        Ok(table(
            &["ID", "STRATEGY", "ALIAS", "TARGETS", "PROVIDERS"],
            &[3],
            rows,
        ))
    };
    run().map_err(|e| (1, e))
}

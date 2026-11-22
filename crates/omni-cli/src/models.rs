use omni_control::{operator_json, settings_value::get};
use omni_ir::jsjson::{self, JsValue};
use std::{
    collections::HashMap,
    io::{BufRead, IsTerminal},
};

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
                return Err(format!(
                    "null is not an object (evaluating '{}')",
                    if show {
                        "target.credentialId"
                    } else {
                        "t.provider"
                    }
                ));
            }
            Ok(a)
        }
        JsValue::Null => Err(format!(
            "null is not an object (evaluating 'model.targets.{}')",
            if show { "some" } else { "length" }
        )),
        value if !show => Err(method_error(
            "model.targets.map",
            "(t) => t.provider",
            prop(value, "map"),
        )),
        value => Err(method_error(
            "model.targets.some",
            "(target) => target.credentialId !== void 0",
            prop(value, "some"),
        )),
    }
}
/// `provider()`: the descriptor's tone through the CLI's own escape table,
/// cyan for an unknown provider or a tone this terminal cannot paint.
pub(crate) fn provider(v: &JsValue, color: bool) -> Result<String, String> {
    let s = text(v)?;
    let tone = omni_control::catalog::descriptor(&s)
        .and_then(|d| get(d, "presentation"))
        .and_then(|p| get(p, "tone"));
    let code = match tone {
        Some(JsValue::String(t)) => match String::from_utf16_lossy(t).as_str() {
            "dim" => "2",
            "red" => "31",
            "green" => "32",
            "yellow" => "33",
            "blue" => "34",
            "magenta" => "35",
            "orange" => "38;5;208",
            "violet" => "38;5;99",
            "azure" => "38;5;33",
            _ => "36",
        },
        _ => "36",
    };
    Ok(if color {
        format!("\x1b[{code}m{s}\x1b[0m")
    } else {
        s
    })
}
pub(crate) fn table(headers: &[&str], right: &[usize], rows: Vec<Vec<String>>) -> String {
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
                .trim_end_matches(omni_ir::js::is_js_whitespace)
                .to_owned()
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// Number.toFixed(2): round the exact binary significand, ties away from zero.
fn fixed(n: f64) -> String {
    fixed_digits(n, 2)
}

fn fixed_digits(n: f64, digits: u32) -> String {
    if n.is_nan() {
        return "NaN".into();
    }
    if !n.is_finite() || n.abs() >= 1e21 {
        return text(&JsValue::Number(n)).expect("number");
    }
    let bits = n.abs().to_bits();
    let exp = ((bits >> 52) & 2047) as i32;
    let mantissa = (bits & ((1_u64 << 52) - 1)) | if exp == 0 { 0 } else { 1_u64 << 52 };
    let shift = if exp == 0 { -1074 } else { exp - 1023 - 52 };
    let scale = 10_u128.pow(digits);
    let scaled = u128::from(mantissa) * scale;
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
        "{}{}.{:0width$}",
        if n < 0.0 { "-" } else { "" },
        rounded / scale,
        rounded % scale,
        width = digits as usize
    )
}
fn price(v: &JsValue) -> Result<String, String> {
    match v {
        JsValue::Undefined => Ok("—".into()),
        JsValue::Number(n) => Ok(fixed(*n)),
        JsValue::Null => Err("null is not an object (evaluating 'value.toFixed')".into()),
        _ => Err(method_error("value.toFixed", "2", prop(v, "toFixed"))),
    }
}
pub(crate) fn method_error(path: &str, args: &str, method: &JsValue) -> String {
    let description = match method {
        JsValue::Object(_) => "an instance of Object".into(),
        JsValue::Array(_) => "an instance of Array".into(),
        JsValue::Undefined => "undefined".into(),
        JsValue::String(units) => format!("\"{}\"", String::from_utf16_lossy(units)),
        JsValue::Number(n) if !n.is_finite() => text(method).expect("number"),
        _ => jsjson::stringify(method).expect("JSON value"),
    };
    format!("{path} is not a function. (In '{path}({args})', '{path}' is {description})")
}

/// Data-only JSON method dispatch. Array locale conversion calls each element's
/// locale method (null/undefined contribute empty cells), not Array.toString.
/// An explicit work stack also makes deeply nested success/error cleanup safe.
fn tokens(value: &JsValue) -> Result<String, String> {
    if matches!(value, JsValue::Undefined) {
        return Ok("—".into());
    }
    let mut out = String::new();
    let mut pending = vec![Some((value, true))];
    while let Some(item) = pending.pop() {
        let Some((v, direct)) = item else {
            out.push(',');
            continue;
        };
        match v {
            JsValue::Null | JsValue::Undefined if !direct => {}
            JsValue::Null => {
                return Err("null is not an object (evaluating 'value.toLocaleString')".into());
            }
            JsValue::Array(a) => {
                for (i, v) in a.iter().enumerate().rev() {
                    pending.push(Some((v, false)));
                    if i > 0 {
                        pending.push(None);
                    }
                }
            }
            JsValue::Object(_) => {
                if let Some(method) = get(v, "toLocaleString") {
                    return Err(if direct {
                        method_error("value.toLocaleString", "\"en-US\"", method)
                    } else {
                        "toLocaleString is not callable".into()
                    });
                }
                if get(v, "toString").is_some() {
                    return Err("Type error".into());
                }
                out.push_str("[object Object]");
            }
            JsValue::Number(_) => out.push_str(&number_tokens(v)?),
            _ => out.push_str(&text(v)?),
        }
    }
    Ok(out)
}

fn number_tokens(v: &JsValue) -> Result<String, String> {
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
                        return Err(method_error(
                            &format!("{path}.toFixed"),
                            "2",
                            prop(value, "toFixed"),
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
        omni_control::cli_cell::scalar_string(prop(model, "strategy")),
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
/// Plugin providers are not supported. A plugin's server entry would import
/// only after discovery finds a loadable, schema-valid manifest declaring the
/// `provider` capability; every earlier stop leaves exactly the built-ins and
/// catalog/put print nothing about it. This refuses only where plugin code
/// could contribute a provider.
fn refuse_plugins(root: &std::path::Path) -> Result<(), String> {
    let found = omni_control::plugins::provider_plugins(root);
    if found.is_empty() {
        return Ok(());
    }
    Err(format!(
        "plugin providers are not supported by this Rust CLI; {} in {} declares one",
        found.join(", "),
        root.join("plugins").display()
    ))
}

fn catalog(only: Option<&str>, json: bool, color: bool) -> Result<String, String> {
    let rows = omni_control::catalog::rows(only);
    if json {
        let models = rows
            .iter()
            .map(|(id, m)| {
                let JsValue::Object(fields) = m else {
                    unreachable!("generated row")
                };
                let mut fields = fields.clone();
                fields.push((
                    "provider".encode_utf16().collect(),
                    JsValue::String(id.encode_utf16().collect()),
                ));
                JsValue::Object(fields)
            })
            .collect();
        return Ok(jsjson::stringify_pretty(&JsValue::Object(vec![(
            "models".encode_utf16().collect(),
            JsValue::Array(models),
        )]))
        .expect("catalog JSON"));
    }
    let mut table_rows = Vec::new();
    for (id, m) in &rows {
        let pricing = prop(m, "pricing");
        let limits = prop(m, "limits");
        // `choiceLimits(entry, "oauth")`: the OAuth backend's figures, else the API's.
        let oauth = match prop(m, "oauthLimits") {
            JsValue::Undefined => limits,
            o => o,
        };
        let mut row = vec![
            provider(&JsValue::String(id.encode_utf16().collect()), color)?,
            text(prop(m, "id"))?,
            text(prop(m, "label"))?,
        ];
        for key in [
            "input",
            "output",
            "cacheRead",
            "cacheWrite5m",
            "cacheWrite1h",
        ] {
            row.push(price(prop(pricing, key))?);
        }
        row.push(tokens(prop(limits, "contextWindow"))?);
        row.push(
            if prop(oauth, "contextWindow") == prop(limits, "contextWindow") {
                "—".into()
            } else {
                tokens(prop(oauth, "contextWindow"))?
            },
        );
        row.push(tokens(prop(limits, "maxOutputTokens"))?);
        table_rows.push(row);
    }
    Ok(table(
        &[
            "PROVIDER",
            "MODEL",
            "LABEL",
            "IN $/MTOK",
            "OUT $/MTOK",
            "CACHE R",
            "CACHE W 5M",
            "CACHE W 1H",
            "CONTEXT",
            "CONTEXT OAUTH",
            "MAX OUT",
        ],
        &(3..11).collect::<Vec<_>>(),
        table_rows,
    ))
}

pub fn run(
    command: &str,
    flags: &HashMap<String, String>,
    args: &[String],
    specs: &[String],
) -> Result<String, (u8, String)> {
    let show = command == "models-show";
    let remove = command == "models-rm";
    let put = command == "models-put";
    // `createContext` runs before the command: root resolution and the
    // ambient-database warning precede every command error.
    let ctx = crate::context::resolve(flags).map_err(|e| (1, e))?;
    let color = !flags.contains_key("no-color")
        && std::env::var("NO_COLOR").unwrap_or_default().is_empty()
        && std::io::stdout().is_terminal();
    if command == "models-dry-run" {
        let id = args
            .first()
            .filter(|s| !s.is_empty())
            .ok_or_else(|| (2, "model id is required".into()))?;
        refuse_plugins(&ctx.root).map_err(|e| (1, e))?;
        let secret = ctx.encryption_key().map_err(|e| (1, e))?;
        let store = ctx.open().map_err(|e| (1, e))?;
        let input = JsValue::from(
            &serde_json::json!({"tools":flags.contains_key("tools"),"images":flags.contains_key("images"),"reasoning":flags.contains_key("reasoning")}),
        );
        #[allow(clippy::cast_precision_loss)]
        let now = chrono::Utc::now().timestamp_millis() as f64;
        let mut result =
            omni_control::dry_run::cli(&store, &secret, id, &input, now).map_err(|e| (1, e))?;
        if let JsValue::Object(fields) = &mut result {
            fields.push((
                "pluginFailures".encode_utf16().collect(),
                JsValue::Array(vec![]),
            ));
        }
        if flags.contains_key("json") {
            return Ok(jsjson::stringify_pretty(&result).expect("result"));
        }
        omni_control::dry_run::cli_table_cells(&store, &result).map_err(|e| (1, e))?;
        return dry_run_human(&result, color).map_err(|e| (1, e));
    }
    if command == "models-catalog" {
        refuse_plugins(&ctx.root).map_err(|e| (1, e))?;
        return catalog(
            flags.get("provider").map(String::as_str),
            flags.contains_key("json"),
            color,
        )
        .map_err(|e| (1, e));
    }
    if (show || remove || put) && args.first().is_none_or(String::is_empty) {
        return Err((2, "model id is required".into()));
    }
    let input = if put {
        if flags.contains_key("file") && flags.contains_key("from-catalog") {
            return Err((2, "pass either -f or --from-catalog, not both".into()));
        }
        if let Some(file) = flags.get("file") {
            let bytes = std::fs::read(file).map_err(|_| (1, format!("could not read {file}")))?;
            let text = String::from_utf8_lossy(&bytes);
            Some(
                operator_json::parse(text.strip_prefix('\u{feff}').unwrap_or(&text))
                    .map_err(|_| (1, format!("{file} is not valid JSON")))?,
            )
        } else if flags.contains_key("from-catalog") {
            refuse_plugins(&ctx.root).map_err(|e| (1, e))?;
            let targets = specs
                .iter()
                .map(|spec| omni_control::catalog::target(spec))
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| (2, e))?;
            let field = |k: &str, v: JsValue| (k.encode_utf16().collect(), v);
            let units = |s: &str| JsValue::String(s.encode_utf16().collect());
            // The draft `putModel` validates: strategy defaults only when the
            // flag is absent, so a blank or unknown one reaches the schema.
            Some(JsValue::Object(vec![
                field("id", units(&args[0])),
                field(
                    "strategy",
                    units(flags.get("strategy").map_or("score", String::as_str)),
                ),
                field("isAlias", JsValue::Bool(flags.contains_key("alias"))),
                field("targets", JsValue::Array(targets)),
            ]))
        } else {
            return Err((
                2,
                "pass -f <file> or --from-catalog <provider>:<model>".into(),
            ));
        }
    } else {
        None
    };
    let run = || -> Result<String, String> {
        let store = ctx.open()?;
        if let Some(input) = &input {
            let id = &args[0];
            omni_control::models::cli_put(&store, id, input)?;
            return Ok(if flags.contains_key("json") {
                jsjson::stringify_pretty(&JsValue::from(&serde_json::json!({"id":id,"ok":true})))
                    .expect("result")
            } else {
                format!("{id} saved")
            });
        }
        if remove {
            let id = &args[0];
            // Control reads/parses every model before asking confirmation.
            omni_control::models::cli_get(&store, id)?;
            if !flags.contains_key("yes") {
                let question = format!("delete virtual model \"{id}\"?");
                if !std::io::stdin().is_terminal() {
                    return Err(format!("{question} — refusing without --yes"));
                }
                eprintln!("{question} [y/N] ");
                let mut answer = Vec::new();
                std::io::stdin()
                    .lock()
                    .read_until(b'\n', &mut answer)
                    .map_err(|e| e.to_string())?;
                let answer = String::from_utf8_lossy(&answer)
                    .trim_matches(omni_ir::js::is_js_whitespace)
                    .to_lowercase();
                if answer != "y" && answer != "yes" {
                    return Err("cancelled".into());
                }
            }
            omni_control::models::remove(&store, id)?;
            return Ok(if flags.contains_key("json") {
                jsjson::stringify_pretty(&JsValue::from(
                    &serde_json::json!({"id": id, "removed": true}),
                ))
                .expect("removal result")
            } else {
                format!("{id} removed")
            });
        }
        let models = if show {
            vec![omni_control::models::cli_get(&store, &args[0])?]
        } else {
            omni_control::models::cli_list(&store)?
        };
        // Pins are checked before emit, including JSON mode.
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
                omni_control::cli_cell::table_text(prop(m, "id"))?,
                omni_control::cli_cell::table_text(prop(m, "strategy"))?,
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

fn dry_run_human(result: &JsValue, color: bool) -> Result<String, String> {
    let header = format!(
        "model          {}\nstrategy       {}\ndeterministic  {}",
        text(prop(result, "modelId"))?,
        text(prop(result, "strategy"))?,
        if truthy(prop(result, "deterministic")) {
            "yes"
        } else {
            "no (weighted draw)"
        }
    );
    let JsValue::Array(candidates) = prop(result, "candidates") else {
        return Err("invalid candidates".into());
    };
    let candidates = if candidates.is_empty() {
        if color {
            "\x1b[31mno candidate can serve this request\x1b[0m".into()
        } else {
            "no candidate can serve this request".into()
        }
    } else {
        let rows = candidates
            .iter()
            .enumerate()
            .map(|(i, c)| {
                Ok(vec![
                    (i + 1).to_string(),
                    text(prop(c, "credentialLabel"))?,
                    provider(prop(c, "provider"), color)?,
                    text(prop(c, "model"))?,
                    text(prop(c, "tier"))?,
                    match prop(c, "score") {
                        JsValue::Number(n) => fixed_digits(*n, 3),
                        _ => "NaN".into(),
                    },
                ])
            })
            .collect::<Result<Vec<_>, String>>()?;
        table(
            &["#", "CREDENTIAL", "PROVIDER", "MODEL", "TIER", "SCORE"],
            &[0, 4, 5],
            rows,
        )
    };
    let JsValue::Array(excluded) = prop(result, "excluded") else {
        return Err("invalid excluded".into());
    };
    let excluded = if excluded.is_empty() {
        String::new()
    } else {
        let rows = excluded
            .iter()
            .map(|e| {
                ["credentialId", "model", "reason"]
                    .iter()
                    .map(|k| text(prop(e, k)))
                    .collect::<Result<Vec<_>, _>>()
            })
            .collect::<Result<Vec<_>, _>>()?;
        format!(
            "\n\n{}\n{}",
            if color {
                "\x1b[2mexcluded\x1b[0m"
            } else {
                "excluded"
            },
            table(&["CREDENTIAL", "MODEL", "REASON"], &[], rows)
        )
    };
    Ok(format!("{header}\n\n{candidates}{excluded}"))
}

#[cfg(test)]
mod locale_tests {
    #[test]
    fn deep_locale_success_and_error_cleanup_use_bounded_stack() {
        std::thread::Builder::new()
            .stack_size(256 * 1024)
            .spawn(|| {
                for (leaf, expected) in [
                    ("1000", Ok("1,000".into())),
                    (
                        r#"{"toLocaleString":null}"#,
                        Err("toLocaleString is not callable".into()),
                    ),
                    (r#"{"toString":42}"#, Err("Type error".into())),
                ] {
                    let raw = format!("{}{}{}", "[".repeat(20_000), leaf, "]".repeat(20_000));
                    let value = omni_control::operator_json::parse(&raw).expect("JSON");
                    assert_eq!(super::tokens(&value), expected);
                }
            })
            .expect("thread")
            .join()
            .expect("bounded stack");
    }
}

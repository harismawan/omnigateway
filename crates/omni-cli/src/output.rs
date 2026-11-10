use omni_ir::jsjson;
use serde_json::Value;

fn text(v: &Value) -> String {
    v.as_str()
        .map_or_else(|| jsjson::to_string(v), str::to_owned)
}
pub(crate) fn time(v: &Value) -> String {
    let Some(ms) = v.as_f64().filter(|n| n.is_finite()) else {
        return "—".into();
    };
    if ms.abs() > 8_640_000_000_000_000.0 {
        return "out of range".into();
    }
    // TimeClip truncates toward zero. Gregorian civil-from-days arithmetic
    // covers the full JS ±100 million day range (including year zero).
    let ms = ms.trunc() as i64;
    let days = ms.div_euclid(86_400_000);
    let z = days + 719468;
    let era = z.div_euclid(146097);
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let mut year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = mp + if mp < 10 { 3 } else { -9 };
    year += i64::from(month <= 2);
    let year = if (0..=9999).contains(&year) {
        format!("{year:04}")
    } else {
        format!(
            "{}{abs:06}",
            if year < 0 { "-" } else { "+" },
            abs = year.abs()
        )
    };
    let seconds = ms.rem_euclid(86_400_000) / 1000;
    let iso = format!(
        "{year}-{month:02}-{day:02} {:02}:{:02}:{:02}",
        seconds / 3600,
        seconds / 60 % 60,
        seconds % 60
    );
    iso[..19].into()
}
fn scope(v: &Value, prefix: &str, out: &mut Vec<String>) {
    for dimension in ["requests", "tokens", "spend"] {
        if let Some(windows) = v[dimension].as_object() {
            for (window, value) in windows {
                if !value.is_null() {
                    out.push(format!("{prefix}{dimension}:{window}={}", text(value)));
                }
            }
        }
    }
    if !v["concurrency"].is_null() {
        out.push(format!("{prefix}concurrency={}", text(&v["concurrency"])));
    }
}
fn paint(color: bool, ok: bool, s: &str) -> String {
    if color {
        format!("\x1b[{}m{s}\x1b[0m", if ok { 32 } else { 31 })
    } else {
        s.into()
    }
}
pub(crate) fn width(s: &str) -> usize {
    let mut rest = s;
    let mut width = 0;
    while !rest.is_empty() {
        if let Some(tail) = rest.strip_prefix("\x1b[") {
            let n = tail
                .bytes()
                .take_while(|b| b.is_ascii_digit() || *b == b';')
                .count();
            if tail[n..].starts_with('m') {
                rest = &tail[n + 1..];
                continue;
            }
        }
        let c = rest.chars().next().expect("nonempty");
        width += c.len_utf16();
        rest = &rest[c.len_utf8()..];
    }
    width
}
pub fn human(
    listing: &omni_control::keys::KeyListing,
    now: i64,
    color: bool,
) -> Result<String, String> {
    let data = &listing.data;
    let Some(keys) = data["keys"].as_array().filter(|k| !k.is_empty()) else {
        return Ok("no api keys; create one with: omni keys create".into());
    };
    let mut rows = vec![
        [
            "ID",
            "LABEL",
            "PREFIX",
            "MODELS",
            "LIMITS",
            "BODY CAPTURE",
            "POLICY",
            "SMART ROUTING",
            "STATE",
            "EXPIRES",
            "CREATED",
        ]
        .map(str::to_owned)
        .to_vec(),
    ];
    for (k, allowlist) in keys.iter().zip(&listing.allowlists) {
        let models = omni_control::operator_json::models(allowlist)?;
        let limits = if k["limits"].is_null() {
            paint(color, false, "unreadable")
        } else {
            let mut parts = Vec::new();
            scope(&k["limits"], "", &mut parts);
            if let Some(models) = k["limits"]["models"].as_object() {
                for (model, v) in jsjson::own_entries(models) {
                    scope(v, &format!("{model}:"), &mut parts);
                }
            }
            if parts.is_empty() {
                "—".into()
            } else {
                parts.join(" ")
            }
        };
        let state = if !k["revokedAt"].is_null() {
            "revoked"
        } else if k["expiresAt"].as_f64().is_some_and(|e| e <= now as f64) {
            "expired"
        } else {
            "active"
        };
        rows.push(vec![
            text(&k["id"]),
            text(&k["label"]),
            text(&k["prefix"]),
            models,
            limits,
            if k["bodyLoggingOptOut"] == true {
                "no bodies"
            } else {
                "—"
            }
            .into(),
            if k["guardrailPolicy"].is_null() {
                "no"
            } else {
                "yes"
            }
            .into(),
            if k["smartRouting"] == true {
                "yes"
            } else {
                "no"
            }
            .into(),
            paint(color, state == "active", state),
            time(&k["expiresAt"]),
            time(&k["createdAt"]),
        ]);
    }
    let widths: Vec<_> = (0..rows[0].len())
        .map(|i| rows.iter().map(|r| width(&r[i])).max().unwrap_or(0))
        .collect();
    Ok(rows
        .iter()
        .map(|r| {
            r.iter()
                .enumerate()
                .map(|(i, c)| format!("{c}{}", " ".repeat(widths[i] - width(c))))
                .collect::<Vec<_>>()
                .join("  ")
                .trim_end()
                .to_owned()
        })
        .collect::<Vec<_>>()
        .join("\n"))
}

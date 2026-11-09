use omni_ir::jsjson;
use serde_json::Value;

fn text(v: &Value) -> String {
    v.as_str()
        .map_or_else(|| jsjson::to_string(v), str::to_owned)
}
fn time(v: &Value) -> String {
    let Some(ms) = v.as_i64() else {
        return "—".into();
    };
    if ms.unsigned_abs() > 8_640_000_000_000_000 {
        return "out of range".into();
    }
    chrono::DateTime::from_timestamp_millis(ms).map_or_else(
        || "out of range".into(),
        |d| d.format("%Y-%m-%d %H:%M:%S").to_string(),
    )
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
fn width(s: &str) -> usize {
    let mut escape = false;
    s.chars()
        .filter(|c| {
            if *c == '\x1b' {
                escape = true;
                false
            } else if escape {
                if *c == 'm' {
                    escape = false;
                }
                false
            } else {
                true
            }
        })
        .map(char::len_utf16)
        .sum()
}
pub fn human(data: &Value, now: i64, color: bool) -> String {
    let Some(keys) = data["keys"].as_array().filter(|k| !k.is_empty()) else {
        return "no api keys; create one with: omni keys create".into();
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
    for k in keys {
        let models = match k["modelAllowlist"].as_array() {
            None => "all".into(),
            Some(a) if a.is_empty() => "none".into(),
            Some(a) => a.iter().map(text).collect::<Vec<_>>().join(","),
        };
        let limits = if k["limits"].is_null() {
            paint(color, false, "unreadable")
        } else {
            let mut parts = Vec::new();
            scope(&k["limits"], "", &mut parts);
            if let Some(models) = k["limits"]["models"].as_object() {
                for (model, v) in models {
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
        } else if k["expiresAt"].as_i64().is_some_and(|e| e <= now) {
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
    rows.iter()
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
        .join("\n")
}

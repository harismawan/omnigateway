//! CLI snapshot projection; provider operations use the shared control quota host.
use crate::observability::{Error, Flags, color, emit, fail, table, text, usage};
use serde_json::{Value, json};
pub fn provider(flags: &Flags, id: &str) -> String {
    let tone = omni_control::catalog::descriptor(id)
        .and_then(|d| omni_control::settings_value::get(d, "presentation"))
        .and_then(|d| omni_control::settings_value::get(d, "tone"))
        .and_then(|v| omni_control::operator_json::string(v).ok());
    color(
        flags,
        match tone.as_deref() {
            Some("green") => "32",
            Some("yellow") => "33",
            Some("blue") => "34",
            Some("magenta") => "35",
            Some("orange") => "38;5;208",
            Some("violet") => "38;5;99",
            Some("azure") => "38;5;33",
            Some("dim") => "2",
            Some("red") => "31",
            _ => "36",
        },
        id,
    )
}
fn span(ms: f64) -> String {
    let s = (ms / 1000.0).round().max(0.0);
    if s < 60.0 {
        format!("{s}s")
    } else if s < 3600.0 {
        format!("{}m", (s / 60.0).floor())
    } else if s < 86400.0 {
        format!(
            "{}h{:02}m",
            (s / 3600.0).floor(),
            (s / 60.0).floor() as u64 % 60
        )
    } else {
        format!(
            "{}d{:02}h",
            (s / 86400.0).floor(),
            (s / 3600.0).floor() as u64 % 24
        )
    }
}
fn nominal(w: &Value) -> f64 {
    w["windowMs"]
        .as_f64()
        .filter(|n| *n > 0.0)
        .unwrap_or(match w["windowType"].as_str() {
            Some("fiveHour") => 18_000_000.0,
            Some("daily") => 86_400_000.0,
            _ => 604_800_000.0,
        })
}
fn burn(w: &Value, now: f64, poll: f64) -> Value {
    let observed = w["observedAt"].as_f64().unwrap_or(0.0);
    let reset = w["resetsAt"].as_f64();
    let start = reset.map(|r| r - nominal(w));
    let rolled = reset.is_some_and(|r| r <= now);
    let stale = observed <= 0.0 || now - observed > poll.max(60000.0) * 3.0;
    let mut b = json!({"credentialId":w["credentialId"],"windowType":w["windowType"],"windowStartsAt":null,"ratePerHour":null,"exhaustsAt":null,"survives":null,"stale":true});
    if stale {
        return b;
    }
    b["windowStartsAt"] = json!(start);
    if rolled {
        return b;
    }
    let used = w["used"].as_f64().unwrap_or(0.0);
    let rate = start.map(|s| {
        if observed <= s || used == 0.0 {
            0.0
        } else {
            used / ((observed - s) / 3600000.0)
        }
    });
    let exhaust = w["limit"]
        .as_f64()
        .filter(|l| *l > 0.0)
        .zip(rate.filter(|r| *r > 0.0))
        .map(|(l, r)| observed + (l - used).max(0.0) / r * 3600000.0);
    b["ratePerHour"] = json!(rate);
    b["exhaustsAt"] = json!(exhaust);
    b["survives"] = json!(exhaust.is_none_or(|e| reset.is_none_or(|r| e >= r)));
    b["stale"] = json!(false);
    b
}
fn history(
    store: &omni_store::SqliteStore,
    windows: &[Value],
    now: f64,
) -> Result<(Vec<Value>, Vec<Value>), Error> {
    let settings = store.get_settings().map_err(fail)?;
    let since = now - settings.log_retention_days * 86400000.0;
    let rows = omni_store::quota::list_quota_samples(store.connection(), since, now, 50001)
        .map_err(fail)?;
    let mut samples = rows
        .into_iter()
        .map(|r| {
            r.iter()
                .map(|v| match v {
                    rusqlite::types::Value::Null => Value::Null,
                    rusqlite::types::Value::Integer(n) => json!(n),
                    rusqlite::types::Value::Real(n) => json!(n),
                    rusqlite::types::Value::Text(s) => json!(s),
                    rusqlite::types::Value::Blob(b) => json!(b),
                })
                .collect::<Vec<_>>()
        })
        .collect::<Vec<_>>();
    samples.sort_by(|a, b| {
        text(&a[0])
            .cmp(&text(&b[0]))
            .then_with(|| text(&a[1]).cmp(&text(&b[1])))
            .then_with(|| {
                a[5].as_f64()
                    .partial_cmp(&b[5].as_f64())
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
    });
    samples.truncate(50000);
    let samples=samples.into_iter().map(|r|json!({"credentialId":r[0],"windowType":r[1],"observedAt":r[5],"used":r[2],"limit":r[3],"resetsAt":r[4],"windowMs":r[6]})).collect();
    let mut rates = Vec::new();
    for w in windows {
        let observed = w["observedAt"].as_f64().unwrap_or(0.0);
        let start = w["resetsAt"].as_f64().map(|r| r - nominal(w));
        let rate = if let Some(s) = start.filter(|s| observed > *s) {
            let raw = omni_control::reports::usage(
                store,
                &format!("grain=raw&groupBy=credential&since={s}&until={observed}"),
                now,
            )
            .map_err(|e| fail(e.message))?;
            let data: Value = serde_json::from_str(&raw).map_err(fail)?;
            let row = data["rows"]
                .as_array()
                .and_then(|r| r.iter().find(|r| r["key"] == w["credentialId"]));
            let tokens = row.map_or(0.0, |r| {
                [
                    "inputTokens",
                    "outputTokens",
                    "cacheReadTokens",
                    "cacheWriteTokens",
                ]
                .iter()
                .map(|k| r[k].as_f64().unwrap_or(0.0))
                .sum()
            });
            Some(tokens / ((observed - s) / 3600000.0))
        } else {
            None
        };
        rates.push(json!({"credentialId":w["credentialId"],"windowType":w["windowType"],"gatewayRatePerHour":rate}));
    }
    Ok((samples, rates))
}
pub fn run(command: &str, flags: &Flags, positional: &[String]) -> Result<(), Error> {
    if command == "quota-refresh" && flags.contains_key("all") == !positional.is_empty() {
        return Err(usage("give an account id or --all, not both"));
    }
    if matches!(command, "quota-reset" | "quota-resets")
        && positional.first().is_none_or(|s| s.is_empty())
    {
        return Err(usage("credential id is required"));
    }
    let store = crate::context::open(flags).map_err(fail)?;
    let raw = omni_control::credentials::cli_rows(&store).map_err(fail)?;
    let accounts = raw.iter().map(omni_control::api::lossy).collect::<Vec<_>>();
    if command != "quota" {
        return crate::quota_operations::run(command, flags, positional);
    }
    let now = chrono::Utc::now().timestamp_millis() as f64;
    let poll = store.get_settings().map_err(fail)?.quota_poll_interval_ms;
    let quota =
        omni_control::credentials::status_quota_json(&store).map_err(|e| fail(e.message))?;
    let quota = omni_control::api::lossy(&quota);
    let windows = quota
        .as_array()
        .ok_or_else(|| fail("invalid quota windows"))?;
    let credentials=accounts.iter().map(|a|json!({"id":a["id"],"provider":a["provider"],"label":a["label"],"windows":windows.iter().filter(|w|w["credentialId"]==a["id"]).collect::<Vec<_>>()})).collect::<Vec<_>>();
    let windows = credentials
        .iter()
        .flat_map(|c| c["windows"].as_array().into_iter().flatten())
        .cloned()
        .collect::<Vec<_>>();
    let burns = windows
        .iter()
        .map(|w| burn(w, now, poll))
        .collect::<Vec<_>>();
    let (samples, rates) = if flags.contains_key("json") {
        history(&store, &windows, now)?
    } else {
        (Vec::new(), Vec::new())
    };
    let data =
        json!({"credentials":credentials,"burn":burns,"samples":samples,"gatewayRates":rates});
    emit(flags, &data, || {
        if credentials.is_empty() {
            return Ok("no credentials; add one with: omni connect <provider>".into());
        }
        let mut rows = Vec::new();
        for c in &credentials {
            let account = format!(
                "{}:{}",
                provider(flags, &text(&c["provider"])),
                text(&c["label"])
            );
            let mut windows = c["windows"].as_array().cloned().unwrap_or_default();
            windows.sort_by_key(|w| match w["windowType"].as_str() {
                Some("fiveHour") => 0,
                Some("daily") => 1,
                _ => 2,
            });
            if windows.is_empty() {
                rows.push(vec![
                    account,
                    "—".into(),
                    color(flags, "2", "unknown"),
                    "—".into(),
                    color(flags, "2", "unknown"),
                    "—".into(),
                ]);
                continue;
            }
            for w in windows {
                let b = burn(&w, now, poll);
                let known = w["limit"].as_f64().is_some_and(|l| l > 0.0);
                let verdict = if w["observedAt"].as_f64().unwrap_or(0.0) > 0.0 && b["stale"] == true
                {
                    "stale"
                } else if !known || b["ratePerHour"].is_null() {
                    "unknown"
                } else if b["survives"] == false {
                    "empty"
                } else {
                    "ok"
                };
                let estimate = match verdict {
                    "empty" => format!(
                        "empty ~{}",
                        span(b["exhaustsAt"].as_f64().unwrap_or(now) - now)
                    ),
                    "ok" => "ok".into(),
                    v => color(flags, "2", v),
                };
                let rate = b["ratePerHour"].as_f64().map_or("—".into(), |r| {
                    if known {
                        format!("{:.1}%/h", r / w["limit"].as_f64().unwrap_or(1.0) * 100.0)
                    } else {
                        format!("{r:.1}/h")
                    }
                });
                rows.push(vec![
                    account.clone(),
                    match w["windowType"].as_str() {
                        Some("fiveHour") => "5h",
                        Some("daily") => "24h",
                        _ => "7d",
                    }
                    .into(),
                    format!(
                        "{}/{}",
                        text(&w["used"]),
                        if w["limit"].is_null() {
                            "—".into()
                        } else {
                            text(&w["limit"])
                        }
                    ),
                    rate,
                    estimate,
                    w["resetsAt"].as_f64().map_or("—".into(), |r| span(r - now)),
                ]);
            }
        }
        Ok(table(
            &["ACCOUNT", "WINDOW", "USED", "RATE", "ESTIMATE", "RESETS"],
            rows,
            &[2, 3, 5],
        ))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn burn_is_anchored_to_observation_not_clock() {
        let window = json!({"credentialId":"c","windowType":"fiveHour","used":25,"limit":100,"resetsAt":18000000,"observedAt":9000000,"windowMs":null});
        let first = burn(&window, 9000001.0, 300000.0);
        let later = burn(&window, 9001000.0, 300000.0);
        assert_eq!(first, later);
        assert_eq!(first["ratePerHour"], 10.0);
        assert_eq!(first["exhaustsAt"], 36000000.0);
        assert_eq!(first["survives"], true);
    }
    #[test]
    fn rollover_keeps_window_start_but_suppresses_inference() {
        let window = json!({"credentialId":"c","windowType":"fiveHour","used":100,"limit":100,"resetsAt":18000000,"observedAt":17999999,"windowMs":null});
        let reading = burn(&window, 18000001.0, 300000.0);
        assert_eq!(reading["windowStartsAt"], 0.0);
        assert_eq!(reading["stale"], true);
        assert!(reading["ratePerHour"].is_null());
    }
}

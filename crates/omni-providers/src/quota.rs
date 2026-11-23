//! One-shot quota wire operations shared by operator hosts; no scheduling.
use crate::oauth::AuthRequest;
use serde_json::{Value, json};
/// Quota-only transport contract; OAuth token requests retain their existing host.
pub struct QuotaRequest {
    pub http: AuthRequest,
    pub timeout: std::time::Duration,
}
pub fn request(
    provider: &str,
    operation: &str,
    token: &str,
    data: &Value,
    body: Value,
) -> Option<QuotaRequest> {
    if (provider, operation) == ("antigravity", "usage") {
        if data["projectId"].as_str().unwrap_or("").trim().is_empty() {
            return None;
        }
        // The captured App shape, shared with bootstrap; 15s timeout.
        return Some(QuotaRequest {
            timeout: std::time::Duration::from_secs(15),
            http: crate::antigravity::oauth::code_assist_request(
                "retrieveUserQuotaSummary",
                token,
                encode(&json!({"project": data["projectId"]})),
            ),
        });
    }
    if (provider, operation) == ("kimi", "usage") {
        // The probe carries the credential's device identity; kimi answers a
        // probe from an unknown device differently.
        let device = crate::kimi::device::from_data(data.as_object());
        return Some(QuotaRequest {
            timeout: std::time::Duration::from_secs(15),
            http: crate::kimi::oauth::usage_request(token, &device),
        });
    }
    if (provider, operation) == ("muse", "usage") {
        // The mint is the only endpoint that carries `subs_usage`, so the
        // probe is a mint — a read of the account's existing key, not an
        // issue of a new one. The returned key is deliberately dropped:
        // `usage` has no channel to persist one.
        return Some(QuotaRequest {
            timeout: std::time::Duration::from_secs(15),
            http: crate::muse::oauth::mint_request(token),
        });
    }
    let url = match (provider, operation) {
        ("openai", "usage") => "https://chatgpt.com/backend-api/wham/usage".into(),
        ("openai", "list") => {
            "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits".into()
        }
        ("openai", "redeem") => {
            "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume".into()
        }
        ("anthropic", "usage") => "https://api.anthropic.com/api/oauth/usage".into(),
        ("anthropic", "list") => {
            "https://api.anthropic.com/api/oauth/usage?cedar_ember=1&skip_spend=1".into()
        }
        ("anthropic", "profile") => "https://api.anthropic.com/api/oauth/profile".into(),
        ("anthropic", "redeem") => format!(
            "https://api.anthropic.com/api/organizations/{}/reset_rate_limits",
            data["organization"].as_str()?
        ),
        _ => return None,
    };
    let post = operation == "redeem";
    let mut headers = vec![
        ("Authorization".into(), format!("Bearer {token}")),
        ("Accept".into(), "application/json".into()),
    ];
    if provider == "openai"
        && let Some(id) = data["accountId"].as_str().filter(|s| !s.trim().is_empty())
    {
        headers.push(("chatgpt-account-id".into(), id.into()));
    }
    if provider == "anthropic" {
        headers.push(("anthropic-beta".into(), "oauth-2025-04-20".into()));
        if operation == "usage" {
            headers.push((
                "User-Agent".into(),
                format!(
                    "claude-code/{}",
                    std::env::var("OMNI_ANTHROPIC_CLI_VERSION").unwrap_or("2.1.296".into())
                ),
            ));
        }
    }
    if post {
        headers.push(("Content-Type".into(), "application/json".into()));
    }
    let headers = match provider {
        "openai" => crate::openai::profile::headers(headers),
        _ => crate::anthropic::profile::headers(headers),
    };
    Some(QuotaRequest {
        // JSON GETs use 15s. Redemption POSTs use the host's
        // 30s ceiling.
        timeout: std::time::Duration::from_secs(if operation == "redeem" { 30 } else { 15 }),
        http: AuthRequest {
            url,
            method: if post { "POST" } else { "GET" }.into(),
            headers,
            body: if post {
                crate::quota::encode(&body)
            } else {
                String::new()
            },
        },
    })
}
fn encode(v: &Value) -> String {
    omni_ir::jsjson::to_string(v)
}
pub(crate) fn num(v: &Value, keys: &[&str]) -> Option<f64> {
    keys.iter().find_map(|k| {
        v[k].as_f64()
            .or_else(|| {
                v[k].as_str()
                    .filter(|s| !s.trim().is_empty())
                    .map(omni_ir::js::string_to_number)
            })
            .filter(|n| n.is_finite())
    })
}
fn date(v: &Value) -> Option<f64> {
    if let Some(s) = v.as_str() {
        chrono::DateTime::parse_from_rfc3339(s)
            .ok()
            .map(|d| d.timestamp_millis() as f64)
    } else {
        v.as_f64()
            .filter(|n| *n > 0.0)
            .map(|n| if n < 1e12 { n * 1000.0 } else { n })
    }
}
fn window(v: &Value, kind: &str, now: f64) -> Option<Value> {
    let seconds = num(
        v,
        &[
            "limit_window_seconds",
            "limitWindowSeconds",
            "window_seconds",
            "windowSeconds",
        ],
    )
    .filter(|n| *n > 0.0);
    let kind = seconds.map_or(kind, |s| {
        if s <= 21600.0 {
            "fiveHour"
        } else if s <= 129600.0 {
            "daily"
        } else {
            "weekly"
        }
    });
    window_from(v, kind, now, seconds.map(|s| s * 1000.0))
}
/// `windowFrom`: one provider window object as a report. `window_ms` is
/// passed in rather than read here because only the caller knows where its
/// provider states a duration — the key differs per payload, and most
/// providers state none. `kind` is not re-derived from it.
pub(crate) fn window_from(
    v: &Value,
    kind: &str,
    now: f64,
    window_ms: Option<f64>,
) -> Option<Value> {
    // `recordOf`: arrays excluded.
    if !v.is_object() {
        return None;
    }
    let used = num(v, &["used", "used_units", "usage", "consumed"]);
    let limit = num(v, &["limit", "limit_units", "total", "quota", "allowed"]);
    let (used, limit) = if let Some(n) = used {
        (n.max(0.0), limit)
    } else if let Some((l, r)) = limit.zip(num(v, &["remaining", "remaining_units", "left"])) {
        ((l - r).max(0.0), Some(l))
    } else {
        (
            num(
                v,
                &[
                    "utilization",
                    "used_percent",
                    "usedPercent",
                    "percent_used",
                    "percentUsed",
                    "percent",
                ],
            )?
            .clamp(0.0, 100.0),
            Some(100.0),
        )
    };
    let reset = [
        "resets_at",
        "resetsAt",
        "reset_at",
        "resetAt",
        "resetTime",
        "reset_time",
        "resets_at_epoch",
        "reset",
    ]
    .iter()
    .find_map(|k| date(&v[k]))
    .or_else(|| {
        num(
            v,
            &[
                "resets_in_seconds",
                "resetsInSeconds",
                "reset_after_seconds",
                "resetAfterSeconds",
                "seconds_until_reset",
                "resets_in",
            ],
        )
        .map(|n| now + (n * 1000.0).round())
    });
    Some(json!({"windowType":kind,"used":used,"limit":limit,"resetsAt":reset,"windowMs":window_ms}))
}
pub fn usage(provider: &str, v: &Value, now: f64) -> Vec<Value> {
    if provider == "muse" {
        // `subs_usage` is absent on an account with no active subscription —
        // a pay-as-you-go key gets no usage — so an empty report is the
        // ordinary answer for those, and the account reads as unknown.
        if !v.is_object() {
            return Vec::new();
        }
        return crate::muse::oauth::parse_usage(v.get("subs_usage").unwrap_or(&Value::Null), now);
    }
    if provider == "kimi" {
        // One plan window under `usage`, counters as strings. The sibling
        // `limits` array is per-minute burst ceilings, not the plan window:
        // mixing them in would park an account for a minute of throttling.
        // `windowFrom(root.usage ?? root.Usage, "weekly", now)`: the window
        // is pinned to weekly with no duration — kimi states none, and a
        // stray duration key must not reclassify the plan window.
        return v
            .get("usage")
            .filter(|v| !v.is_null())
            .or_else(|| v.get("Usage").filter(|v| !v.is_null()))
            .and_then(|root| window_from(root, "weekly", now, None))
            .into_iter()
            .collect();
    }
    if provider == "antigravity" {
        let groups = v["groups"]
            .as_array()
            .or_else(|| v["quotaSummary"]["groups"].as_array());
        let mut rows = Vec::new();
        for g in groups.into_iter().flatten() {
            if !g["displayName"]
                .as_str()
                .unwrap_or("")
                .to_lowercase()
                .contains("gemini")
            {
                continue;
            }
            for b in g["buckets"].as_array().into_iter().flatten() {
                if b["disabled"] == true {
                    continue;
                }
                let label = format!(
                    "{} {}",
                    b["bucketId"].as_str().unwrap_or(""),
                    b["displayName"].as_str().unwrap_or("")
                )
                .to_lowercase();
                let kind = if label.contains("week") {
                    "weekly"
                } else if label.contains("5h")
                    || label.contains("5-hour")
                    || label.contains("5 hour")
                    || label.contains("five hour")
                {
                    "fiveHour"
                } else {
                    continue;
                };
                if let Some(n) = num(b, &["remainingFraction"]) {
                    rows.push(json!({"windowType":kind,"used":((1.0-n.clamp(0.0,1.0))*100.0).round(),"limit":100,"resetsAt":date(&b["resetTime"]),"windowMs":null}));
                }
            }
        }
        return rows;
    }
    let keys = if provider == "openai" {
        &["rate_limit", "rateLimit"][..]
    } else {
        &["usage", "rate_limits", "limits"][..]
    };
    let root = keys
        .iter()
        .find_map(|k| v.get(k).filter(|v| v.is_object()))
        .unwrap_or(v);
    let names = if provider == "openai" {
        [
            &["primary_window", "primaryWindow"][..],
            &["secondary_window", "secondaryWindow"][..],
        ]
    } else {
        [
            &["five_hour", "fiveHour", "session"][..],
            &["seven_day", "sevenDay", "weekly"][..],
        ]
    };
    names
        .iter()
        .zip(["fiveHour", "weekly"])
        .filter_map(|(keys, kind)| {
            keys.iter()
                .find_map(|k| root.get(k).filter(|v| !v.is_null()))
                .and_then(|v| window(v, kind, now))
        })
        .collect()
}
pub fn credits(provider: &str, v: &Value) -> Option<Value> {
    if !v.is_object() {
        return None;
    }
    let mut available = 0;
    let mut rows = Vec::new();
    if provider == "openai" {
        for c in v["credits"].as_array()? {
            let (Some(id), Some(status)) = (c["id"].as_str(), c["status"].as_str()) else {
                continue;
            };
            available += usize::from(status == "available");
            rows.push(json!({"id":id,"status":status,"title":c["title"].as_str(),"grantedAt":date(&c["granted_at"]),"expiresAt":date(&c["expires_at"])}));
        }
    } else {
        let b = &v["cedar_ember"];
        if !b.is_null() {
            for g in b["grants"].as_array()? {
                let Some(id) = g["id"].as_str() else { continue };
                let left = g["resets_left"].as_u64().unwrap_or(0);
                let ok = left > 0
                    && g["usable_now"] == true
                    && g["paused"] != true
                    && (g["use_requires_limit"] != true || b["at_limit"] == true)
                    && (b["next_grant_id"].as_str().is_none_or(|n| n == id));
                if ok {
                    available += left as usize
                }
                rows.push(json!({"id":format!("{id}-u{left}"),"status":if ok{"available"}else if left>0{"unavailable"}else{"used"},"title":g["label"].as_str().filter(|s|!s.is_empty()),"grantedAt":date(&g["starts_at"]),"expiresAt":date(&g["ends_at"])}));
            }
        }
    }
    Some(json!({"available":available,"credits":rows}))
}

pub fn redeemed(provider: &str, result: &Value) -> Result<Option<f64>, String> {
    if provider == "openai" {
        return Ok(num(result, &["windows_reset"]));
    }
    match result["result"].as_str() {
        Some("reset") => Ok(result["cleared"].as_array().map(|a| a.len() as f64)),
        Some("cooldown") => Err("RATE_LIMIT: reset claim refused: cooldown".into()),
        Some(s @ ("already_used" | "not_limited" | "ineligible")) => {
            Err(format!("CONFLICT: reset claim refused: {s}"))
        }
        _ => Err("UPSTREAM: reset claim answered without a reset".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn quota_json_headers_and_operation_deadlines() {
        let data = json!({"accountId":"workspace","projectId":"project","organization":"org"});
        for (provider, operations) in [
            ("openai", &["usage", "list", "redeem"][..]),
            ("anthropic", &["usage", "list", "profile", "redeem"][..]),
            ("antigravity", &["usage"][..]),
        ] {
            for operation in operations {
                let request = request(provider, operation, "access", &data, Value::Null)
                    .expect("supported quota operation");
                let accept = request
                    .http
                    .headers
                    .iter()
                    .filter(|(name, _)| name.eq_ignore_ascii_case("accept"))
                    .map(|(_, value)| value.as_str())
                    .collect::<Vec<_>>();
                // The captured App quota RPC sends no `Accept`.
                let want: &[&str] = if provider == "antigravity" {
                    &[]
                } else {
                    &["application/json"]
                };
                assert_eq!(accept, want, "{provider} {operation}");
                assert_eq!(
                    request.timeout.as_secs(),
                    if *operation == "redeem" { 30 } else { 15 }
                );
            }
        }
    }
    #[test]
    fn provider_windows_and_reset_capabilities_match_frozen_shapes() {
        let rows = usage(
            "openai",
            &json!({"rate_limit":{"primary_window":{"used_percent":25,"limit_window_seconds":604800,"reset_at":1893456000}}}),
            1.0,
        );
        assert_eq!(rows[0]["windowType"], "weekly");
        assert_eq!(rows[0]["windowMs"], 604800000.0);
        assert_eq!(rows[0]["resetsAt"], 1893456000000.0);
        let grants=credits("anthropic",&json!({"cedar_ember":{"at_limit":true,"grants":[{"id":"grant","resets_left":2,"usable_now":true,"use_requires_limit":true}]}})).expect("grants");
        assert_eq!(grants["available"], 2);
        assert_eq!(grants["credits"][0]["id"], "grant-u2");
        assert_eq!(
            redeemed("anthropic", &json!({"result":"already_used"})).expect_err("conflict"),
            "CONFLICT: reset claim refused: already_used"
        );
        assert!(request("antigravity", "list", "access", &json!({}), Value::Null).is_none());
    }
}

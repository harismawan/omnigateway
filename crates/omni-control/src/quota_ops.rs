//! Transactional provider snapshot/history writes, independent of scheduling.
use omni_store::SqliteStore;
use serde_json::Value;
/// Operator retained history, including corroborating gateway rates.
pub fn history(store: &SqliteStore, query: &str, now: f64) -> Result<String, crate::api::Failure> {
    history_inner(store, query, now).map_err(|_| crate::api::Failure {
        code: None,
        message: "quota history read failed".into(),
    })
}
fn history_inner(store: &SqliteStore, query: &str, now: f64) -> Result<String, HistoryError> {
    let settings = store.get_settings()?;
    let oldest = now - settings.log_retention_days * 86400000.0;
    let pairs = url::form_urlencoded::parse(query.as_bytes()).collect::<Vec<_>>();
    let get = |key: &str| {
        pairs
            .iter()
            .rev()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.as_ref())
    };
    let number = |key: &str, default: f64| {
        get(key)
            .and_then(|v| v.parse::<f64>().ok())
            .filter(|v| v.is_finite())
            .unwrap_or(default)
    };
    let since = number("since", oldest).max(oldest);
    let until = number("until", now).min(now);
    let id = get("credentialId");
    let mut stmt=store.connection().prepare("SELECT credential_id,window_type,used,limit_value,resets_at,observed_at,window_ms FROM (SELECT * FROM quota_samples WHERE observed_at>=? AND observed_at<=? AND (? IS NULL OR credential_id=?) ORDER BY observed_at DESC LIMIT 50001) ORDER BY credential_id,window_type,observed_at")?;
    let mut rows = stmt.query(rusqlite::params![since, until, id, id])?;
    let mut samples = Vec::new();
    while let Some(r) = rows.next()? {
        samples.push(serde_json::json!({"credentialId":r.get::<_,String>(0)?,"windowType":r.get::<_,String>(1)?,"used":r.get::<_,f64>(2)?,"limit":r.get::<_,Option<f64>>(3)?,"resetsAt":r.get::<_,Option<f64>>(4)?,"observedAt":r.get::<_,f64>(5)?,"windowMs":r.get::<_,Option<f64>>(6)?}));
    }
    let truncated = samples.len() > 50000;
    samples.truncate(50000);
    let mut stmt=store.connection().prepare("SELECT credential_id,window_type,used,limit_value,resets_at,observed_at,window_ms FROM quota_windows WHERE ? IS NULL OR credential_id=?")?;
    let mut rows = stmt.query(rusqlite::params![id, id])?;
    let mut rates = Vec::new();
    while let Some(r) = rows.next()? {
        let id: String = r.get(0)?;
        let kind: String = r.get(1)?;
        let reset: Option<f64> = r.get(4)?;
        let observed: f64 = r.get(5)?;
        let duration =
            r.get::<_, Option<f64>>(6)?
                .filter(|v| *v > 0.0)
                .unwrap_or(match kind.as_str() {
                    "fiveHour" => 18000000.0,
                    "daily" => 86400000.0,
                    _ => 604800000.0,
                });
        let rate = if let Some(start) = reset.map(|r| r - duration).filter(|s| observed > *s) {
            let raw = crate::reports::usage(
                store,
                &format!("grain=raw&groupBy=credential&since={start}&until={observed}"),
                now,
            )?;
            let data: Value = serde_json::from_str(&raw).unwrap_or(Value::Null);
            let tokens = data["rows"]
                .as_array()
                .and_then(|a| a.iter().find(|r| r["key"] == id))
                .map_or(0.0, |r| {
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
            Some(tokens / ((observed - start) / 3600000.0))
        } else {
            None
        };
        rates.push(
            serde_json::json!({"credentialId":id,"windowType":kind,"gatewayRatePerHour":rate}),
        );
    }
    Ok(
        serde_json::json!({"samples":samples,"gatewayRates":rates,"truncated":truncated})
            .to_string(),
    )
}
struct HistoryError;
impl From<rusqlite::Error> for HistoryError {
    fn from(_: rusqlite::Error) -> Self {
        Self
    }
}
impl From<omni_store::StoreError> for HistoryError {
    fn from(_: omni_store::StoreError) -> Self {
        Self
    }
}
impl From<crate::api::Failure> for HistoryError {
    fn from(_: crate::api::Failure) -> Self {
        Self
    }
}
pub fn save(store: &SqliteStore, id: &str, windows: &[Value], now: i64) -> Result<(), String> {
    let tx = store
        .connection()
        .unchecked_transaction()
        .map_err(|e| e.to_string())?;
    for w in windows {
        let kind = w["windowType"].as_str().ok_or("invalid quota window")?;
        let used = w["used"].as_f64().ok_or("invalid quota usage")?;
        let limit = w["limit"].as_f64();
        let reset = w["resetsAt"].as_f64();
        let duration = w["windowMs"].as_f64();
        tx.execute("INSERT INTO quota_windows(credential_id,window_type,starts_at,used,limit_value,resets_at,observed_at,window_ms) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(credential_id,window_type) DO UPDATE SET starts_at=excluded.starts_at,used=excluded.used,limit_value=excluded.limit_value,resets_at=excluded.resets_at,observed_at=excluded.observed_at,window_ms=excluded.window_ms",rusqlite::params![id,kind,now,used,limit,reset,now,duration]).map_err(|e|e.to_string())?;
        let unchanged:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM (SELECT * FROM quota_samples WHERE credential_id=? AND window_type=? ORDER BY observed_at DESC LIMIT 1) WHERE used=? AND limit_value IS ? AND (resets_at IS ? OR abs(resets_at-?)<=60000) AND window_ms IS ?)",rusqlite::params![id,kind,used,limit,reset,reset,duration],|r|r.get(0)).map_err(|e|e.to_string())?;
        if !unchanged {
            tx.execute("INSERT OR REPLACE INTO quota_samples(credential_id,window_type,observed_at,used,limit_value,resets_at,window_ms) VALUES(?,?,?,?,?,?,?)",rusqlite::params![id,kind,now,used,limit,reset,duration]).map_err(|e|e.to_string())?;
        }
    }
    let kinds = serde_json::to_string(
        &windows
            .iter()
            .filter_map(|w| w["windowType"].as_str())
            .collect::<Vec<_>>(),
    )
    .map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM quota_windows WHERE credential_id=? AND window_type NOT IN(SELECT value FROM json_each(?))",rusqlite::params![id,kinds]).map_err(|e|e.to_string())?;
    tx.commit().map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    #[test]
    fn snapshot_replaces_missing_windows_and_deduplicates_idle_history() {
        let dir = tempfile::tempdir().expect("temp");
        let store = omni_store::SqliteStore::open(dir.path().join("db"), 0).expect("store");
        store.connection().execute("INSERT INTO credentials(id,provider,label,auth_type,created_at,updated_at) VALUES('c','openai','c','oauth',1,1)",[]).expect("credential");
        let w = serde_json::json!({"windowType":"fiveHour","used":25,"limit":100,"resetsAt":100000,"windowMs":null});
        super::save(&store, "c", std::slice::from_ref(&w), 1).expect("first");
        super::save(&store, "c", &[w], 2).expect("idle");
        let count: i64 = store
            .connection()
            .query_row("SELECT count(*) FROM quota_samples", [], |r| r.get(0))
            .expect("count");
        assert_eq!(count, 1);
        super::save(&store,"c",&[serde_json::json!({"windowType":"weekly","used":10,"limit":100,"resetsAt":200000,"windowMs":null})],3).expect("replacement");
        let kind: String = store
            .connection()
            .query_row("SELECT window_type FROM quota_windows", [], |r| r.get(0))
            .expect("kind");
        assert_eq!(kind, "weekly");
    }
}

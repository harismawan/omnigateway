//! Transactional provider snapshot/history writes, independent of scheduling.
use omni_store::SqliteStore;
use serde_json::Value;
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

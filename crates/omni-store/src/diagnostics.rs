//! Reporting only: never repairs derived usage data.
use crate::StoreError;
pub fn audit_rollup(conn: &rusqlite::Connection) -> Result<(i64, i64), StoreError> {
    Ok(conn.query_row("WITH truth AS (
      SELECT api_key_id k, CAST(at / 3600000 AS INTEGER) h, COUNT(*) requests,
      COALESCE(SUM(input_tokens),0) input_tokens, COALESCE(SUM(output_tokens),0) output_tokens,
      COALESCE(SUM(cache_read_tokens),0) cache_read_tokens, COALESCE(SUM(cache_write_tokens),0) cache_write_tokens,
      COALESCE(SUM(cost_usd),0) cost_usd FROM request_logs WHERE state='done' AND api_key_id IS NOT NULL GROUP BY k,h)
      SELECT (SELECT COUNT(*) FROM truth),
      (SELECT COUNT(*) FROM truth LEFT JOIN usage_rollup r ON r.api_key_id=truth.k AND r.hour=truth.h
      WHERE r.api_key_id IS NULL OR r.requests<>truth.requests OR r.input_tokens<>truth.input_tokens
      OR r.output_tokens<>truth.output_tokens OR r.cache_read_tokens<>truth.cache_read_tokens
      OR r.cache_write_tokens<>truth.cache_write_tokens OR ABS(r.cost_usd-truth.cost_usd)>1e-9+ABS(truth.cost_usd)*1e-9)
      +(SELECT COUNT(*) FROM usage_rollup r LEFT JOIN truth ON r.api_key_id=truth.k AND r.hour=truth.h WHERE truth.k IS NULL)", [], |r| Ok((r.get(0)?,r.get(1)?)))?)
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    #[test]
    fn audit_reports_orphan_without_repair() {
        let store = crate::SqliteStore::open(":memory:", 0).unwrap();
        assert_eq!(super::audit_rollup(store.connection()).unwrap(), (0, 0));
        store.connection().execute("INSERT INTO usage_rollup(api_key_id,hour,requests,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,cost_usd) VALUES ('orphan',1,2,0,0,0,0,0)",[]).unwrap();
        assert_eq!(super::audit_rollup(store.connection()).unwrap(), (0, 1));
        assert_eq!(super::audit_rollup(store.connection()).unwrap(), (0, 1));
    }

    #[test]
    fn compares_authoritative_done_counters_and_cost() {
        let store = crate::SqliteStore::open(":memory:", 0).unwrap();
        let c = store.connection();
        c.execute("INSERT INTO request_logs(id,at,api_key_id,requested_model,status,duration_ms,state,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,cost_usd) VALUES ('r',3600000,'k','m',200,1,'done',10,20,30,40,0.5)",[]).unwrap();
        assert_eq!(super::audit_rollup(c).unwrap(), (1, 1));
        c.execute("INSERT INTO usage_rollup(api_key_id,hour,requests,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,cost_usd) VALUES ('k',1,1,10,20,30,40,0.5)",[]).unwrap();
        assert_eq!(super::audit_rollup(c).unwrap(), (1, 0));
        for column in [
            "requests",
            "input_tokens",
            "output_tokens",
            "cache_read_tokens",
            "cache_write_tokens",
            "cost_usd",
        ] {
            c.execute(&format!("UPDATE usage_rollup SET {column}={column}+1"), [])
                .unwrap();
            assert_eq!(super::audit_rollup(c).unwrap(), (1, 1), "{column}");
            c.execute(&format!("UPDATE usage_rollup SET {column}={column}-1"), [])
                .unwrap();
        }
    }
}

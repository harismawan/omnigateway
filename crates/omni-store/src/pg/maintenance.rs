//! Frozen Postgres retention; raw deletion and boundary-hour rebuild are atomic.
use crate::StoreError;

impl super::PgStore {
    pub async fn pending_interruptions(
        &self,
        node: &str,
        now: i64,
    ) -> Result<Vec<crate::writer::RequestLog>, StoreError> {
        super::usage::pending_interruptions(&self.client().await?, node, now).await
    }
    pub async fn heartbeat(&self, node: &str, now: i64) -> Result<(), StoreError> {
        let c = self.client().await?;
        c.execute("INSERT INTO nodes (id, seen_at) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET seen_at = EXCLUDED.seen_at", &[&node, &now]).await?;
        c.execute(
            "DELETE FROM nodes WHERE seen_at < $1",
            &[&(now - 86_400_000)],
        )
        .await?;
        Ok(())
    }

    pub async fn prune_logs(&self, horizon: f64) -> Result<u64, StoreError> {
        let horizon = crate::maintenance::pg_horizon(horizon)?;
        let mut c = self.client().await?;
        let tx = c.transaction().await?;
        let removed = tx
            .execute("DELETE FROM request_logs WHERE at < $1", &[&horizon])
            .await?;
        let boundary = horizon.div_euclid(3_600_000);
        tx.execute("DELETE FROM usage_rollup WHERE hour <= $1", &[&boundary])
            .await?;
        tx.execute("INSERT INTO usage_rollup (api_key_id, hour, requests, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd) SELECT api_key_id, $1::bigint, COUNT(*), COALESCE(SUM(input_tokens), 0), COALESCE(SUM(output_tokens), 0), COALESCE(SUM(cache_read_tokens), 0), COALESCE(SUM(cache_write_tokens), 0), COALESCE(SUM(cost_usd), 0) FROM request_logs WHERE state = 'done' AND api_key_id IS NOT NULL AND at >= $2 AND at < $3 GROUP BY api_key_id", &[&boundary, &(boundary * 3_600_000), &((boundary + 1) * 3_600_000)]).await?;
        tx.commit().await?;
        Ok(removed)
    }

    pub async fn prune_daily(&self, horizon: f64) -> Result<u64, StoreError> {
        let horizon = crate::maintenance::pg_horizon(horizon)?;
        Ok(self
            .client()
            .await?
            .execute("DELETE FROM usage_daily WHERE day < $1", &[&horizon])
            .await?)
    }

    pub async fn prune_quota_samples(&self, horizon: f64) -> Result<u64, StoreError> {
        let horizon = crate::maintenance::pg_horizon(horizon)?;
        Ok(self
            .client()
            .await?
            .execute(
                "DELETE FROM quota_samples WHERE observed_at < $1",
                &[&horizon],
            )
            .await?)
    }

    pub async fn prune_bodies(&self, horizon: f64) -> Result<usize, StoreError> {
        let horizon = crate::maintenance::pg_horizon(horizon)?;
        let c = self.client().await?;
        let rows = c
            .query(
                "SELECT request_id FROM request_bodies WHERE at < $1",
                &[&horizon],
            )
            .await?;
        let ids: Vec<String> = rows.iter().map(|r| r.get(0)).collect();
        if !ids.is_empty() {
            c.execute(
                "DELETE FROM request_bodies WHERE request_id = ANY($1)",
                &[&ids],
            )
            .await?;
        }
        Ok(ids.len())
    }

    pub async fn prune_bodies_to_cap(&self, cap: i64) -> Result<usize, StoreError> {
        let c = self.client().await?;
        let total: i64 = c
            .query_one("SELECT COUNT(*) FROM request_bodies", &[])
            .await?
            .get(0);
        if total <= cap {
            return Ok(0);
        }
        let rows = c
            .query(
                "SELECT request_id FROM request_bodies ORDER BY at ASC, request_id ASC LIMIT $1",
                &[&(total - cap)],
            )
            .await?;
        let ids: Vec<String> = rows.iter().map(|r| r.get(0)).collect();
        if !ids.is_empty() {
            c.execute(
                "DELETE FROM request_bodies WHERE request_id = ANY($1)",
                &[&ids],
            )
            .await?;
        }
        Ok(ids.len())
    }
}

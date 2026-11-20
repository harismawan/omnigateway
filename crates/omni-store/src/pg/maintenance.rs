//! Frozen Postgres retention; raw deletion and boundary-hour rebuild are atomic.
use crate::StoreError;

pub struct DatabaseStats {
    pub bytes: i64,
    pub page_size: i32,
    pub schema_version: i64,
}

pub struct TableStats {
    pub name: String,
    pub bytes: i64,
    pub rows: i64,
    pub dead_rows: i64,
}

impl super::PgStore {
    pub async fn database_stats(&self) -> Result<DatabaseStats, StoreError> {
        let row = self
            .client()
            .await?
            .query_one(
                "SELECT pg_database_size(current_database()), current_setting('block_size')::int,
                    COALESCE((SELECT MAX(id)::bigint FROM migrations), 0)",
                &[],
            )
            .await?;
        Ok(DatabaseStats {
            bytes: row.try_get(0)?,
            page_size: row.try_get(1)?,
            schema_version: row.try_get(2)?,
        })
    }

    pub async fn database_tables(&self) -> Result<Vec<TableStats>, StoreError> {
        self.client()
            .await?
            .query(
                "SELECT c.relname::text AS name, pg_total_relation_size(c.oid) AS bytes,
                    GREATEST(c.reltuples, 0)::bigint, COALESCE(s.n_dead_tup, 0)
               FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
               LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
              WHERE c.relkind = 'r' AND n.nspname = current_schema()
              ORDER BY bytes DESC, name",
                &[],
            )
            .await?
            .iter()
            .map(|r| {
                Ok(TableStats {
                    name: r.try_get(0)?,
                    bytes: r.try_get(1)?,
                    rows: r.try_get(2)?,
                    dead_rows: r.try_get(3)?,
                })
            })
            .collect()
    }

    pub async fn live_nodes(&self, now: i64) -> Result<Vec<(String, i64)>, StoreError> {
        self.client()
            .await?
            .query(
                "SELECT id, seen_at FROM nodes WHERE seen_at > $1 ORDER BY seen_at DESC",
                &[&now.saturating_sub(60_000)],
            )
            .await?
            .iter()
            .map(|row| Ok((row.try_get(0)?, row.try_get(1)?)))
            .collect()
    }

    pub async fn pending_interruptions(
        &self,
        boot_node: Option<&str>,
        now: i64,
    ) -> Result<Vec<crate::writer::RequestLog>, StoreError> {
        super::usage::pending_interruptions(&self.client().await?, boot_node, now).await
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

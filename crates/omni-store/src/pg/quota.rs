//! Provider observations: replace the current set, append distinct samples.
use crate::{QuotaWindow, StoreError, quota::WindowType};

impl super::PgStore {
    pub async fn fresh_quota_windows(
        &self,
        id: &str,
        started: i64,
    ) -> Result<Option<usize>, StoreError> {
        let row = self
            .client()
            .await?
            .query_one(
                "SELECT count(*), max(observed_at) FROM quota_windows WHERE credential_id=$1",
                &[&id],
            )
            .await?;
        let count: i64 = row.try_get(0)?;
        let at: Option<i64> = row.try_get(1)?;
        Ok(at
            .filter(|at| *at >= started)
            .and_then(|_| usize::try_from(count).ok()))
    }

    pub async fn save_quota(
        &self,
        id: &str,
        windows: &[QuotaWindow],
        now: i64,
    ) -> Result<(), StoreError> {
        let mut client = self.client().await?;
        let tx = client.transaction().await?;
        // Also serializes a first write when there are no windows to lock.
        tx.query_one("SELECT id FROM credentials WHERE id=$1 FOR UPDATE", &[&id])
            .await?;
        let mut kinds = Vec::with_capacity(windows.len());
        for window in windows {
            let kind = window.window_type.as_str();
            kinds.push(kind);
            let args: &[&(dyn tokio_postgres::types::ToSql + Sync)] = &[
                &id,
                &kind,
                &now,
                &window.used,
                &window.limit,
                &window.resets_at,
                &window.window_ms,
            ];
            tx.execute("INSERT INTO quota_windows (credential_id,window_type,starts_at,observed_at,used,limit_value,resets_at,window_ms)
                VALUES ($1,$2,$3,$3,$4::float8::bigint,$5::float8::bigint,$6::float8::bigint,$7::float8::bigint)
                ON CONFLICT (credential_id,window_type) DO UPDATE SET starts_at=excluded.starts_at,observed_at=excluded.observed_at,used=excluded.used,limit_value=excluded.limit_value,resets_at=excluded.resets_at,window_ms=excluded.window_ms",args).await?;
            tx.execute("INSERT INTO quota_samples (credential_id,window_type,observed_at,used,limit_value,resets_at,window_ms)
                SELECT $1,$2,$3,$4::float8::bigint,$5::float8::bigint,$6::float8::bigint,$7::float8::bigint
                WHERE NOT EXISTS (SELECT FROM (SELECT * FROM quota_samples WHERE credential_id=$1 AND window_type=$2 ORDER BY observed_at DESC LIMIT 1) AS previous
                    WHERE used=$4::float8::bigint AND limit_value IS NOT DISTINCT FROM $5::float8::bigint
                    AND (resets_at IS NOT DISTINCT FROM $6::float8::bigint OR abs(resets_at::float8-$6)<=60000)
                    AND window_ms IS NOT DISTINCT FROM $7::float8::bigint)
                ON CONFLICT (credential_id,window_type,observed_at) DO UPDATE SET used=excluded.used,limit_value=excluded.limit_value,resets_at=excluded.resets_at,window_ms=excluded.window_ms", args).await?;
        }
        tx.execute(
            "DELETE FROM quota_windows WHERE credential_id=$1 AND NOT (window_type=ANY($2))",
            &[&id, &kinds],
        )
        .await?;
        tx.commit().await?;
        Ok(())
    }

    pub async fn quota_samples(
        &self,
        since: f64,
        until: f64,
        id: Option<&str>,
    ) -> Result<Vec<QuotaWindow>, StoreError> {
        let client = self.client().await?;
        let rows = client.query("SELECT credential_id,window_type,used::float8,limit_value::float8,resets_at::float8,observed_at::float8,window_ms::float8 FROM quota_samples
            WHERE observed_at >= ceil($1::float8)::bigint AND observed_at <= floor($2::float8)::bigint AND ($3::text IS NULL OR credential_id=$3)
            ORDER BY observed_at DESC, credential_id, window_type LIMIT 50001", &[&since,&until,&id]).await?;
        rows.iter()
            .map(|row| {
                Ok(QuotaWindow {
                    text_spent: None,
                    credential_id: row.try_get(0)?,
                    window_type: WindowType::parse(row.try_get(1)?),
                    used: row.try_get(2)?,
                    limit: row.try_get(3)?,
                    resets_at: row.try_get(4)?,
                    observed_at: row.try_get(5)?,
                    window_ms: row.try_get(6)?,
                    starts_at: 0.0,
                })
            })
            .collect()
    }
}

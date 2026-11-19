//! Production adapters between the primary store and reviewed cluster limiter.
use omni_cluster_limit::{SeedRead, UsageSource};

/// A successfully persisted completion with its original row association.
pub struct CommittedDebit<'a> {
    pub key: &'a str,
    pub model: Option<&'a str>,
    pub tokens: f64,
    pub cost_usd: f64,
    pub at: f64,
    pub commit: &'a str,
}

/// Failed-persistence fallback completions belong only to the single-node
/// limiter. Never turn them into a fabricated cluster visibility identity.
pub fn committed_debit(row: &omni_store::writer::Completion) -> Option<CommittedDebit<'_>> {
    Some(CommittedDebit {
        key: row.api_key_id.as_deref()?,
        model: row.debit_model.then_some(row.requested_model.as_str()),
        tokens: row.tokens,
        cost_usd: row.cost_usd,
        at: row.at,
        commit: row.commit_id.as_deref().filter(|id| !id.is_empty())?,
    })
}

pub struct PgUsage {
    primary: omni_store::pg::PgStore,
}

impl PgUsage {
    pub fn new(primary: omni_store::pg::PgStore) -> Self {
        Self { primary }
    }
}

#[async_trait::async_trait]
impl UsageSource for PgUsage {
    async fn seed_read(
        &self,
        key_id: &str,
        since_ms: f64,
        grain_ms: f64,
        model: Option<&str>,
    ) -> Result<SeedRead, String> {
        if !grain_ms.is_finite()
            || grain_ms.fract() != 0.0
            || !(1.0..=3_600_000.0).contains(&grain_ms)
        {
            return Err("invalid cluster seed grain".into());
        }
        #[allow(clippy::cast_possible_truncation)]
        let grain = grain_ms as i64;
        let read = self
            .primary
            .cluster_seed_read(key_id, since_ms, grain, model)
            .await
            .map_err(|e| e.to_string())?;
        #[allow(clippy::cast_precision_loss)]
        Ok(SeedRead {
            snapshot: read.snapshot,
            rows: read
                .rows
                .into_iter()
                .map(|(at, counts)| (at as f64, counts))
                .collect(),
            ranges: read
                .ranges
                .into_iter()
                .map(|(bucket, low, high)| (bucket as f64, low as f64, high as f64))
                .collect(),
        })
    }
}

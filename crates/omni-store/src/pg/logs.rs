//! Bounded Postgres log reads. Only known columns become SQL identifiers;
//! exact scopes and escaped text search are bound separately.
use crate::{StoreError, logs::Query};
use omni_ir::jsjson::{JsValue, parse_js};
use tokio_postgres::types::ToSql;

impl super::PgStore {
    pub async fn last_used_by_credential(&self) -> Result<Vec<(String, i64)>, StoreError> {
        self.client()
            .await?
            .query(
                "SELECT id, at FROM credentials JOIN LATERAL (
            SELECT at FROM request_logs WHERE credential_id=credentials.id ORDER BY at DESC LIMIT 1
        ) AS recent ON true",
                &[],
            )
            .await?
            .iter()
            .map(|r| Ok((r.try_get(0)?, r.try_get(1)?)))
            .collect()
    }

    pub async fn log_page(&self, q: &Query) -> Result<Vec<JsValue>, StoreError> {
        let mut params: Vec<Box<dyn ToSql + Send + Sync>> = Vec::new();
        let mut clauses = Vec::new();
        let mut bind = |v: Box<dyn ToSql + Send + Sync>| {
            params.push(v);
            format!("${}", params.len())
        };
        if let Some((at, id)) = &q.cursor {
            let p = bind(Box::new(*at));
            let id = bind(Box::new(String::from_utf16_lossy(id)));
            // `at` is integral. A fractional cursor cannot tie an integer row.
            clauses.push(format!("(at < ceil({p}::float8)::bigint OR (at = floor({p}::float8)::bigint AND floor({p}::float8) = {p} AND id < {id}))"));
        }
        for (column, v) in [
            ("state", &q.state),
            ("resolved_provider", &q.provider),
            ("api_key_id", &q.api_key_id),
            ("credential_id", &q.credential_id),
        ] {
            if let Some(v) = v {
                clauses.push(format!("{column} = {}", bind(Box::new(v.clone()))));
            }
        }
        for (column, v) in [
            ("requested_model", &q.requested_model),
            ("resolved_model", &q.resolved_model),
            ("error_code", &q.error_code),
            ("", &q.model),
        ] {
            if let Some(v) = v {
                let p = bind(Box::new(format!("%{}%", crate::logs::escape_like(v))));
                if column.is_empty() {
                    clauses.push(format!("(requested_model ILIKE {p} ESCAPE '\\' OR resolved_model ILIKE {p} ESCAPE '\\')"));
                } else {
                    clauses.push(format!("{column} ILIKE {p} ESCAPE '\\'"));
                }
            }
        }
        for (op, round, v) in [(">=", "ceil", q.since), ("<=", "floor", q.until)] {
            if let Some(v) = v {
                clauses.push(format!(
                    "at {op} {round}({}::float8)::bigint",
                    bind(Box::new(v))
                ));
            }
        }
        if q.failed {
            clauses.push("state = 'done' AND status >= 400".into());
        }
        let filter = if clauses.is_empty() {
            String::new()
        } else {
            format!("WHERE {}", clauses.join(" AND "))
        };
        let limit = bind(Box::new(
            i64::try_from(q.limit.saturating_add(1)).unwrap_or(i64::MAX),
        ));
        let sql = format!("SELECT json_build_object(
            'id', id, 'state', CASE WHEN state = 'pending' THEN 'pending' ELSE 'done' END,
            'at', at, 'apiKeyId', api_key_id, 'requestedModel', requested_model,
            'resolvedProvider', resolved_provider, 'resolvedModel', resolved_model,
            'credentialId', credential_id, 'attempts', attempts, 'status', status,
            'errorCode', error_code, 'inputTokens', input_tokens, 'outputTokens', output_tokens,
            'cacheReadTokens', cache_read_tokens, 'cacheWriteTokens', cache_write_tokens,
            'ttftMs', ttft_ms, 'durationMs', duration_ms, 'costUsd', cost_usd,
            'degradations', degradations::json, 'rtkApplied', rtk_applied, 'rtkFilterHits', rtk_filter_hits,
            'rtkOriginalCodeUnits', rtk_original_code_units, 'rtkCompressedCodeUnits', rtk_compressed_code_units,
            'rtkEstimatedTokensSaved', rtk_estimated_tokens_saved)::text, rtk_filters
            FROM request_logs {filter} ORDER BY at DESC, id DESC LIMIT {limit}");
        let c = self.client().await?;
        let params: Vec<&(dyn ToSql + Sync)> =
            params.iter().map(|p| &**p as &(dyn ToSql + Sync)).collect();
        c.query(&sql, &params)
            .await?
            .into_iter()
            .map(|row| {
                let raw: String = row.try_get(0)?;
                let mut value = parse_js(&raw)
                    .map_err(|_| StoreError::Refused("invalid request log projection".into()))?;
                if let JsValue::Object(fields) = &mut value {
                    let rtks: String = row.try_get(1)?;
                    fields.push((
                        "rtkFilters".encode_utf16().collect(),
                        JsValue::Array(
                            crate::maintenance::rtk_filters(&rtks)
                                .into_iter()
                                .map(|s| JsValue::String(s.encode_utf16().collect()))
                                .collect(),
                        ),
                    ));
                }
                Ok(value)
            })
            .collect()
    }
}

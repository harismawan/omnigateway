//! Aggregate on the bounded report connection; encode each row as it arrives.
use crate::{
    StoreError,
    reports::{MEASURES, UsageQuery, dimension},
};
use futures_util::TryStreamExt as _;
use omni_ir::jsjson::{write_number, write_str};
use tokio_postgres::types::ToSql;

impl super::PgStore {
    pub async fn usage_json(&self, q: UsageQuery<'_>, out: &mut String) -> Result<(), StoreError> {
        let UsageQuery {
            daily,
            key,
            split,
            mut since,
            until,
            api_key,
            credential,
        } = q;
        if !std::iter::once(key)
            .chain(split)
            .all(|c| dimension(c, daily))
        {
            return Err(StoreError::Refused("invalid usage dimension".into()));
        }
        let expression = |c| {
            if c == "CAST(at / 3600000 AS INTEGER)" {
                "at / 3600000"
            } else {
                c
            }
        };
        let key = expression(key);
        let split = split.map(expression);
        if daily {
            #[allow(clippy::cast_precision_loss)]
            let offset = self.day_offset_minutes() as f64 * 60_000.0;
            since = ((since + offset) / 86_400_000.0).floor() * 86_400_000.0 - offset;
        }
        let mut params: Vec<&(dyn ToSql + Sync)> = vec![&since, &until];
        let mut filters = String::new();
        for (col, value) in [("api_key_id", &api_key), ("credential_id", &credential)] {
            if let Some(value) = value {
                params.push(value);
                use std::fmt::Write as _;
                write!(filters, " AND {col} = ${}", params.len()).expect("string");
            }
        }
        let (table, day, done, requests, errors, duration, saved, applied) = if daily {
            (
                "usage_daily",
                "day",
                "",
                "SUM(requests)",
                "SUM(errors)",
                "SUM(duration_ms_sum)",
                "rtk_saved_tokens",
                "rtk_applied_requests",
            )
        } else {
            (
                "request_logs",
                "at",
                "state = 'done' AND ",
                "COUNT(*)",
                "COUNT(*) FILTER (WHERE status >= 400)",
                "SUM(duration_ms)",
                "rtk_estimated_tokens_saved",
                "rtk_applied::int",
            )
        };
        let sql = format!("SELECT ({key})::text, ({})::text,
            COALESCE({requests},0)::float8, COALESCE({errors},0)::float8, COALESCE({duration},0)::float8,
            COALESCE(SUM(input_tokens),0)::float8, COALESCE(SUM(output_tokens),0)::float8,
            COALESCE(SUM(cache_read_tokens),0)::float8, COALESCE(SUM(cache_write_tokens),0)::float8,
            COALESCE(SUM({saved}),0)::float8, COALESCE(SUM({applied}),0)::float8, COALESCE(SUM(cost_usd),0)::float8
            FROM {table} WHERE {done}{day} >= ceil($1::float8)::bigint AND {day} <= floor($2::float8)::bigint{filters}
            GROUP BY {key}{} ORDER BY 3 DESC", split.unwrap_or("NULL"), split.map(|s| format!(", {s}")).unwrap_or_default());
        let c = self.client().await?;
        let stmt = c.prepare_cached(&sql).await?;
        let rows = c.query_raw(&stmt, params).await?;
        tokio::pin!(rows);
        out.push('[');
        let mut first = true;
        while let Some(row) = rows.try_next().await? {
            if !first {
                out.push(',');
            }
            first = false;
            let label = |i: usize| -> Result<&str, StoreError> {
                Ok(row
                    .try_get::<_, Option<&str>>(i)?
                    .filter(|s| !s.is_empty())
                    .unwrap_or("unknown"))
            };
            out.push_str("{\"key\":");
            write_str(label(0)?, out);
            for (name, col) in MEASURES {
                out.push_str(",\"");
                out.push_str(name);
                out.push_str("\":");
                write_number(row.try_get(col)?, out);
            }
            if split.is_some() {
                out.push_str(",\"split\":");
                write_str(label(1)?, out);
            }
            out.push('}');
        }
        out.push(']');
        Ok(())
    }
}

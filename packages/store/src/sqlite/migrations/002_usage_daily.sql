-- Pre-aggregated request counters, one row per day and dimension tuple.
--
-- `request_logs` is pruned at the configured retention (30 days by default), so
-- it cannot answer "what did the last year look like". This table is written in
-- the same transaction as the log row and is pruned on a far longer horizon, so
-- the console can draw a year of activity without keeping a year of raw rows.
--
-- `day` is the epoch of the *host's local* midnight, fixed at write time: daily
-- rows cannot be re-bucketed into another timezone after the fact.
--
-- The key columns are NOT NULL with an empty-string sentinel rather than
-- nullable, because a WITHOUT ROWID primary key treats NULLs as distinct and a
-- credential-less request would then get one row per insert.
CREATE TABLE usage_daily (
  day                INTEGER NOT NULL,
  provider           TEXT NOT NULL DEFAULT '',
  credential_id      TEXT NOT NULL DEFAULT '',
  requested_model    TEXT NOT NULL DEFAULT '',
  resolved_model     TEXT NOT NULL DEFAULT '',
  api_key_id         TEXT NOT NULL DEFAULT '',
  requests           INTEGER NOT NULL DEFAULT 0,
  errors             INTEGER NOT NULL DEFAULT 0,
  input_tokens       INTEGER NOT NULL DEFAULT 0,
  output_tokens      INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd           REAL NOT NULL DEFAULT 0,
  duration_ms_sum    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, provider, credential_id, requested_model, resolved_model, api_key_id)
) WITHOUT ROWID;

CREATE INDEX idx_usage_daily_day ON usage_daily (day);

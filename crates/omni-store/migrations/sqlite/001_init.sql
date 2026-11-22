CREATE TABLE credentials (
  id             TEXT PRIMARY KEY,
  provider       TEXT NOT NULL,
  label          TEXT NOT NULL,
  auth_type      TEXT NOT NULL,
  enabled        INTEGER NOT NULL DEFAULT 1,
  tier           INTEGER NOT NULL DEFAULT 1,
  weight         REAL NOT NULL DEFAULT 1.0,
  expires_at     INTEGER,
  account_email  TEXT,
  provider_data  TEXT NOT NULL DEFAULT '{}',
  access_token   TEXT,
  refresh_token  TEXT,
  api_key        TEXT,
  id_token       TEXT,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE INDEX idx_credentials_provider ON credentials (provider, enabled);

CREATE TABLE credential_health (
  credential_id        TEXT NOT NULL REFERENCES credentials (id) ON DELETE CASCADE,
  model                TEXT NOT NULL,
  breaker_state        TEXT NOT NULL DEFAULT 'closed',
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  opened_at            INTEGER,
  rate_limited_until   INTEGER,
  ewma_ttft_ms         REAL,
  last_used_at         INTEGER,
  PRIMARY KEY (credential_id, model)
);

CREATE TABLE quota_windows (
  credential_id TEXT NOT NULL REFERENCES credentials (id) ON DELETE CASCADE,
  window_type   TEXT NOT NULL,
  starts_at     INTEGER NOT NULL,
  used          INTEGER NOT NULL DEFAULT 0,
  limit_value   INTEGER,
  PRIMARY KEY (credential_id, window_type)
);

CREATE TABLE virtual_models (
  id        TEXT PRIMARY KEY,
  targets   TEXT NOT NULL,
  strategy  TEXT NOT NULL DEFAULT 'score',
  is_alias  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE api_keys (
  id                 TEXT PRIMARY KEY,
  label              TEXT NOT NULL,
  prefix             TEXT NOT NULL,
  hash               TEXT NOT NULL UNIQUE,
  model_allowlist    TEXT,
  rate_limit_per_min INTEGER,
  created_at         INTEGER NOT NULL,
  revoked_at         INTEGER
);
CREATE INDEX idx_api_keys_hash ON api_keys (hash);

CREATE TABLE request_logs (
  id                 TEXT PRIMARY KEY,
  at                 INTEGER NOT NULL,
  api_key_id         TEXT,
  requested_model    TEXT NOT NULL,
  resolved_provider  TEXT,
  resolved_model     TEXT,
  credential_id      TEXT,
  attempts           INTEGER NOT NULL DEFAULT 1,
  status             INTEGER NOT NULL,
  error_code         TEXT,
  input_tokens       INTEGER NOT NULL DEFAULT 0,
  output_tokens      INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  ttft_ms            INTEGER,
  duration_ms        INTEGER NOT NULL,
  cost_usd           REAL NOT NULL DEFAULT 0,
  degradations       TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX idx_request_logs_at ON request_logs (at DESC);
CREATE INDEX idx_request_logs_cred ON request_logs (credential_id, at DESC);

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

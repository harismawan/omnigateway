-- The SQLite schema as it stands after its migrations 001 through 012, written
-- once. This track is numbered from 001 on its own and never shares a number
-- with the SQLite one: a Postgres install has no history to walk forward, so
-- the reasoning each SQLite migration recorded is kept beside the column it
-- produced, and the ALTERs are not replayed.
--
-- Types, stated once. Every timestamp is epoch milliseconds in a BIGINT, as
-- SQLite's INTEGER held it. Every flag is BOOLEAN where SQLite stored 0/1; the
-- repos map both to the same TypeScript shape. Counters that accumulate —
-- tokens, durations, rollup sums — are BIGINT because SQLite's INTEGER is
-- 64-bit and a per-key yearly token sum outgrows int4. Small enumerations
-- (tier, attempts, status, versions) stay INTEGER.

CREATE TABLE credentials (
  id              TEXT PRIMARY KEY,
  provider        TEXT NOT NULL,
  label           TEXT NOT NULL,
  auth_type       TEXT NOT NULL,
  enabled         BOOLEAN NOT NULL DEFAULT TRUE,
  tier            INTEGER NOT NULL DEFAULT 1,
  weight          DOUBLE PRECISION NOT NULL DEFAULT 1.0,
  expires_at      BIGINT,
  account_email   TEXT,
  provider_data   TEXT NOT NULL DEFAULT '{}',
  -- A disabled credential is either the operator's decision or the provider's.
  -- Without this the console cannot tell the two apart, and an account whose
  -- refresh token was repudiated looks exactly like one somebody switched off.
  disabled_reason TEXT,
  disabled_at     BIGINT,
  access_token    TEXT,
  refresh_token   TEXT,
  api_key         TEXT,
  id_token        TEXT,
  created_at      BIGINT NOT NULL,
  updated_at      BIGINT NOT NULL,
  -- Compare-and-swap for token material. Two processes refreshing one
  -- credential at once must not both write: the second write would carry a
  -- rotation the provider already invalidated. The refresher passes the version
  -- it read, and a write whose version has moved is refused rather than applied.
  token_version   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_credentials_provider ON credentials (provider, enabled);

CREATE TABLE credential_health (
  credential_id        TEXT NOT NULL REFERENCES credentials (id) ON DELETE CASCADE,
  model                TEXT NOT NULL,
  breaker_state        TEXT NOT NULL DEFAULT 'closed',
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  opened_at            BIGINT,
  rate_limited_until   BIGINT,
  ewma_ttft_ms         DOUBLE PRECISION,
  last_used_at         BIGINT,
  PRIMARY KEY (credential_id, model)
);

-- Provider-reported quota. A row says when the window rolls over and when the
-- reading was taken: a snapshot whose `observed_at` is old is a claim about the
-- past, and the console says so rather than drawing a stale bar as if it were
-- current. `window_ms` is how long the window really runs for when the provider
-- states it; the three window names are buckets, and null means it said nothing.
CREATE TABLE quota_windows (
  credential_id TEXT NOT NULL REFERENCES credentials (id) ON DELETE CASCADE,
  window_type   TEXT NOT NULL,
  starts_at     BIGINT NOT NULL,
  used          BIGINT NOT NULL DEFAULT 0,
  limit_value   BIGINT,
  resets_at     BIGINT,
  observed_at   BIGINT NOT NULL DEFAULT 0,
  window_ms     BIGINT,
  PRIMARY KEY (credential_id, window_type)
);

-- Retained provider quota readings. `quota_windows` is overwritten in place, so
-- every reading is lost the moment the next probe lands; this table keeps them.
-- `observed_at` is part of the key: a reading is identified by which window it
-- describes and when it was taken. No window-set replacement here as there is
-- for `quota_windows` — a window the provider stopped reporting still happened.
CREATE TABLE quota_samples (
  credential_id TEXT NOT NULL REFERENCES credentials (id) ON DELETE CASCADE,
  window_type   TEXT NOT NULL,
  observed_at   BIGINT NOT NULL,
  used          BIGINT NOT NULL,
  limit_value   BIGINT,
  resets_at     BIGINT,
  window_ms     BIGINT,
  PRIMARY KEY (credential_id, window_type, observed_at)
);
-- On `observed_at` alone, because pruning sweeps every credential at once and
-- the primary key already serves a lookup that names one.
CREATE INDEX quota_samples_observed ON quota_samples (observed_at);

CREATE TABLE virtual_models (
  id        TEXT PRIMARY KEY,
  targets   TEXT NOT NULL,
  strategy  TEXT NOT NULL DEFAULT 'score',
  is_alias  BOOLEAN NOT NULL DEFAULT FALSE
);

-- `limits` is a sparse `(dimension, window)` matrix as JSON text, and its keys
-- are a storage contract in the same class as RTK filter ids: an unknown key is
-- a parse failure, never "no limit". `NOT NULL DEFAULT '{}'` so "unlimited" has
-- exactly one spelling at the column level.
--
-- `body_logging_opt_out` is per-key suppression, checked before any capture
-- work begins; the default keeps every key on the installation-wide setting,
-- which is itself off by default.
CREATE TABLE api_keys (
  id                   TEXT PRIMARY KEY,
  label                TEXT NOT NULL,
  prefix               TEXT NOT NULL,
  hash                 TEXT NOT NULL UNIQUE,
  model_allowlist      TEXT,
  limits               TEXT NOT NULL DEFAULT '{}',
  body_logging_opt_out BOOLEAN NOT NULL DEFAULT FALSE,
  created_at           BIGINT NOT NULL,
  revoked_at           BIGINT
);
CREATE INDEX idx_api_keys_hash ON api_keys (hash);

-- One row per request, written twice: `pending` when dispatch starts, `done`
-- when it finishes. `status` and `duration_ms` stay NOT NULL; a pending row's
-- zeros are never read, and readers key off `state` alone.
--
-- `node_id` names the process that owns a pending row; `nodes` says who is
-- still here. `DEFAULT ''` rather than NULL: an owner nothing heartbeats for is
-- exactly a dead one.
CREATE TABLE request_logs (
  id                         TEXT PRIMARY KEY,
  state                      TEXT NOT NULL DEFAULT 'done',
  node_id                    TEXT NOT NULL DEFAULT '',
  at                         BIGINT NOT NULL,
  api_key_id                 TEXT,
  requested_model            TEXT NOT NULL,
  resolved_provider          TEXT,
  resolved_model             TEXT,
  credential_id              TEXT,
  attempts                   INTEGER NOT NULL DEFAULT 1,
  status                     INTEGER NOT NULL,
  error_code                 TEXT,
  input_tokens               BIGINT NOT NULL DEFAULT 0,
  output_tokens              BIGINT NOT NULL DEFAULT 0,
  cache_read_tokens          BIGINT NOT NULL DEFAULT 0,
  cache_write_tokens         BIGINT NOT NULL DEFAULT 0,
  ttft_ms                    BIGINT,
  duration_ms                BIGINT NOT NULL,
  cost_usd                   DOUBLE PRECISION NOT NULL DEFAULT 0,
  degradations               TEXT NOT NULL DEFAULT '[]',
  rtk_applied                BOOLEAN NOT NULL DEFAULT FALSE,
  rtk_filter_hits            BIGINT NOT NULL DEFAULT 0,
  rtk_original_code_units    BIGINT NOT NULL DEFAULT 0,
  rtk_compressed_code_units  BIGINT NOT NULL DEFAULT 0,
  rtk_estimated_tokens_saved BIGINT NOT NULL DEFAULT 0,
  rtk_filters                TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX idx_request_logs_at ON request_logs (at DESC);
CREATE INDEX idx_request_logs_cred ON request_logs (credential_id, at DESC);
-- Partial, because pending rows are a handful at any moment while the table
-- holds a month of finished ones.
CREATE INDEX idx_request_logs_pending ON request_logs (state) WHERE state = 'pending';
-- Correctness-adjacent, not an optimisation. A sliding weekly sum for one key
-- against `idx_request_logs_at` scans every row in the week for every key on
-- the install, and that scan sits on the request hot path. Composite order
-- matters: `(api_key_id, at DESC)` lets the range scan start at the key.
CREATE INDEX idx_request_logs_key_at ON request_logs (api_key_id, at DESC);

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Pre-aggregated request counters, one row per day and dimension tuple, so the
-- console can draw a year of activity without keeping a year of raw rows.
--
-- `day` is the epoch of the *host's local* midnight, fixed at write time: daily
-- rows cannot be re-bucketed into another timezone after the fact.
--
-- The key columns are NOT NULL with an empty-string sentinel rather than
-- nullable, because a primary key treats NULLs as distinct and a
-- credential-less request would then get one row per insert.
CREATE TABLE usage_daily (
  day                  BIGINT NOT NULL,
  provider             TEXT NOT NULL DEFAULT '',
  credential_id        TEXT NOT NULL DEFAULT '',
  requested_model      TEXT NOT NULL DEFAULT '',
  resolved_model       TEXT NOT NULL DEFAULT '',
  api_key_id           TEXT NOT NULL DEFAULT '',
  requests             BIGINT NOT NULL DEFAULT 0,
  errors               BIGINT NOT NULL DEFAULT 0,
  input_tokens         BIGINT NOT NULL DEFAULT 0,
  output_tokens        BIGINT NOT NULL DEFAULT 0,
  cache_read_tokens    BIGINT NOT NULL DEFAULT 0,
  cache_write_tokens   BIGINT NOT NULL DEFAULT 0,
  rtk_saved_tokens     BIGINT NOT NULL DEFAULT 0,
  rtk_applied_requests BIGINT NOT NULL DEFAULT 0,
  cost_usd             DOUBLE PRECISION NOT NULL DEFAULT 0,
  duration_ms_sum      BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (day, provider, credential_id, requested_model, resolved_model, api_key_id)
);
CREATE INDEX idx_usage_daily_day ON usage_daily (day);

-- Per-key hourly counters, so a long sliding window is read rather than
-- scanned. Derived: `request_logs` stays the source of truth and every figure
-- here is reproducible from it by one grouped select — there is a rebuild, a
-- restore that runs it, and a `doctor` check that compares the two.
--
-- `hour` is `at / 3600000`, floored. `api_key_id` is NOT NULL and anonymous
-- rows are left out: nothing reads this table except a per-key lookup that could
-- never match one.
CREATE TABLE usage_rollup (
  api_key_id         TEXT NOT NULL,
  hour               BIGINT NOT NULL,
  requests           BIGINT NOT NULL DEFAULT 0,
  input_tokens       BIGINT NOT NULL DEFAULT 0,
  output_tokens      BIGINT NOT NULL DEFAULT 0,
  cache_read_tokens  BIGINT NOT NULL DEFAULT 0,
  cache_write_tokens BIGINT NOT NULL DEFAULT 0,
  cost_usd           DOUBLE PRECISION NOT NULL DEFAULT 0,
  PRIMARY KEY (api_key_id, hour)
);

-- Captured request and response bodies. Unlike the SQLite store, the bytes
-- live here rather than in a file tree: there is no directory beside a
-- Postgres database for them to live in, and a bytea column rides pg_dump with
-- everything else. The envelope is byte-identical to the file the SQLite store
-- writes — encrypted under the same key, digested as ciphertext — so `sha256`
-- still detects truncation without `OMNI_ENCRYPTION_KEY`, and `detail_state`
-- keeps its four values (`none`, `ready`, `missing`, `corrupt`) so a reader
-- renders the same states. `rel_path` is kept as the artifact's name so the row
-- reads back with the same shape; nothing on disk answers to it.
--
-- No foreign key to `request_logs`, for the reason the SQLite migration gives:
-- expiry is performed explicitly, deleting bytes and row together.
CREATE TABLE request_bodies (
  request_id   TEXT PRIMARY KEY,
  at           BIGINT NOT NULL,
  rel_path     TEXT,
  size_bytes   BIGINT NOT NULL DEFAULT 0,
  sha256       TEXT,
  detail_state TEXT NOT NULL DEFAULT 'none',
  truncated    BOOLEAN NOT NULL DEFAULT FALSE,
  bytes        BYTEA
);
CREATE INDEX idx_request_bodies_at ON request_bodies (at DESC);

-- The plugin migration ledger, kept deliberately apart from core's
-- `migrations`: a plugin's version 1 is its own version 1 forever, and core's
-- next number is unaffected by how many any plugin ships. No cascade and no
-- row for the plugin's tables — see `PluginRepo.dropAll` and `orphanTables`.
CREATE TABLE plugin_migrations (
  plugin_id  TEXT NOT NULL,
  version    INTEGER NOT NULL,
  applied_at BIGINT NOT NULL,
  PRIMARY KEY (plugin_id, version)
);

-- Which processes are alive. A row not seen within `NODE_GRACE_MS` is dead,
-- and its pending rows are what a sweep may retire.
CREATE TABLE nodes (
  id      TEXT PRIMARY KEY,
  seen_at BIGINT NOT NULL
);

-- What `PRAGMA data_version` gave the SQLite store: a counter that moves when
-- another connection commits a change routing might care about. One row,
-- bumped by a statement-level trigger on every table `buildSnapshot` reads
-- (and `api_keys`, which key policy reads the same way), so a replica can ask
-- "has anyone changed the configuration" with one indexed read rather than
-- five table scans.
CREATE TABLE config_version (
  id      INTEGER PRIMARY KEY CHECK (id = 1),
  version BIGINT NOT NULL DEFAULT 0
);
INSERT INTO config_version (id, version) VALUES (1, 0);

CREATE FUNCTION bump_config_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE config_version SET version = version + 1 WHERE id = 1;
  RETURN NULL;
END
$$;

CREATE TRIGGER credentials_config_version
  AFTER INSERT OR UPDATE OR DELETE ON credentials
  FOR EACH STATEMENT EXECUTE FUNCTION bump_config_version();
CREATE TRIGGER credential_health_config_version
  AFTER INSERT OR UPDATE OR DELETE ON credential_health
  FOR EACH STATEMENT EXECUTE FUNCTION bump_config_version();
CREATE TRIGGER quota_windows_config_version
  AFTER INSERT OR UPDATE OR DELETE ON quota_windows
  FOR EACH STATEMENT EXECUTE FUNCTION bump_config_version();
CREATE TRIGGER virtual_models_config_version
  AFTER INSERT OR UPDATE OR DELETE ON virtual_models
  FOR EACH STATEMENT EXECUTE FUNCTION bump_config_version();
CREATE TRIGGER settings_config_version
  AFTER INSERT OR UPDATE OR DELETE ON settings
  FOR EACH STATEMENT EXECUTE FUNCTION bump_config_version();
CREATE TRIGGER api_keys_config_version
  AFTER INSERT OR UPDATE OR DELETE ON api_keys
  FOR EACH STATEMENT EXECUTE FUNCTION bump_config_version();

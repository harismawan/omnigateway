-- Retained provider quota readings, and the duration a window really runs for.
--
-- `quota_windows` is keyed (credential_id, window_type) and overwritten in
-- place, so every reading is lost the moment the next probe lands. That is
-- enough to draw a bar and to price a route against, and not enough to answer
-- "is this draining faster than usual". This table keeps the readings.
--
-- `observed_at` is part of the key rather than a plain column: a reading is
-- identified by which window it describes and when it was taken, and two
-- readings of the same window at the same instant are the same reading.
-- WITHOUT ROWID for the same reason as `usage_daily` — the key is the whole
-- row's identity, so a separate rowid buys nothing and costs a second b-tree.
--
-- There is no window-set replacement here as there is for `quota_windows`. A
-- window the provider stopped reporting still happened, and its history stays
-- readable until it ages out. Rows die two ways: the credential is deleted, or
-- retention prunes them.
--
-- No backfill: there is no history to recover.
CREATE TABLE quota_samples (
  credential_id TEXT NOT NULL REFERENCES credentials (id) ON DELETE CASCADE,
  window_type   TEXT NOT NULL,
  observed_at   INTEGER NOT NULL,
  used          INTEGER NOT NULL,
  limit_value   INTEGER,
  resets_at     INTEGER,
  window_ms     INTEGER,
  PRIMARY KEY (credential_id, window_type, observed_at)
) WITHOUT ROWID;

-- On `observed_at` alone, because pruning sweeps every credential at once and
-- the primary key already serves a lookup that names one.
CREATE INDEX quota_samples_observed ON quota_samples (observed_at);

-- How long the window runs for, when the provider states it.
--
-- The three window names are buckets: Codex declares `limit_window_seconds` and
-- the nearest of the three names is what gets stored, so a three-hour window is
-- filed under `fiveHour`. Inferring its start from the nominal five hours would
-- place it about two hours too early. Null means the provider said nothing,
-- which is the normal state for Anthropic and Kimi.
ALTER TABLE quota_windows ADD COLUMN window_ms INTEGER;

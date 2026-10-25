-- The Postgres half of the sqlite migration `022_log_export.sql`, plus the
-- runtime state table that SQLite keeps in its separate `export.db`. Design:
-- docs/superpowers/specs/2026-10-24-log-export-design.md (*Cursor*,
-- *Destination*).
--
-- `completed_at` is stamped from the database clock, not a replica's, so every
-- writer shares one clock and the cursor orders their rows consistently.
ALTER TABLE request_logs ADD COLUMN completed_at BIGINT;
UPDATE request_logs SET completed_at = at + duration_ms WHERE state = 'done';
CREATE INDEX idx_request_logs_completed ON request_logs (completed_at, id);

-- Configuration, written by the admin API alone. Deliberately **no**
-- `bump_config_version` trigger: nothing routing reads lives here, and a change
-- must not invalidate every replica's routing snapshot.
CREATE TABLE export_destinations (
  id                TEXT PRIMARY KEY,
  generation        TEXT NOT NULL UNIQUE,
  type              TEXT NOT NULL,
  enabled           BOOLEAN NOT NULL DEFAULT TRUE,
  config            TEXT NOT NULL DEFAULT '{}',
  secret            TEXT,
  filter            TEXT NOT NULL DEFAULT '{}',
  include_bodies    BOOLEAN NOT NULL DEFAULT FALSE,
  max_request_bytes BIGINT,
  start_at          BIGINT NOT NULL,
  created_at        BIGINT NOT NULL,
  updated_at        BIGINT NOT NULL
);

-- Runtime state, one row per destination generation, written only by the
-- export worker under its epoch fence. Also no `bump_config_version` trigger,
-- and for a stronger reason: the worker writes it on every batch. Not carried
-- by snapshots; a restored destination resumes from its own generation's row,
-- or from `start_at` when there is none. `orphaned_at` is when the worker first
-- found no destination with this generation (cleared if one reappears); the row
-- is deleted 7 days after it, long enough to survive restoring a recent
-- snapshot. Schema and SQL shared with SQLite's `export.db`:
-- `apps/gateway/src/export/state/`.
CREATE TABLE export_state (
  generation                TEXT PRIMARY KEY,
  cursor_at                 BIGINT NOT NULL,
  cursor_id                 TEXT NOT NULL DEFAULT '',
  epoch                     BIGINT NOT NULL DEFAULT 0,
  last_success_at           BIGINT,
  last_error                TEXT,
  last_error_at             BIGINT,
  exported_total            BIGINT NOT NULL DEFAULT 0,
  dropped_total             BIGINT NOT NULL DEFAULT 0,
  caught_up_through         BIGINT NOT NULL DEFAULT 0,
  seen_retention_lowered_at BIGINT NOT NULL DEFAULT 0,
  gap_possible_at           BIGINT,
  skip_requested_at         BIGINT,
  orphaned_at               BIGINT
);

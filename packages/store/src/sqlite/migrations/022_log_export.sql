-- Log export, part 1: the completion cursor and destination configuration.
-- Design: docs/superpowers/specs/2026-10-24-log-export-design.md (*Cursor*,
-- *Destination*).
--
-- `completed_at` is when a row became `done`, stamped by the store in the
-- statement that completes it (`usage.append`, `sweepPending`). `at` is when the
-- request *started*, so a cursor on it would pass a long stream that finishes
-- after shorter, later requests and never come back for it.
ALTER TABLE request_logs ADD COLUMN completed_at INTEGER;
-- Every completed row gets one, so pre-upgrade history sits on the same cursor
-- and a destination created with `startFrom: "oldest"` exports it. A pending row
-- stays NULL until its completion stamps it. Runs once, at boot, before serving.
UPDATE request_logs SET completed_at = at + duration_ms WHERE state = 'done';
CREATE INDEX idx_request_logs_completed ON request_logs (completed_at, id);

-- Configuration only, written by the admin API. Runtime state (cursor, epoch,
-- counters) is not here: on SQLite it lives in a separate `export.db` that only
-- the export worker opens, so worker writes never contend with this file.
--
-- `generation` is minted at creation and never changes; state is keyed by it,
-- so a deleted-and-recreated slug starts fresh. `secret` is an `enc:v1` envelope
-- from `encryption.ts`, never plaintext. `start_at` is fixed at creation: now
-- for `startFrom: "now"`, 0 for `"oldest"`.
CREATE TABLE export_destinations (
  id                TEXT PRIMARY KEY,
  generation        TEXT NOT NULL UNIQUE,
  type              TEXT NOT NULL,
  enabled           INTEGER NOT NULL DEFAULT 1,
  config            TEXT NOT NULL DEFAULT '{}',
  secret            TEXT,
  filter            TEXT NOT NULL DEFAULT '{}',
  include_bodies    INTEGER NOT NULL DEFAULT 0,
  max_request_bytes INTEGER,
  start_at          INTEGER NOT NULL,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);

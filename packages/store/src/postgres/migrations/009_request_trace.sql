-- The Postgres half of the sqlite migration `021_request_trace.sql`: caller-
-- supplied grouping on each request-log row. Design:
-- docs/superpowers/specs/2026-10-24-request-traceability-design.md.
--
-- Nullable or empty-default, no backfill. Safe under a rolling deploy: added
-- columns with defaults and nothing dropped, so a replica on the previous image
-- keeps inserting (its inserts name their columns) and never reads these.
ALTER TABLE request_logs ADD COLUMN session_id TEXT;
ALTER TABLE request_logs ADD COLUMN turn_id TEXT;
ALTER TABLE request_logs ADD COLUMN agent TEXT;
ALTER TABLE request_logs ADD COLUMN tags TEXT NOT NULL DEFAULT '[]';
ALTER TABLE request_logs ADD COLUMN trace_metadata TEXT NOT NULL DEFAULT '{}';
ALTER TABLE request_logs ADD COLUMN client_request_id TEXT;
ALTER TABLE request_logs ADD COLUMN upstream_request_id TEXT;
CREATE INDEX idx_request_logs_session ON request_logs (session_id, at DESC) WHERE session_id IS NOT NULL;
CREATE INDEX idx_request_logs_key_session ON request_logs (api_key_id, session_id) WHERE session_id IS NOT NULL;

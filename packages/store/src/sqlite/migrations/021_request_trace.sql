-- Request traceability: who a request belongs to, as far as its caller said.
-- Design: docs/superpowers/specs/2026-10-24-request-traceability-design.md.
--
-- Every column is caller-supplied grouping, bounded at ingress
-- (`apps/gateway/src/trace/extract.ts`). Nullable (or an empty JSON default)
-- with no backfill: rows written before this migration carry no trace, and
-- inventing one would attribute old traffic to sessions it never belonged to.
-- Safe on rollback: an older build never reads the columns, and its inserts
-- name their columns, so the defaults fill these in.
ALTER TABLE request_logs ADD COLUMN session_id TEXT;
ALTER TABLE request_logs ADD COLUMN turn_id TEXT;
ALTER TABLE request_logs ADD COLUMN agent TEXT;
ALTER TABLE request_logs ADD COLUMN tags TEXT NOT NULL DEFAULT '[]';
ALTER TABLE request_logs ADD COLUMN trace_metadata TEXT NOT NULL DEFAULT '{}';
ALTER TABLE request_logs ADD COLUMN client_request_id TEXT;
ALTER TABLE request_logs ADD COLUMN upstream_request_id TEXT;
-- Partial: most rows carry no session, and the session reads (the Sessions tab,
-- the session filter) never ask for rows without one.
CREATE INDEX idx_request_logs_session ON request_logs (session_id, at DESC) WHERE session_id IS NOT NULL;
CREATE INDEX idx_request_logs_key_session ON request_logs (api_key_id, session_id) WHERE session_id IS NOT NULL;

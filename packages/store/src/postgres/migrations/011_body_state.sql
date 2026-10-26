-- The Postgres half of the sqlite migration `023_body_state.sql`: whether a
-- request's body made it to the store. Design:
-- docs/superpowers/specs/2026-10-24-log-export-design.md (*Capture state on the
-- row*). No backfill — a row older than the column never had its capture
-- tracked — and no trigger: `request_logs` moves no `config_version`.
ALTER TABLE request_logs ADD COLUMN body_state TEXT;
CREATE INDEX idx_request_logs_body_pending ON request_logs (completed_at)
  WHERE body_state = 'pending';

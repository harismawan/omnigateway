-- Indexes for the keyset traversal of `request_logs`. The SQLite copy,
-- `015_log_keyset.sql`, carries the reasoning: `id` in the index is what makes
-- "the row after this one" a question with one answer when `at` repeats, and
-- the three shorter indexes are replaced rather than kept because a redundant
-- prefix costs a write per row and answers nothing the longer one does not.
DROP INDEX IF EXISTS idx_request_logs_at;
DROP INDEX IF EXISTS idx_request_logs_key_at;
DROP INDEX IF EXISTS idx_request_logs_cred;

CREATE INDEX idx_request_logs_at ON request_logs (at DESC, id DESC);
CREATE INDEX idx_request_logs_key_at ON request_logs (api_key_id, at DESC, id DESC);
CREATE INDEX idx_request_logs_cred ON request_logs (credential_id, at DESC, id DESC);

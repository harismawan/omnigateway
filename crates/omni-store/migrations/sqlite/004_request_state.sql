-- Whether a request is still running.
--
-- A row used to be written once, after the response stream drained, so a long
-- stream was invisible for its whole life and the console showed an idle
-- gateway. A row is now written twice: `pending` when dispatch starts, `done`
-- when it finishes.
--
-- Existing rows default to 'done'. Every row that predates this migration
-- describes a request that has already ended, by definition.
ALTER TABLE request_logs ADD COLUMN state TEXT NOT NULL DEFAULT 'done';

-- `status` and `duration_ms` stay NOT NULL: making them nullable means a table
-- rebuild in SQLite, and a pending row's zeros are never read. Readers key off
-- `state` alone.
--
-- Partial, because pending rows are a handful at any moment while the table
-- holds a month of finished ones.
CREATE INDEX idx_request_logs_pending ON request_logs(state) WHERE state = 'pending';

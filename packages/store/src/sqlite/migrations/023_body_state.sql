-- Log export, part 2: whether a request's body made it to the store. Design:
-- docs/superpowers/specs/2026-10-24-log-export-design.md (*Capture state on the
-- row*).
--
-- NULL — capture was not attempted; `pending` — set when the request begins (or
-- completes, for one that failed before it began) with capture on; `ready` /
-- `omitted` — written in the same transaction as the `request_bodies` pointer;
-- `failed` — the writer crashed or reported an error, or the body was still
-- pending an hour after the row completed. No backfill: a row older than this
-- column never had its capture tracked, and NULL is the honest answer for it.
ALTER TABLE request_logs ADD COLUMN body_state TEXT;
-- The hourly sweep's read: rows still pending, by completion. Partial, so it
-- holds only the handful of bodies in flight rather than the whole log.
CREATE INDEX idx_request_logs_body_pending ON request_logs (completed_at)
  WHERE body_state = 'pending';

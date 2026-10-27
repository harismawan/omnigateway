-- The hourly sweep's read for 011's column: rows whose body is still pending,
-- by completion. Partial, so it holds only the handful of bodies in flight.
--
-- Its own migration, so its transaction holds only what `CREATE INDEX` takes:
-- SHARE on `request_logs` for one scan of the table. Reads go on throughout;
-- writes — every request's `begin` and `append` — wait for that scan, once, at
-- upgrade (see docs/operations.md, *Recording bodies*). Not `CONCURRENTLY`: the
-- runner is transactional, and 009 and 010 index this table the same way.
CREATE INDEX idx_request_logs_body_pending ON request_logs (completed_at)
  WHERE body_state = 'pending';

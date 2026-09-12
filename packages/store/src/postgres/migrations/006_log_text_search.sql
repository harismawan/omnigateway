-- Re-shapes migration 005's indexes for a substring match. The SQLite copy,
-- `017_log_text_search.sql`, carries the measurement and the reasoning: a leading
-- wildcard cannot seek a B-tree, so the three per-column indexes answer none of
-- the queries they were built for and are dropped rather than left costing a
-- write per row.
--
-- **The replacement is honestly weaker here than it is there.** SQLite will test
-- the match against entries of the index it is already walking, which is what
-- buys the 2.6x measured on that side. Postgres applies a leading-wildcard
-- `ILIKE` as a filter on the heap tuple, so trailing index columns do not save
-- the fetch for a `SELECT *` the way they do in SQLite — the shape is kept so the
-- two backends carry one schema and one contract, not because the numbers
-- transfer.
--
-- What does work on this backend, when a substring miss over a large log stops
-- being acceptable, is `pg_trgm` with a GIN index. It is left out because it is
-- an extension an operator must have installed, and because SQLite's answer to
-- the same problem is a different mechanism entirely (FTS5 trigram), so adopting
-- either means the two backends stop sharing one predicate. A time bound is the
-- cheap lever on both, and it is the one already wired into every surface.
--
-- `resolved_provider` keeps its own index and its `=`: it arrives from a dropdown
-- of ids the gateway supplied, so it is never half-typed.
DROP INDEX IF EXISTS idx_request_logs_resolved_model;
DROP INDEX IF EXISTS idx_request_logs_requested_model;
DROP INDEX IF EXISTS idx_request_logs_error_code;

DROP INDEX IF EXISTS idx_request_logs_at;
CREATE INDEX idx_request_logs_at
  ON request_logs (at DESC, id DESC, requested_model, resolved_model, error_code);

-- Re-shapes migration 016's indexes for a substring match instead of an equality.
--
-- The typed filters — `requested_model`, `resolved_model`, `error_code`, and the
-- `model` filter that reads the first two — became `LIKE '%value%'`, because an
-- exact match on a name nobody recalls exactly answered "no such traffic" for
-- every spelling but one. A leading wildcard cannot seek a B-tree: there is no
-- prefix to range over, so 016's three per-column indexes now answer none of the
-- queries they were built for, and each was still costing a write per row. They
-- are dropped rather than left as ballast.
--
-- What replaces them is the same columns moved *into* the keyset index. The scan
-- is going to walk `(at DESC, id DESC)` regardless — that is where the ordering
-- comes from — and carrying the three text columns in that index lets it test
-- the match against index entries rather than fetching each row to do it. Only
-- the page that survives is fetched.
--
-- Measured at 1,000,000 rows of 300 bytes, filter matching nothing, which is the
-- case that has to scan to the end to prove it:
--
--   keyset index          model filter   error filter   head read   index size
--   (at, id)                   204.4ms        160.1ms      0.08ms        44.2MB
--   (at, id, + 3 columns)       78.3ms         33.0ms      0.08ms        87.0MB
--
-- So: 2.6x on the model filter, 4.8x on the error one, no cost to the unfiltered
-- head read every board opens with, and double the index. The size is the price
-- and it is worth naming — at a million rows this index is 87MB where the three
-- it replaces were their own 60-odd — but it is one index doing what four did,
-- and it is the only one a substring can use at all.
--
-- A second, separate covering index does **not** work: SQLite prefers the
-- narrower index that supplies the ordering and ignores the wider one, measured
-- at 198ms against 202ms. The columns have to be in the index the scan already
-- wants, which is why this replaces `idx_request_logs_at` rather than joining it.
--
-- `resolved_provider` keeps its own index from 016 and its `=`: it arrives from a
-- dropdown of ids the gateway supplied, so it is never half-typed and a
-- substring would only widen it.
--
-- Migration 016's `ANALYZE` trap is gone with the plan that had it. There is one
-- plan for a leading wildcard, so statistics have nothing to choose between:
-- measured identical, 22.5ms either way at 300,000 rows.
--
-- A time bound still collapses all of this — the same 22.5ms miss is 0.23ms with
-- `since` set to the newest 1% — because `at` still leads the index. That remains
-- the cheapest thing an operator can do, and the reason export requires both
-- bounds. If a substring miss on a very large log ever needs to be free rather
-- than linear, the next step is FTS5's trigram tokenizer, which is a shadow
-- table and a trigger to keep in sync and a `pg_trgm` GIN index to match it on
-- the other backend. Not worth it for one query per typed name, behind a
-- debounce.
DROP INDEX IF EXISTS idx_request_logs_resolved_model;
DROP INDEX IF EXISTS idx_request_logs_requested_model;
DROP INDEX IF EXISTS idx_request_logs_error_code;

DROP INDEX IF EXISTS idx_request_logs_at;
CREATE INDEX idx_request_logs_at
  ON request_logs (at DESC, id DESC, requested_model, resolved_model, error_code);

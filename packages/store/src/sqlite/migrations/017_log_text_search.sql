-- Indexes the typed log filters, which match substrings rather than values.
--
-- `requested_model`, `resolved_model`, `error_code`, and the `model` filter that
-- reads the first two, became `LIKE '%value%'`, because an exact match on a name
-- nobody recalls exactly answered "no such traffic" for every spelling but one. A
-- leading wildcard cannot seek a B-tree: there is no prefix to range over.
--
-- The three `DROP`s below are **upgrade-only cleanup and no-ops on a fresh
-- install.** An earlier draft of 016 created a per-column index for each of these
-- three filters, back when they were equalities. Nothing released ever ran it, so
-- 016 now creates only the provider index it still justifies — but a database
-- that applied the draft is carrying three indexes that can no longer be seeked
-- and still cost a write per row, so they are named here rather than left to rot.
-- Building them only to drop them cost an upgrading install 1,334ms at 1,000,000
-- rows, which is why the fix was to stop creating them rather than to keep the
-- symmetry.
--
-- What the typed filters get instead is those same columns moved *into* the keyset
-- index. The scan is going to walk `(at DESC, id DESC)` regardless — that is where
-- the ordering comes from — and carrying the three text columns in that index lets
-- it test the match against index entries rather than fetching each row to do it.
-- Only the page that survives is fetched.
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
-- and it is worth naming — at a million rows this index is 87MB against 44MB —
-- but it is one index instead of three, and it is the only shape a substring can
-- use at all.
--
-- A second, separate covering index does **not** work: SQLite prefers the
-- narrower index that supplies the ordering and ignores the wider one, measured
-- at 198ms against 202ms. The columns have to be in the index the scan already
-- wants, which is why this replaces `idx_request_logs_at` rather than joining it.
--
-- `resolved_provider` keeps 016's index and its `=`: it arrives from a dropdown
-- of ids the gateway supplied, so it is never half-typed, a substring would only
-- widen it, and an equality can still seek — which is worth 84ms to 0 on a
-- provider with no traffic.
--
-- The `ANALYZE` trap an earlier draft of 016 documented is gone with the plan
-- that had it. There is one plan for a leading wildcard, so statistics have
-- nothing to choose between: measured identical, 22.5ms either way at 300,000
-- rows.
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

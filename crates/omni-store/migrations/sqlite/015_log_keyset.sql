-- Indexes for the keyset traversal of `request_logs`.
--
-- Ordering by `at DESC, id DESC` is what makes a page boundary exact: `at`
-- repeats within a millisecond, so an index on `at` alone leaves SQLite to
-- resolve the tie however the scan happens to reach it, and the resolution can
-- differ between two reads of the same table. The `id` column in the index is
-- therefore not a tie-break for display — it is what makes "the row after this
-- one" a question with one answer.
--
-- Each of the three replaces a shorter index with the same leading columns, so
-- they are dropped rather than kept beside the new ones. A redundant prefix
-- index costs a write on every row inserted and answers no query the longer one
-- does not: `(at DESC, id DESC)` seeks and scans exactly as `(at DESC)` did for
-- every reader that never mentions `id`, including `prune`'s range delete and
-- `aggregate`'s window.
--
-- The key and credential indexes are the two scoped reads that must stay
-- bounded. `api_key_id` is every client page and every scoped operator read,
-- and it is also the sliding-window limiter's edge scan, which runs on the
-- request hot path. `credential_id` is `lastUsedByCredential` — one seek to a
-- head — and the account investigation an operator reaches for first.
--
-- Deliberately no index for `provider`, `resolved_model`, `state` or
-- `error_code`. One index per filter is a combinatorial answer to a question
-- nobody has measured yet, paid for on every insert; the cursor and the time
-- bounds already keep a filtered page's scan to the rows above it. A production
-- measurement of the query distribution is what should buy the next index.
DROP INDEX IF EXISTS idx_request_logs_at;
DROP INDEX IF EXISTS idx_request_logs_key_at;
DROP INDEX IF EXISTS idx_request_logs_cred;

CREATE INDEX idx_request_logs_at ON request_logs (at DESC, id DESC);
CREATE INDEX idx_request_logs_key_at ON request_logs (api_key_id, at DESC, id DESC);
CREATE INDEX idx_request_logs_cred ON request_logs (credential_id, at DESC, id DESC);

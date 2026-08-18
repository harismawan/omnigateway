-- Per-key hourly counters, so a long sliding window is read rather than scanned.
--
-- `sumSince` is on the admission path of every request, and `bun:sqlite` is
-- synchronous: a `SELECT SUM` over a week of one key's rows blocks the entire
-- event loop for its duration — `/health`, `/api/*`, the quiesce latch, and
-- every other key's traffic with it. Measured on one machine, one key, WAL:
-- 149ms at 0.2M rows in the window, 2.1s at 2M, 10.8s at 8M. The cost is
-- O(accumulated history) and has no ceiling, and the eager-refresh rule makes it
-- worst exactly when a key is busiest — a key inside the last tenth of a long
-- ceiling reads through on every admission. The same reads against this table
-- are flat at ~0.017ms, because a week is 168 buckets however much traffic each
-- one summarises.
--
-- This reverses the design's own rejection of a counter table, and the reason it
-- can be reversed is that this table is *derived*. `request_logs` stays the
-- source of truth; every figure here is reproducible from it by one grouped
-- select. The original objection was that a counter table can disagree with the
-- log and nobody can tell which is right — that objection is answered by there
-- being a rebuild, a restore that runs it, and a `doctor` check that compares
-- the two. It would not be answered by care.
--
-- `hour` is `at / 3600000`, floored, and every SQL side spells that
-- `CAST(at / 3600000 AS INTEGER)`. The cast is not decoration: nothing validates
-- `at`, and SQLite's `/` is integer division only when both operands are
-- integers, so a fractional `at` would give this INTEGER column a REAL key that
-- no later integer-hour write ever merges with. Truncation toward zero and
-- JavaScript's `Math.floor` then agree on every epoch this side of 1970, which
-- is every epoch a request log holds.
--
-- `api_key_id` is NOT NULL and anonymous rows are left out: a WITHOUT ROWID
-- primary key cannot hold a NULL, and nothing reads this table except a per-key
-- lookup that could never match one.
CREATE TABLE usage_rollup (
  api_key_id         TEXT NOT NULL,
  hour               INTEGER NOT NULL,
  requests           INTEGER NOT NULL DEFAULT 0,
  input_tokens       INTEGER NOT NULL DEFAULT 0,
  output_tokens      INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd           REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (api_key_id, hour)
) WITHOUT ROWID;

-- The backfill is this migration's `after` hook rather than an INSERT here, and
-- it is the same `rebuildRollup` a restore runs. Seeding an existing install and
-- repairing a suspect one are the same statement, so they are the same code and
-- cannot drift into disagreeing about which rows count.

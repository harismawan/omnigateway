-- Per-key limits as a sparse `(dimension, window)` matrix, replacing the single
-- requests-per-minute integer.
--
-- One JSON column rather than a column per pair, because the matrix is sparse
-- and the pairs are not fixed: `requests` and `tokens` are meaningful at all
-- three windows, `spend` only at the two long ones, and `concurrency` is a gauge
-- with no window at all. Twelve mostly-null integer columns would encode the
-- same thing while making every future pair a migration.
--
-- The JSON keys are a storage contract in the same class as `RTK_FILTER_IDS`:
-- the dimension and window names are persisted in every row, so adding a name is
-- free and renaming or removing one loses data. Unlike RTK ids, which are
-- dropped silently on read, an unknown limit key is a parse failure — a limit
-- the gateway cannot understand must never be read as "no limit", because that
-- fails open on a control the operator explicitly set.
--
-- `NOT NULL DEFAULT '{}'` rather than nullable, so "unlimited" has exactly one
-- spelling at the column level and every reader parses the same shape.
ALTER TABLE api_keys ADD COLUMN limits TEXT NOT NULL DEFAULT '{}';

-- The old ceiling was requests per minute and nothing else, so it lands whole in
-- `requests["1m"]`. A NULL meant unlimited and stays unlimited as the default
-- `{}`: an absent key and an explicit null both mean the same thing, and the
-- empty object is the shape a newly minted key starts at.
UPDATE api_keys
   SET limits = json_object('requests', json_object('1m', rate_limit_per_min))
 WHERE rate_limit_per_min IS NOT NULL;

ALTER TABLE api_keys DROP COLUMN rate_limit_per_min;

-- Correctness-adjacent, not an optimisation, and it must not be dropped later as
-- redundant with `idx_request_logs_at`.
--
-- `request_logs` leads its existing indexes with `at` and with `credential_id`;
-- nothing leads with `api_key_id`. A sliding weekly sum for one key against
-- `idx_request_logs_at` scans every row in the week for every key on the
-- install, and that scan sits on the request hot path.
--
-- Composite order matters: `(api_key_id, at DESC)` lets the range scan start at
-- the key. `(at DESC, api_key_id)` does not.
CREATE INDEX idx_request_logs_key_at ON request_logs (api_key_id, at DESC);

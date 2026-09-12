-- An index for the provider filter on `request_logs`. The SQLite copy,
-- `016_log_filter_indexes.sql`, carries the measurement: filtering by a provider
-- with no traffic has nothing to seek, so proving the absence reads every row,
-- and the console offers exactly that query because its dropdown is built from
-- the provider catalog rather than from traffic.
--
-- Leading column then the keyset pair, so one seek answers the filter and the
-- walk from it is already in page order.
CREATE INDEX idx_request_logs_provider ON request_logs (resolved_provider, at DESC, id DESC);

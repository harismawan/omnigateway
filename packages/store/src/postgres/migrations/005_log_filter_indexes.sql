-- Indexes for the exact filters on `request_logs`. The SQLite copy,
-- `016_log_filter_indexes.sql`, carries the measurement and the reasoning: an
-- unindexed exact filter scans the table whenever it matches nothing, and the
-- `model` filter is an OR over two columns that cannot stop at the page limit
-- because the limit bounds what is returned, not what is compared.
--
-- The numbers there are SQLite's, where the scan is also the event loop. This
-- backend runs the same query through a planner that reaches an OR over two
-- indexed columns as a BitmapOr, so the shape is what matters here rather than
-- the microseconds: each index leads with the filtered column and continues
-- with the keyset pair, so the filter is one seek and the walk from it is
-- already in page order.
CREATE INDEX idx_request_logs_resolved_model ON request_logs (resolved_model, at DESC, id DESC);
CREATE INDEX idx_request_logs_requested_model ON request_logs (requested_model, at DESC, id DESC);
CREATE INDEX idx_request_logs_error_code ON request_logs (error_code, at DESC, id DESC);
CREATE INDEX idx_request_logs_provider ON request_logs (resolved_provider, at DESC, id DESC);

-- `credential_health` keeps decisions, not measurements.
--
-- `ewma_ttft_ms` and `last_used_at` were written on every successful request,
-- and a success that changes nothing else now writes nothing. Both live in the
-- gateway's process-local `loadRegistry` instead: latency is a property of
-- *this* process's path to the provider, and the round-robin tiebreak reads
-- the value the process holds. The console's "last used" reads
-- `request_logs` through `usage.lastUsedByCredential`, served by
-- `idx_request_logs_cred`.
--
-- Neither column is indexed or constrained, so `DROP COLUMN` is permitted.
ALTER TABLE credential_health DROP COLUMN ewma_ttft_ms;
ALTER TABLE credential_health DROP COLUMN last_used_at;

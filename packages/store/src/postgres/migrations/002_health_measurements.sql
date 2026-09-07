-- `credential_health` keeps decisions, not measurements.
--
-- `ewma_ttft_ms` and `last_used_at` were written on every successful request,
-- and a success that changes nothing else now writes nothing. Both live in the
-- gateway's process-local `loadRegistry` instead. The console's "last used"
-- reads `request_logs` through `usage.lastUsedByCredential`, served by
-- `idx_request_logs_cred`.
ALTER TABLE credential_health DROP COLUMN ewma_ttft_ms;
ALTER TABLE credential_health DROP COLUMN last_used_at;

-- The statement-level trigger bumped `config_version` — one row, locked until
-- commit, by every writer on every replica — on every health write, and every
-- bump makes every replica rebuild its routing snapshot. Only a change to a
-- column routing *decides* on needs that; a bare `consecutive_failures`
-- increment is patched into the held snapshot from the `healthSaved` change.
--
-- The INSERT arm must stay `FOR EACH ROW`. The write is an upsert, and a
-- statement-level INSERT trigger fires on an upsert whichever path each row
-- took, which would bump on every write and make the WHEN clause below moot.
-- Row-level `AFTER INSERT` fires only for rows actually inserted.
DROP TRIGGER credential_health_config_version ON credential_health;

CREATE TRIGGER credential_health_config_version_upd
  AFTER UPDATE ON credential_health
  FOR EACH ROW
  WHEN (OLD.breaker_state      IS DISTINCT FROM NEW.breaker_state
     OR OLD.rate_limited_until IS DISTINCT FROM NEW.rate_limited_until
     OR OLD.opened_at          IS DISTINCT FROM NEW.opened_at)
  EXECUTE FUNCTION bump_config_version();

CREATE TRIGGER credential_health_config_version_ins
  AFTER INSERT ON credential_health
  FOR EACH ROW EXECUTE FUNCTION bump_config_version();

CREATE TRIGGER credential_health_config_version_del
  AFTER DELETE ON credential_health
  FOR EACH ROW EXECUTE FUNCTION bump_config_version();

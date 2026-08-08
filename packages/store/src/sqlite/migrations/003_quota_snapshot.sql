-- Provider-reported quota, and why a credential stopped routing.
--
-- `quota_windows` was designed for operator-typed limits and nothing ever wrote
-- it. It now holds what the provider itself reports, so a row needs to say when
-- the window rolls over and when the reading was taken: a snapshot whose
-- `observed_at` is old is a claim about the past, and the console says so
-- rather than drawing a stale bar as if it were current.
--
-- `observed_at` defaults to 0 rather than a timestamp, so any row predating
-- this migration reads as "never observed" instead of as a fresh reading.
ALTER TABLE quota_windows ADD COLUMN resets_at INTEGER;
ALTER TABLE quota_windows ADD COLUMN observed_at INTEGER NOT NULL DEFAULT 0;

-- A disabled credential is either the operator's decision or the provider's.
-- Without this the console cannot tell the two apart, and an account whose
-- refresh token was repudiated looks exactly like one somebody switched off.
ALTER TABLE credentials ADD COLUMN disabled_reason TEXT;
ALTER TABLE credentials ADD COLUMN disabled_at INTEGER;

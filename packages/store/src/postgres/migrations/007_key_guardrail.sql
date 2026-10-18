-- The Postgres half of the sqlite migration `019_key_guardrail.sql`: an
-- optional usage policy on a gateway API key, NULL meaning no guardrail.
--
-- No backfill: every existing key was minted without a policy. Safe under a
-- rolling deploy — a nullable column and nothing dropped, so a replica on the
-- previous image keeps serving, ignoring the field (and therefore not judging
-- that key's requests until it is replaced, which README's upgrade notes say).
ALTER TABLE api_keys ADD COLUMN guardrail_policy TEXT;

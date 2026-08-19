-- The plugin migration ledger, kept deliberately apart from core's `migrations`.
--
-- Core's track is a single ascending integer owned by this repository. A plugin
-- ships its own numbered migrations and knows nothing about ours, so the two
-- cannot share a counter: if they did, installing a plugin would consume numbers
-- that core's next migration then collides with, and the collision would surface
-- as "migration already applied" on an upgrade rather than as anything legible.
-- Core's next migration is 012 regardless of how many migrations any plugin
-- ships, and a plugin's version 1 is its own version 1 forever.
--
-- The primary key is (plugin_id, version) rather than a surrogate id because
-- that pair *is* the identity: applying the same version twice is the thing this
-- table exists to prevent, and a uniqueness constraint states it once instead of
-- leaving it to whichever code path happens to check first.
--
-- `applied_at` is milliseconds, matching every other timestamp in this schema.
-- It is recorded for an operator reading the table during an incident, not read
-- by the host: the host asks only whether a row exists.
--
-- Note what is *not* here: no row for the plugin's tables, and no cascade. A
-- plugin's tables outlive its rows here on purpose — see `PluginRepo.dropAll`
-- and `orphanTables`. Dropping a table because a plugin is currently absent
-- destroys data irreversibly, and a restore is precisely the moment a plugin is
-- most likely to be absent.
CREATE TABLE plugin_migrations (
  plugin_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  applied_at INTEGER NOT NULL,
  PRIMARY KEY (plugin_id, version)
);

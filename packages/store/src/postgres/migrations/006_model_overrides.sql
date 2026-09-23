-- Per-model overrides of the global RTK and ponytail settings.
--
-- NULL means "follow the global setting", which is what every existing row
-- keeps, so there is nothing to backfill.
ALTER TABLE virtual_models ADD COLUMN rtk_enabled BOOLEAN;
ALTER TABLE virtual_models ADD COLUMN ponytail_mode TEXT;

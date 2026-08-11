ALTER TABLE usage_daily ADD COLUMN rtk_saved_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE usage_daily ADD COLUMN rtk_applied_requests INTEGER NOT NULL DEFAULT 0;

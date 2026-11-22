ALTER TABLE request_logs ADD COLUMN rtk_applied INTEGER NOT NULL DEFAULT 0;
ALTER TABLE request_logs ADD COLUMN rtk_filter_hits INTEGER NOT NULL DEFAULT 0;
ALTER TABLE request_logs ADD COLUMN rtk_original_code_units INTEGER NOT NULL DEFAULT 0;
ALTER TABLE request_logs ADD COLUMN rtk_compressed_code_units INTEGER NOT NULL DEFAULT 0;
ALTER TABLE request_logs ADD COLUMN rtk_estimated_tokens_saved INTEGER NOT NULL DEFAULT 0;
ALTER TABLE request_logs ADD COLUMN rtk_filters TEXT NOT NULL DEFAULT '[]';

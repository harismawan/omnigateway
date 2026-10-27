CREATE TABLE prompts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  active_version INTEGER,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE TABLE prompt_versions (
  prompt_id TEXT NOT NULL REFERENCES prompts(id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK (version > 0),
  text TEXT NOT NULL,
  note TEXT,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (prompt_id, version)
);
ALTER TABLE api_keys ADD COLUMN prompts TEXT;
ALTER TABLE request_logs ADD COLUMN prompts TEXT NOT NULL DEFAULT '[]';
CREATE TRIGGER prompts_config_version AFTER INSERT OR UPDATE OR DELETE ON prompts
  FOR EACH STATEMENT EXECUTE FUNCTION bump_config_version();
CREATE TRIGGER prompt_versions_config_version AFTER INSERT OR UPDATE OR DELETE ON prompt_versions
  FOR EACH STATEMENT EXECUTE FUNCTION bump_config_version();

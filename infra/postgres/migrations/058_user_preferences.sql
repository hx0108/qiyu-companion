-- 结构化偏好档案（沉淀方向一）：每角色一行的确定性注入规则（称呼/雷区/作息/风格）。
-- 与自由文本关系资产的本质区别：这些规则 100% 注入提示词，不参与记忆召回竞争。
BEGIN;

CREATE TABLE IF NOT EXISTS user_preferences (
  account_id uuid NOT NULL REFERENCES accounts(account_id),
  character_id uuid NOT NULL REFERENCES characters(character_id),
  address_terms jsonb NOT NULL DEFAULT '{"character_to_user":null,"user_to_character":null}'::jsonb,
  taboos jsonb NOT NULL DEFAULT '[]'::jsonb,
  schedule jsonb NOT NULL DEFAULT '{"sleep_at":null,"wake_at":null}'::jsonb,
  style jsonb NOT NULL DEFAULT '{"reply_length":null,"emoji_enabled":null}'::jsonb,
  version integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, character_id)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON user_preferences TO qiyu_app;

INSERT INTO schema_migrations (migration_id) VALUES ('058_user_preferences.sql');

COMMIT;

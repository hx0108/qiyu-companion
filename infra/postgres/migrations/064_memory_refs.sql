-- 六项能力 A1（方案 §4.3）：助手消息的本轮记忆引用快照。一条助手消息一份引用集
-- （UNIQUE message_id）；本表不复制资产正文，读取时对资产/事件当前状态重验，
-- 旧版本或已删除来源只返回不可用标记。消息引用为弱引用（同 060 约定）。
-- followup_grants / followup_jobs / proactive_daily_slots 属 A2 范围（方案 §6.1），
-- 届时编号顺延并在合并前重查占用。
BEGIN;

CREATE TABLE message_memory_refs (
  ref_id uuid PRIMARY KEY DEFAULT app.uuid_v7(),
  message_id uuid NOT NULL,
  account_id uuid NOT NULL REFERENCES accounts(account_id),
  character_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  refs_json jsonb NOT NULL,
  context_bundle_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (message_id)
);
CREATE INDEX message_memory_refs_account_idx ON message_memory_refs (account_id, message_id);

ALTER TABLE message_memory_refs ENABLE ROW LEVEL SECURITY;
ALTER TABLE message_memory_refs FORCE ROW LEVEL SECURITY;
CREATE POLICY message_memory_refs_scope ON message_memory_refs FOR ALL TO qiyu_app
  USING (account_id = app.current_account_id()) WITH CHECK (account_id = app.current_account_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON message_memory_refs TO qiyu_app;

INSERT INTO schema_migrations (migration_id) VALUES ('064_memory_refs.sql');

COMMIT;

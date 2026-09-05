BEGIN;

-- 人格草稿与稳定人格分离：应用角色可以创建并读取草稿，但不能把草稿发布为
-- CANARY/STABLE。真正的审核员发布流程应使用独立 reviewer 会话与审批记录。
ALTER TABLE characters
  ADD COLUMN IF NOT EXISTS active_persona_version bigint;
UPDATE characters SET active_persona_version = version
  WHERE active_persona_version IS NULL;

ALTER TABLE persona_versions
  ADD COLUMN IF NOT EXISTS state text NOT NULL DEFAULT 'STABLE'
    CHECK (state IN ('DRAFT', 'EVALUATING', 'SHADOW', 'CANARY', 'STABLE', 'REJECTED', 'ROLLED_BACK', 'RETIRED')),
  ADD COLUMN IF NOT EXISTS parent_version bigint,
  ADD COLUMN IF NOT EXISTS evaluation_json jsonb,
  ADD COLUMN IF NOT EXISTS canary_json jsonb,
  ADD COLUMN IF NOT EXISTS rollback_json jsonb,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE INDEX IF NOT EXISTS persona_versions_release_state_idx
  ON persona_versions (account_id, character_id, state, version DESC);

INSERT INTO schema_migrations (migration_id) VALUES ('031_development_persona_release_drafts.sql');
COMMIT;

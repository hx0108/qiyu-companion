-- 六项能力 A1（方案 §4.1/§6.1）：生活事件投影 + 提取任务队列。life_events 是
-- 已确认关系资产的可查询投影与生命周期记录（语义唯一事实源仍是 relationship_assets
-- 版本链，投影只由事件服务写入）；消息/会话/资产引用沿用 call_turns 的弱引用约定
-- （普通 uuid 列，不加外键）——消息有保留期物理删除与账户注销删除路径，强外键
-- 会让删除事务回滚。过期联动由保留期清扫（clearExpiredMessageMemoryLinks）负责。
BEGIN;

CREATE TABLE life_events (
  event_id uuid PRIMARY KEY DEFAULT app.uuid_v7(),
  account_id uuid NOT NULL REFERENCES accounts(account_id),
  character_id uuid NOT NULL,
  current_asset_id uuid NOT NULL,
  asset_version bigint NOT NULL DEFAULT 1 CHECK (asset_version > 0),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  domain text NOT NULL CHECK (domain IN ('REAL_LIFE', 'FICTIONAL_SHARED')),
  event_kind text NOT NULL CHECK (event_kind IN ('INTERVIEW', 'READING', 'CREATION', 'OTHER')),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 80),
  scheduled_at timestamptz,
  timezone text,
  time_precision text NOT NULL DEFAULT 'UNKNOWN' CHECK (time_precision IN ('UNKNOWN', 'DATE', 'MINUTE')),
  status text NOT NULL DEFAULT 'PLANNED' CHECK (status IN ('PLANNED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED')),
  clarification_required boolean NOT NULL DEFAULT false,
  source_message_id uuid,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at timestamptz,
  UNIQUE (event_id, account_id, character_id),
  FOREIGN KEY (character_id, account_id) REFERENCES characters(character_id, account_id)
);
CREATE INDEX life_events_account_idx ON life_events (account_id, character_id, updated_at) WHERE deleted_at IS NULL;

-- 每条用户消息最多一个提取任务（UNIQUE message_id）；认领/重验/退避由 Worker
-- 在账户事务内完成；FAILED 任务留在本表（不另建死信表）供内部任务台查询。
CREATE TABLE life_event_extraction_jobs (
  job_id uuid PRIMARY KEY DEFAULT app.uuid_v7(),
  account_id uuid NOT NULL REFERENCES accounts(account_id),
  character_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  message_id uuid NOT NULL,
  captured_revocation_epoch bigint NOT NULL DEFAULT 0 CHECK (captured_revocation_epoch >= 0),
  state text NOT NULL DEFAULT 'PENDING' CHECK (state IN ('PENDING', 'PROCESSING', 'COMPLETED', 'CANCELLED', 'FAILED')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  exhausted_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at timestamptz,
  UNIQUE (message_id),
  CHECK ((state IN ('COMPLETED', 'CANCELLED', 'FAILED')) = (completed_at IS NOT NULL OR exhausted_at IS NOT NULL))
);
CREATE INDEX life_event_extraction_jobs_due_idx ON life_event_extraction_jobs (state, next_attempt_at) WHERE exhausted_at IS NULL;

ALTER TABLE life_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE life_events FORCE ROW LEVEL SECURITY;
CREATE POLICY life_events_scope ON life_events FOR ALL TO qiyu_app
  USING (account_id = app.current_account_id()) WITH CHECK (account_id = app.current_account_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON life_events TO qiyu_app;

ALTER TABLE life_event_extraction_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE life_event_extraction_jobs FORCE ROW LEVEL SECURITY;
CREATE POLICY life_event_extraction_jobs_scope ON life_event_extraction_jobs FOR ALL TO qiyu_app
  USING (account_id = app.current_account_id()) WITH CHECK (account_id = app.current_account_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON life_event_extraction_jobs TO qiyu_app;

INSERT INTO schema_migrations (migration_id) VALUES ('063_life_events_and_extraction_jobs.sql');

COMMIT;

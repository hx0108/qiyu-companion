BEGIN;

-- 资产 Embedding 生命周期（技术设计 6.3.2/7.7/12.4）：任务状态机 + 死信重放。
-- 向量本体写入 001 的 relationship_asset_embeddings（RLS 已在 002 建立）。
-- 吸取 029/030 教训：建表同时授予 qiyu_app DML 权限，策略统一用
-- app.current_account_id()（读 'app.account_id' GUC 的基线函数）。

CREATE TABLE IF NOT EXISTS asset_embedding_jobs (
  job_id uuid PRIMARY KEY DEFAULT app.uuid_v7(),
  account_id uuid NOT NULL REFERENCES accounts(account_id),
  character_id uuid,
  asset_id uuid NOT NULL REFERENCES relationship_assets(asset_id),
  asset_version bigint NOT NULL CHECK (asset_version > 0),
  state text NOT NULL CHECK (state IN ('PENDING', 'PROCESSING', 'COMPLETED', 'CANCELLED', 'FAILED')),
  attempt_count bigint NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL,
  exhausted_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at timestamptz
);
CREATE INDEX IF NOT EXISTS asset_embedding_jobs_queue_idx
  ON asset_embedding_jobs (state, next_attempt_at) WHERE exhausted_at IS NULL;
ALTER TABLE asset_embedding_jobs ENABLE ROW LEVEL SECURITY;
CREATE POLICY asset_embedding_jobs_scope ON asset_embedding_jobs FOR ALL TO qiyu_app
  USING (account_id = app.current_account_id())
  WITH CHECK (account_id = app.current_account_id());

CREATE TABLE IF NOT EXISTS asset_embedding_dead_letters (
  dead_letter_id uuid PRIMARY KEY DEFAULT app.uuid_v7(),
  job_id uuid NOT NULL UNIQUE REFERENCES asset_embedding_jobs(job_id),
  account_id uuid NOT NULL REFERENCES accounts(account_id),
  asset_id uuid NOT NULL,
  attempt_count bigint NOT NULL,
  error_code text NOT NULL,
  state text NOT NULL CHECK (state IN ('OPEN', 'REPLAYED')),
  replay_count bigint NOT NULL DEFAULT 0,
  occurred_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_replayed_at timestamptz,
  last_replayed_by text,
  last_replay_reason_sha256 text
);
ALTER TABLE asset_embedding_dead_letters ENABLE ROW LEVEL SECURITY;
CREATE POLICY asset_embedding_dead_letters_scope ON asset_embedding_dead_letters FOR ALL TO qiyu_app
  USING (account_id = app.current_account_id())
  WITH CHECK (account_id = app.current_account_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE asset_embedding_jobs, asset_embedding_dead_letters TO qiyu_app;

INSERT INTO schema_migrations (migration_id) VALUES ('041_development_asset_embedding_lifecycle.sql');

COMMIT;

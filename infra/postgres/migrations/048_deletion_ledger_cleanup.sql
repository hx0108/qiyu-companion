BEGIN;

-- P0 数据删除编排（PRD 7.0/AC-15）：
-- 1) 账户注销/会话删除需要物理删除原始消息，media_jobs.source_message_id
--    此前的外键没有 ON DELETE 动作，会阻塞删除。任务行是审计记录：
--    消息删除时保留任务行、仅断开消息引用。
ALTER TABLE media_jobs ALTER COLUMN source_message_id DROP NOT NULL;
ALTER TABLE media_jobs DROP CONSTRAINT IF EXISTS media_jobs_source_message_id_fkey;
ALTER TABLE media_jobs ADD CONSTRAINT media_jobs_source_message_id_fkey
  FOREIGN KEY (source_message_id) REFERENCES messages(message_id) ON DELETE SET NULL;

-- 2) 清理 Worker 的物理删除权限：只放开原始/派生内容表（messages、
--    conversation_summaries、oc_imports）。行级软删表（媒体资产、关系资产、
--    候选、会话）保留审计行，不在物理删除范围内。
GRANT DELETE ON TABLE messages, conversation_summaries, oc_imports TO qiyu_app;

INSERT INTO schema_migrations (migration_id) VALUES ('048_deletion_ledger_cleanup.sql');

COMMIT;

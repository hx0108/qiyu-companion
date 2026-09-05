BEGIN;

ALTER TABLE conversation_summary_jobs
  ADD COLUMN IF NOT EXISTS last_attempt_at timestamptz,
  ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'qiyu_conversation_summary_worker') THEN
    CREATE ROLE qiyu_conversation_summary_worker NOLOGIN NOINHERIT BYPASSRLS;
  ELSIF NOT (SELECT rolbypassrls FROM pg_roles WHERE rolname = 'qiyu_conversation_summary_worker') THEN
    RAISE EXCEPTION 'qiyu_conversation_summary_worker must retain BYPASSRLS';
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS conversation_summary_jobs_worker_ready_idx
  ON conversation_summary_jobs (next_attempt_at, created_at)
  WHERE state IN ('PENDING', 'PROCESSING');

GRANT USAGE ON SCHEMA app, public TO qiyu_conversation_summary_worker;
GRANT SELECT ON accounts, conversations, messages, conversation_summaries TO qiyu_conversation_summary_worker;
GRANT SELECT, UPDATE ON conversation_summary_jobs TO qiyu_conversation_summary_worker;
GRANT INSERT, UPDATE ON conversation_summaries TO qiyu_conversation_summary_worker;
REVOKE ALL ON conversation_summary_jobs, conversation_summaries FROM PUBLIC;

INSERT INTO schema_migrations (migration_id) VALUES ('036_development_conversation_summary_worker.sql');
COMMIT;

BEGIN;

CREATE TABLE IF NOT EXISTS conversation_summary_jobs (
  job_id uuid PRIMARY KEY DEFAULT app.uuid_v7(),
  account_id uuid NOT NULL REFERENCES accounts(account_id),
  conversation_id uuid NOT NULL REFERENCES conversations(conversation_id),
  source_to_id uuid NOT NULL,
  captured_revocation_epoch bigint NOT NULL,
  state text NOT NULL CHECK (state IN ('PENDING', 'PROCESSING', 'COMPLETED', 'CANCELLED')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_error text CHECK (last_error IS NULL OR length(last_error) BETWEEN 1 AND 1000),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at timestamptz,
  CHECK ((state IN ('COMPLETED', 'CANCELLED')) = (completed_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS conversation_summary_jobs_account_ready_idx
  ON conversation_summary_jobs (account_id, next_attempt_at, created_at)
  WHERE state IN ('PENDING', 'PROCESSING');
ALTER TABLE conversation_summary_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation_summary_jobs FORCE ROW LEVEL SECURITY;
CREATE POLICY conversation_summary_jobs_scope ON conversation_summary_jobs FOR ALL TO qiyu_app
  USING (account_id = app.current_account_id()) WITH CHECK (account_id = app.current_account_id());
GRANT SELECT, INSERT, UPDATE (state, completed_at, last_error) ON conversation_summary_jobs TO qiyu_app;
INSERT INTO schema_migrations (migration_id) VALUES ('035_development_conversation_summary_jobs.sql');
COMMIT;

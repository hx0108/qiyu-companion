BEGIN;

ALTER TABLE conversation_summary_jobs
  ADD COLUMN IF NOT EXISTS exhausted_at timestamptz;

CREATE TABLE IF NOT EXISTS conversation_summary_dead_letters (
  dead_letter_id uuid PRIMARY KEY DEFAULT app.uuid_v7(),
  job_id uuid NOT NULL UNIQUE REFERENCES conversation_summary_jobs(job_id),
  account_id uuid NOT NULL REFERENCES accounts(account_id),
  conversation_id uuid NOT NULL REFERENCES conversations(conversation_id),
  source_to_id uuid NOT NULL,
  attempt_count integer NOT NULL CHECK (attempt_count >= 8),
  error_code text NOT NULL CHECK (error_code ~ '^[A-Z0-9_]{3,80}$'),
  occurred_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS conversation_summary_dead_letters_account_idx
  ON conversation_summary_dead_letters (account_id, occurred_at DESC);
ALTER TABLE conversation_summary_dead_letters ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation_summary_dead_letters FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON conversation_summary_dead_letters TO qiyu_conversation_summary_worker;
REVOKE ALL ON conversation_summary_dead_letters FROM PUBLIC, qiyu_app;

INSERT INTO schema_migrations (migration_id) VALUES ('038_development_conversation_summary_dlq.sql');
COMMIT;

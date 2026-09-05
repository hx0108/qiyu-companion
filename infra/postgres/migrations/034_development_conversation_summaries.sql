BEGIN;

CREATE TABLE IF NOT EXISTS conversation_summaries (
  summary_id uuid PRIMARY KEY DEFAULT app.uuid_v7(),
  account_id uuid NOT NULL REFERENCES accounts(account_id),
  conversation_id uuid NOT NULL REFERENCES conversations(conversation_id),
  source_from_id uuid NOT NULL,
  source_to_id uuid NOT NULL,
  summary_ciphertext bytea NOT NULL,
  model_route_id text NOT NULL,
  prompt_version text NOT NULL,
  source_checksum text NOT NULL CHECK (source_checksum ~ '^[a-f0-9]{64}$'),
  revocation_epoch bigint NOT NULL,
  state text NOT NULL CHECK (state IN ('ACTIVE', 'SUPERSEDED', 'INVALIDATED')),
  retention_expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  invalidated_at timestamptz
);
CREATE INDEX IF NOT EXISTS conversation_summaries_scope_idx ON conversation_summaries (account_id, conversation_id, state, created_at DESC);
ALTER TABLE conversation_summaries ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation_summaries FORCE ROW LEVEL SECURITY;
CREATE POLICY conversation_summaries_scope ON conversation_summaries FOR ALL TO qiyu_app
  USING (account_id = app.current_account_id()) WITH CHECK (account_id = app.current_account_id());
GRANT SELECT, INSERT, UPDATE ON conversation_summaries TO qiyu_app;
INSERT INTO schema_migrations (migration_id) VALUES ('034_development_conversation_summaries.sql');
COMMIT;

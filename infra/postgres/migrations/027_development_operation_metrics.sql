BEGIN;

-- Privacy-preserving operational metrics: no prompts, replies, contact data,
-- object keys, or provider raw payloads are permitted in this append-only row.
CREATE TABLE IF NOT EXISTS operation_metrics (
  metric_id text PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(account_id),
  capability text NOT NULL CHECK (capability IN ('CHAT_GENERATION', 'TTS', 'ASR', 'IMAGE_GENERATION', 'TEXT_MODERATION', 'IMAGE_MODERATION')),
  provider text NOT NULL CHECK (length(provider) BETWEEN 1 AND 80),
  model_version text CHECK (model_version IS NULL OR length(model_version) <= 160),
  input_tokens integer NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens integer NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  latency_ms integer NOT NULL CHECK (latency_ms >= 0 AND latency_ms <= 3600000),
  outcome text NOT NULL CHECK (outcome IN ('COMPLETED', 'FALLBACK', 'FAILED', 'BLOCKED')),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS operation_metrics_account_created_idx ON operation_metrics (account_id, created_at DESC);
ALTER TABLE operation_metrics ENABLE ROW LEVEL SECURITY;
ALTER TABLE operation_metrics FORCE ROW LEVEL SECURITY;
CREATE POLICY operation_metrics_scope ON operation_metrics FOR SELECT TO qiyu_app
  USING (account_id = current_setting('app.account_id', true)::uuid);
CREATE POLICY operation_metrics_insert_scope ON operation_metrics FOR INSERT TO qiyu_app
  WITH CHECK (account_id = current_setting('app.account_id', true)::uuid);
REVOKE UPDATE, DELETE ON operation_metrics FROM qiyu_app;

INSERT INTO schema_migrations (migration_id) VALUES ('027_development_operation_metrics.sql');
COMMIT;

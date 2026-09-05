BEGIN;

-- Summary-worker telemetry stays in the same append-only, no-content table.
-- Cost cannot be inferred safely without a separately versioned price contract.
ALTER TABLE operation_metrics
  DROP CONSTRAINT IF EXISTS operation_metrics_capability_check;
ALTER TABLE operation_metrics
  ADD CONSTRAINT operation_metrics_capability_check CHECK (capability IN (
    'CHAT_GENERATION', 'CONVERSATION_SUMMARY_GENERATION', 'TTS', 'ASR',
    'IMAGE_GENERATION', 'TEXT_MODERATION', 'IMAGE_MODERATION'
  ));

GRANT INSERT ON operation_metrics TO qiyu_conversation_summary_worker;

INSERT INTO schema_migrations (migration_id) VALUES ('039_development_conversation_summary_metrics.sql');
COMMIT;

BEGIN;

CREATE UNIQUE INDEX IF NOT EXISTS outbox_conversation_summary_requested_once
  ON outbox_events (aggregate_type, aggregate_id, event_type)
  WHERE event_type = 'conversation.summary_requested.v1' AND deleted_at IS NULL;

INSERT INTO schema_migrations (migration_id) VALUES ('037_development_conversation_summary_outbox.sql');
COMMIT;

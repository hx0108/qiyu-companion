BEGIN;

ALTER TABLE messages
  ADD COLUMN effective_chat_started_at timestamptz,
  ADD CONSTRAINT effective_chat_start_shape CHECK (
    effective_chat_started_at IS NULL OR (
      effective_chat_source_id IS NOT NULL AND effective_chat_started_at <= created_at
    )
  ) NOT VALID;

INSERT INTO schema_migrations(migration_id) VALUES ('117_realtime_effective_turn_start.sql');
COMMIT;

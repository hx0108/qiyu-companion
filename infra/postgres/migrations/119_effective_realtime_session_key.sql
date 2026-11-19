BEGIN;

ALTER TABLE messages
  ADD COLUMN effective_chat_session_key uuid,
  ADD CONSTRAINT effective_chat_session_shape CHECK (
    effective_chat_session_key IS NULL OR (
      effective_chat_source_id IS NOT NULL AND provider = 'volcengine-realtime' AND provider IS NOT NULL
    )
  ) NOT VALID;

INSERT INTO schema_migrations(migration_id) VALUES ('119_effective_realtime_session_key.sql');
COMMIT;

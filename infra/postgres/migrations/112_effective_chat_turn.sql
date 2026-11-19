BEGIN;
ALTER TABLE messages ADD COLUMN effective_chat_source_id uuid;
ALTER TABLE messages ADD CONSTRAINT effective_chat_reply_only CHECK (
  effective_chat_source_id IS NULL OR (actor = 'ASSISTANT' AND ai_generated)
) NOT VALID;
INSERT INTO schema_migrations(migration_id) VALUES ('112_effective_chat_turn.sql');
COMMIT;

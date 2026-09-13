BEGIN;

ALTER TABLE messages ADD COLUMN IF NOT EXISTS attachments jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_attachments_array_check;
ALTER TABLE messages ADD CONSTRAINT messages_attachments_array_check CHECK (jsonb_typeof(attachments) = 'array');

ALTER TABLE media_assets ADD COLUMN IF NOT EXISTS conversation_id uuid REFERENCES conversations(conversation_id);
ALTER TABLE media_assets ADD COLUMN IF NOT EXISTS message_id uuid REFERENCES messages(message_id);
ALTER TABLE media_assets ADD COLUMN IF NOT EXISTS width integer;
ALTER TABLE media_assets ADD COLUMN IF NOT EXISTS height integer;
ALTER TABLE media_assets ADD COLUMN IF NOT EXISTS metadata_stripped boolean;
ALTER TABLE media_assets DROP CONSTRAINT IF EXISTS media_assets_type_check;
ALTER TABLE media_assets ADD CONSTRAINT media_assets_type_check CHECK (type IN ('TTS_AUDIO', 'ASR_INPUT_AUDIO', 'REFERENCE_IMAGE', 'SCENE_IMAGE', 'USER_CONTEXT_IMAGE'));
ALTER TABLE media_assets DROP CONSTRAINT IF EXISTS media_assets_ai_generated_check;
ALTER TABLE media_assets ADD CONSTRAINT media_assets_ai_generated_check CHECK (
  (type IN ('TTS_AUDIO', 'SCENE_IMAGE') AND ai_generated)
  OR (type IN ('ASR_INPUT_AUDIO', 'REFERENCE_IMAGE', 'USER_CONTEXT_IMAGE') AND NOT ai_generated)
);
CREATE INDEX IF NOT EXISTS media_assets_context_image_idx ON media_assets (account_id, conversation_id, type, state) WHERE type = 'USER_CONTEXT_IMAGE' AND deleted_at IS NULL;

INSERT INTO schema_migrations (migration_id) VALUES ('057_context_image_messages.sql');

COMMIT;

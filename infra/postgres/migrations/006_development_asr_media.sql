BEGIN;

-- Extend the local media model for user-provided ASR input. This is still not
-- production media storage: bytes remain in the private development vault.
ALTER TABLE media_jobs ALTER COLUMN source_message_id DROP NOT NULL;
ALTER TABLE media_jobs ADD COLUMN IF NOT EXISTS input_asset_id uuid;
ALTER TABLE media_jobs ADD COLUMN IF NOT EXISTS transcript_text text;
ALTER TABLE media_jobs ADD COLUMN IF NOT EXISTS transcript_state text;
ALTER TABLE media_jobs DROP CONSTRAINT IF EXISTS media_jobs_type_check;
ALTER TABLE media_jobs DROP CONSTRAINT IF EXISTS media_jobs_state_check;
ALTER TABLE media_jobs ADD CONSTRAINT media_jobs_type_check CHECK (type IN ('TTS', 'ASR'));
ALTER TABLE media_jobs ADD CONSTRAINT media_jobs_state_check CHECK (state IN ('PENDING', 'RUNNING', 'COMPLETED', 'CONFIRMED', 'BLOCKED', 'FAILED', 'DELETED'));
ALTER TABLE media_jobs ADD CONSTRAINT media_jobs_transcript_state_check CHECK (transcript_state IS NULL OR transcript_state IN ('PENDING_CONFIRMATION', 'CONFIRMED'));

ALTER TABLE media_assets DROP CONSTRAINT IF EXISTS media_assets_type_check;
ALTER TABLE media_assets DROP CONSTRAINT IF EXISTS media_assets_mime_type_check;
ALTER TABLE media_assets DROP CONSTRAINT IF EXISTS media_assets_ai_generated_check;
ALTER TABLE media_assets ADD CONSTRAINT media_assets_type_check CHECK (type IN ('TTS_AUDIO', 'ASR_INPUT_AUDIO'));
ALTER TABLE media_assets ADD CONSTRAINT media_assets_mime_type_check CHECK (mime_type IN ('audio/mpeg', 'audio/wav', 'audio/x-wav', 'audio/mp4', 'audio/aac', 'audio/ogg'));
ALTER TABLE media_assets ADD CONSTRAINT media_assets_ai_generated_check CHECK (type <> 'TTS_AUDIO' OR ai_generated);

INSERT INTO schema_migrations (migration_id) VALUES ('006_development_asr_media.sql');

COMMIT;

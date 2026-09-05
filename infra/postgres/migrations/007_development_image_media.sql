BEGIN;

-- Durable state for the controlled image pipeline. Object bytes remain solely
-- in private COS; no URL, signed URL or image payload is stored in PostgreSQL.
ALTER TABLE media_jobs ALTER COLUMN conversation_id DROP NOT NULL;
ALTER TABLE media_jobs ADD COLUMN IF NOT EXISTS reference_asset_id uuid;
ALTER TABLE media_jobs ADD COLUMN IF NOT EXISTS provider_job_id text;
ALTER TABLE media_jobs ADD COLUMN IF NOT EXISTS scene_contract jsonb;
ALTER TABLE media_jobs DROP CONSTRAINT IF EXISTS media_jobs_type_check;
ALTER TABLE media_jobs ADD CONSTRAINT media_jobs_type_check CHECK (type IN ('TTS', 'ASR', 'IMAGE_GENERATION'));

ALTER TABLE media_assets ALTER COLUMN job_id DROP NOT NULL;
ALTER TABLE media_assets ADD COLUMN IF NOT EXISTS confirmation_state text;
ALTER TABLE media_assets ADD COLUMN IF NOT EXISTS moderation_policy_version text;
ALTER TABLE media_assets ADD COLUMN IF NOT EXISTS failure_code text;
ALTER TABLE media_assets DROP CONSTRAINT IF EXISTS media_assets_type_check;
ALTER TABLE media_assets DROP CONSTRAINT IF EXISTS media_assets_state_check;
ALTER TABLE media_assets DROP CONSTRAINT IF EXISTS media_assets_mime_type_check;
ALTER TABLE media_assets DROP CONSTRAINT IF EXISTS media_assets_ai_generated_check;
ALTER TABLE media_assets ADD CONSTRAINT media_assets_type_check CHECK (type IN ('TTS_AUDIO', 'ASR_INPUT_AUDIO', 'REFERENCE_IMAGE', 'SCENE_IMAGE'));
ALTER TABLE media_assets ADD CONSTRAINT media_assets_state_check CHECK (state IN ('PENDING_MODERATION', 'AVAILABLE', 'REVIEW_REQUIRED', 'BLOCKED', 'FAILED', 'DELETED'));
ALTER TABLE media_assets ADD CONSTRAINT media_assets_mime_type_check CHECK (mime_type IN ('audio/mpeg', 'audio/wav', 'audio/x-wav', 'audio/mp4', 'audio/aac', 'audio/ogg', 'image/jpeg', 'image/png', 'image/webp'));
ALTER TABLE media_assets ADD CONSTRAINT media_assets_ai_generated_check CHECK (
  (type IN ('TTS_AUDIO', 'SCENE_IMAGE') AND ai_generated)
  OR (type IN ('ASR_INPUT_AUDIO', 'REFERENCE_IMAGE') AND NOT ai_generated)
);
ALTER TABLE media_assets ADD CONSTRAINT media_assets_confirmation_state_check CHECK (
  confirmation_state IS NULL OR confirmation_state IN ('PENDING', 'USER_CONFIRMED', 'REJECTED', 'NOT_REQUIRED')
);

CREATE INDEX IF NOT EXISTS media_jobs_provider_job_idx ON media_jobs (provider_job_id) WHERE provider_job_id IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS media_assets_reference_image_idx ON media_assets (account_id, character_id, type, state) WHERE type = 'REFERENCE_IMAGE' AND deleted_at IS NULL;

INSERT INTO schema_migrations (migration_id) VALUES ('007_development_image_media.sql');

COMMIT;

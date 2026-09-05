BEGIN;

-- Tencent standard-voice entitlement provenance is a service-side operator
-- record, not a client-provided voice selection. These nullable columns also
-- preserve older ASR/image rows in the shared media_jobs table.
ALTER TABLE media_jobs ADD COLUMN IF NOT EXISTS voice_id text;
ALTER TABLE media_jobs ADD COLUMN IF NOT EXISTS voice_version text;
ALTER TABLE media_jobs ADD COLUMN IF NOT EXISTS authorization_record_id text;
ALTER TABLE media_jobs ADD COLUMN IF NOT EXISTS rights_review_id text;
ALTER TABLE media_jobs ADD COLUMN IF NOT EXISTS rights_review_state text;
ALTER TABLE media_jobs DROP CONSTRAINT IF EXISTS media_jobs_tts_voice_provenance_check;
ALTER TABLE media_jobs ADD CONSTRAINT media_jobs_tts_voice_provenance_check CHECK (
  type <> 'TTS'
  -- Existing development rows remain readable rather than being falsely
  -- backfilled as approved. New TTS jobs always take the second branch.
  OR (voice_id IS NULL AND voice_version IS NULL AND authorization_record_id IS NULL AND rights_review_id IS NULL AND rights_review_state IS NULL)
  OR (voice_id ~ '^[A-Za-z0-9._:-]{1,128}$'
      AND voice_version ~ '^[A-Za-z0-9._:-]{1,128}$'
      AND authorization_record_id ~ '^[A-Za-z0-9._:-]{1,128}$'
      AND rights_review_id ~ '^[A-Za-z0-9._:-]{1,128}$'
      AND rights_review_state = 'APPROVED')
);
CREATE INDEX IF NOT EXISTS media_jobs_tts_voice_provenance_idx
  ON media_jobs (voice_id, voice_version, authorization_record_id)
  WHERE type = 'TTS' AND deleted_at IS NULL;

INSERT INTO schema_migrations (migration_id) VALUES ('023_development_tts_voice_provenance.sql');
COMMIT;

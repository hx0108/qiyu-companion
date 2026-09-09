BEGIN;

-- Migration 007 added image asset types but left the original TTS-only
-- media_type constraint in place. Persisted reference and generated images
-- must be able to use IMAGE while existing audio assets remain valid.
ALTER TABLE media_assets DROP CONSTRAINT IF EXISTS media_assets_media_type_check;
ALTER TABLE media_assets ADD CONSTRAINT media_assets_media_type_check
  CHECK (media_type IN ('AUDIO', 'IMAGE'));

INSERT INTO schema_migrations (migration_id) VALUES ('046_development_image_media_type_constraint.sql');

COMMIT;

BEGIN;

-- Old jobs remain readable without a snapshot. New image jobs bind a single
-- immutable world-state identity/version pair at acceptance time.
ALTER TABLE media_jobs ADD COLUMN IF NOT EXISTS world_state_id uuid;
ALTER TABLE media_jobs ADD COLUMN IF NOT EXISTS world_state_version bigint;
ALTER TABLE media_jobs DROP CONSTRAINT IF EXISTS media_jobs_world_state_snapshot_check;
ALTER TABLE media_jobs ADD CONSTRAINT media_jobs_world_state_snapshot_check CHECK (
  (world_state_id IS NULL AND world_state_version IS NULL)
  OR (world_state_id IS NOT NULL AND world_state_version > 0)
);
CREATE INDEX IF NOT EXISTS media_jobs_world_state_snapshot_idx
  ON media_jobs (account_id, character_id, world_state_id, world_state_version)
  WHERE world_state_id IS NOT NULL AND deleted_at IS NULL;

INSERT INTO schema_migrations (migration_id) VALUES ('018_development_media_world_state_snapshot.sql');

COMMIT;

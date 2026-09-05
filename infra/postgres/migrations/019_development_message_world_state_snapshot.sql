BEGIN;

-- Assistant messages retain the exact short-term state used for their model
-- request. TTS copies this pair so later world-state changes cannot alter the
-- provenance of an already generated response or voice task.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS world_state_id uuid;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS world_state_version bigint;
ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_world_state_snapshot_check;
ALTER TABLE messages ADD CONSTRAINT messages_world_state_snapshot_check CHECK (
  (world_state_id IS NULL AND world_state_version IS NULL)
  OR (world_state_id IS NOT NULL AND world_state_version > 0)
);
CREATE INDEX IF NOT EXISTS messages_world_state_snapshot_idx
  ON messages (world_state_id, world_state_version) WHERE world_state_id IS NOT NULL AND deleted_at IS NULL;

INSERT INTO schema_migrations (migration_id) VALUES ('019_development_message_world_state_snapshot.sql');

COMMIT;

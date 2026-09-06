BEGIN;

-- \`index_state\` is derived Worker progress, not a user-visible memory revision.
-- The generic touch trigger increments every UPDATE, which would make an
-- otherwise valid embedding stale immediately after PENDING -> READY.
CREATE OR REPLACE FUNCTION app.touch_relationship_asset_row()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := CURRENT_TIMESTAMP;
  IF ROW(
    NEW.account_id, NEW.character_id, NEW.type, NEW.value_json, NEW.state,
    NEW.source_candidate_id, NEW.provenance_ids, NEW.activation_actor,
    NEW.valid_from, NEW.valid_until, NEW.superseded_by, NEW.deleted_at, NEW.display_text
  ) IS DISTINCT FROM ROW(
    OLD.account_id, OLD.character_id, OLD.type, OLD.value_json, OLD.state,
    OLD.source_candidate_id, OLD.provenance_ids, OLD.activation_actor,
    OLD.valid_from, OLD.valid_until, OLD.superseded_by, OLD.deleted_at, OLD.display_text
  ) THEN
    NEW.version := OLD.version + 1;
  ELSE
    NEW.version := OLD.version;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS relationship_assets_touch_version ON relationship_assets;
CREATE TRIGGER relationship_assets_touch_version
  BEFORE UPDATE ON relationship_assets
  FOR EACH ROW EXECUTE FUNCTION app.touch_relationship_asset_row();

-- Existing rows that were marked READY by the old trigger can be rebuilt
-- without exposing content or changing the user-confirmed asset itself.
INSERT INTO asset_embedding_jobs (account_id, character_id, asset_id, asset_version, state, attempt_count, next_attempt_at, created_at)
SELECT asset.account_id, asset.character_id, asset.asset_id, asset.version, 'PENDING', 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM relationship_assets AS asset
WHERE asset.state = 'ACTIVE'
  AND asset.deleted_at IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM relationship_asset_embeddings AS embedding
    WHERE embedding.asset_id = asset.asset_id
      AND embedding.deleted_at IS NULL
      AND embedding.version = asset.version
  )
  AND NOT EXISTS (
    SELECT 1 FROM asset_embedding_jobs AS job
    WHERE job.asset_id = asset.asset_id
      AND job.asset_version = asset.version
      AND job.state IN ('PENDING', 'PROCESSING')
      AND job.exhausted_at IS NULL
  );

INSERT INTO schema_migrations (migration_id) VALUES ('044_asset_index_state_version_boundary.sql');
COMMIT;

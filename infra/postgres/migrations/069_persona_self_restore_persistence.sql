BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- Additive and backward-compatible: old application versions ignore this field.
-- A restore appends a new snapshot and references an earlier snapshot of the
-- same character. It never replaces or deletes the historical persona JSON.
ALTER TABLE persona_versions ADD COLUMN IF NOT EXISTS restored_from_version bigint;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'persona_restore_earlier_version' AND conrelid = 'persona_versions'::regclass) THEN
    ALTER TABLE persona_versions ADD CONSTRAINT persona_restore_earlier_version
      CHECK (restored_from_version IS NULL OR (restored_from_version > 0 AND restored_from_version < version));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'persona_restore_same_character_fk' AND conrelid = 'persona_versions'::regclass) THEN
    ALTER TABLE persona_versions ADD CONSTRAINT persona_restore_same_character_fk
      FOREIGN KEY (character_id, restored_from_version) REFERENCES persona_versions(character_id, version)
      DEFERRABLE INITIALLY DEFERRED;
  END IF;
END;
$$;
CREATE INDEX IF NOT EXISTS persona_restore_source_idx
  ON persona_versions(character_id, restored_from_version) WHERE restored_from_version IS NOT NULL;

-- Previous ON CONFLICT DO NOTHING lost STABLE -> RETIRED transitions. Only
-- repair earlier STABLE versions when a current STABLE snapshot is explicitly
-- referenced by the character. Do not infer release of drafts/future versions.
UPDATE persona_versions old
SET state = 'RETIRED', updated_at = CURRENT_TIMESTAMP
FROM characters c, persona_versions active
WHERE old.character_id = c.character_id AND old.account_id = c.account_id
  AND active.character_id = c.character_id AND active.account_id = c.account_id
  AND active.version = c.active_persona_version AND active.state = 'STABLE'
  AND old.state = 'STABLE' AND old.version < c.active_persona_version;

INSERT INTO schema_migrations(migration_id) VALUES ('069_persona_self_restore_persistence.sql') ON CONFLICT DO NOTHING;
COMMIT;

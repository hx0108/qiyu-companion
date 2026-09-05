BEGIN;

-- Persona profile fields (PRD 3.2.1 user-editable layers) and the minimal
-- version-history record required by PRD 3.4. Evaluation/shadow/gray-release
-- pipelines remain production scope and are intentionally not modeled here.
ALTER TABLE characters ADD COLUMN IF NOT EXISTS persona_json jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS persona_versions (
  character_id uuid NOT NULL REFERENCES characters(character_id),
  account_id uuid NOT NULL REFERENCES accounts(account_id),
  version bigint NOT NULL CHECK (version > 0),
  persona_json jsonb NOT NULL,
  changed_fields text[] NOT NULL DEFAULT '{}',
  note text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (character_id, version)
);
CREATE INDEX IF NOT EXISTS persona_versions_account_idx ON persona_versions (account_id, character_id, version DESC);

ALTER TABLE persona_versions ENABLE ROW LEVEL SECURITY;
CREATE POLICY persona_versions_scope ON persona_versions FOR ALL TO qiyu_app
  USING (account_id = current_setting('app.current_account', true)::uuid)
  WITH CHECK (account_id = current_setting('app.current_account', true)::uuid);

INSERT INTO schema_migrations (migration_id) VALUES ('012_development_character_persona.sql');

COMMIT;

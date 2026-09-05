BEGIN;

-- Development persistence for asynchronous-from-chat TTS jobs. Audio bytes are
-- kept in the private object store, never in PostgreSQL or a public URL column.
CREATE TABLE IF NOT EXISTS media_jobs (
  job_id uuid PRIMARY KEY DEFAULT app.uuid_v7(),
  account_id uuid NOT NULL REFERENCES accounts(account_id),
  character_id uuid NOT NULL,
  conversation_id uuid NOT NULL REFERENCES conversations(conversation_id),
  source_message_id uuid NOT NULL REFERENCES messages(message_id),
  type text NOT NULL CHECK (type IN ('TTS')),
  state text NOT NULL CHECK (state IN ('PENDING', 'RUNNING', 'COMPLETED', 'BLOCKED', 'FAILED', 'DELETED')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0 AND attempts <= 2),
  provider text,
  provider_request_id text,
  moderation_policy_version text,
  result_asset_id uuid,
  failure_code text,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  deleted_at timestamptz,
  FOREIGN KEY (character_id, account_id) REFERENCES characters(character_id, account_id),
  UNIQUE (job_id, account_id)
);
CREATE INDEX media_jobs_account_created_idx ON media_jobs (account_id, created_at DESC) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS media_assets (
  asset_id uuid PRIMARY KEY DEFAULT app.uuid_v7(),
  account_id uuid NOT NULL REFERENCES accounts(account_id),
  character_id uuid NOT NULL,
  job_id uuid NOT NULL REFERENCES media_jobs(job_id),
  type text NOT NULL CHECK (type IN ('TTS_AUDIO')),
  state text NOT NULL CHECK (state IN ('AVAILABLE', 'DELETED')),
  media_type text NOT NULL CHECK (media_type IN ('AUDIO')),
  mime_type text NOT NULL CHECK (mime_type IN ('audio/mpeg')),
  byte_length integer NOT NULL CHECK (byte_length > 0 AND byte_length <= 10485760),
  checksum text NOT NULL CHECK (checksum ~ '^[a-f0-9]{64}$'),
  object_key text NOT NULL UNIQUE,
  provider text NOT NULL,
  provider_request_id text NOT NULL,
  ai_generated boolean NOT NULL DEFAULT true CHECK (ai_generated),
  aigc_mark_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  deleted_at timestamptz,
  FOREIGN KEY (character_id, account_id) REFERENCES characters(character_id, account_id),
  UNIQUE (asset_id, account_id)
);
CREATE INDEX media_assets_account_state_idx ON media_assets (account_id, state, created_at DESC) WHERE deleted_at IS NULL;

ALTER TABLE media_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE media_jobs FORCE ROW LEVEL SECURITY;
CREATE POLICY media_jobs_scope ON media_jobs FOR ALL TO qiyu_app
  USING (account_id = app.current_account_id()
    AND (app.current_character_id() IS NULL OR character_id = app.current_character_id()))
  WITH CHECK (account_id = app.current_account_id()
    AND (app.current_character_id() IS NULL OR character_id = app.current_character_id()));

ALTER TABLE media_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE media_assets FORCE ROW LEVEL SECURITY;
CREATE POLICY media_assets_scope ON media_assets FOR ALL TO qiyu_app
  USING (account_id = app.current_account_id()
    AND (app.current_character_id() IS NULL OR character_id = app.current_character_id()))
  WITH CHECK (account_id = app.current_account_id()
    AND (app.current_character_id() IS NULL OR character_id = app.current_character_id()));

CREATE TRIGGER media_jobs_touch_version BEFORE UPDATE ON media_jobs
  FOR EACH ROW EXECUTE FUNCTION app.touch_versioned_row();
CREATE TRIGGER media_assets_touch_version BEFORE UPDATE ON media_assets
  FOR EACH ROW EXECUTE FUNCTION app.touch_versioned_row();

GRANT SELECT, INSERT, UPDATE ON media_jobs, media_assets TO qiyu_app;
INSERT INTO schema_migrations (migration_id) VALUES ('005_development_media_tts.sql');

COMMIT;

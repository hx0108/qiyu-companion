BEGIN;

ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_status_check;
ALTER TABLE conversations ADD CONSTRAINT conversations_status_check
  CHECK (status IN ('ACTIVE', 'USER_PAUSED', 'CLOSED', 'DELETED'));

CREATE TABLE IF NOT EXISTS message_feedback (
  feedback_id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(account_id),
  message_id uuid NOT NULL REFERENCES messages(message_id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES conversations(conversation_id) ON DELETE CASCADE,
  type text NOT NULL CHECK (type IN ('OOC', 'MEMORY_ERROR', 'IMAGE_FACE_MISMATCH', 'IMAGE_WARDROBE_ERROR', 'IMAGE_SCENE_CONFLICT', 'UNSAFE_OR_UNCOMFORTABLE')),
  severity text NOT NULL CHECK (severity IN ('LOW', 'MEDIUM', 'HIGH')),
  note text,
  provider text,
  model_version text,
  world_state_id uuid,
  world_state_version bigint,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK ((world_state_id IS NULL AND world_state_version IS NULL) OR (world_state_id IS NOT NULL AND world_state_version > 0))
);
CREATE INDEX IF NOT EXISTS message_feedback_account_created_idx ON message_feedback (account_id, created_at DESC);
ALTER TABLE message_feedback ENABLE ROW LEVEL SECURITY;
ALTER TABLE message_feedback FORCE ROW LEVEL SECURITY;
CREATE POLICY message_feedback_scope ON message_feedback FOR ALL TO qiyu_app
  USING (account_id = app.current_account_id()) WITH CHECK (account_id = app.current_account_id());
GRANT SELECT, INSERT ON message_feedback TO qiyu_app;

INSERT INTO schema_migrations (migration_id) VALUES ('020_development_conversation_pause_feedback.sql');

COMMIT;

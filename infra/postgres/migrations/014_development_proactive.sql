BEGIN;

-- Proactive preferences live on the account; events reference user-confirmed
-- assets or explicit user settings (tech design 8.8). Dispatch decisions are
-- deterministic; the model only ever fills a template slot.
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS proactive_preferences_json jsonb NOT NULL DEFAULT '{"enabled":true,"quiet_start_hour":23,"quiet_end_hour":8,"timezone_offset_minutes":0}'::jsonb;

CREATE TABLE IF NOT EXISTS proactive_events (
  event_id text PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(account_id),
  character_id uuid,
  type text NOT NULL CHECK (type IN ('SUBSCRIBED_MORNING', 'SUBSCRIBED_EVENING', 'CONFIRMED_ANNIVERSARY', 'CONFIRMED_BIRTHDAY', 'CONFIRMED_APPOINTMENT', 'CONFIRMED_REALITY_ACTION')),
  title text NOT NULL,
  due_at timestamptz,
  time_of_day_local smallint CHECK (time_of_day_local IS NULL OR (time_of_day_local >= 0 AND time_of_day_local <= 23)),
  state text NOT NULL DEFAULT 'ACTIVE' CHECK (state IN ('ACTIVE', 'DELETED')),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS proactive_events_account_idx ON proactive_events (account_id, state);
ALTER TABLE proactive_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY proactive_events_scope ON proactive_events FOR ALL TO qiyu_app
  USING (account_id = current_setting('app.current_account', true)::uuid)
  WITH CHECK (account_id = current_setting('app.current_account', true)::uuid);

CREATE TABLE IF NOT EXISTS proactive_messages (
  message_id text PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(account_id),
  character_id uuid,
  event_id text,
  kind text NOT NULL CHECK (kind IN ('NORMAL', 'SYSTEM')),
  template_slot text NOT NULL,
  text text NOT NULL,
  sent_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS proactive_messages_account_idx ON proactive_messages (account_id, sent_at DESC);
ALTER TABLE proactive_messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY proactive_messages_scope ON proactive_messages FOR ALL TO qiyu_app
  USING (account_id = current_setting('app.current_account', true)::uuid)
  WITH CHECK (account_id = current_setting('app.current_account', true)::uuid);

INSERT INTO schema_migrations (migration_id) VALUES ('014_development_proactive.sql');

COMMIT;

BEGIN;

-- Short-lived, user-visible scene state. It is deliberately separate from
-- persona, safety, age and relationship-asset facts.
CREATE TABLE IF NOT EXISTS character_world_states (
  world_state_id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(account_id),
  character_id uuid NOT NULL UNIQUE REFERENCES characters(character_id),
  mood_code text NOT NULL CHECK (mood_code IN ('CALM', 'HAPPY', 'TIRED', 'CONCERNED', 'NEUTRAL')),
  location_code text NOT NULL CHECK (location_code IN ('UNSPECIFIED', 'HOME', 'CAFE', 'PARK', 'STUDIO', 'LIBRARY', 'WORKPLACE')),
  wardrobe_asset_id uuid,
  active_event_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  source text NOT NULL CHECK (source IN ('TEMPLATE_DEFAULT', 'USER_PATCH', 'USER_RESET', 'SYSTEM_EXPIRED')),
  state_version bigint NOT NULL CHECK (state_version > 0),
  expires_at timestamptz,
  reset_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS world_state_events (
  event_id uuid PRIMARY KEY,
  world_state_id uuid NOT NULL REFERENCES character_world_states(world_state_id),
  account_id uuid NOT NULL REFERENCES accounts(account_id),
  character_id uuid NOT NULL REFERENCES characters(character_id),
  patch_json jsonb NOT NULL,
  source_type text NOT NULL CHECK (source_type IN ('TEMPLATE_DEFAULT', 'USER_PATCH', 'USER_RESET', 'SYSTEM_EXPIRED')),
  previous_version bigint NOT NULL CHECK (previous_version >= 0),
  new_version bigint NOT NULL CHECK (new_version > previous_version),
  occurred_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS world_state_events_account_idx ON world_state_events (account_id, character_id, new_version DESC);
ALTER TABLE character_world_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE character_world_states FORCE ROW LEVEL SECURITY;
CREATE POLICY character_world_states_scope ON character_world_states FOR ALL TO qiyu_app
  USING (account_id = app.current_account_id()) WITH CHECK (account_id = app.current_account_id());
ALTER TABLE world_state_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE world_state_events FORCE ROW LEVEL SECURITY;
CREATE POLICY world_state_events_scope ON world_state_events FOR ALL TO qiyu_app
  USING (account_id = app.current_account_id()) WITH CHECK (account_id = app.current_account_id());
GRANT SELECT, INSERT, UPDATE ON character_world_states TO qiyu_app;
GRANT SELECT, INSERT ON world_state_events TO qiyu_app;
INSERT INTO schema_migrations (migration_id) VALUES ('017_development_world_state.sql');
COMMIT;

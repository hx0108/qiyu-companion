BEGIN;

ALTER TABLE accounts ADD COLUMN trial_behavior_enabled boolean NOT NULL DEFAULT false;

CREATE TABLE trial_behavior_events (
  account_id uuid NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
  event_id uuid NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('relationship_action', 'access_info_viewed')),
  character_id uuid,
  schema_version smallint NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  received_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (account_id, event_id),
  CHECK ((event_type = 'relationship_action') = (character_id IS NOT NULL))
);

CREATE INDEX trial_behavior_events_account_time_idx ON trial_behavior_events (account_id, received_at);
CREATE INDEX trial_behavior_events_expiry_idx ON trial_behavior_events (received_at);
ALTER TABLE trial_behavior_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE trial_behavior_events FORCE ROW LEVEL SECURITY;
CREATE POLICY trial_behavior_account_scope ON trial_behavior_events TO qiyu_app
  USING (account_id = app.current_account_id())
  WITH CHECK (account_id = app.current_account_id());
GRANT SELECT, INSERT, DELETE ON trial_behavior_events TO qiyu_app;

CREATE FUNCTION app.clear_trial_behavior_events() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM public.trial_behavior_events WHERE account_id = NEW.account_id;
  RETURN NEW;
END;
$$;

CREATE TRIGGER clear_trial_behavior_events
  AFTER UPDATE OF trial_behavior_enabled, account_status, deleted_at ON accounts
  FOR EACH ROW
  WHEN ((OLD.trial_behavior_enabled AND NOT NEW.trial_behavior_enabled)
    OR (OLD.account_status = 'OPEN' AND NEW.account_status <> 'OPEN')
    OR (OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL))
  EXECUTE FUNCTION app.clear_trial_behavior_events();

INSERT INTO schema_migrations(migration_id) VALUES ('113_closed_trial_behavior.sql');
COMMIT;

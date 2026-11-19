BEGIN;

ALTER TABLE accounts
  ADD COLUMN trial_relationship_processing_enabled boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT trial_processing_requires_behavior CHECK (
    NOT trial_relationship_processing_enabled OR trial_behavior_enabled
  ) NOT VALID;

ALTER TABLE trial_behavior_events
  ADD COLUMN action_kind text NOT NULL DEFAULT 'VIEW',
  ADD CONSTRAINT trial_behavior_events_action_kind CHECK (
    action_kind = 'VIEW' OR
    (action_kind = 'PROCESS' AND event_type = 'relationship_action' AND schema_version = 1)
  ) NOT VALID;

CREATE FUNCTION app.record_trial_relationship_processing() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM account_id
  FROM public.accounts
  WHERE account_id = NEW.account_id AND account_status = 'OPEN' AND deleted_at IS NULL
    AND trial_relationship_processing_enabled
  FOR UPDATE;

  IF FOUND THEN
    INSERT INTO public.trial_behavior_events (account_id, event_id, event_type, character_id, action_kind)
    VALUES (NEW.account_id, app.uuid_v7(), 'relationship_action', NEW.character_id, 'PROCESS');
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER record_trial_relationship_processing
  AFTER INSERT ON relationship_assets
  FOR EACH ROW
  WHEN (NEW.activation_actor = 'USER' AND NEW.state = 'ACTIVE' AND NEW.deleted_at IS NULL)
  EXECUTE FUNCTION app.record_trial_relationship_processing();

INSERT INTO schema_migrations(migration_id) VALUES ('116_trial_relationship_processing.sql');
COMMIT;

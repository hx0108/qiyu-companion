BEGIN;

ALTER TABLE trial_behavior_events
  DROP CONSTRAINT trial_behavior_events_schema_version_check,
  ADD COLUMN entry_surface text,
  ADD COLUMN client_build text,
  ADD COLUMN client_observed_at timestamptz,
  ADD CONSTRAINT trial_behavior_events_schema_shape CHECK (
    (schema_version = 1 AND entry_surface IS NULL AND client_build IS NULL AND client_observed_at IS NULL)
    OR
    (schema_version = 2
      AND entry_surface IS NOT NULL AND entry_surface IN ('home','chat','profile','data','assets','subscription','other')
      AND client_build IS NOT NULL AND client_build ~ '^(unversioned|[0-9]{8}-[a-z0-9-]{1,40})$'
      AND client_observed_at IS NOT NULL)
  ) NOT VALID;

INSERT INTO schema_migrations(migration_id) VALUES ('115_trial_behavior_delivery_metadata.sql');
COMMIT;

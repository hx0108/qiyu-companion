BEGIN;

-- A safe, machine-readable provider error code supports internal retry and
-- support diagnosis. It is not exposed by the user-facing media API and never
-- stores an upstream message, callback payload, URL, or credential.
ALTER TABLE media_jobs ADD COLUMN IF NOT EXISTS provider_error_code text;
ALTER TABLE media_jobs ADD CONSTRAINT media_jobs_provider_error_code_check CHECK (
  provider_error_code IS NULL OR provider_error_code ~ '^[A-Za-z0-9._-]{1,128}$'
);

INSERT INTO schema_migrations (migration_id) VALUES ('009_development_media_provider_diagnostics.sql');

COMMIT;

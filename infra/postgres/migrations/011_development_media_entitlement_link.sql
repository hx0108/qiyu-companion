BEGIN;

-- Links a media job to the immutable subscription-period entitlement chosen at
-- reservation time. The append-only ledger remains the source of truth.
ALTER TABLE media_jobs ADD COLUMN IF NOT EXISTS entitlement_id text;
CREATE INDEX IF NOT EXISTS media_jobs_entitlement_idx ON media_jobs (account_id, entitlement_id) WHERE entitlement_id IS NOT NULL AND deleted_at IS NULL;

INSERT INTO schema_migrations (migration_id) VALUES ('011_development_media_entitlement_link.sql');

COMMIT;

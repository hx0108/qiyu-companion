BEGIN;

-- The SECURITY DEFINER reviewer function updates only media_assets.state, but
-- PostgreSQL also requires SELECT on the columns used by its ownership/type
-- predicate. Keep the grant limited to the rights-service role and columns.
GRANT SELECT (asset_id, account_id, type) ON media_assets TO qiyu_rights_service;

INSERT INTO schema_migrations (migration_id) VALUES ('047_development_rights_service_reference_asset_read.sql');

COMMIT;

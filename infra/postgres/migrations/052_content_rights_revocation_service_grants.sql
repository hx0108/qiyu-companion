BEGIN;

-- Reassert the narrow privileges required by the SECURITY DEFINER approval
-- and revocation functions. The role remains NOLOGIN/NOINHERIT and callers
-- receive no direct table DML.
GRANT USAGE ON SCHEMA app, public TO qiyu_rights_service;
GRANT SELECT ON content_rights_reviewer_identities, content_rights_reviews, media_assets, media_jobs TO qiyu_rights_service;
GRANT UPDATE (state, reviewer_id, decision_reason, updated_at) ON content_rights_reviews TO qiyu_rights_service;
GRANT UPDATE (state, deleted_at) ON media_assets TO qiyu_rights_service;
GRANT UPDATE (state) ON oc_imports TO qiyu_rights_service;
GRANT INSERT ON content_rights_review_decisions, outbox_events, audit_events TO qiyu_rights_service;

INSERT INTO schema_migrations (migration_id) VALUES ('052_content_rights_revocation_service_grants.sql');
COMMIT;

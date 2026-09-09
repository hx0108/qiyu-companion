BEGIN;

-- qiyu_reviewer may execute the explicitly granted review functions in the
-- app schema, but must not receive table DML or role-switch privileges.
GRANT USAGE ON SCHEMA app TO qiyu_reviewer;

INSERT INTO schema_migrations (migration_id) VALUES ('051_content_rights_reviewer_app_schema_usage.sql');
COMMIT;

BEGIN;

-- Existing local volumes do not rerun init scripts. Grant only the current
-- migration owner membership so the API can SET LOCAL ROLE qiyu_app; this does
-- not turn qiyu_app into a login role or embed a password in source control.
DO $$
BEGIN
  EXECUTE format('GRANT qiyu_app TO %I', current_user);
END
$$;

INSERT INTO schema_migrations (migration_id) VALUES ('004_development_app_role_membership.sql');
COMMIT;

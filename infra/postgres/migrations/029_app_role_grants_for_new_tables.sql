BEGIN;

-- 迁移 012 起新增的表只建了 RLS 策略，漏授 qiyu_app 的表级 DML 权限，
-- 导致 Postgres 持久化模式在请求作用域（SET LOCAL ROLE qiyu_app）下 42501。
-- 本迁移按既有惯例（见 001/003 的 GRANT）补齐；schema_migrations 只读授 SELECT。
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  persona_versions, emergency_contacts, complaints,
  proactive_events, proactive_messages,
  payment_event_quarantines,
  age_review_decisions,
  content_rights_reviewer_identities, content_rights_review_decisions,
  content_rights_cleanup_jobs, operation_metrics
TO qiyu_app;
GRANT SELECT ON TABLE schema_migrations TO qiyu_app;

INSERT INTO schema_migrations (migration_id) VALUES ('029_app_role_grants_for_new_tables.sql');

COMMIT;

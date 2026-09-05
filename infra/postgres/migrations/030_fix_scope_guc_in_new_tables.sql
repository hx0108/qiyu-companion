BEGIN;

-- 迁移 012/013/014/028 新表策略误用不存在的 GUC 'app.current_account'（基线 002
-- 的惯例是 app.current_account_id() 函数，读 'app.account_id'），导致请求作用域
-- 下这些表恒不可写（42501）。统一重建为基线同款表达式。
DROP POLICY IF EXISTS persona_versions_scope ON persona_versions;
CREATE POLICY persona_versions_scope ON persona_versions FOR ALL TO qiyu_app
  USING (account_id = app.current_account_id())
  WITH CHECK (account_id = app.current_account_id());

DROP POLICY IF EXISTS emergency_contacts_scope ON emergency_contacts;
CREATE POLICY emergency_contacts_scope ON emergency_contacts FOR ALL TO qiyu_app
  USING (account_id = app.current_account_id())
  WITH CHECK (account_id = app.current_account_id());

DROP POLICY IF EXISTS complaints_scope ON complaints;
CREATE POLICY complaints_scope ON complaints FOR ALL TO qiyu_app
  USING (account_id = app.current_account_id())
  WITH CHECK (account_id = app.current_account_id());

DROP POLICY IF EXISTS proactive_events_scope ON proactive_events;
CREATE POLICY proactive_events_scope ON proactive_events FOR ALL TO qiyu_app
  USING (account_id = app.current_account_id())
  WITH CHECK (account_id = app.current_account_id());

DROP POLICY IF EXISTS proactive_messages_scope ON proactive_messages;
CREATE POLICY proactive_messages_scope ON proactive_messages FOR ALL TO qiyu_app
  USING (account_id = app.current_account_id())
  WITH CHECK (account_id = app.current_account_id());

DROP POLICY IF EXISTS age_review_decisions_scope ON age_review_decisions;
CREATE POLICY age_review_decisions_scope ON age_review_decisions FOR ALL TO qiyu_app
  USING (account_id = app.current_account_id())
  WITH CHECK (account_id = app.current_account_id());

INSERT INTO schema_migrations (migration_id) VALUES ('030_fix_scope_guc_in_new_tables.sql');

COMMIT;

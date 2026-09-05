BEGIN;

-- These policies require the API transaction to call
-- SELECT set_config('app.account_id', :authenticated_account_id, true)
-- and, for role-scoped work, set app.character_id as well. They complement,
-- rather than replace, repository methods that take the authenticated scope.
ALTER TABLE accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE accounts FORCE ROW LEVEL SECURITY;
CREATE POLICY accounts_scope ON accounts FOR ALL TO qiyu_app
  USING (account_id = app.current_account_id())
  WITH CHECK (account_id = app.current_account_id());

ALTER TABLE age_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE age_decisions FORCE ROW LEVEL SECURITY;
CREATE POLICY age_decisions_scope ON age_decisions FOR ALL TO qiyu_app
  USING (account_id = app.current_account_id()) WITH CHECK (account_id = app.current_account_id());

ALTER TABLE account_interaction_controls ENABLE ROW LEVEL SECURITY;
ALTER TABLE account_interaction_controls FORCE ROW LEVEL SECURITY;
CREATE POLICY interaction_controls_scope ON account_interaction_controls FOR ALL TO qiyu_app
  USING (account_id = app.current_account_id()) WITH CHECK (account_id = app.current_account_id());

ALTER TABLE required_notices ENABLE ROW LEVEL SECURITY;
ALTER TABLE required_notices FORCE ROW LEVEL SECURITY;
CREATE POLICY required_notices_scope ON required_notices FOR ALL TO qiyu_app
  USING (account_id = app.current_account_id()) WITH CHECK (account_id = app.current_account_id());

ALTER TABLE characters ENABLE ROW LEVEL SECURITY;
ALTER TABLE characters FORCE ROW LEVEL SECURITY;
CREATE POLICY characters_scope ON characters FOR ALL TO qiyu_app
  USING (account_id = app.current_account_id()
    AND (app.current_character_id() IS NULL OR character_id = app.current_character_id()))
  WITH CHECK (account_id = app.current_account_id()
    AND (app.current_character_id() IS NULL OR character_id = app.current_character_id()));

ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversations FORCE ROW LEVEL SECURITY;
CREATE POLICY conversations_scope ON conversations FOR ALL TO qiyu_app
  USING (account_id = app.current_account_id()
    AND (app.current_character_id() IS NULL OR character_id = app.current_character_id()))
  WITH CHECK (account_id = app.current_account_id()
    AND (app.current_character_id() IS NULL OR character_id = app.current_character_id()));

ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages FORCE ROW LEVEL SECURITY;
CREATE POLICY messages_scope ON messages FOR ALL TO qiyu_app
  USING (EXISTS (SELECT 1 FROM conversations c WHERE c.conversation_id = messages.conversation_id
    AND c.account_id = app.current_account_id()
    AND (app.current_character_id() IS NULL OR c.character_id = app.current_character_id())))
  WITH CHECK (EXISTS (SELECT 1 FROM conversations c WHERE c.conversation_id = messages.conversation_id
    AND c.account_id = app.current_account_id()
    AND (app.current_character_id() IS NULL OR c.character_id = app.current_character_id())));

ALTER TABLE memory_candidates ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_candidates FORCE ROW LEVEL SECURITY;
CREATE POLICY memory_candidates_scope ON memory_candidates FOR ALL TO qiyu_app
  USING (account_id = app.current_account_id()
    AND (app.current_character_id() IS NULL OR character_id = app.current_character_id()))
  WITH CHECK (account_id = app.current_account_id()
    AND (app.current_character_id() IS NULL OR character_id = app.current_character_id()));

ALTER TABLE relationship_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE relationship_assets FORCE ROW LEVEL SECURITY;
CREATE POLICY relationship_assets_scope ON relationship_assets FOR ALL TO qiyu_app
  USING (account_id = app.current_account_id()
    AND (app.current_character_id() IS NULL OR character_id = app.current_character_id()))
  WITH CHECK (account_id = app.current_account_id()
    AND (app.current_character_id() IS NULL OR character_id = app.current_character_id()));

ALTER TABLE relationship_asset_embeddings ENABLE ROW LEVEL SECURITY;
ALTER TABLE relationship_asset_embeddings FORCE ROW LEVEL SECURITY;
CREATE POLICY relationship_asset_embeddings_scope ON relationship_asset_embeddings FOR ALL TO qiyu_app
  USING (account_id = app.current_account_id()
    AND (app.current_character_id() IS NULL OR character_id = app.current_character_id()))
  WITH CHECK (account_id = app.current_account_id()
    AND (app.current_character_id() IS NULL OR character_id = app.current_character_id()));

ALTER TABLE deletion_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE deletion_jobs FORCE ROW LEVEL SECURITY;
CREATE POLICY deletion_jobs_scope ON deletion_jobs FOR ALL TO qiyu_app
  USING (account_id = app.current_account_id()) WITH CHECK (account_id = app.current_account_id());

ALTER TABLE deletion_targets ENABLE ROW LEVEL SECURITY;
ALTER TABLE deletion_targets FORCE ROW LEVEL SECURITY;
CREATE POLICY deletion_targets_scope ON deletion_targets FOR ALL TO qiyu_app
  USING (account_id = app.current_account_id()) WITH CHECK (account_id = app.current_account_id());

ALTER TABLE idempotency_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE idempotency_keys FORCE ROW LEVEL SECURITY;
CREATE POLICY idempotency_keys_scope ON idempotency_keys FOR ALL TO qiyu_app
  USING (account_id = app.current_account_id()) WITH CHECK (account_id = app.current_account_id());

ALTER TABLE outbox_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbox_events FORCE ROW LEVEL SECURITY;
CREATE POLICY outbox_events_scope ON outbox_events FOR ALL TO qiyu_app
  USING (account_id = app.current_account_id()
    AND (app.current_character_id() IS NULL OR character_id IS NULL OR character_id = app.current_character_id()))
  WITH CHECK (account_id = app.current_account_id()
    AND (app.current_character_id() IS NULL OR character_id IS NULL OR character_id = app.current_character_id()));

ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events FORCE ROW LEVEL SECURITY;
CREATE POLICY audit_events_select_scope ON audit_events FOR SELECT TO qiyu_app
  USING (account_id = app.current_account_id()
    AND (app.current_character_id() IS NULL OR character_id IS NULL OR character_id = app.current_character_id()));
CREATE POLICY audit_events_insert_scope ON audit_events FOR INSERT TO qiyu_app
  WITH CHECK (account_id = app.current_account_id()
    AND (app.current_character_id() IS NULL OR character_id IS NULL OR character_id = app.current_character_id()));

INSERT INTO schema_migrations (migration_id) VALUES ('002_row_level_security.sql');

COMMIT;

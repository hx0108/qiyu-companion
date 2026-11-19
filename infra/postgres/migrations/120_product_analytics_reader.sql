BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'qiyu_product_analytics_reader') THEN
    CREATE ROLE qiyu_product_analytics_reader NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION;
  ELSIF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'qiyu_product_analytics_reader'
    AND (rolcanlogin OR rolinherit OR rolsuper OR rolcreatedb OR rolcreaterole OR rolbypassrls OR rolreplication)) THEN
    RAISE EXCEPTION 'Invalid product analytics reader role';
  END IF;
END $$;
GRANT USAGE ON SCHEMA public TO qiyu_product_analytics_reader;

GRANT SELECT (account_id, first_claimed_at) ON trial_invites TO qiyu_product_analytics_reader;
GRANT SELECT (account_id, created_at, deleted_at, status) ON characters TO qiyu_product_analytics_reader;
GRANT SELECT (account_id, character_id, conversation_id, deleted_at, status) ON conversations TO qiyu_product_analytics_reader;
GRANT SELECT (message_id, conversation_id, actor, provider, created_at, deleted_at, call_session_id,
  effective_chat_source_id, effective_chat_started_at, effective_chat_session_key) ON messages TO qiyu_product_analytics_reader;
GRANT SELECT (account_id, call_session_id, user_message_id, assistant_message_id, created_at, ended_at, state,
  interrupted) ON call_turns TO qiyu_product_analytics_reader;
GRANT SELECT (account_id, event_id, character_id, event_type, action_kind, received_at, entry_surface,
  client_build, client_observed_at) ON trial_behavior_events TO qiyu_product_analytics_reader;
GRANT SELECT (account_id, type, severity, created_at) ON message_feedback TO qiyu_product_analytics_reader;
GRANT SELECT (account_id, exposure_id, sku, amount_fen, currency, billing_cycle, viewed_at,
  clicked_at) ON development_offer_exposures TO qiyu_product_analytics_reader;
GRANT SELECT (order_id, account_id, subscription_id, sku, amount_fen, currency, channel, auto_renew, created_at,
  development_exposure_id) ON subscription_orders TO qiyu_product_analytics_reader;
GRANT SELECT (account_id, subscription_id, channel, period_start, period_end) ON subscriptions TO qiyu_product_analytics_reader;
GRANT SELECT (account_id, subscription_id, provider_event_id, event_type, outcome, created_at, refund_amount_fen,
  refund_currency) ON payment_events TO qiyu_product_analytics_reader;
GRANT SELECT (account_id, entitlement_id, source_event_id, source, action, created_at) ON entitlement_ledgers TO qiyu_product_analytics_reader;

CREATE POLICY product_analytics_read ON characters FOR SELECT TO qiyu_product_analytics_reader USING (true);
CREATE POLICY product_analytics_read ON conversations FOR SELECT TO qiyu_product_analytics_reader USING (true);
CREATE POLICY product_analytics_read ON messages FOR SELECT TO qiyu_product_analytics_reader USING (true);
CREATE POLICY product_analytics_read ON call_turns FOR SELECT TO qiyu_product_analytics_reader USING (true);
CREATE POLICY product_analytics_read ON trial_behavior_events FOR SELECT TO qiyu_product_analytics_reader USING (true);
CREATE POLICY product_analytics_read ON message_feedback FOR SELECT TO qiyu_product_analytics_reader USING (true);
CREATE POLICY product_analytics_read ON development_offer_exposures FOR SELECT TO qiyu_product_analytics_reader USING (true);
CREATE POLICY product_analytics_read ON subscription_orders FOR SELECT TO qiyu_product_analytics_reader USING (channel = 'DEVELOPMENT_SIMULATED');
CREATE POLICY product_analytics_read ON subscriptions FOR SELECT TO qiyu_product_analytics_reader USING (channel = 'DEVELOPMENT_TRIAL');
CREATE POLICY product_analytics_read ON payment_events FOR SELECT TO qiyu_product_analytics_reader USING (
  EXISTS (SELECT 1 FROM subscription_orders AS orders WHERE orders.account_id = payment_events.account_id
    AND orders.subscription_id = payment_events.subscription_id AND orders.channel = 'DEVELOPMENT_SIMULATED'));
CREATE POLICY product_analytics_read ON entitlement_ledgers FOR SELECT TO qiyu_product_analytics_reader USING (source = 'PAYMENT_VERIFIED');

INSERT INTO schema_migrations(migration_id) VALUES ('120_product_analytics_reader.sql');
COMMIT;

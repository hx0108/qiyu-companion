BEGIN;

ALTER POLICY product_analytics_read ON characters USING (
  EXISTS (SELECT 1 FROM trial_invites AS invite WHERE invite.account_id = characters.account_id AND invite.first_claimed_at IS NOT NULL));
ALTER POLICY product_analytics_read ON conversations USING (
  EXISTS (SELECT 1 FROM trial_invites AS invite WHERE invite.account_id = conversations.account_id AND invite.first_claimed_at IS NOT NULL));
ALTER POLICY product_analytics_read ON messages USING (
  EXISTS (SELECT 1 FROM conversations AS conversation WHERE conversation.conversation_id = messages.conversation_id));
ALTER POLICY product_analytics_read ON call_turns USING (
  EXISTS (SELECT 1 FROM trial_invites AS invite WHERE invite.account_id = call_turns.account_id AND invite.first_claimed_at IS NOT NULL));
ALTER POLICY product_analytics_read ON trial_behavior_events USING (
  EXISTS (SELECT 1 FROM trial_invites AS invite WHERE invite.account_id = trial_behavior_events.account_id AND invite.first_claimed_at IS NOT NULL));
ALTER POLICY product_analytics_read ON message_feedback USING (
  EXISTS (SELECT 1 FROM trial_invites AS invite WHERE invite.account_id = message_feedback.account_id AND invite.first_claimed_at IS NOT NULL));
ALTER POLICY product_analytics_read ON entitlement_ledgers USING (
  source = 'PAYMENT_VERIFIED' AND EXISTS (SELECT 1 FROM payment_events AS payment
    WHERE payment.account_id = entitlement_ledgers.account_id AND payment.provider_event_id = entitlement_ledgers.source_event_id));

INSERT INTO schema_migrations(migration_id) VALUES ('122_product_analytics_cohort_scope.sql');
COMMIT;

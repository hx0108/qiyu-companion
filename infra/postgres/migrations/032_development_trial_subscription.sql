BEGIN;

-- The free seven-day complete-experience trial has no order or payment event.
-- Keep it explicit and local-development-only, so it cannot be mistaken for a
-- provider-confirmed Alipay/WeChat transaction.
ALTER TABLE subscriptions DROP CONSTRAINT IF EXISTS subscriptions_channel_check;
ALTER TABLE subscriptions ADD CONSTRAINT subscriptions_channel_check
  CHECK (channel IN ('ALIPAY_H5', 'WECHAT_H5', 'DEVELOPMENT_SIMULATED', 'DEVELOPMENT_TRIAL'));

ALTER TABLE subscriptions DROP CONSTRAINT IF EXISTS subscriptions_state_check;
ALTER TABLE subscriptions ADD CONSTRAINT subscriptions_state_check
  CHECK (state IN ('PENDING', 'TRIAL', 'ACTIVE', 'BILLING_RETRY', 'GRACE_PERIOD', 'CANCEL_AT_PERIOD_END', 'EXPIRED', 'REFUNDED', 'REVOKED'));

INSERT INTO schema_migrations (migration_id) VALUES ('032_development_trial_subscription.sql');

COMMIT;

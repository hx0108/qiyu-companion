BEGIN;

-- The local-only simulated checkout is a distinct internal channel. It must
-- be explicit in persisted state, while real payment channels remain limited
-- to the provider-normalized values below.
ALTER TABLE subscriptions DROP CONSTRAINT IF EXISTS subscriptions_channel_check;
ALTER TABLE subscriptions ADD CONSTRAINT subscriptions_channel_check
  CHECK (channel IN ('ALIPAY_H5', 'WECHAT_H5', 'DEVELOPMENT_SIMULATED'));

ALTER TABLE subscription_orders DROP CONSTRAINT IF EXISTS subscription_orders_channel_check;
ALTER TABLE subscription_orders ADD CONSTRAINT subscription_orders_channel_check
  CHECK (channel IN ('ALIPAY_H5', 'WECHAT_H5', 'DEVELOPMENT_SIMULATED'));

INSERT INTO schema_migrations (migration_id) VALUES ('016_development_simulated_payment_channel.sql');

COMMIT;

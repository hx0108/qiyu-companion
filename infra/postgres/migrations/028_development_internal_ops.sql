BEGIN;

-- 封测期线下收款通道：用户人工转账、运营经 /internal 人工发放并留痕；
-- 退款由运营撤销（REVOKED），生产真实渠道接入前不得对外自动开通。
ALTER TABLE subscriptions DROP CONSTRAINT IF EXISTS subscriptions_channel_check;
ALTER TABLE subscriptions ADD CONSTRAINT subscriptions_channel_check
  CHECK (channel IN ('ALIPAY_H5', 'WECHAT_H5', 'DEVELOPMENT_SIMULATED', 'MANUAL_OFFLINE_PAYMENT'));
ALTER TABLE subscription_orders DROP CONSTRAINT IF EXISTS subscription_orders_channel_check;
ALTER TABLE subscription_orders ADD CONSTRAINT subscription_orders_channel_check
  CHECK (channel IN ('ALIPAY_H5', 'WECHAT_H5', 'DEVELOPMENT_SIMULATED', 'MANUAL_OFFLINE_PAYMENT'));
ALTER TABLE subscription_orders DROP CONSTRAINT IF EXISTS subscription_orders_state_check;
ALTER TABLE subscription_orders ADD CONSTRAINT subscription_orders_state_check
  CHECK (state IN ('PENDING_PAYMENT', 'PAID', 'CLOSED', 'REFUNDED', 'PAID_OFFLINE'));

-- 年龄人工复核决策（FB 级：第三方断言接入前的运营复核留痕）。
CREATE TABLE IF NOT EXISTS age_review_decisions (
  decision_id text PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(account_id),
  reviewer_id text NOT NULL,
  decision text NOT NULL CHECK (decision IN ('PASS', 'DENIED_MINOR', 'MAINTAIN_REVIEW')),
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 1000),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS age_review_decisions_account_idx ON age_review_decisions (account_id, created_at DESC);
ALTER TABLE age_review_decisions ENABLE ROW LEVEL SECURITY;
CREATE POLICY age_review_decisions_scope ON age_review_decisions FOR ALL TO qiyu_app
  USING (account_id = current_setting('app.current_account', true)::uuid)
  WITH CHECK (account_id = current_setting('app.current_account', true)::uuid);

INSERT INTO schema_migrations (migration_id) VALUES ('028_development_internal_ops.sql');

COMMIT;

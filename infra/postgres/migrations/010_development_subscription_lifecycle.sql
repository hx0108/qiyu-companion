BEGIN;

-- No raw payment notification, signature, bank/card value, or checkout URL is
-- persisted. A real provider adapter verifies those values before it writes
-- the minimal normalized event and its SHA-256 event hash.
CREATE TABLE IF NOT EXISTS subscriptions (
  subscription_id uuid PRIMARY KEY DEFAULT app.uuid_v7(),
  account_id uuid NOT NULL REFERENCES accounts(account_id),
  sku text NOT NULL,
  channel text NOT NULL CHECK (channel IN ('ALIPAY_H5', 'WECHAT_H5')),
  state text NOT NULL CHECK (state IN ('PENDING', 'ACTIVE', 'BILLING_RETRY', 'GRACE_PERIOD', 'CANCEL_AT_PERIOD_END', 'EXPIRED', 'REFUNDED', 'REVOKED')),
  auto_renew boolean NOT NULL DEFAULT false,
  disclosure_version text NOT NULL,
  period_start timestamptz,
  period_end timestamptz,
  grace_period_end timestamptz,
  refund_status text NOT NULL DEFAULT 'NONE' CHECK (refund_status IN ('NONE', 'PARTIAL', 'FULL')),
  transaction_ref_hash text,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  CHECK ((state = 'PENDING' AND period_start IS NULL AND period_end IS NULL) OR (state <> 'PENDING' AND period_start IS NOT NULL AND period_end IS NOT NULL AND period_start < period_end))
);
CREATE INDEX subscriptions_account_state_idx ON subscriptions (account_id, state, period_end) WHERE state NOT IN ('EXPIRED', 'REFUNDED', 'REVOKED');

CREATE TABLE IF NOT EXISTS subscription_orders (
  order_id uuid PRIMARY KEY DEFAULT app.uuid_v7(),
  account_id uuid NOT NULL REFERENCES accounts(account_id),
  subscription_id uuid NOT NULL REFERENCES subscriptions(subscription_id),
  sku text NOT NULL,
  amount_fen integer NOT NULL CHECK (amount_fen > 0),
  currency text NOT NULL CHECK (currency = 'CNY'),
  state text NOT NULL CHECK (state IN ('PENDING_PAYMENT', 'PAID', 'CLOSED', 'REFUNDED')),
  channel text NOT NULL CHECK (channel IN ('ALIPAY_H5', 'WECHAT_H5')),
  auto_renew boolean NOT NULL DEFAULT false,
  disclosure_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (subscription_id, account_id)
);

CREATE TABLE IF NOT EXISTS payment_events (
  provider_event_id text PRIMARY KEY,
  account_id uuid REFERENCES accounts(account_id),
  subscription_id uuid REFERENCES subscriptions(subscription_id),
  event_type text NOT NULL,
  transaction_ref_hash text NOT NULL,
  event_hash text NOT NULL CHECK (event_hash ~ '^[a-f0-9]{64}$'),
  outcome text NOT NULL CHECK (outcome IN ('APPLIED', 'QUARANTINED')),
  quarantine_reason text,
  effective_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK ((outcome = 'APPLIED' AND account_id IS NOT NULL AND subscription_id IS NOT NULL AND quarantine_reason IS NULL) OR (outcome = 'QUARANTINED' AND quarantine_reason IS NOT NULL))
);
CREATE INDEX payment_events_account_created_idx ON payment_events (account_id, created_at DESC);
CREATE INDEX payment_events_transaction_owner_idx ON payment_events (transaction_ref_hash, account_id) WHERE outcome = 'APPLIED';

CREATE TABLE IF NOT EXISTS payment_event_quarantines (
  provider_event_id text PRIMARY KEY REFERENCES payment_events(provider_event_id),
  reason text NOT NULL,
  received_at timestamptz NOT NULL,
  resolved_at timestamptz,
  resolution_note text
);

ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriptions FORCE ROW LEVEL SECURITY;
CREATE POLICY subscriptions_scope ON subscriptions FOR ALL TO qiyu_app
  USING (account_id = app.current_account_id()) WITH CHECK (account_id = app.current_account_id());
ALTER TABLE subscription_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscription_orders FORCE ROW LEVEL SECURITY;
CREATE POLICY subscription_orders_scope ON subscription_orders FOR ALL TO qiyu_app
  USING (account_id = app.current_account_id()) WITH CHECK (account_id = app.current_account_id());
ALTER TABLE payment_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_events FORCE ROW LEVEL SECURITY;
CREATE POLICY payment_events_scope ON payment_events FOR ALL TO qiyu_app
  USING (account_id = app.current_account_id()) WITH CHECK (account_id = app.current_account_id());

CREATE TRIGGER subscriptions_touch_version BEFORE UPDATE ON subscriptions
  FOR EACH ROW EXECUTE FUNCTION app.touch_versioned_row();
GRANT SELECT, INSERT, UPDATE ON subscriptions, subscription_orders TO qiyu_app;
GRANT SELECT, INSERT ON payment_events TO qiyu_app;
INSERT INTO schema_migrations (migration_id) VALUES ('010_development_subscription_lifecycle.sql');

COMMIT;

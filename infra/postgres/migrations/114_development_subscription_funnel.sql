BEGIN;

CREATE TABLE development_offer_exposures (
  account_id uuid NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
  exposure_id uuid NOT NULL,
  sku text NOT NULL,
  amount_fen integer NOT NULL CHECK (amount_fen > 0),
  currency text NOT NULL CHECK (currency = 'CNY'),
  billing_cycle text NOT NULL CHECK (billing_cycle IN ('MONTH', 'QUARTER')),
  viewed_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  clicked_at timestamptz,
  PRIMARY KEY (account_id, exposure_id)
);

CREATE INDEX development_offer_exposures_viewed_idx ON development_offer_exposures (viewed_at);
ALTER TABLE development_offer_exposures ENABLE ROW LEVEL SECURITY;
ALTER TABLE development_offer_exposures FORCE ROW LEVEL SECURITY;
CREATE POLICY development_offer_account_scope ON development_offer_exposures TO qiyu_app
  USING (account_id = app.current_account_id())
  WITH CHECK (account_id = app.current_account_id());
GRANT SELECT, INSERT, UPDATE ON development_offer_exposures TO qiyu_app;

ALTER TABLE subscription_orders ADD COLUMN development_exposure_id uuid;
ALTER TABLE subscription_orders ADD CONSTRAINT development_exposure_channel CHECK (
  development_exposure_id IS NULL OR channel = 'DEVELOPMENT_SIMULATED'
) NOT VALID;

INSERT INTO schema_migrations(migration_id) VALUES ('114_development_subscription_funnel.sql');
COMMIT;

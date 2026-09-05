BEGIN;

-- The ledger is append-only. It deliberately contains no price, channel payload,
-- card/bank identifier, or provider callback body. Payment verification will only
-- record a minimal source event reference before issuing a GRANT.
CREATE TABLE IF NOT EXISTS entitlement_ledgers (
  entitlement_ledger_id uuid PRIMARY KEY DEFAULT app.uuid_v7(),
  account_id uuid NOT NULL REFERENCES accounts(account_id),
  entitlement_id text NOT NULL,
  capability text NOT NULL CHECK (capability IN ('IMAGE_GENERATION', 'SYNTHESIZE_TTS', 'TRANSCRIBE_ASR')),
  action text NOT NULL CHECK (action IN ('GRANT', 'RESERVE', 'COMMIT', 'RELEASE')),
  job_id uuid REFERENCES media_jobs(job_id),
  quantity integer NOT NULL CHECK (quantity > 0),
  reserved_quantity integer CHECK (reserved_quantity IS NULL OR reserved_quantity > 0),
  idempotency_key text NOT NULL,
  source text,
  source_event_id text,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (
    (action = 'GRANT' AND job_id IS NULL AND reserved_quantity IS NULL AND source = 'PAYMENT_VERIFIED' AND source_event_id IS NOT NULL)
    OR (action = 'RESERVE' AND job_id IS NOT NULL AND reserved_quantity IS NULL AND source IS NULL AND source_event_id IS NULL)
    OR (action = 'COMMIT' AND job_id IS NOT NULL AND reserved_quantity IS NOT NULL AND quantity <= reserved_quantity AND source IS NULL AND source_event_id IS NULL)
    OR (action = 'RELEASE' AND job_id IS NOT NULL AND reserved_quantity = quantity AND source IS NULL AND source_event_id IS NULL)
  )
);

CREATE UNIQUE INDEX entitlement_ledgers_account_idempotency_idx ON entitlement_ledgers (account_id, idempotency_key);
CREATE UNIQUE INDEX entitlement_ledgers_job_action_idx ON entitlement_ledgers (account_id, job_id, action) WHERE job_id IS NOT NULL;
CREATE INDEX entitlement_ledgers_balance_idx ON entitlement_ledgers (account_id, entitlement_id, capability, created_at);

ALTER TABLE entitlement_ledgers ENABLE ROW LEVEL SECURITY;
ALTER TABLE entitlement_ledgers FORCE ROW LEVEL SECURITY;
CREATE POLICY entitlement_ledgers_scope ON entitlement_ledgers FOR ALL TO qiyu_app
  USING (account_id = app.current_account_id())
  WITH CHECK (account_id = app.current_account_id());

CREATE OR REPLACE FUNCTION app.prevent_entitlement_ledger_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'entitlement ledger entries are append-only';
END;
$$;
CREATE TRIGGER entitlement_ledgers_append_only BEFORE UPDATE OR DELETE ON entitlement_ledgers
  FOR EACH ROW EXECUTE FUNCTION app.prevent_entitlement_ledger_mutation();

GRANT SELECT, INSERT ON entitlement_ledgers TO qiyu_app;
INSERT INTO schema_migrations (migration_id) VALUES ('008_development_entitlement_ledger.sql');

COMMIT;

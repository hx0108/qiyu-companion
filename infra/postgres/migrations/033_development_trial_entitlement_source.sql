BEGIN;

-- Preserve the append-only ledger invariant while allowing only the explicitly
-- modeled local seven-day trial to issue a no-payment grant.
ALTER TABLE entitlement_ledgers DROP CONSTRAINT IF EXISTS entitlement_ledgers_check;
ALTER TABLE entitlement_ledgers ADD CONSTRAINT entitlement_ledgers_check CHECK (
  (action = 'GRANT' AND job_id IS NULL AND reserved_quantity IS NULL AND source IN ('PAYMENT_VERIFIED', 'TRIAL_GRANTED') AND source_event_id IS NOT NULL)
  OR (action = 'RESERVE' AND job_id IS NOT NULL AND reserved_quantity IS NULL AND source IS NULL AND source_event_id IS NULL)
  OR (action = 'COMMIT' AND job_id IS NOT NULL AND reserved_quantity IS NOT NULL AND quantity <= reserved_quantity AND source IS NULL AND source_event_id IS NULL)
  OR (action = 'RELEASE' AND job_id IS NOT NULL AND reserved_quantity = quantity AND source IS NULL AND source_event_id IS NULL)
);

INSERT INTO schema_migrations (migration_id) VALUES ('033_development_trial_entitlement_source.sql');

COMMIT;

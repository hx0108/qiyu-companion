BEGIN;

ALTER TABLE payment_events
  ADD COLUMN refund_ref_hash text,
  ADD COLUMN refund_amount_fen integer,
  ADD COLUMN refund_currency text,
  ADD CONSTRAINT payment_events_development_refund_shape CHECK (
    (refund_ref_hash IS NULL AND refund_amount_fen IS NULL AND refund_currency IS NULL)
    OR (event_type IN ('REFUND_PARTIAL', 'REFUND_FULL')
      AND refund_ref_hash IS NOT NULL AND refund_ref_hash ~ '^[0-9a-f]{64}$'
      AND refund_amount_fen IS NOT NULL AND refund_amount_fen > 0
      AND refund_currency IS NOT NULL AND refund_currency = 'CNY')
  ) NOT VALID;

CREATE UNIQUE INDEX payment_events_development_refund_ref_idx
  ON payment_events (subscription_id, refund_ref_hash)
  WHERE outcome = 'APPLIED' AND refund_ref_hash IS NOT NULL;

INSERT INTO schema_migrations(migration_id) VALUES ('118_development_refund_amounts.sql');
COMMIT;

BEGIN;

ALTER TABLE subscriptions ADD COLUMN development_renewal_cancelled_at timestamptz;

CREATE FUNCTION app.record_development_renewal_cancellation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.development_renewal_cancelled_at := NULL;
  ELSE
    NEW.development_renewal_cancelled_at := OLD.development_renewal_cancelled_at;
    IF NEW.development_renewal_cancelled_at IS NULL
      AND OLD.channel = 'DEVELOPMENT_SIMULATED' AND NEW.channel = OLD.channel
      AND OLD.auto_renew AND NOT NEW.auto_renew AND NEW.state = 'CANCEL_AT_PERIOD_END' THEN
      NEW.development_renewal_cancelled_at := statement_timestamp();
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER record_development_renewal_cancellation
  BEFORE INSERT OR UPDATE ON subscriptions FOR EACH ROW
  EXECUTE FUNCTION app.record_development_renewal_cancellation();

ALTER POLICY product_analytics_read ON subscriptions USING (channel IN ('DEVELOPMENT_TRIAL', 'DEVELOPMENT_SIMULATED'));
GRANT SELECT (development_renewal_cancelled_at) ON subscriptions TO qiyu_product_analytics_reader;

INSERT INTO schema_migrations(migration_id) VALUES ('121_development_renewal_cancellation.sql');
COMMIT;

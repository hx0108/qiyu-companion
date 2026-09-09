BEGIN;

ALTER TABLE notifications ADD COLUMN dedupe_key text;
UPDATE notifications SET dedupe_key = 'legacy:' || notification_id::text WHERE dedupe_key IS NULL;
ALTER TABLE notifications ALTER COLUMN dedupe_key SET NOT NULL;
ALTER TABLE notifications ADD CONSTRAINT notifications_account_dedupe_unique UNIQUE (account_id, dedupe_key);

ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_type_check CHECK (type IN (
  'ACCOUNT_DELETION_STARTED', 'ACCOUNT_DELETION_COMPLETED', 'SUBSCRIPTION_GRANTED', 'SUBSCRIPTION_MANUAL_GRANT',
  'TRIAL_ENDING', 'SUBSCRIPTION_RENEWAL_REMINDER', 'SUBSCRIPTION_RENEWED', 'REFUND_STATUS_CHANGED', 'SAFETY_SUPPORT_STARTED'
));

INSERT INTO schema_migrations (migration_id) VALUES ('053_notification_scheduler.sql');
COMMIT;

BEGIN;

-- 封闭试用期的站内通知：只保存账户内必要告知，不承载营销、短信内容或聊天正文。
CREATE TABLE notifications (
  notification_id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(account_id),
  type text NOT NULL CHECK (type IN ('ACCOUNT_DELETION_STARTED', 'SUBSCRIPTION_GRANTED')),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 500),
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX notifications_account_created_idx ON notifications (account_id, created_at DESC);

ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications FORCE ROW LEVEL SECURITY;
CREATE POLICY notifications_scope ON notifications FOR ALL TO qiyu_app
  USING (account_id = app.current_account_id())
  WITH CHECK (account_id = app.current_account_id());
GRANT SELECT, INSERT, UPDATE ON notifications TO qiyu_app;

INSERT INTO schema_migrations (migration_id) VALUES ('050_development_notifications.sql');
COMMIT;

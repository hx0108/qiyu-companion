BEGIN;

-- Daily ordinary-chat fairness is a per-account, China-local-calendar counter.
-- The API creates and locks the current-day row before calling a model, so a
-- concurrent second message cannot bypass the 100-round / 320k-input-token cap.
CREATE TABLE IF NOT EXISTS daily_chat_usage (
  account_id uuid NOT NULL REFERENCES accounts(account_id),
  usage_date date NOT NULL,
  chat_rounds integer NOT NULL DEFAULT 0 CHECK (chat_rounds >= 0 AND chat_rounds <= 100),
  billed_input_tokens integer NOT NULL DEFAULT 0 CHECK (billed_input_tokens >= 0 AND billed_input_tokens <= 320000),
  reserved_input_tokens integer NOT NULL DEFAULT 0 CHECK (reserved_input_tokens >= 0 AND reserved_input_tokens <= 320000),
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (account_id, usage_date),
  CHECK (billed_input_tokens + reserved_input_tokens <= 320000)
);

ALTER TABLE daily_chat_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE daily_chat_usage FORCE ROW LEVEL SECURITY;
CREATE POLICY daily_chat_usage_scope ON daily_chat_usage FOR ALL TO qiyu_app
  USING (account_id = app.current_account_id())
  WITH CHECK (account_id = app.current_account_id());

GRANT SELECT, INSERT, UPDATE ON daily_chat_usage TO qiyu_app;
INSERT INTO schema_migrations (migration_id) VALUES ('015_development_daily_chat_usage.sql');

COMMIT;

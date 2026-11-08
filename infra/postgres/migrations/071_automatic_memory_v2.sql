BEGIN;
ALTER TABLE accounts ADD COLUMN automatic_memory_preference_source text NOT NULL DEFAULT 'LEGACY'
  CHECK (automatic_memory_preference_source IN ('LEGACY', 'DEFAULT', 'USER'));
ALTER TABLE accounts ADD COLUMN automatic_memory_preference_version bigint NOT NULL DEFAULT 0;
ALTER TABLE accounts ALTER COLUMN automatic_memory_preference_source SET DEFAULT 'DEFAULT';
ALTER TABLE accounts ALTER COLUMN automatic_memory_enabled SET DEFAULT true;

CREATE TABLE automatic_memory_jobs (
  message_id uuid PRIMARY KEY REFERENCES messages(message_id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
  preference_version bigint NOT NULL,
  revocation_epoch bigint NOT NULL,
  mode text NOT NULL CHECK (mode IN ('shadow','active')),
  state text NOT NULL DEFAULT 'PENDING' CHECK (state IN ('PENDING','PROCESSING','COMPLETED','CANCELLED','FAILED')),
  attempts smallint NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 2),
  available_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  lease_id uuid,
  result_code text
);
CREATE INDEX automatic_memory_jobs_due_idx ON automatic_memory_jobs (available_at, message_id)
  WHERE state IN ('PENDING','PROCESSING');
CREATE INDEX automatic_memory_jobs_account_order_idx ON automatic_memory_jobs (account_id, message_id)
  WHERE state IN ('PENDING','PROCESSING');
ALTER TABLE automatic_memory_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE automatic_memory_jobs FORCE ROW LEVEL SECURITY;
CREATE POLICY automatic_memory_jobs_scope ON automatic_memory_jobs FOR ALL TO qiyu_app
  USING (account_id = app.current_account_id()) WITH CHECK (account_id = app.current_account_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON automatic_memory_jobs TO qiyu_app;

ALTER TABLE relationship_assets ADD COLUMN automatic_policy_version text;
ALTER TABLE relationship_assets DROP CONSTRAINT relationship_assets_activation_origin_check;
ALTER TABLE relationship_assets ADD CONSTRAINT relationship_assets_activation_origin_check
  CHECK (state <> 'ACTIVE' OR activation_actor = 'USER' OR
    (activation_actor = 'SYSTEM' AND type = 'PREFERENCE' AND source_candidate_id IS NULL AND COALESCE(
      (automatic_policy_version IS NULL AND (
        (value_json->>'fact_key' = 'communication.response_style' AND value_json->>'fact_value' IN ('direct', 'concise', 'detailed'))
        OR (value_json->>'fact_key' IN ('user.preference.drink:hot_americano', 'user.preference.drink:coffee', 'user.preference.drink:tea') AND value_json->>'fact_value' = 'like')
        OR (value_json->>'fact_key' = 'recent.activity.interview' AND value_json->>'fact_value' = 'preparing' AND valid_until IS NOT NULL)
      )) OR (automatic_policy_version = 'v2'
        AND (value_json->>'fact_key' ~ '^v2:(preference|interest|communication|background|goal|recent):'
          OR (value_json->>'fact_key' = 'communication.response_style' AND value_json->>'fact_value' IN ('direct','concise','detailed'))
          OR (value_json->>'fact_key' IN ('user.preference.drink:tea','user.preference.drink:coffee','user.preference.drink:hot_americano')
            AND value_json->>'fact_value' IN ('like','dislike')))
        AND jsonb_typeof(value_json->'fact_value') = 'string'
        AND (value_json->>'fact_key' NOT LIKE 'v2:recent:%' OR valid_until IS NOT NULL)), false)));

INSERT INTO schema_migrations (migration_id) VALUES ('071_automatic_memory_v2.sql');
COMMIT;

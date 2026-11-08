BEGIN;
ALTER TABLE accounts ADD COLUMN automatic_memory_enabled boolean NOT NULL DEFAULT false;
-- Keep user confirmation distinct: only narrowly typed system-origin records
-- may be activated without a candidate confirmation.
DO $$
DECLARE constraint_name text;
BEGIN
  SELECT conname INTO STRICT constraint_name FROM pg_constraint
    WHERE conrelid = 'relationship_assets'::regclass AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%activation_actor%'
      AND pg_get_constraintdef(oid) LIKE '%state%';
  EXECUTE format('ALTER TABLE relationship_assets DROP CONSTRAINT %I', constraint_name);
END $$;
ALTER TABLE relationship_assets ADD COLUMN automatic_source_message_id uuid REFERENCES messages(message_id) ON DELETE SET NULL;
ALTER TABLE relationship_assets ADD CONSTRAINT relationship_assets_activation_origin_check
  CHECK (state <> 'ACTIVE' OR activation_actor = 'USER' OR
    (activation_actor = 'SYSTEM' AND type = 'PREFERENCE' AND source_candidate_id IS NULL
      AND COALESCE((value_json->>'fact_key' = 'communication.response_style' AND value_json->>'fact_value' IN ('direct', 'concise', 'detailed'))
        OR (value_json->>'fact_key' IN ('user.preference.drink:hot_americano', 'user.preference.drink:coffee', 'user.preference.drink:tea') AND value_json->>'fact_value' = 'like')
        OR (value_json->>'fact_key' = 'recent.activity.interview' AND value_json->>'fact_value' = 'preparing' AND valid_until IS NOT NULL), false)));
CREATE UNIQUE INDEX relationship_assets_one_automatic_preference_idx
  ON relationship_assets (account_id, character_id, (value_json->>'fact_key'))
  WHERE state = 'ACTIVE' AND activation_actor = 'SYSTEM';
INSERT INTO schema_migrations (migration_id) VALUES ('070_automatic_memory_preference.sql');
COMMIT;

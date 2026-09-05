\set ON_ERROR_STOP on
BEGIN;

DO $$
DECLARE
  required_tables text[] := ARRAY[
    'accounts', 'age_decisions', 'account_interaction_controls', 'required_notices', 'characters',
    'conversations', 'messages', 'memory_candidates', 'relationship_assets',
    'deletion_jobs', 'deletion_targets', 'idempotency_keys', 'outbox_events', 'audit_events'
  ];
  required_table text;
BEGIN
  FOREACH required_table IN ARRAY required_tables LOOP
    IF to_regclass('public.' || required_table) IS NULL THEN
      RAISE EXCEPTION 'missing required table: %', required_table;
    END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
    RAISE EXCEPTION 'pgvector extension missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'relationship_assets') THEN
    RAISE EXCEPTION 'relationship_assets RLS policy missing';
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'age_decisions'
      AND column_name IN ('document_image', 'face_template', 'biometric_sample', 'date_of_birth', 'provider_payload')
  ) THEN
    RAISE EXCEPTION 'age_decisions contains prohibited identity or biometric storage columns';
  END IF;
END;
$$;

INSERT INTO accounts (account_id) VALUES
  ('00000000-0000-7000-8000-0000000000a1'),
  ('00000000-0000-7000-8000-0000000000b2');
INSERT INTO characters (character_id, account_id) VALUES
  ('00000000-0000-7000-8000-0000000000c1', '00000000-0000-7000-8000-0000000000a1'),
  ('00000000-0000-7000-8000-0000000000c2', '00000000-0000-7000-8000-0000000000b2');
INSERT INTO age_decisions (account_id, age_status, method, decision_assertion, transaction_id, policy_version) VALUES
  ('00000000-0000-7000-8000-0000000000a1', 'AGE_PASS', 'VERIFICATION_TRANSACTION', 'OVER_18_VERIFIED', 'test-age-transaction-a1', 'age-policy-v1'),
  ('00000000-0000-7000-8000-0000000000b2', 'AGE_DENIED_MINOR', 'MANUAL_REVIEW', 'MINOR_DECISION', 'test-age-transaction-b2', 'age-policy-v1');
INSERT INTO relationship_assets (asset_id, account_id, character_id, type, value_json, source_candidate_id, state, activation_actor) VALUES
  ('00000000-0000-7000-8000-0000000000d1', '00000000-0000-7000-8000-0000000000a1', '00000000-0000-7000-8000-0000000000c1', 'PREFERENCE', '{"value":"tea"}', NULL, 'ACTIVE', 'USER'),
  ('00000000-0000-7000-8000-0000000000d2', '00000000-0000-7000-8000-0000000000b2', '00000000-0000-7000-8000-0000000000c2', 'PREFERENCE', '{"value":"coffee"}', NULL, 'ACTIVE', 'USER');

SET LOCAL ROLE qiyu_app;
SELECT set_config('app.account_id', '00000000-0000-7000-8000-0000000000a1', true);
SELECT set_config('app.character_id', '00000000-0000-7000-8000-0000000000c1', true);
DO $$
BEGIN
  IF (SELECT count(*) FROM relationship_assets) <> 1 THEN
    RAISE EXCEPTION 'RLS did not isolate relationship assets by account and character';
  END IF;
  IF EXISTS (SELECT 1 FROM relationship_assets WHERE asset_id = '00000000-0000-7000-8000-0000000000d2') THEN
    RAISE EXCEPTION 'cross-account relationship asset was visible';
  END IF;
  IF (SELECT count(*) FROM age_decisions) <> 1
     OR (SELECT age_status FROM age_decisions) <> 'AGE_PASS' THEN
    RAISE EXCEPTION 'RLS did not isolate age decisions by account';
  END IF;
END;
$$;
RESET ROLE;

DO $$
BEGIN
  BEGIN
    INSERT INTO relationship_assets (account_id, character_id, type, value_json, state, activation_actor)
    VALUES ('00000000-0000-7000-8000-0000000000a1', '00000000-0000-7000-8000-0000000000c1', 'PREFERENCE', '{"value":"model"}', 'ACTIVE', 'MODEL');
    RAISE EXCEPTION 'model-created active relationship asset unexpectedly succeeded';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
END;
$$;

DO $$
DECLARE
  test_candidate_id uuid;
BEGIN
  INSERT INTO memory_candidates (account_id, character_id, type, normalized_value, display_text)
  VALUES ('00000000-0000-7000-8000-0000000000a1', '00000000-0000-7000-8000-0000000000c1', 'PREFERENCE', 'tea', 'Likes tea')
  RETURNING candidate_id INTO test_candidate_id;
  BEGIN
    UPDATE memory_candidates SET state = 'CONFIRMED', last_transition_actor = 'MODEL' WHERE candidate_id = test_candidate_id;
    RAISE EXCEPTION 'model confirmation unexpectedly succeeded';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%requires a user action%' THEN RAISE; END IF;
  END;
END;
$$;

DO $$
DECLARE
  before_version bigint;
  after_version bigint;
BEGIN
  SELECT version INTO before_version FROM accounts WHERE account_id = '00000000-0000-7000-8000-0000000000a1';
  UPDATE accounts SET account_status = 'SUSPENDED' WHERE account_id = '00000000-0000-7000-8000-0000000000a1';
  SELECT version INTO after_version FROM accounts WHERE account_id = '00000000-0000-7000-8000-0000000000a1';
  IF after_version <> before_version + 1 THEN RAISE EXCEPTION 'version did not advance'; END IF;
END;
$$;

ROLLBACK;
SELECT 'schema verification passed' AS result;

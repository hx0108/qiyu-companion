BEGIN;

-- DLQ 重放与普通应用、摘要 Worker 分离：运营者只能经受控函数触发一次重放，
-- 原始 reason 只在请求边界使用，库内只保留不可逆哈希。
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'qiyu_summary_operator') THEN
    CREATE ROLE qiyu_summary_operator NOLOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'qiyu_summary_replay_service') THEN
    CREATE ROLE qiyu_summary_replay_service NOLOGIN NOINHERIT BYPASSRLS;
  ELSIF NOT (SELECT rolbypassrls FROM pg_roles WHERE rolname = 'qiyu_summary_replay_service') THEN
    RAISE EXCEPTION 'qiyu_summary_replay_service must retain BYPASSRLS';
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS conversation_summary_operator_identities (
  database_role name PRIMARY KEY,
  operator_id uuid NOT NULL UNIQUE,
  state text NOT NULL CHECK (state IN ('ACTIVE', 'SUSPENDED')),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
ALTER TABLE conversation_summary_operator_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation_summary_operator_identities FORCE ROW LEVEL SECURITY;
CREATE POLICY conversation_summary_operator_identities_self
  ON conversation_summary_operator_identities FOR SELECT TO qiyu_summary_operator
  USING (database_role = session_user::name);

ALTER TABLE conversation_summary_dead_letters
  ADD COLUMN IF NOT EXISTS state text NOT NULL DEFAULT 'OPEN' CHECK (state IN ('OPEN', 'REPLAYED')),
  ADD COLUMN IF NOT EXISTS replay_count integer NOT NULL DEFAULT 0 CHECK (replay_count BETWEEN 0 AND 1),
  ADD COLUMN IF NOT EXISTS last_replayed_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_replayed_by uuid,
  ADD COLUMN IF NOT EXISTS last_replay_reason_sha256 char(64);

CREATE OR REPLACE FUNCTION app.replay_conversation_summary_dead_letter(
  p_job_id uuid,
  p_reason text
) RETURNS conversation_summary_jobs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app
AS $$
DECLARE
  job_row conversation_summary_jobs%ROWTYPE;
  dead_letter_row conversation_summary_dead_letters%ROWTYPE;
  operator_row conversation_summary_operator_identities%ROWTYPE;
  character_ref uuid;
BEGIN
  IF NOT pg_has_role(session_user, 'qiyu_summary_operator', 'member') THEN
    RAISE EXCEPTION 'summary operator role is required';
  END IF;
  SELECT * INTO operator_row
    FROM conversation_summary_operator_identities
   WHERE database_role = session_user::name AND state = 'ACTIVE';
  IF NOT FOUND THEN RAISE EXCEPTION 'active summary operator identity is required'; END IF;
  IF length(trim(coalesce(p_reason, ''))) NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'replay reason must be 1-1000 characters';
  END IF;

  SELECT * INTO dead_letter_row FROM conversation_summary_dead_letters
   WHERE job_id = p_job_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'conversation summary dead letter not found'; END IF;
  IF dead_letter_row.replay_count >= 1 THEN
    RAISE EXCEPTION 'conversation summary dead letter replay limit reached';
  END IF;
  SELECT * INTO job_row FROM conversation_summary_jobs WHERE job_id = p_job_id FOR UPDATE;
  IF NOT FOUND OR job_row.exhausted_at IS NULL OR job_row.attempt_count < 8 THEN
    RAISE EXCEPTION 'conversation summary job is not exhausted';
  END IF;
  PERFORM 1 FROM accounts a JOIN conversations c ON c.account_id = a.account_id
   WHERE a.account_id = job_row.account_id AND c.conversation_id = job_row.conversation_id
     AND a.account_status = 'OPEN' AND c.status <> 'DELETED'
     AND a.revocation_epoch = job_row.captured_revocation_epoch;
  IF NOT FOUND THEN RAISE EXCEPTION 'summary source account or conversation was revoked'; END IF;
  PERFORM 1 FROM messages
   WHERE conversation_id = job_row.conversation_id AND message_id = job_row.source_to_id AND deleted_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'summary source message was revoked'; END IF;

  UPDATE conversation_summary_jobs
     SET state = 'PENDING', exhausted_at = NULL, completed_at = NULL, lease_expires_at = NULL,
         next_attempt_at = CURRENT_TIMESTAMP, last_error = 'manual summary DLQ replay requested'
   WHERE job_id = p_job_id
   RETURNING * INTO job_row;
  UPDATE conversation_summary_dead_letters
     SET state = 'REPLAYED', replay_count = replay_count + 1, last_replayed_at = CURRENT_TIMESTAMP,
         last_replayed_by = operator_row.operator_id,
         last_replay_reason_sha256 = encode(digest(trim(p_reason), 'sha256'), 'hex')
   WHERE job_id = p_job_id;
  SELECT character_id INTO character_ref FROM conversations WHERE conversation_id = job_row.conversation_id;
  INSERT INTO outbox_events (account_id, character_id, aggregate_type, aggregate_id, event_type, payload_json)
    VALUES (job_row.account_id, character_ref, 'CONVERSATION_SUMMARY_JOB', job_row.job_id,
      'conversation.summary_dlq_replayed.v1',
      jsonb_build_object('conversation_id', job_row.conversation_id, 'source_to_id', job_row.source_to_id, 'replay_count', 1));
  INSERT INTO audit_events (account_id, character_id, actor_type, actor_id, action, resource_type, resource_id, reason_code)
    VALUES (job_row.account_id, character_ref, 'ADMIN', operator_row.operator_id::text,
      'CONVERSATION_SUMMARY_DLQ_REPLAYED', 'CONVERSATION_SUMMARY_JOB', job_row.job_id::text, 'MANUAL_REPLAY');
  RETURN job_row;
END;
$$;

ALTER FUNCTION app.replay_conversation_summary_dead_letter(uuid, text) OWNER TO qiyu_summary_replay_service;
GRANT USAGE ON SCHEMA app, public TO qiyu_summary_replay_service, qiyu_summary_operator;
GRANT SELECT ON conversation_summary_operator_identities, accounts, conversations, messages, conversation_summary_jobs, conversation_summary_dead_letters TO qiyu_summary_replay_service;
GRANT UPDATE (state, exhausted_at, completed_at, lease_expires_at, next_attempt_at, last_error) ON conversation_summary_jobs TO qiyu_summary_replay_service;
GRANT UPDATE (state, replay_count, last_replayed_at, last_replayed_by, last_replay_reason_sha256) ON conversation_summary_dead_letters TO qiyu_summary_replay_service;
GRANT INSERT ON outbox_events, audit_events TO qiyu_summary_replay_service;
REVOKE ALL ON conversation_summary_operator_identities, conversation_summary_dead_letters FROM PUBLIC, qiyu_app;
REVOKE ALL ON FUNCTION app.replay_conversation_summary_dead_letter(uuid, text) FROM PUBLIC, qiyu_app;
GRANT SELECT ON conversation_summary_operator_identities, conversation_summary_dead_letters TO qiyu_summary_operator;
GRANT EXECUTE ON FUNCTION app.replay_conversation_summary_dead_letter(uuid, text) TO qiyu_summary_operator;

INSERT INTO schema_migrations (migration_id) VALUES ('040_development_conversation_summary_dlq_replay.sql');
COMMIT;

-- 1:1 通话回合：状态机审计行（7 态）+ 用量锚点。消息/媒体 job 的引用是弱引用
-- （普通 uuid 列，不加外键）：消息有保留期物理删除与账户注销删除路径，而通话
-- 回合行作为审计记录长期保留，强外键会让删除事务回滚。
BEGIN;

CREATE TABLE IF NOT EXISTS call_turns (
  turn_id uuid PRIMARY KEY,
  call_session_id uuid NOT NULL REFERENCES call_sessions(call_id),
  account_id uuid NOT NULL REFERENCES accounts(account_id),
  turn_index integer NOT NULL CHECK (turn_index > 0),
  state text NOT NULL CHECK (state IN ('CREATED', 'UPLOADING', 'FINALIZED', 'TRANSCRIBING', 'THINKING', 'SPEAKING', 'COMPLETED', 'INTERRUPTED', 'FAILED')),
  user_message_id uuid,
  assistant_message_id uuid,
  asr_job_id uuid,
  tts_job_id uuid,
  audio_bytes integer NOT NULL DEFAULT 0 CHECK (audio_bytes >= 0),
  chunk_count integer NOT NULL DEFAULT 0 CHECK (chunk_count >= 0),
  transcript_text text,
  interrupted boolean NOT NULL DEFAULT false,
  failure_code text,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ended_at timestamptz,
  UNIQUE (call_session_id, turn_index),
  CHECK ((state IN ('COMPLETED', 'INTERRUPTED', 'FAILED')) = (ended_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS call_turns_session_idx ON call_turns (call_session_id, turn_index);

ALTER TABLE call_turns ENABLE ROW LEVEL SECURITY;
ALTER TABLE call_turns FORCE ROW LEVEL SECURITY;
CREATE POLICY call_turns_scope ON call_turns FOR ALL TO qiyu_app
  USING (account_id = app.current_account_id()) WITH CHECK (account_id = app.current_account_id());
GRANT SELECT, INSERT, UPDATE ON call_turns TO qiyu_app;

-- 通话内消息与普通消息同表保留；call_session_id 标记来源供通话记录卡片与回放
-- 复用锚点使用（call_sessions 行长期保留，不设 ON DELETE）。
ALTER TABLE messages ADD COLUMN IF NOT EXISTS call_session_id uuid REFERENCES call_sessions(call_id);
CREATE INDEX IF NOT EXISTS messages_call_session_idx ON messages (call_session_id) WHERE call_session_id IS NOT NULL;

INSERT INTO schema_migrations (migration_id) VALUES ('060_call_turns.sql');

COMMIT;

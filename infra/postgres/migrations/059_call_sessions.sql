-- 1:1 实时语音通话会话：仅审计计量（时长、回合数、用量秒数），不含任何正文。
-- 通话音频永不落库（进程内存过一道 ASR 即弃）；可保留内容只有 messages 里的
-- 转写文本与回复文本。单账户单 ACTIVE 通话由部分唯一索引在数据库侧兜底。
BEGIN;

CREATE TABLE IF NOT EXISTS call_sessions (
  call_id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(account_id),
  conversation_id uuid NOT NULL REFERENCES conversations(conversation_id),
  character_id uuid NOT NULL REFERENCES characters(character_id),
  state text NOT NULL CHECK (state IN ('ACTIVE', 'ENDED')),
  end_reason text CHECK (end_reason IS NULL OR end_reason IN ('USER_HANGUP', 'IDLE_TIMEOUT', 'DURATION_CAP', 'ERROR')),
  started_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ended_at timestamptz,
  last_activity_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  turn_count integer NOT NULL DEFAULT 0 CHECK (turn_count >= 0),
  interrupted_turn_count integer NOT NULL DEFAULT 0 CHECK (interrupted_turn_count >= 0),
  asr_seconds_used integer NOT NULL DEFAULT 0 CHECK (asr_seconds_used >= 0),
  tts_seconds_used integer NOT NULL DEFAULT 0 CHECK (tts_seconds_used >= 0),
  CHECK ((state = 'ENDED') = (ended_at IS NOT NULL)),
  CHECK (state = 'ACTIVE' OR end_reason IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS call_sessions_one_active_per_account_idx
  ON call_sessions (account_id) WHERE state = 'ACTIVE';
CREATE INDEX IF NOT EXISTS call_sessions_account_started_idx
  ON call_sessions (account_id, started_at DESC);

ALTER TABLE call_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE call_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY call_sessions_scope ON call_sessions FOR ALL TO qiyu_app
  USING (account_id = app.current_account_id()) WITH CHECK (account_id = app.current_account_id());
GRANT SELECT, INSERT, UPDATE ON call_sessions TO qiyu_app;

INSERT INTO schema_migrations (migration_id) VALUES ('059_call_sessions.sql');

COMMIT;

BEGIN;

-- 角色语音情感化（实时语音合成）：记录每个 TTS 任务实际朗读的文本与
-- 情感投放，保证“这条语音为什么是这个情绪”可审计回放。
-- tts_text 为清洗后的明文（剥离（动作）与截断），与 media_jobs.transcript_text
-- 的既有明文口径一致；台词原文仍在 messages 的存储口径中不受影响。
-- emotion_category 用格式 CHECK 而非 17 值枚举：供应商扩充情感值时无需改约束。
ALTER TABLE media_jobs
  ADD COLUMN IF NOT EXISTS tts_text text,
  ADD COLUMN IF NOT EXISTS emotion_category text
    CONSTRAINT media_jobs_emotion_category_format CHECK (emotion_category IS NULL OR emotion_category ~ '^[a-z][a-z0-9_]{0,31}$'),
  ADD COLUMN IF NOT EXISTS emotion_intensity integer
    CONSTRAINT media_jobs_emotion_intensity_range CHECK (emotion_intensity IS NULL OR (emotion_intensity >= 50 AND emotion_intensity <= 200)),
  ADD COLUMN IF NOT EXISTS emotion_source text
    CONSTRAINT media_jobs_emotion_source_format CHECK (emotion_source IS NULL OR emotion_source IN ('model_judgement', 'world_state_mood', 'fallback_neutral')),
  ADD COLUMN IF NOT EXISTS tts_speed numeric(4, 2)
    CONSTRAINT media_jobs_tts_speed_range CHECK (tts_speed IS NULL OR (tts_speed >= -2 AND tts_speed <= 6));

INSERT INTO schema_migrations (migration_id) VALUES ('056_tts_emotion_columns.sql');
COMMIT;

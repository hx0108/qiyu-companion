-- 修复存量缺陷：media_jobs.voice_gender 从未持久化（写入列缺失），PG 模式重启后
-- 同消息语音重播的复用判断（source_message_id + voice_gender + COMPLETED）失效，
-- 必然重复合成重扣额度。历史行如实为 NULL——性别未知时不复用、保守重合成，
-- 与修复前的运行时行为一致。
BEGIN;

ALTER TABLE media_jobs ADD COLUMN IF NOT EXISTS voice_gender text
  CHECK (voice_gender IS NULL OR voice_gender IN ('female', 'male'));

INSERT INTO schema_migrations (migration_id) VALUES ('061_media_jobs_voice_gender.sql');

COMMIT;

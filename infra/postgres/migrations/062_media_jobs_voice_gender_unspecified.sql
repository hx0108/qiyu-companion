-- 修正 061：voice_gender 收紧为 (female, male) 挡住了合法的 'unspecified'
-- （normalizePersonaGender 的三分支之一）。中性音色角色的 TTS 任务行因此被
-- CHECK 拒绝、整笔延迟事务回滚。该列只服务于同源回放复用匹配，取值由应用层
-- 枚举保证，数据库侧不设 CHECK（回归 061 前的宽松口径）。
BEGIN;

ALTER TABLE media_jobs DROP CONSTRAINT IF EXISTS media_jobs_voice_gender_check;

INSERT INTO schema_migrations (migration_id) VALUES ('062_media_jobs_voice_gender_unspecified.sql');

COMMIT;

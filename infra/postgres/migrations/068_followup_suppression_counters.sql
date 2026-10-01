-- 六项能力 A4（方案 §7-A4「灰度检查抑制原因」）：跟进投递抑制原因计数表。
-- DB 表而非进程内存计数——双进程 Worker 各自的内存计数会互相看不见且重启
-- 即丢；表随发布事务同提交（ON CONFLICT 原子累加），跨进程聚合、重启不丢。
-- 纯枚举计数无账户维度（不做个体画像），因此不设 RLS；API 只读、Worker
-- 写入。灰度检查口径见 OPERATIONS_RUNBOOK「灰度检查清单」。
BEGIN;

CREATE TABLE followup_suppression_counters (
  action text NOT NULL CHECK (action IN ('CANCEL', 'EXPIRE', 'DEFER')),
  reason text NOT NULL,
  count bigint NOT NULL DEFAULT 0 CHECK (count >= 0),
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (action, reason)
);

GRANT SELECT ON followup_suppression_counters TO qiyu_app;
GRANT SELECT, INSERT, UPDATE ON followup_suppression_counters TO qiyu_followup_worker;
REVOKE ALL ON followup_suppression_counters FROM PUBLIC;

INSERT INTO schema_migrations (migration_id) VALUES ('068_followup_suppression_counters.sql');

COMMIT;

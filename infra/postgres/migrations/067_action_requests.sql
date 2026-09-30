-- 六项能力 A3（方案 §4.6/§6.1）：独立行动权限——参数绑定审批及执行记录。
-- 角色提议不等于执行成功：模型只能输出受控意图与参数候选；白名单、资源归属、
-- 版本、必要授权、安全模式与额度核对归域层 action-gate.js（同 065 把
-- followup_kind 映射留在域层的哲学，action_type 不加 CHECK 枚举，此处登记
-- 首批：ACCEPT_PLAN → WRITE_MEMORY）。parameters_digest 对服务器规范化的
-- 最终参数计算哈希——审批后参数变化必须重新批准。默认审批期限 15 分钟，
-- 过期为惰性裁决（查询/审批/执行时判定，不建后台清扫）。UNKNOWN 仅预留
-- 外部执行超时路径（B1 日历直写），首批不进入常规流转。
-- (account_id, idempotency_key) 全量唯一 = 域级幂等：同键重放返回既有行，
-- 不产生第二条审批。审批记录不存密钥；凭据由服务端保管，不进角色 Prompt。
BEGIN;

CREATE TABLE action_requests (
  action_id uuid PRIMARY KEY DEFAULT app.uuid_v7(),
  account_id uuid NOT NULL REFERENCES accounts(account_id),
  character_id uuid NOT NULL,
  action_type text NOT NULL,
  target_ref uuid NOT NULL,
  target_version bigint,
  parameters_digest text NOT NULL,
  state text NOT NULL DEFAULT 'PROPOSED' CHECK (state IN ('PROPOSED', 'APPROVED', 'EXECUTING', 'SUCCEEDED', 'FAILED', 'REJECTED', 'EXPIRED', 'CANCELLED', 'UNKNOWN')),
  expires_at timestamptz NOT NULL,
  result_ref text,
  failure_code text,
  idempotency_key text NOT NULL,
  approved_at timestamptz,
  executed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- 审批与执行两个状态分开记录：批准即绑定当时的 digest 与目标版本。
  CHECK (approved_at IS NULL OR state NOT IN ('PROPOSED')),
  UNIQUE (account_id, idempotency_key),
  FOREIGN KEY (character_id, account_id) REFERENCES characters(character_id, account_id)
);
CREATE INDEX action_requests_account_idx ON action_requests (account_id, created_at DESC);

ALTER TABLE action_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE action_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY action_requests_scope ON action_requests FOR ALL TO qiyu_app
  USING (account_id = app.current_account_id()) WITH CHECK (account_id = app.current_account_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON action_requests TO qiyu_app;

REVOKE ALL ON action_requests FROM PUBLIC;

INSERT INTO schema_migrations (migration_id) VALUES ('067_action_requests.sql');

COMMIT;

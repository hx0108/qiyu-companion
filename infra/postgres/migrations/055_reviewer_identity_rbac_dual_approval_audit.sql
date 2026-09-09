BEGIN;

-- 运营审核员身份 / RBAC / 双人审批 / 追加写审计（个人项目可完成项，技术设计 8.10）。
-- 边界与 024 一致：qiyu_app 是应用进程角色（应用层鉴权后读写），
-- qiyu_reviewer 是审核员请求作用域角色——API 在运营请求事务内
-- SET LOCAL ROLE qiyu_reviewer + set_config('app.reviewer_id', ...)，
-- 由下方 RLS 策略把可见范围限制到"本人相关"行。
-- 诚实边界：单人项目的角色分离是逻辑上的；数据库机制无法证明
-- 两个账号背后是两个不同的人。

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'qiyu_reviewer') THEN
    CREATE ROLE qiyu_reviewer NOLOGIN NOINHERIT;
  END IF;
  -- 应用进程可以"降权"进入审核员会话（SET ROLE 只降不升：qiyu_reviewer
  -- 仅持窄授权），部署管理员另行给真实审核员发放登录成员身份。
  IF NOT EXISTS (SELECT 1 FROM pg_auth_members m
    JOIN pg_roles grantee ON grantee.oid = m.member
    JOIN pg_roles granted ON granted.oid = m.roleid
    WHERE grantee.rolname = 'qiyu_app' AND granted.rolname = 'qiyu_reviewer') THEN
    GRANT qiyu_reviewer TO qiyu_app;
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS reviewer_accounts (
  reviewer_id uuid PRIMARY KEY DEFAULT app.uuid_v7(),
  username text NOT NULL UNIQUE CHECK (username ~ '^[a-z0-9._-]{3,32}$'),
  password_hash text NOT NULL,
  display_name text NOT NULL,
  roles text[] NOT NULL CHECK (roles <@ ARRAY['REVIEWER','RELEASE','SECURITY_ADMIN']::text[] AND array_length(roles, 1) >= 1),
  state text NOT NULL DEFAULT 'ACTIVE' CHECK (state IN ('ACTIVE','SUSPENDED')),
  mfa_required boolean NOT NULL DEFAULT false,
  mfa_secret text,
  failed_login_attempts integer NOT NULL DEFAULT 0,
  locked_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 会话令牌只存 sha256 摘要；吊销/过期即失效。
CREATE TABLE IF NOT EXISTS reviewer_sessions (
  session_id uuid PRIMARY KEY DEFAULT app.uuid_v7(),
  reviewer_id uuid NOT NULL REFERENCES reviewer_accounts(reviewer_id),
  token_hash text NOT NULL UNIQUE,
  ip text,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);
CREATE INDEX IF NOT EXISTS reviewer_sessions_reviewer_idx ON reviewer_sessions (reviewer_id, created_at DESC);

-- 双人审批状态机：REQUESTED → APPROVED → EXECUTED；REQUESTED → REJECTED / EXPIRED。
CREATE TABLE IF NOT EXISTS dual_approval_requests (
  approval_id uuid PRIMARY KEY DEFAULT app.uuid_v7(),
  action text NOT NULL CHECK (action IN ('PERSONA_STABLE_RELEASE','SUBSCRIPTION_MANUAL_REVOKE')),
  target_id text NOT NULL,
  payload_json jsonb,
  requested_by uuid NOT NULL REFERENCES reviewer_accounts(reviewer_id),
  approved_by uuid REFERENCES reviewer_accounts(reviewer_id),
  rejected_by uuid REFERENCES reviewer_accounts(reviewer_id),
  state text NOT NULL DEFAULT 'REQUESTED' CHECK (state IN ('REQUESTED','APPROVED','EXECUTED','REJECTED','EXPIRED')),
  request_reason text NOT NULL CHECK (length(request_reason) BETWEEN 1 AND 1000),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at timestamptz NOT NULL,
  decided_at timestamptz,
  executed_at timestamptz,
  CHECK (requested_by <> approved_by)
);

-- 运营审计：追加写。触发器拒绝一切 UPDATE/DELETE（应用角色与表主人都不能改）。
CREATE TABLE IF NOT EXISTS ops_audit_events (
  audit_id uuid PRIMARY KEY DEFAULT app.uuid_v7(),
  actor_type text NOT NULL CHECK (actor_type IN ('REVIEWER','SYSTEM','ANONYMOUS')),
  actor_id text,
  action text NOT NULL,
  resource_type text NOT NULL,
  resource_id text,
  before_json jsonb,
  after_json jsonb,
  reason text,
  ip text,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS ops_audit_events_created_idx ON ops_audit_events (created_at DESC);
CREATE INDEX IF NOT EXISTS ops_audit_events_action_idx ON ops_audit_events (action, created_at DESC);

CREATE OR REPLACE FUNCTION app.reject_ops_audit_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ops_audit_events is append-only (audit_id=%, attempted %)', OLD.audit_id, TG_OP;
END;
$$;

DROP TRIGGER IF EXISTS ops_audit_events_append_only ON ops_audit_events;
CREATE TRIGGER ops_audit_events_append_only
  BEFORE UPDATE OR DELETE ON ops_audit_events
  FOR EACH ROW EXECUTE FUNCTION app.reject_ops_audit_mutation();
-- TRUNCATE 边界（如实声明）：PostgreSQL 不支持 TRUNCATE 事件触发器，行级
-- 触发器也不拦 TRUNCATE。因此应用角色显式不含 TRUNCATE 权限（下方 GRANT
-- 仅 INSERT/SELECT），UPDATE/DELETE 由触发器拒绝——应用侧不可篡改。
-- 表主/超主仍可 TRUNCATE：彻底不可变需要外部 WORM/异地归档，属生产加固项，
-- 见 development/OPERATIONS_SECURITY_PLAYBOOK.md。
REVOKE TRUNCATE ON ops_audit_events FROM PUBLIC, qiyu_app;

-- 审核员请求作用域 RLS：由 set_config('app.reviewer_id', ...) 提供身份。
ALTER TABLE reviewer_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE reviewer_accounts FORCE ROW LEVEL SECURITY;
CREATE POLICY reviewer_accounts_self ON reviewer_accounts
  FOR SELECT TO qiyu_reviewer USING (reviewer_id = current_setting('app.reviewer_id', true)::uuid);

ALTER TABLE dual_approval_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE dual_approval_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY dual_approvals_participant ON dual_approval_requests
  FOR SELECT TO qiyu_reviewer USING (requested_by = current_setting('app.reviewer_id', true)::uuid
    OR approved_by = current_setting('app.reviewer_id', true)::uuid);

ALTER TABLE ops_audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops_audit_events FORCE ROW LEVEL SECURITY;
-- 安全管理员可读全部审计（只读）；其余审核员只能读自己作为 actor 的行。
CREATE POLICY ops_audit_security_admin_read ON ops_audit_events
  FOR SELECT TO qiyu_reviewer USING (
    EXISTS (SELECT 1 FROM reviewer_accounts
            WHERE reviewer_id = current_setting('app.reviewer_id', true)::uuid
              AND state = 'ACTIVE' AND 'SECURITY_ADMIN' = ANY (roles))
    OR actor_id = current_setting('app.reviewer_id', true)
  );

-- 应用进程授权（应用层鉴权 + 域规则在 API 内）；审核员会话只获得窄读权。
GRANT SELECT, INSERT, UPDATE ON reviewer_accounts, reviewer_sessions, dual_approval_requests TO qiyu_app;
GRANT INSERT, SELECT ON ops_audit_events TO qiyu_app;
REVOKE ALL ON reviewer_accounts, reviewer_sessions, dual_approval_requests, ops_audit_events FROM PUBLIC;
GRANT SELECT ON reviewer_accounts, dual_approval_requests, ops_audit_events TO qiyu_reviewer;

INSERT INTO schema_migrations (migration_id) VALUES ('055_reviewer_identity_rbac_dual_approval_audit.sql');
COMMIT;

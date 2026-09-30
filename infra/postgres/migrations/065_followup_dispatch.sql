-- 六项能力 A2（方案 §4.2/§6.1）：事件级跟进许可 + 调度任务 + 每日槽位。
-- 确认事件 ≠ 允许提醒：一次许可（followup_grants）= 一次跟进，绑定用户确认的
-- 具体事件版本与时间窗口；改期后旧许可失效、新许可需再次确认。任务投递走
-- 租约领取→措辞→短事务发布（evaluateFollowupPublish 域函数是决策唯一写者，
-- 本库只供数与落库）。每日一条限额由 proactive_daily_slots 主键 + ON CONFLICT
-- 原子竞争（禁止查数量再插入），与既有手动触发共享。事件引用为弱引用（同
-- 060/063 约定，无外键——事件删除不回滚许可撤销事务）。
-- followup_kind 触发类型映射（域层拥有实现，此处登记）：
--   BEFORE_EVENT → CONFIRMED_APPOINTMENT（准点提醒，默认 due_at=事件时间）
--   AFTER_EVENT  → CONFIRMED_REALITY_ACTION（事后关心，默认 due_at=事件后 2 小时）
BEGIN;

CREATE TABLE followup_grants (
  grant_id uuid PRIMARY KEY DEFAULT app.uuid_v7(),
  account_id uuid NOT NULL REFERENCES accounts(account_id),
  character_id uuid NOT NULL,
  event_id uuid NOT NULL,
  event_version bigint NOT NULL CHECK (event_version > 0),
  followup_kind text NOT NULL CHECK (followup_kind IN ('BEFORE_EVENT', 'AFTER_EVENT')),
  channel text NOT NULL DEFAULT 'IN_APP' CHECK (channel = 'IN_APP'),
  allowed_from timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  state text NOT NULL DEFAULT 'ACTIVE' CHECK (state IN ('ACTIVE', 'REVOKED', 'EXPIRED')),
  consented_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (expires_at > allowed_from),
  CHECK (revoked_at IS NULL OR state = 'REVOKED'),
  UNIQUE (grant_id, account_id),
  FOREIGN KEY (character_id, account_id) REFERENCES characters(character_id, account_id)
);
-- 同一事件版本+种类只允许一个在生效许可（一次许可=一次跟进；PUBLISHED 后由
-- 域层置 REVOKED/EXPIRED 释放名额，第二次跟进须单独同意）。
CREATE UNIQUE INDEX followup_grants_active_unique
  ON followup_grants (event_id, event_version, followup_kind) WHERE state = 'ACTIVE';

-- READY 为方案枚举保留的瞬态（发布事务内复核通过待写消息）；当前实现直迁
-- LEASED→PUBLISHED，READY 不进入常规流转，保留以便后续发布分步化。
CREATE TABLE followup_jobs (
  job_id uuid PRIMARY KEY DEFAULT app.uuid_v7(),
  account_id uuid NOT NULL REFERENCES accounts(account_id),
  character_id uuid NOT NULL,
  event_id uuid NOT NULL,
  event_version bigint NOT NULL CHECK (event_version > 0),
  grant_id uuid NOT NULL,
  followup_kind text NOT NULL CHECK (followup_kind IN ('BEFORE_EVENT', 'AFTER_EVENT')),
  due_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  local_date date NOT NULL,
  state text NOT NULL DEFAULT 'PENDING' CHECK (state IN ('PENDING', 'LEASED', 'READY', 'PUBLISHED', 'CANCELLED', 'EXPIRED', 'FAILED')),
  lease_owner text,
  lease_expires_at timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  published_at timestamptz,
  CHECK (expires_at > due_at),
  -- 非租约态不得残留 lease 字段（CANCELLED 终态前可能带租约信息，允许；
  -- PENDING/READY 必须无租约）。
  CHECK (state NOT IN ('PENDING', 'READY') OR lease_owner IS NULL),
  UNIQUE (event_id, event_version, followup_kind, due_at)
);
CREATE INDEX followup_jobs_due_idx ON followup_jobs (next_attempt_at) WHERE state = 'PENDING';
CREATE INDEX followup_jobs_lease_idx ON followup_jobs (lease_expires_at) WHERE state = 'LEASED';

-- 每日槽位：主键即限额（每账户每天恰好一行）。竞争语义 = INSERT ON CONFLICT
-- DO NOTHING，不查数量、不进程内加锁。claimed_by 记 job_id 或 'manual'
-- （手动触发与 Worker 共享每日一条）。
CREATE TABLE proactive_daily_slots (
  account_id uuid NOT NULL REFERENCES accounts(account_id),
  local_date date NOT NULL,
  claimed_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (account_id, local_date)
);

-- operation_metrics capability 枚举扩充（照 039 重定义样式）：A1 提取与 A2
-- 跟进调度的指标值此前未入枚举，PG 路径 INSERT 会被 CHECK 拒绝。
ALTER TABLE operation_metrics
  DROP CONSTRAINT IF EXISTS operation_metrics_capability_check;
ALTER TABLE operation_metrics
  ADD CONSTRAINT operation_metrics_capability_check CHECK (capability IN (
    'CHAT_GENERATION', 'CONVERSATION_SUMMARY_GENERATION', 'TTS', 'ASR',
    'TRANSCRIBE_ASR', 'SYNTHESIZE_TTS', 'IMAGE_GENERATION', 'TEXT_MODERATION',
    'IMAGE_MODERATION', 'LIFE_EVENT_EXTRACTION', 'FOLLOWUP_DISPATCH'
  ));

ALTER TABLE followup_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE followup_grants FORCE ROW LEVEL SECURITY;
CREATE POLICY followup_grants_scope ON followup_grants FOR ALL TO qiyu_app
  USING (account_id = app.current_account_id()) WITH CHECK (account_id = app.current_account_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON followup_grants TO qiyu_app;

ALTER TABLE followup_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE followup_jobs FORCE ROW LEVEL SECURITY;
CREATE POLICY followup_jobs_scope ON followup_jobs FOR ALL TO qiyu_app
  USING (account_id = app.current_account_id()) WITH CHECK (account_id = app.current_account_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON followup_jobs TO qiyu_app;

ALTER TABLE proactive_daily_slots ENABLE ROW LEVEL SECURITY;
ALTER TABLE proactive_daily_slots FORCE ROW LEVEL SECURITY;
CREATE POLICY proactive_daily_slots_scope ON proactive_daily_slots FOR ALL TO qiyu_app
  USING (account_id = app.current_account_id()) WITH CHECK (account_id = app.current_account_id());
GRANT SELECT, INSERT, DELETE ON proactive_daily_slots TO qiyu_app;

-- 跟进 Worker 专用角色（照 036 守卫）：BYPASSRLS + 最小授权——跨账户领取
-- 到期任务、写投递三件（messages/message_memory_refs/proactive_messages）与
-- 槽位。不得降级为普通角色。
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'qiyu_followup_worker') THEN
    CREATE ROLE qiyu_followup_worker NOLOGIN NOINHERIT BYPASSRLS;
  ELSIF NOT (SELECT rolbypassrls FROM pg_roles WHERE rolname = 'qiyu_followup_worker') THEN
    RAISE EXCEPTION 'qiyu_followup_worker must retain BYPASSRLS';
  END IF;
END
$$;
GRANT USAGE ON SCHEMA app, public TO qiyu_followup_worker;
GRANT SELECT ON accounts, account_interaction_controls, required_notices, characters, conversations, life_events, followup_grants, proactive_daily_slots, proactive_messages TO qiyu_followup_worker;
GRANT SELECT, UPDATE ON followup_jobs TO qiyu_followup_worker;
-- conversations：投递落点可能需要新建会话（同内存 Worker ensureFollowupConversation）。
GRANT INSERT ON followup_jobs, proactive_daily_slots, proactive_messages, messages, message_memory_refs, conversations TO qiyu_followup_worker;
-- 操作指标（照 039 对摘要 worker 的授权）。
GRANT INSERT ON operation_metrics TO qiyu_followup_worker;
REVOKE ALL ON followup_grants, followup_jobs, proactive_daily_slots FROM PUBLIC;

INSERT INTO schema_migrations (migration_id) VALUES ('065_followup_dispatch.sql');

COMMIT;

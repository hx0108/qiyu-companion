-- 六项能力 A3（方案 §4.4/§4.5/§6.1）：共同小计划 + 交互成果卡片。
-- 计划建议不自动成为用户承诺：模型只产草案（DRAFT），接受（accept）才建立
-- 计划；接受也不自动授权提醒——卡片内单独勾选才经 A2 grantFollowup 落一条
-- linked 许可。暂停计划原子撤销这条 linked 许可（只撤它，不碰同事件上用户
-- 独立开启的提醒）；恢复只展示重新开启入口、不补发。计划自身无调度任务，
-- 投递仍归既有 qiyu_followup_worker，本迁移不建新后台角色。
-- 卡片是事件/计划的视图，不存第二份可编辑事实：artifact_cards 只落身份行
-- （稳定 id、账本清理、时间线重开定位），内容 GET 时现场渲染。事件引用为
-- 弱引用（同 063/065 约定，无外键——事件删除不回滚计划清理事务）。
-- 一事件至多一个未终结计划（部分唯一）；重复提案由域层 supersede 旧 DRAFT，
-- 不靠索引把正常重提变成报错。
BEGIN;

CREATE TABLE companion_plans (
  plan_id uuid PRIMARY KEY DEFAULT app.uuid_v7(),
  account_id uuid NOT NULL REFERENCES accounts(account_id),
  character_id uuid NOT NULL,
  event_id uuid,
  template_version text NOT NULL DEFAULT 'INTERVIEW_PREP_V1',
  support_mode text NOT NULL CHECK (support_mode IN ('PRACTICE_TOGETHER', 'BREAK_DOWN_STEPS', 'LISTEN_ONLY')),
  title text NOT NULL,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  state text NOT NULL DEFAULT 'DRAFT' CHECK (state IN ('DRAFT', 'ACTIVE', 'PAUSED', 'COMPLETED', 'CANCELLED')),
  linked_followup_grant_id uuid,
  state_reason text,
  expires_at timestamptz,
  accepted_at timestamptz,
  paused_at timestamptz,
  completed_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- DRAFT 才有草案 30 天过期窗（接受时置 NULL）；终态计划不携带过期语义。
  CHECK (state <> 'DRAFT' OR expires_at IS NOT NULL),
  -- 撤销语义的 linked 许可只挂在未终结计划上；终结时域层置 NULL 之外的残留
  -- 不允许出现在非 DRAFT 态（DRAFT 不可能已带许可）。
  CHECK (linked_followup_grant_id IS NULL OR state IN ('ACTIVE', 'PAUSED')),
  UNIQUE (plan_id, account_id),
  FOREIGN KEY (character_id, account_id) REFERENCES characters(character_id, account_id)
);
-- 同一事件同时至多一个未终结计划（DRAFT/ACTIVE/PAUSED）。ACTIVE 期间再提案
-- 须先暂停/取消（符合「不催促完成」的产品语气）；终态后可重新开始。
CREATE UNIQUE INDEX companion_plans_open_unique
  ON companion_plans (account_id, event_id)
  WHERE state IN ('DRAFT', 'ACTIVE', 'PAUSED') AND event_id IS NOT NULL;
CREATE INDEX companion_plans_account_idx ON companion_plans (account_id, updated_at DESC);

-- 步骤：首批不可重排（UNIQUE(plan_id, step_order)），完成/跳过必须用户操作。
-- API 乐观锁只用 plan.version 聚合锁（PATCH step 要求计划的 expected_version），
-- step.version 保留为行级审计字段。
CREATE TABLE companion_plan_steps (
  step_id uuid PRIMARY KEY DEFAULT app.uuid_v7(),
  plan_id uuid NOT NULL,
  account_id uuid NOT NULL REFERENCES accounts(account_id),
  step_order integer NOT NULL CHECK (step_order BETWEEN 1 AND 5),
  title text NOT NULL,
  estimated_minutes integer CHECK (estimated_minutes BETWEEN 5 AND 180),
  state text NOT NULL DEFAULT 'TODO' CHECK (state IN ('TODO', 'DONE', 'SKIPPED')),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (plan_id, step_order),
  FOREIGN KEY (plan_id, account_id) REFERENCES companion_plans(plan_id, account_id)
);
CREATE INDEX companion_plan_steps_plan_idx ON companion_plan_steps (plan_id);

-- 卡片身份行（一源一卡）：内容永不落库，GET /artifacts/{id} 时按 source 现场
-- 渲染（严格「视图、不存第二份事实」）。source_version 是创建时的锚点版本，
-- 仅信息性——卡片始终读源当前值，旧版本在来源面板按既有语义显示失效。
CREATE TABLE artifact_cards (
  artifact_id uuid PRIMARY KEY DEFAULT app.uuid_v7(),
  account_id uuid NOT NULL REFERENCES accounts(account_id),
  character_id uuid NOT NULL,
  type text NOT NULL CHECK (type IN ('EVENT_V1', 'PLAN_V1', 'READING_LOG_V1')),
  source_type text NOT NULL CHECK (source_type IN ('LIFE_EVENT', 'COMPANION_PLAN')),
  source_id uuid NOT NULL,
  source_version bigint NOT NULL CHECK (source_version > 0),
  schema_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (account_id, source_type, source_id),
  FOREIGN KEY (character_id, account_id) REFERENCES characters(character_id, account_id)
);
-- 事件类卡片的源约束登记（域层拥有实现）：EVENT_V1 ← 任意已确认事件；
-- READING_LOG_V1 ← event_kind=READING 的事件。

-- operation_metrics capability 枚举扩充（照 039/065 重定义样式）：A3 计划
-- 提议（模型槽）的指标值入枚举。
ALTER TABLE operation_metrics
  DROP CONSTRAINT IF EXISTS operation_metrics_capability_check;
ALTER TABLE operation_metrics
  ADD CONSTRAINT operation_metrics_capability_check CHECK (capability IN (
    'CHAT_GENERATION', 'CONVERSATION_SUMMARY_GENERATION', 'TTS', 'ASR',
    'TRANSCRIBE_ASR', 'SYNTHESIZE_TTS', 'IMAGE_GENERATION', 'TEXT_MODERATION',
    'IMAGE_MODERATION', 'LIFE_EVENT_EXTRACTION', 'FOLLOWUP_DISPATCH',
    'COMPANION_PLAN_PROPOSAL'
  ));

ALTER TABLE companion_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE companion_plans FORCE ROW LEVEL SECURITY;
CREATE POLICY companion_plans_scope ON companion_plans FOR ALL TO qiyu_app
  USING (account_id = app.current_account_id()) WITH CHECK (account_id = app.current_account_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON companion_plans TO qiyu_app;

ALTER TABLE companion_plan_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE companion_plan_steps FORCE ROW LEVEL SECURITY;
CREATE POLICY companion_plan_steps_scope ON companion_plan_steps FOR ALL TO qiyu_app
  USING (account_id = app.current_account_id()) WITH CHECK (account_id = app.current_account_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON companion_plan_steps TO qiyu_app;

ALTER TABLE artifact_cards ENABLE ROW LEVEL SECURITY;
ALTER TABLE artifact_cards FORCE ROW LEVEL SECURITY;
CREATE POLICY artifact_cards_scope ON artifact_cards FOR ALL TO qiyu_app
  USING (account_id = app.current_account_id()) WITH CHECK (account_id = app.current_account_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON artifact_cards TO qiyu_app;

REVOKE ALL ON companion_plans, companion_plan_steps, artifact_cards FROM PUBLIC;

INSERT INTO schema_migrations (migration_id) VALUES ('066_companion_plans_and_artifacts.sql');

COMMIT;

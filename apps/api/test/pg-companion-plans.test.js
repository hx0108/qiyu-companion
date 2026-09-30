'use strict';
// 六项能力 A3 PG 隔离库实测（P3.5）：无 QIYU_PG_TEST_DATABASE_URL 时整体
// skip（默认 npm test 不红）。由 scripts/run-pg-companion-plans.js 编排
// 临时库。硬门禁：迁移 066/067 可执行 + RLS/FORCE 与账户隔离、部分唯一
// 索引（一事件至多一个未终结计划）、action 幂等唯一、乐观锁恰一胜、
// 复合角色 FK 拒跨账户、域层全旅程（草案→接受带 followup→暂停撤 linked→
// 恢复不补发→事件取消→计划 PAUSED）。
const test = require('node:test');
const assert = require('node:assert/strict');
const pg = require('pg');
const { PostgresStore } = require('../src/persistence/postgres-store');
const { createPlanDraft, acceptPlan, pausePlan, resumePlan } = require('../src/domain/plan-service');
const { validatePlanDraftRequest, validateAcceptRequest } = require('../src/domain/plan-schema');
const { pausePlansOnEventCancellation } = require('../src/domain/plan-service');

const DATABASE_URL = process.env.QIYU_PG_TEST_DATABASE_URL;
const options = { skip: DATABASE_URL ? false : '需要 QIYU_PG_TEST_DATABASE_URL（npm run test:pg-companion-plans 编排）' };

// 开发库固定两账户（postgres-store DEVELOPMENT_DATABASE_ACCOUNT_IDS）。
const ALICE = '00000000-0000-7000-8000-0000000000a1';
const BOB = '00000000-0000-7000-8000-0000000000b2';
const ALICE_CHARACTER = 'aaaaaaaa-0000-7000-8000-000000000001';
const BOB_CHARACTER = 'bbbbbbbb-0000-7000-8000-000000000002';
const ALICE_CONVERSATION = 'aaaaaaaa-0000-7000-8000-000000000003';
const EVENT = 'e3000000-0000-7000-8000-000000000001';

const sharedPool = DATABASE_URL ? new pg.Pool({ connectionString: DATABASE_URL, max: 20 }) : null;
// 注意：Node 22.16 根级 test.before/after 传 options（含 skip:false）时钩子
// 不执行——这里不带 options，库未配置时在钩子内部自行跳过。
test.before(async () => { if (DATABASE_URL) await seedFixture(); });
test.after(async () => { if (sharedPool) await sharedPool.end(); });

async function scopedClient(accountId) {
  const client = await sharedPool.connect();
  await client.query('BEGIN');
  await client.query("SELECT set_config('app.current_account_id', $1, true)", [accountId]);
  return client;
}

async function seedFixture() {
  const store = new PostgresStore({ pool: sharedPool });
  await store.withAccountTransaction(ALICE, () => 'seed');
  await store.withAccountTransaction(BOB, () => 'seed');
  const client = await sharedPool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`INSERT INTO characters (character_id, account_id, display_name, status) VALUES ($1, $2, '栖夏', 'ACTIVE') ON CONFLICT (character_id) DO NOTHING`, [ALICE_CHARACTER, ALICE]);
    await client.query(`INSERT INTO characters (character_id, account_id, display_name, status) VALUES ($1, $2, '栖夏替身', 'ACTIVE') ON CONFLICT (character_id) DO NOTHING`, [BOB_CHARACTER, BOB]);
    await client.query(`INSERT INTO conversations (conversation_id, account_id, character_id, status, retention_expires_at) VALUES ($1, $2, $3, 'ACTIVE', CURRENT_TIMESTAMP + INTERVAL '90 days') ON CONFLICT (conversation_id) DO NOTHING`, [ALICE_CONVERSATION, ALICE, ALICE_CHARACTER]);
    await client.query(
      `INSERT INTO life_events (event_id, account_id, character_id, current_asset_id, domain, event_kind, title, scheduled_at, timezone, status, version)
       VALUES ($1, $2, $3, '88888888-8888-7000-8000-888888888888', 'REAL_LIFE', 'INTERVIEW', 'PG 计划验证面试', '2026-12-02T02:00:00Z', 'Asia/Shanghai', 'PLANNED', 1)
       ON CONFLICT (event_id) DO NOTHING`,
      [EVENT, ALICE, ALICE_CHARACTER]
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

test('PG A3：迁移 066/067 四表存在且 RLS/FORCE 生效（A 看不到 B 的行）', options, async () => {
  const tables = await sharedPool.query("SELECT tablename FROM pg_tables WHERE tablename IN ('companion_plans', 'companion_plan_steps', 'artifact_cards', 'action_requests') ORDER BY tablename");
  assert.deepEqual(tables.rows.map((row) => row.tablename), ['action_requests', 'artifact_cards', 'companion_plan_steps', 'companion_plans']);
  const rls = await sharedPool.query("SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname IN ('companion_plans', 'companion_plan_steps', 'artifact_cards', 'action_requests')");
  assert.equal(rls.rows.length, 4);
  assert.equal(rls.rows.filter((row) => row.relrowsecurity && row.relforcerowsecurity).length, 4, '四表都必须 RLS+FORCE');
  // 真实 RLS 过滤：superuser 绕过 RLS，必须 SET LOCAL ROLE qiyu_app 才走
  // 策略（生产请求路径同款：beginAccountScope 的 SET LOCAL ROLE +
  // app.account_id；注意函数读的是 app.account_id，不是 app.current_account_id）。
  // 同事务内切作用域验证 USING 过滤；插入验证 WITH CHECK。
  const client = await sharedPool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE qiyu_app');
    await client.query("SELECT set_config('app.account_id', $1, true)", [ALICE]);
    const inserted = await client.query(
      `INSERT INTO companion_plans (plan_id, account_id, character_id, event_id, template_version, support_mode, title, state, expires_at)
       VALUES ('a3000000-0000-7000-8000-000000000001', $1, $2, $3, 'INTERVIEW_PREP_V1', 'PRACTICE_TOGETHER', 'RLS 隔离验证', 'DRAFT', CURRENT_TIMESTAMP + INTERVAL '30 days')`,
      [ALICE, ALICE_CHARACTER, EVENT]
    );
    assert.equal(inserted.rowCount, 1, 'A 作用域内插入自身计划');
    await client.query("SELECT set_config('app.account_id', $1, true)", [BOB]);
    const bobView = await client.query('SELECT count(*)::int AS n FROM companion_plans');
    assert.equal(bobView.rows[0].n, 0, 'B 作用域必须看不到 A 的计划（RLS USING 过滤）');
    // 越权写：B 作用域对 A 的行 UPDATE 影响 0 行（FORCE 语义=静默过滤）。
    const crossWrite = await client.query("UPDATE companion_plans SET title = '越权改写' WHERE plan_id = 'a3000000-0000-7000-8000-000000000001'");
    assert.equal(crossWrite.rowCount, 0, 'B 作用域对 A 的行 UPDATE 必须 0 行');
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
  }
});

test('PG A3：部分唯一索引——同事件第二个未终结计划被拒；终态后可再建', options, async () => {
  // 段一：提交第一个 DRAFT（duplicate key 会中止事务，约束验证分开做）。
  const first = await scopedClient(ALICE);
  try {
    await first.query(
      `INSERT INTO companion_plans (plan_id, account_id, character_id, event_id, template_version, support_mode, title, state, expires_at)
       VALUES ('a3000000-0000-7000-8000-000000000002', $1, $2, $3, 'INTERVIEW_PREP_V1', 'PRACTICE_TOGETHER', '第一个计划', 'DRAFT', CURRENT_TIMESTAMP + INTERVAL '30 days')`,
      [ALICE, ALICE_CHARACTER, EVENT]
    );
    await first.query('COMMIT');
  } finally {
    first.release();
  }
  // 段二：同事件第二个未终结计划撞部分唯一索引。
  const second = await scopedClient(ALICE);
  try {
    await assert.rejects(
      () => second.query(
        `INSERT INTO companion_plans (plan_id, account_id, character_id, event_id, template_version, support_mode, title, state, expires_at)
         VALUES ('a3000000-0000-7000-8000-000000000003', $1, $2, $3, 'INTERVIEW_PREP_V1', 'BREAK_DOWN_STEPS', '第二个计划', 'DRAFT', CURRENT_TIMESTAMP + INTERVAL '30 days')`,
        [ALICE, ALICE_CHARACTER, EVENT]
      ),
      (error) => /companion_plans_open_unique|duplicate key/.test(error.message),
      '同事件第二个未终结计划必须被部分唯一索引拒绝'
    );
  } finally {
    await second.query('ROLLBACK').catch(() => {});
    second.release();
  }
  // 段三：终态释放名额——取消后可再建（提交：保留 CANCELLED 基线，避免
  // 残留 DRAFT 挡住后续测试的同事件唯一索引）。
  const third = await scopedClient(ALICE);
  try {
    await third.query("UPDATE companion_plans SET state = 'CANCELLED', cancelled_at = CURRENT_TIMESTAMP WHERE plan_id = 'a3000000-0000-7000-8000-000000000002'");
    const recreate = await third.query(
      `INSERT INTO companion_plans (plan_id, account_id, character_id, event_id, template_version, support_mode, title, state, expires_at)
       VALUES ('a3000000-0000-7000-8000-000000000003', $1, $2, $3, 'INTERVIEW_PREP_V1', 'BREAK_DOWN_STEPS', '重新开始', 'DRAFT', CURRENT_TIMESTAMP + INTERVAL '30 days')`,
      [ALICE, ALICE_CHARACTER, EVENT]
    );
    assert.equal(recreate.rowCount, 1, '终态后可再建');
    await third.query('COMMIT');
  } finally {
    await third.query('ROLLBACK').catch(() => {});
    third.release();
  }
  // 收尾：清掉「重新开始」DRAFT，事件只留终态行。
  const cleanup = await scopedClient(ALICE);
  try {
    await cleanup.query("DELETE FROM companion_plans WHERE plan_id = 'a3000000-0000-7000-8000-000000000003'");
    await cleanup.query('COMMIT');
  } finally {
    cleanup.release();
  }
});

test('PG A3：action_requests (account, idempotency_key) 全量唯一——域级幂等的 DB 防线', options, async () => {
  const client = await scopedClient(ALICE);
  try {
    await client.query(
      `INSERT INTO action_requests (action_id, account_id, character_id, action_type, target_ref, parameters_digest, expires_at, idempotency_key)
       VALUES ('a4000000-0000-7000-8000-000000000001', $1, $2, 'ACCEPT_PLAN', 'a3000000-0000-7000-8000-000000000009', 'digest', CURRENT_TIMESTAMP + INTERVAL '15 minutes', 'idem-pg-1')`,
      [ALICE, ALICE_CHARACTER]
    );
    await assert.rejects(
      () => client.query(
        `INSERT INTO action_requests (action_id, account_id, character_id, action_type, target_ref, parameters_digest, expires_at, idempotency_key)
         VALUES ('a4000000-0000-7000-8000-000000000002', $1, $2, 'ACCEPT_PLAN', 'a3000000-0000-7000-8000-000000000009', 'digest', CURRENT_TIMESTAMP + INTERVAL '15 minutes', 'idem-pg-1')`,
        [ALICE, ALICE_CHARACTER]
      ),
      (error) => /action_requests_account_id_idempotency_key_key|duplicate key/.test(error.message),
      '同 (account, idempotency_key) 第二行必须被唯一约束拒绝'
    );
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
  }
});

test('PG A3：乐观锁恰一胜——并发 accept 同版本计划只有一个生效', options, async () => {
  const client = await scopedClient(ALICE);
  try {
    await client.query(
      `INSERT INTO companion_plans (plan_id, account_id, character_id, event_id, template_version, support_mode, title, state, expires_at)
       VALUES ('a5000000-0000-7000-8000-000000000001', $1, $2, $3, 'INTERVIEW_PREP_V1', 'PRACTICE_TOGETHER', '并发接受验证', 'DRAFT', CURRENT_TIMESTAMP + INTERVAL '30 days')`,
      [ALICE, ALICE_CHARACTER, EVENT]
    );
    const winner = await client.query("UPDATE companion_plans SET state = 'ACTIVE', accepted_at = CURRENT_TIMESTAMP, expires_at = NULL, version = version + 1 WHERE plan_id = 'a5000000-0000-7000-8000-000000000001' AND state = 'DRAFT' AND version = 1");
    assert.equal(winner.rowCount, 1);
    const loser = await client.query("UPDATE companion_plans SET state = 'ACTIVE', accepted_at = CURRENT_TIMESTAMP, expires_at = NULL, version = version + 1 WHERE plan_id = 'a5000000-0000-7000-8000-000000000001' AND state = 'DRAFT' AND version = 1");
    assert.equal(loser.rowCount, 0, '旧版本的接受必须落空（乐观锁恰一胜）');
    const finalRow = (await client.query("SELECT state, version FROM companion_plans WHERE plan_id = 'a5000000-0000-7000-8000-000000000001'")).rows[0];
    assert.equal(finalRow.state, 'ACTIVE');
    assert.equal(Number(finalRow.version), 2);
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
  }
});

test('PG A3：复合角色 FK 拒绝跨账户 character_id；步骤复合 FK 依赖计划行', options, async () => {
  // 段一：跨账户角色 FK（拒绝会中止事务，独立验证）。
  const first = await scopedClient(ALICE);
  try {
    await assert.rejects(
      () => first.query(
        `INSERT INTO companion_plans (plan_id, account_id, character_id, template_version, support_mode, title, state, expires_at)
         VALUES ('a6000000-0000-7000-8000-000000000001', $1, $2, 'INTERVIEW_PREP_V1', 'PRACTICE_TOGETHER', '跨账户角色', 'DRAFT', CURRENT_TIMESTAMP + INTERVAL '30 days')`,
        [ALICE, BOB_CHARACTER]
      ),
      (error) => /foreign key|violates/.test(error.message),
      'ALICE 的计划挂 BOB 的角色必须被复合 FK 拒绝'
    );
  } finally {
    await first.query('ROLLBACK').catch(() => {});
    first.release();
  }
  // 段二：合法计划 + 错账户步骤（拒绝是本事务最后一条语句，回滚即可）。
  const second = await scopedClient(ALICE);
  try {
    await second.query(
      `INSERT INTO companion_plans (plan_id, account_id, character_id, template_version, support_mode, title, state, expires_at)
       VALUES ('a6000000-0000-7000-8000-000000000002', $1, $2, 'INTERVIEW_PREP_V1', 'PRACTICE_TOGETHER', '步骤外键验证', 'DRAFT', CURRENT_TIMESTAMP + INTERVAL '30 days')`,
      [ALICE, ALICE_CHARACTER]
    );
    await assert.rejects(
      () => second.query(
        `INSERT INTO companion_plan_steps (step_id, plan_id, account_id, step_order, title)
         VALUES ('a6000000-0000-7000-8000-000000000003', 'a6000000-0000-7000-8000-000000000002', $1, 1, '错账户步骤')`,
        [BOB]
      ),
      (error) => /foreign key|violates/.test(error.message),
      '步骤的 (plan, account) 复合 FK 拒绝错账户'
    );
  } finally {
    await second.query('ROLLBACK').catch(() => {});
    second.release();
  }
});

test('PG A3：域层全旅程——草案→接受带 followup→暂停撤 linked→恢复不补发→事件取消→计划 PAUSED', options, async () => {
  const store = new PostgresStore({ pool: sharedPool });
  const PROPOSAL = { title: 'PG 计划全旅程', steps: [
    { title: '练一次自我介绍', estimated_minutes: 20 },
    { title: '梳理两个故事', estimated_minutes: 30 }
  ], provider: 'template', model_version: 'plan-template-v1' };

  // 草案 + 卡片行 + 卡片消息（每次操作独立提交事务，模拟真实请求序列）。
  const draft = await store.withAccountTransaction(ALICE, (scoped) => {
    const event = scoped.lifeEvents.get(EVENT);
    return createPlanDraft({
      store: scoped, account: scoped.account(ALICE), event,
      validated: validatePlanDraftRequest({ template_version: 'INTERVIEW_PREP_V1', support_mode: 'PRACTICE_TOGETHER' }, { event }).value,
      proposal: PROPOSAL, now: new Date()
    });
  });
  assert.equal(draft.plan.state, 'DRAFT');
  assert.ok(draft.card.artifact_id, 'PG 路径草案产卡片身份行');
  const cardMessageCount = (await sharedPool.query(
    "SELECT count(*)::int AS n FROM messages WHERE provider = 'companion-card' AND attachments @> '[{\"type\":\"companion-card\"}]'::jsonb"
  )).rows[0].n;
  assert.equal(cardMessageCount, 1, '聊天卡片消息落库');

  // 接受（带 followup 子对象 → A2 许可与任务）。
  const accepted = await store.withAccountTransaction(ALICE, (scoped) => {
    const event = scoped.lifeEvents.get(EVENT);
    const plan = scoped.companionPlans.get(draft.plan.plan_id);
    return acceptPlan({
      store: scoped, account: scoped.account(ALICE), plan,
      validated: validateAcceptRequest({ expected_version: 1, followup: { followup_kind: 'BEFORE_EVENT' } }, { event, now: new Date() }).value,
      event, now: new Date()
    });
  });
  assert.equal(accepted.plan.state, 'ACTIVE');
  assert.ok(accepted.linked_grant.grant_id);
  const grantRow = (await sharedPool.query('SELECT state FROM followup_grants WHERE grant_id = $1', [accepted.linked_grant.grant_id])).rows[0];
  assert.equal(grantRow.state, 'ACTIVE');
  const jobRow = (await sharedPool.query('SELECT state FROM followup_jobs WHERE grant_id = $1', [accepted.linked_grant.grant_id])).rows[0];
  assert.equal(jobRow.state, 'PENDING');

  // 暂停：linked 许可撤销、在途任务取消（只撤那一条）。
  const paused = await store.withAccountTransaction(ALICE, (scoped) => {
    const plan = scoped.companionPlans.get(draft.plan.plan_id);
    return pausePlan({ store: scoped, plan, now: new Date() });
  });
  assert.equal(paused.plan.state, 'PAUSED');
  assert.equal(paused.followup_revoked.grants_revoked, 1);
  assert.equal((await sharedPool.query('SELECT state FROM followup_grants WHERE grant_id = $1', [accepted.linked_grant.grant_id])).rows[0].state, 'REVOKED');
  assert.equal((await sharedPool.query('SELECT state FROM followup_jobs WHERE grant_id = $1', [accepted.linked_grant.grant_id])).rows[0].state, 'CANCELLED');

  // 恢复：不补发（无新任务行）。
  const resumed = await store.withAccountTransaction(ALICE, (scoped) => {
    const plan = scoped.companionPlans.get(draft.plan.plan_id);
    return resumePlan({ store: scoped, plan, now: new Date() });
  });
  assert.equal(resumed.plan.state, 'ACTIVE');
  assert.equal((await sharedPool.query('SELECT count(*)::int AS n FROM followup_jobs WHERE grant_id = $1 AND state IN (\'PENDING\',\'LEASED\')', [accepted.linked_grant.grant_id])).rows[0].n, 0, '恢复不补发');

  // 事件取消联动：计划 PAUSED + state_reason。
  const linkage = await store.withAccountTransaction(ALICE, (scoped) => {
    const event = scoped.lifeEvents.get(EVENT);
    return pausePlansOnEventCancellation({ store: scoped, event, now: new Date() });
  });
  assert.equal(linkage.plans_paused, 1);
  const planRow = (await sharedPool.query('SELECT state, state_reason FROM companion_plans WHERE plan_id = $1', [draft.plan.plan_id])).rows[0];
  assert.equal(planRow.state, 'PAUSED');
  assert.equal(planRow.state_reason, 'event_cancelled');
});

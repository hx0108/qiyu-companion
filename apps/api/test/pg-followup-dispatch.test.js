'use strict';
// 六项能力 A2 PG 隔离库实测（P2.5）：无 QIYU_PG_TEST_DATABASE_URL 时整体
// skip（默认 npm test 不红）。由 scripts/run-pg-followup-dispatch.js 编排
// 临时库，或对便携版/远程测试库直连。硬门禁：迁移 065 可执行 + RLS、
// 双连接并发 claim 不相交（SKIP LOCKED）、并发 publish 抢槽恰一胜、
// Worker 全旅程（模板措辞→聊天流+来源引用+审计+槽位）、静默顺延、
// 租约过期重领（进程重启恢复）。
const test = require('node:test');
const assert = require('node:assert/strict');
const pg = require('pg');
const { PostgresStore } = require('../src/persistence/postgres-store');
const { PostgresFollowupRepository } = require('../src/persistence/postgres-followup-repository');

const DATABASE_URL = process.env.QIYU_PG_TEST_DATABASE_URL;
const options = { skip: DATABASE_URL ? false : '需要 QIYU_PG_TEST_DATABASE_URL（npm run test:pg-followup 编排）' };

// 开发库固定两账户（postgres-store DEVELOPMENT_DATABASE_ACCOUNT_IDS）。
const ALICE = '00000000-0000-7000-8000-0000000000a1';
const ALICE_CHARACTER = 'aaaaaaaa-0000-7000-8000-000000000001';
const ALICE_CONVERSATION = 'aaaaaaaa-0000-7000-8000-000000000002';
const EVENT = 'e1000000-0000-7000-8000-000000000001';

// 各测试用不同 local_date，避免共享每日槽位互相污染（同库串行跑）。
const DAY = { claim: '2026-10-03', publish: '2026-10-04', publish4: '2026-10-05', defer: '2026-10-06', lease: '2026-10-07' };
const NOW = {
  claim: '2026-10-03T10:00:00.000Z', publish: '2026-10-04T10:00:00.000Z',
  publish4: '2026-10-05T08:00:00.000Z', defer: '2026-10-06T10:00:00.000Z', lease: '2026-10-07T10:00:00.000Z'
};

const sharedPool = DATABASE_URL ? new pg.Pool({ connectionString: DATABASE_URL, max: 20 }) : null;
// 注意：Node 22.16 根级 test.before/after 传 options（含 skip:false）时钩子
// 不执行——这里不带 options，库未配置时在钩子内部自行跳过。
test.before(async () => { if (DATABASE_URL) await seedFixture(); });
test.after(async () => { if (sharedPool) await sharedPool.end(); });

let grantSeq = 0;
let jobSeq = 0;
// 许可+任务种子：同库跨测试共享行——同 (event,version,kind) 新许可前先撤销
// 旧 ACTIVE 许可（同域层 re-grant 语义，绕开部分唯一索引）；due 全部已到期。
async function seedFollowupJob(localDate, dueAt, kind = 'BEFORE_EVENT', overrides = {}) {
  grantSeq += 1;
  jobSeq += 1;
  const grantId = `f2000000-0000-7000-8000-${String(grantSeq).padStart(12, '0')}`;
  const jobId = `f3000000-0000-7000-8000-${String(jobSeq).padStart(12, '0')}`;
  await sharedPool.query(
    `UPDATE followup_grants SET state = 'REVOKED', revoked_at = CURRENT_TIMESTAMP
      WHERE event_id = $1 AND event_version = 1 AND followup_kind = $2 AND state = 'ACTIVE'`,
    [EVENT, kind]
  );
  await sharedPool.query(
    `INSERT INTO followup_grants (grant_id, account_id, character_id, event_id, event_version, followup_kind, allowed_from, expires_at)
     VALUES ($1, $2, $3, $4, 1, $5, '2026-09-01', '2026-10-10')`,
    [grantId, ALICE, ALICE_CHARACTER, EVENT, kind]
  );
  await sharedPool.query(
    `INSERT INTO followup_jobs (job_id, account_id, character_id, event_id, event_version, grant_id, followup_kind,
      due_at, expires_at, local_date, state, next_attempt_at)
     VALUES ($1, $2, $3, $4, 1, $5, $6, $7::timestamptz, '2026-10-10', $8::date, $9, $7::timestamptz)`,
    [jobId, ALICE, ALICE_CHARACTER, EVENT, grantId, kind, dueAt, localDate, overrides.state ?? 'PENDING']
  );
  return { grantId, jobId };
}

async function seedFixture() {
  const store = new PostgresStore({ pool: sharedPool });
  await store.withAccountTransaction(ALICE, () => 'seed');
  const client = await sharedPool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`INSERT INTO characters (character_id, account_id, display_name, status) VALUES ($1, $2, '栖夏', 'ACTIVE') ON CONFLICT (character_id) DO NOTHING`, [ALICE_CHARACTER, ALICE]);
    await client.query(`INSERT INTO conversations (conversation_id, account_id, character_id, status, retention_expires_at) VALUES ($1, $2, $3, 'ACTIVE', CURRENT_TIMESTAMP + INTERVAL '90 days') ON CONFLICT (conversation_id) DO NOTHING`, [ALICE_CONVERSATION, ALICE, ALICE_CHARACTER]);
    // 告知已展示（决策层对 NOTICE_PENDING fail-closed）：种子函数已建 PENDING
    // 告知，这里置为 DISPLAYED——不插第二张（due_at 平局会让 LIMIT 1 任取）。
    await client.query(`UPDATE required_notices SET state = 'DISPLAYED', displayed_at = CURRENT_TIMESTAMP WHERE account_id = $1`, [ALICE]);
    await client.query(
      `INSERT INTO life_events (event_id, account_id, character_id, current_asset_id, domain, event_kind, title, scheduled_at, timezone, status, version)
       VALUES ($1, $2, $3, '22222222-2222-7000-8000-222222222222', 'REAL_LIFE', 'INTERVIEW', 'PG 跟进验证面试', '2026-10-05T02:00:00Z', 'Asia/Shanghai', 'PLANNED', 1)
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

test('PG A2：迁移 065 三表存在且 RLS/FORCE 生效；worker 角色保留 BYPASSRLS', options, async () => {
  const tables = await sharedPool.query("SELECT tablename FROM pg_tables WHERE tablename IN ('followup_grants', 'followup_jobs', 'proactive_daily_slots') ORDER BY tablename");
  assert.deepEqual(tables.rows.map((row) => row.tablename), ['followup_grants', 'followup_jobs', 'proactive_daily_slots']);
  const rls = await sharedPool.query("SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname IN ('followup_grants', 'followup_jobs', 'proactive_daily_slots')");
  assert.equal(rls.rows.length, 3);
  assert.equal(rls.rows.filter((row) => row.relrowsecurity && row.relforcerowsecurity).length, 3, '三表都必须 RLS+FORCE');
  const role = await sharedPool.query("SELECT rolbypassrls FROM pg_roles WHERE rolname = 'qiyu_followup_worker'");
  assert.equal(role.rows[0]?.rolbypassrls, true, 'worker 角色（或角色缺失=迁移未跑时报 undefined）');
});

test('PG A2：双连接并发 claimDueBatch 不相交（SKIP LOCKED 恰一胜防线）', options, async () => {
  const first = await seedFollowupJob(DAY.claim, '2026-10-03T09:59:00Z', 'BEFORE_EVENT');
  const second = await seedFollowupJob(DAY.claim, '2026-10-03T09:58:00Z', 'AFTER_EVENT');
  const repoA = new PostgresFollowupRepository({ pool: sharedPool });
  const repoB = new PostgresFollowupRepository({ pool: sharedPool });
  const [batchA, batchB] = await Promise.all([
    repoA.claimDueBatch({ workerId: 'w1', limit: 1, now: new Date(NOW.claim) }),
    repoB.claimDueBatch({ workerId: 'w2', limit: 1, now: new Date(NOW.claim) })
  ]);
  const idsA = batchA.map((job) => job.job_id);
  const idsB = batchB.map((job) => job.job_id);
  assert.equal(idsA.length + idsB.length, 2, '两连接各恰好领到 1 条');
  assert.deepEqual([...idsA, ...idsB].sort(), [first.jobId, second.jobId].sort(), '领取结果不相交且覆盖全部到期任务');
  const rows = await sharedPool.query('SELECT job_id, state, lease_owner, attempts FROM followup_jobs WHERE job_id = ANY($1::uuid[]) ORDER BY job_id', [[first.jobId, second.jobId]]);
  assert.equal(rows.rows.filter((row) => row.state === 'LEASED').length, 2);
  assert.deepEqual(rows.rows.map((row) => Number(row.attempts)), [1, 1], '领取即 attempts+1');
  // 跨测试污染防护：LEASED 残留会在后续测试的时钟里以「租约过期」被重领
  //（其许可已被后续种子撤销）。终态化，退出领取候选。
  await sharedPool.query(`UPDATE followup_jobs SET state = 'CANCELLED', lease_owner = NULL, lease_expires_at = NULL, last_error = 'test cleanup'
    WHERE job_id = ANY($1::uuid[])`, [[first.jobId, second.jobId]]);
});

test('PG A2：并发 publish 抢每日槽位恰一胜——输家 EXPIRED 零投递', options, async () => {
  const first = await seedFollowupJob(DAY.publish, '2026-10-04T09:59:00Z', 'BEFORE_EVENT');
  const second = await seedFollowupJob(DAY.publish, '2026-10-04T09:58:00Z', 'AFTER_EVENT');
  const repo = new PostgresFollowupRepository({ pool: sharedPool });
  // 先各持有租约（并发 publish 的守卫 UPDATE 要求 LEASED）。
  const leaseA = (await repo.claimDueBatch({ workerId: 'wA', limit: 1, now: new Date(NOW.publish) }))[0];
  const leaseB = (await repo.claimDueBatch({ workerId: 'wB', limit: 1, now: new Date(NOW.publish) }))[0];
  assert.ok(leaseA && leaseB, '两条都应被租约领取');
  const composed = { text: '「PG 跟进验证面试」到时间啦。', provider: 'template', template_slot: 'CONFIRMED_APPOINTMENT', model_version: 'followup-template-v1' };
  const [outcomeA, outcomeB] = await Promise.all([
    repo.publish(leaseA, composed, { now: new Date(NOW.publish) }),
    repo.publish(leaseB, composed, { now: new Date(NOW.publish) })
  ]);
  const outcomes = [outcomeA, outcomeB];
  assert.equal(outcomes.filter((item) => item.state === 'PUBLISHED').length, 1, `每日一条：并发发布恰一胜（实际：${JSON.stringify(outcomes)}）`);
  assert.equal(outcomes.filter((item) => item.state === 'EXPIRED' && item.reason === 'DAILY_LIMIT_REACHED').length, 1, '输家 EXPIRED 不补发');
  assert.equal((await sharedPool.query("SELECT count(*)::int AS n FROM messages WHERE provider = 'proactive-followup'")).rows[0].n, 1, '聊天流只落一条');
  assert.equal((await sharedPool.query("SELECT count(*)::int AS n FROM proactive_messages WHERE account_id = $1 AND kind = 'NORMAL'", [ALICE])).rows[0].n, 1, '审计只一条');
  const slots = await sharedPool.query('SELECT claimed_by FROM proactive_daily_slots WHERE account_id = $1 AND local_date = $2::date', [ALICE, DAY.publish]);
  assert.equal(slots.rows.length, 1);
  const loserId = outcomes.find((item) => item.state === 'EXPIRED').job_id;
  assert.equal(slots.rows[0].claimed_by, outcomes.find((item) => item.state === 'PUBLISHED').job_id, '槽位归属赢家');
  const loserRow = (await sharedPool.query('SELECT state, last_error FROM followup_jobs WHERE job_id = $1', [loserId])).rows[0];
  assert.equal(loserRow.state, 'EXPIRED');
  assert.match(loserRow.last_error, /daily slot taken|DAILY_LIMIT_REACHED/);
  // A4 抑制原因计数表（迁移 068）：输家的每日一条抑制被同事务计数。
  const suppressed = (await sharedPool.query("SELECT count FROM followup_suppression_counters WHERE action = 'EXPIRE' AND reason = 'DAILY_LIMIT_REACHED'")).rows[0];
  assert.equal(Number(suppressed?.count ?? 0), 1, 'PG 路抑制计数：EXPIRE/DAILY_LIMIT_REACHED 恰一次');
});

test('PG A2：runNext 全旅程——模板措辞→聊天流+来源引用+审计+槽位；第二任务同日 EXPIRED', options, async () => {
  // 独立 local_date（与测试 3 分开，避免每日槽位互相占用）；first 的 due 更早，
  // 保证首个 runNext 领到的是它（领取按 next_attempt_at 升序）。
  const first = await seedFollowupJob(DAY.publish4, '2026-10-05T07:58:00Z', 'BEFORE_EVENT');
  const second = await seedFollowupJob(DAY.publish4, '2026-10-05T07:59:00Z', 'AFTER_EVENT');
  const repo = new PostgresFollowupRepository({ pool: sharedPool });
  const published = await repo.runNext({ composer: null, workerId: 'journey', now: new Date(NOW.publish4) });
  assert.equal(published.state, 'PUBLISHED');
  const messageRow = (await sharedPool.query('SELECT conversation_id, actor, convert_from(content_ciphertext, \'UTF8\') AS text FROM messages WHERE message_id = $1', [published.message_id])).rows[0];
  assert.equal(messageRow.actor, 'ASSISTANT');
  assert.equal(messageRow.conversation_id, ALICE_CONVERSATION, '投递进最新非删除会话');
  assert.match(messageRow.text, /PG 跟进验证面试/, '模板措辞含事件标题');
  const refRow = (await sharedPool.query('SELECT refs_json FROM message_memory_refs WHERE message_id = $1', [published.message_id])).rows[0];
  assert.equal(refRow.refs_json.refs[0].kind, 'LIFE_EVENT');
  assert.equal(refRow.refs_json.refs[0].id, EVENT);
  assert.equal(refRow.refs_json.refs[0].version, 1, '引用绑定事件版本');
  const auditRow = (await sharedPool.query('SELECT kind, template_slot FROM proactive_messages WHERE account_id = $1 AND sent_at::date = $2::date', [ALICE, DAY.publish4])).rows[0];
  assert.equal(auditRow.kind, 'NORMAL');
  assert.equal(auditRow.template_slot, 'CONFIRMED_APPOINTMENT');
  const jobRow = (await sharedPool.query('SELECT state, published_at FROM followup_jobs WHERE job_id = $1', [first.jobId])).rows[0];
  assert.equal(jobRow.state, 'PUBLISHED');
  assert.ok(jobRow.published_at, 'published_at 落库');
  const throttled = await repo.runNext({ composer: null, workerId: 'journey', now: new Date('2026-10-05T08:01:00.000Z') });
  assert.equal(throttled.state, 'EXPIRED');
  assert.equal(throttled.reason, 'DAILY_LIMIT_REACHED', '同日第二任务不补发（second.jobId 走槽位拒绝）');
  assert.equal((await sharedPool.query('SELECT state FROM followup_jobs WHERE job_id = $1', [second.jobId])).rows[0].state, 'EXPIRED');
});

test('PG A2：静默时段 DEFER 顺延到静默结束；租约过期任务被重领（重启恢复）', options, async () => {
  // 静默 23-12（本地 UTC 0 偏移）：10:00Z 在静默内 → DEFER 到 12:00Z。
  await sharedPool.query('UPDATE accounts SET proactive_preferences_json = $2::jsonb WHERE account_id = $1', [ALICE, JSON.stringify({ enabled: true, quiet_start_hour: 23, quiet_end_hour: 12, timezone_offset_minutes: 0 })]);
  try {
    const quietJob = await seedFollowupJob(DAY.defer, '2026-10-06T09:59:00Z', 'BEFORE_EVENT');
    const repo = new PostgresFollowupRepository({ pool: sharedPool });
    const deferred = await repo.runNext({ composer: null, workerId: 'quiet', now: new Date(NOW.defer) });
    assert.equal(deferred.state, 'DEFERRED', `静默任务应顺延（实际：${JSON.stringify(deferred)}）`);
    assert.equal(deferred.defer_until, '2026-10-06T12:00:00.000Z', '顺延到静默结束的精确时刻');
    const quietRow = (await sharedPool.query('SELECT state, next_attempt_at, attempts FROM followup_jobs WHERE job_id = $1', [quietJob.jobId])).rows[0];
    assert.equal(quietRow.state, 'PENDING');
    // pg 把 timestamptz 解析为 Date，统一转 ISO 再比较。
    assert.equal(new Date(quietRow.next_attempt_at).toISOString(), '2026-10-06T12:00:00.000Z');
    assert.equal(Number(quietRow.attempts), 1, '领取记一次尝试，顺延不额外耗尽');
    // A4 抑制原因计数（迁移 068）：静默顺延被发布事务同事务计数。
    const deferredCount = (await sharedPool.query("SELECT count FROM followup_suppression_counters WHERE action = 'DEFER' AND reason = 'QUIET_HOURS'")).rows[0];
    assert.equal(Number(deferredCount?.count ?? 0), 1, 'PG 路抑制计数：DEFER/QUIET_HOURS 恰一次');
  } finally {
    // 列 NOT NULL：重置为空对象（域层按默认偏好处理），不能置 NULL。
    await sharedPool.query('UPDATE accounts SET proactive_preferences_json = $2::jsonb WHERE account_id = $1', [ALICE, '{}']);
  }

  const leasedJob = await seedFollowupJob(DAY.lease, '2026-10-07T09:59:00Z', 'AFTER_EVENT');
  // 模拟 Worker 崩溃遗留：LEASED 且租约已过期（崩溃前那次领取已计 attempts=1）。
  await sharedPool.query(`UPDATE followup_jobs SET state = 'LEASED', attempts = 1, lease_owner = 'crashed', lease_expires_at = $2::timestamptz - INTERVAL '1 second' WHERE job_id = $1`, [leasedJob.jobId, NOW.lease]);
  const repo = new PostgresFollowupRepository({ pool: sharedPool });
  const reclaimed = await repo.claimDueBatch({ workerId: 'recovered', limit: 5, now: new Date(NOW.lease) });
  assert.equal(reclaimed.filter((job) => job.job_id === leasedJob.jobId).length, 1, '租约过期任务被重新领取');
  const reclaimedRow = (await sharedPool.query('SELECT lease_owner, attempts FROM followup_jobs WHERE job_id = $1', [leasedJob.jobId])).rows[0];
  assert.equal(reclaimedRow.lease_owner, 'recovered');
  assert.equal(Number(reclaimedRow.attempts), 2, '重领继续累计 attempts');
});

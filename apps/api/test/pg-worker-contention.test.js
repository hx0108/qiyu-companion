'use strict';
// 六项能力 A4 双进程 Worker 竞争验收（P4.4）：spawn 两个真实 run-workers
// 进程打同一 PG 库——S1 恰一胜（20 个账户各一条并发到期任务，每条恰一
// 投递；多账户是因为每日一条按真实时刻裁决，单账户同日只允许一条）、
// S2 崩溃租约重领（SQL 预置过期 LEASED 模拟被 kill -9 的进程，真实进程
// 重领恢复——attempts 累计）、S3 零重复投递审计（消息/审计按任务唯一、
// 终态守恒无残留）。无 QIYU_PG_TEST_DATABASE_URL 时整体 skip；由
// scripts/run-pg-worker-contention.js 编排临时库。
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const pg = require('pg');

const DATABASE_URL = process.env.QIYU_PG_TEST_DATABASE_URL;
const options = { skip: DATABASE_URL ? false : '需要 QIYU_PG_TEST_DATABASE_URL（npm run test:pg-worker-contention 编排）', timeout: 180_000 };

// 20 个竞争账户 + 1 个崩溃恢复账户（SQL 直种，不经 withAccountTransaction——
// 开发账户种子函数的 notice 幂等键只支持固定两账户）。
const CONTENTION_ACCOUNTS = Array.from({ length: 20 }, (_, index) => `b1000000-0000-7000-8000-${String(index + 1).padStart(12, '0')}`);
const RECOVERY_ACCOUNT = 'b1000000-0000-7000-8000-000000000021';
const RUN_WORKERS = path.join(__dirname, '..', 'scripts', 'run-workers.js');

const sharedPool = DATABASE_URL ? new pg.Pool({ connectionString: DATABASE_URL, max: 10 }) : null;
// 注意：Node 22.16 根级钩子带 options 不执行——同 A2/A3 套件，内部自行跳过。
test.before(async () => { if (DATABASE_URL) await seedAccounts([...CONTENTION_ACCOUNTS, RECOVERY_ACCOUNT]); });
test.after(async () => { if (sharedPool) await sharedPool.end(); });

async function seedAccounts(accountIds) {
  const client = await sharedPool.connect();
  try {
    await client.query('BEGIN');
    for (const accountId of accountIds) {
      // 静默规避：0-0 等宽窗口在策略层恒非静默（HTTP 校验会拒、直写 SQL 合法），
      // 测试可在任意时刻运行。
      await client.query(
        `INSERT INTO accounts (account_id, age_status, proactive_preferences_json)
         VALUES ($1, 'AGE_PASS', '{"enabled": true, "quiet_start_hour": 0, "quiet_end_hour": 0, "timezone_offset_minutes": 0}'::jsonb)
         ON CONFLICT (account_id) DO NOTHING`,
        [accountId]
      );
      await client.query(`INSERT INTO account_interaction_controls (account_id) VALUES ($1) ON CONFLICT (account_id) DO NOTHING`, [accountId]);
      await client.query(
        `INSERT INTO required_notices (notice_id, account_id, type, notice_version, state, displayed_at)
         VALUES (app.uuid_v7(), $1, 'AI_IDENTITY', 'ai_identity_m1.0', 'DISPLAYED', CURRENT_TIMESTAMP)`,
        [accountId]
      );
      await client.query(
        `INSERT INTO characters (character_id, account_id, display_name, status) VALUES ($1, $2, '栖夏', 'ACTIVE') ON CONFLICT (character_id) DO NOTHING`,
        [accountId.replace(/^b1/, 'b2'), accountId]
      );
      await client.query(
        `INSERT INTO conversations (conversation_id, account_id, character_id, status, retention_expires_at)
         VALUES ($1, $2, $3, 'ACTIVE', CURRENT_TIMESTAMP + INTERVAL '90 days') ON CONFLICT (conversation_id) DO NOTHING`,
        [accountId.replace(/^b1/, 'b3'), accountId, accountId.replace(/^b1/, 'b2')]
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

let jobSeq = 100;
// 每账户一条可发布到期任务（独立事件——许可部分唯一索引按 (event,version,kind)）。
async function seedPublishableJob(accountId, { state = 'PENDING', attempts = 0, leaseOwner = null, leaseExpired = false } = {}) {
  jobSeq += 1;
  const suffix = String(jobSeq).padStart(12, '0');
  const eventId = `e5000000-0000-7000-8000-${suffix}`;
  const grantId = `f5000000-0000-7000-8000-${suffix}`;
  const jobId = `f6000000-0000-7000-8000-${suffix}`;
  const characterId = accountId.replace(/^b1/, 'b2');
  await sharedPool.query(
    `INSERT INTO life_events (event_id, account_id, character_id, current_asset_id, domain, event_kind, title, scheduled_at, timezone, status, version)
     VALUES ($1, $2, $3, '99999999-9999-7000-8000-999999999999', 'REAL_LIFE', 'INTERVIEW', $4, CURRENT_TIMESTAMP - INTERVAL '1 hour', 'Asia/Shanghai', 'PLANNED', 1)`,
    [eventId, accountId, characterId, `双进程竞争面试 ${jobSeq}`]
  );
  await sharedPool.query(
    `INSERT INTO followup_grants (grant_id, account_id, character_id, event_id, event_version, followup_kind, allowed_from, expires_at)
     VALUES ($1, $2, $3, $4, 1, 'BEFORE_EVENT', '2026-09-01', '2027-01-01')`,
    [grantId, accountId, characterId, eventId]
  );
  // 租约到期时刻按模式内联（PENDING 无租约；未过期=+60s；已过期=模拟崩溃）。
  const leaseExpr = leaseOwner === null
    ? 'NULL'
    : leaseExpired ? "CURRENT_TIMESTAMP - INTERVAL '1 second'" : "CURRENT_TIMESTAMP + INTERVAL '60 seconds'";
  await sharedPool.query(
    `INSERT INTO followup_jobs (job_id, account_id, character_id, event_id, event_version, grant_id, followup_kind,
      due_at, expires_at, local_date, state, lease_owner, lease_expires_at, attempts, next_attempt_at)
     VALUES ($1, $2, $3, $4, 1, $5, 'BEFORE_EVENT',
      CURRENT_TIMESTAMP - INTERVAL '5 seconds', CURRENT_TIMESTAMP + INTERVAL '1 day', CURRENT_DATE, $6, $7, ${leaseExpr}, $8, CURRENT_TIMESTAMP - INTERVAL '5 seconds')`,
    [jobId, accountId, characterId, eventId, grantId, state, leaseOwner, attempts]
  );
  return { grantId, jobId, eventId };
}

// spawn 一个真实 run-workers 进程；ready 探针=启动日志行；SIGKILL≈kill -9。
function startWorker(workerId, { leaseSeconds = 2 } = {}) {
  const child = spawn(process.execPath, [RUN_WORKERS, '--interval-ms=200'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      QIYU_PERSISTENCE: 'postgres',
      DATABASE_URL,
      QIYU_WORKER_ID: workerId,
      QIYU_FOLLOWUP_LEASE_SECONDS: String(leaseSeconds)
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false
  });
  let readyResolve;
  const ready = new Promise((resolve, reject) => {
    readyResolve = resolve;
    const timeout = setTimeout(() => reject(new Error(`worker ${workerId} 15s 内未就绪`)), 15_000);
    readyResolve.timeout = timeout;
  });
  child.stdout.on('data', (chunk) => {
    if (String(chunk).includes('独立 Worker 已启动')) {
      clearTimeout(readyResolve.timeout);
      readyResolve();
    }
  });
  return {
    child, ready,
    kill: () => { try { child.kill('SIGKILL'); } catch { /* 已退出 */ } }
  };
}

async function waitFor(predicate, { timeoutMs = 60_000, label = '条件' } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`等待超时：${label}`);
}

test('PG A4·S1+S3：双进程竞争 20 账户各一条到期任务——每条恰一投递、零重复、终态守恒', options, async () => {
  for (const accountId of CONTENTION_ACCOUNTS) await seedPublishableJob(accountId);
  const workerA = startWorker('contention-a');
  const workerB = startWorker('contention-b');
  try {
    await Promise.all([workerA.ready, workerB.ready]);
    await waitFor(async () => {
      const remaining = await sharedPool.query("SELECT count(*)::int AS n FROM followup_jobs WHERE state IN ('PENDING', 'LEASED')");
      return remaining.rows[0].n === 0;
    }, { label: '20 条任务全部终态' });
  } finally {
    workerA.kill();
    workerB.kill();
  }
  const states = await sharedPool.query('SELECT state, count(*)::int AS n FROM followup_jobs GROUP BY state');
  const published = states.rows.find((row) => row.state === 'PUBLISHED')?.n ?? 0;
  assert.equal(published, 20, `20 条应全部 PUBLISHED（实际：${JSON.stringify(states.rows)}）`);
  // 零重复投递：审计 20 条（每任务恰一）、聊天流 20 条、无重复行、零在途残留。
  const auditRows = await sharedPool.query("SELECT count(*)::int AS n FROM proactive_messages WHERE kind = 'NORMAL'");
  assert.equal(auditRows.rows[0].n, 20, '审计恰 20 条（每任务恰一投递）');
  const dupAudit = await sharedPool.query('SELECT count(*)::int AS n FROM (SELECT 1 FROM proactive_messages GROUP BY account_id, event_id HAVING count(*) > 1) d');
  assert.equal(dupAudit.rows[0].n, 0, '无账户内重复投递');
  const messages = await sharedPool.query("SELECT count(*)::int AS n FROM messages WHERE provider = 'proactive-followup'");
  assert.equal(messages.rows[0].n, 20, '聊天流恰 20 条主动消息');
  const slots = await sharedPool.query('SELECT count(*)::int AS n FROM proactive_daily_slots');
  assert.equal(slots.rows[0].n, 20, '每日槽位恰 20 行（每账户一行，PK 唯一）');
  assert.equal(states.rows.filter((row) => ['PENDING', 'LEASED'].includes(row.state)).length, 0, '零在途残留');
});

test('PG A4·S2：崩溃进程的过期租约被真实 Worker 重领恢复（attempts 累计）', options, async () => {
  const crashed = await seedPublishableJob(RECOVERY_ACCOUNT, { state: 'LEASED', attempts: 1, leaseOwner: 'crashed-process', leaseExpired: true });
  const worker = startWorker('contention-recovery', { leaseSeconds: 2 });
  try {
    await worker.ready;
    await waitFor(async () => {
      const row = await sharedPool.query('SELECT state FROM followup_jobs WHERE job_id = $1', [crashed.jobId]);
      return row.rows[0]?.state === 'PUBLISHED';
    }, { label: '崩溃租约任务被重领并发布' });
  } finally {
    worker.kill();
  }
  const row = (await sharedPool.query('SELECT state, attempts, lease_owner FROM followup_jobs WHERE job_id = $1', [crashed.jobId])).rows[0];
  assert.equal(row.state, 'PUBLISHED');
  assert.ok(Number(row.attempts) >= 2, `重领累计 attempts（实际 ${row.attempts}）`);
  assert.equal(row.lease_owner, null, '发布后租约清空');
  const audit = await sharedPool.query('SELECT count(*)::int AS n FROM proactive_messages WHERE account_id = $1', [RECOVERY_ACCOUNT]);
  assert.equal(audit.rows[0].n, 1, '恰一投递');
});

#!/usr/bin/env node
'use strict';

// 六项能力 A4 删除账本本地恢复演练（P4.6）：主库造九域数据 → pg_dump 备份
// → 主库执行注销清理（账本 COMPLETED）→ 恢复备份到第二库（模拟备份恢复
// 带回数据）→ 账本重放 dry-run + --apply → 断言恢复库九域清零。全程 docker
// exec 内完成 pg_dump/restore（不经宿主机路径）。产出
// development/eval/runs/deletion-recovery-drill-r1/DRILL.md 并登记
// DELETION_RECOVERY_DRILL_RUNBOOK §4 台账（本地 Docker 合成数据，非生产
// 备份介质——生产首演空位不动）。

const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const pg = require('pg');
const { PostgresStore } = require('../src/persistence/postgres-store');
const { confirmLifeEventFromCandidate } = require('../src/domain/life-event-service');
const { grantFollowup } = require('../src/domain/followup-service');
const { validateFollowupGrantRequest } = require('../src/domain/followup-schema');
const { createPlanDraft, acceptPlan, ensureArtifactCard } = require('../src/domain/plan-service');
const { validatePlanDraftRequest, validateAcceptRequest } = require('../src/domain/plan-schema');
const { registerAccountDeletionTargets, runAccountDeletionCleanup, deletionReceipt } = require('../src/domain/deletion-orchestration');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const COMPOSE_FILE = path.join(REPO_ROOT, 'infra', 'postgres', 'docker-compose.test.yml');
const CONTAINER = 'qiyu-postgres-a1-test';
const PRIMARY_URL = process.env.QIYU_PG_TEST_DATABASE_URL || 'postgres://postgres:qiyu-a1-test-only@127.0.0.1:54329/qiyu_a1_test';
const RESTORED_URL = 'postgres://postgres:qiyu-a1-test-only@127.0.0.1:54329/qiyu_restored';
const ACCOUNT = '00000000-0000-7000-8000-0000000000a1';
const CHARACTER = 'aaaaaaaa-0000-7000-8000-000000000001';
const CONVERSATION = 'aaaaaaaa-0000-7000-8000-000000000002';
const EVENT = 'e7000000-0000-7000-8000-000000000001';
const NOW = new Date();
const NINE_DOMAINS = ['life_events', 'life_event_extraction_jobs', 'message_memory_refs', 'followup_grants', 'followup_jobs', 'proactive_daily_slots', 'companion_plans', 'companion_plan_steps', 'artifact_cards', 'action_requests'];

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: ['ignore', options.capture ? 'pipe' : 'inherit', 'inherit'], shell: process.platform === 'win32', ...options });
  return { ok: result.status === 0, stdout: result.stdout ? String(result.stdout) : '' };
}

function dockerAvailable() { return run('docker', ['info'], { capture: true }).ok; }

async function warmup(url) {
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const client = new pg.Client({ connectionString: url });
    try { await client.connect(); await client.query('SELECT 1'); return true; }
    catch { /* 重试 */ }
    finally { await client.end().catch(() => {}); }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  return false;
}

async function seedNineDomains(pool) {
  const store = new PostgresStore({ pool });
  // 基础设施行直 SQL（自动提交）；域数据经 withAccountTransaction 走真实
  // 域函数（flush 覆盖 PG 语义）。
  await store.withAccountTransaction(ACCOUNT, () => 'seed');
  await pool.query(`INSERT INTO characters (character_id, account_id, display_name, status) VALUES ($1, $2, '栖夏', 'ACTIVE') ON CONFLICT DO NOTHING`, [CHARACTER, ACCOUNT]);
  await pool.query(`INSERT INTO conversations (conversation_id, account_id, character_id, status, retention_expires_at) VALUES ($1, $2, $3, 'ACTIVE', CURRENT_TIMESTAMP + INTERVAL '90 days') ON CONFLICT DO NOTHING`, [CONVERSATION, ACCOUNT, CHARACTER]);
  await pool.query(`UPDATE required_notices SET state = 'DISPLAYED', displayed_at = CURRENT_TIMESTAMP WHERE account_id = $1`, [ACCOUNT]);
  await pool.query(`INSERT INTO life_events (event_id, account_id, character_id, current_asset_id, domain, event_kind, title, scheduled_at, timezone, status, version)
    VALUES ($1, $2, $3, 'aaaaaaaa-0000-7000-8000-000000000003', 'REAL_LIFE', 'INTERVIEW', '删除演练面试', '2026-12-02T02:00:00Z', 'Asia/Shanghai', 'PLANNED', 1) ON CONFLICT DO NOTHING`, [EVENT, ACCOUNT, CHARACTER]);
  await pool.query(`INSERT INTO messages (message_id, conversation_id, actor, content_ciphertext, retention_expires_at) VALUES ('e8000000-0000-7000-8000-000000000002', $1, 'USER', convert_to('删除演练消息', 'UTF8'), CURRENT_TIMESTAMP + INTERVAL '90 days') ON CONFLICT DO NOTHING`, [CONVERSATION]);
  await pool.query(`INSERT INTO life_event_extraction_jobs (job_id, account_id, character_id, conversation_id, message_id, captured_revocation_epoch)
    VALUES ('e8000000-0000-7000-8000-000000000001', $1, $2, $3, 'e8000000-0000-7000-8000-000000000002', 0) ON CONFLICT DO NOTHING`, [ACCOUNT, CHARACTER, CONVERSATION]);
  await pool.query(`INSERT INTO message_memory_refs (ref_id, message_id, account_id, character_id, conversation_id, refs_json, context_bundle_version)
    VALUES ('e8000000-0000-7000-8000-000000000003', 'e8000000-0000-7000-8000-000000000002', $1, $2, $3, '{"refs":[]}'::jsonb, 'context-v1') ON CONFLICT DO NOTHING`, [ACCOUNT, CHARACTER, CONVERSATION]);
  // A2 域。
  await store.withAccountTransaction(ACCOUNT, async (scoped) => {
    const event = scoped.lifeEvents.get(EVENT);
    await grantFollowup({ store: scoped, account: scoped.account(ACCOUNT), event, validated: validateFollowupGrantRequest({ followup_kind: 'BEFORE_EVENT', due_at: '2026-12-05T06:00:00.000Z', allowed_from: NOW.toISOString(), expires_at: '2026-12-10T06:00:00.000Z' }, { event, now: NOW }).value, now: NOW });
  });
  // A3 域。
  await store.withAccountTransaction(ACCOUNT, async (scoped) => {
    const event = scoped.lifeEvents.get(EVENT);
    const draft = createPlanDraft({
      store: scoped, account: scoped.account(ACCOUNT), event,
      validated: validatePlanDraftRequest({ template_version: 'INTERVIEW_PREP_V1', support_mode: 'PRACTICE_TOGETHER' }, { event }).value,
      proposal: { title: '删除演练计划', steps: [{ title: '第一步', estimated_minutes: 20 }], provider: 'template', model_version: 'plan-template-v1' }, now: NOW
    });
    await acceptPlan({ store: scoped, account: scoped.account(ACCOUNT), plan: draft.plan, validated: validateAcceptRequest({ expected_version: draft.plan.version }, { event, now: NOW }).value, event, now: NOW });
    await ensureArtifactCard({ store: scoped, accountId: ACCOUNT, characterId: CHARACTER, type: 'EVENT_V1', sourceType: 'LIFE_EVENT', sourceId: EVENT, sourceVersion: 1, now: NOW });
    scoped.actionRequests.set('e9000000-0000-7000-8000-000000000001', { action_id: 'e9000000-0000-7000-8000-000000000001', account_id: ACCOUNT, character_id: CHARACTER, action_type: 'ACCEPT_PLAN', target_ref: draft.plan.plan_id, target_version: 1, parameters_digest: 'x', state: 'SUCCEEDED', expires_at: NOW.toISOString(), result_ref: null, failure_code: null, idempotency_key: 'drill-1', approved_at: NOW.toISOString(), executed_at: NOW.toISOString(), created_at: NOW.toISOString(), updated_at: NOW.toISOString() });
  });
}

async function domainCounts(pool) {
  const counts = {};
  for (const table of NINE_DOMAINS) {
    const column = table === 'proactive_daily_slots' ? 'account_id' : 'account_id';
    const result = await pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE ${column} = $1`, [ACCOUNT]);
    counts[table] = result.rows[0].n;
  }
  return counts;
}

async function main() {
  const reportLines = ['# 删除账本本地恢复演练（A4·P4.6）', '', `- 运行时间：${new Date().toISOString()}`, '- 边界：本地 Docker tmpfs 合成数据，非生产备份介质；生产首次演练仍按 Runbook §4 空位登记（封测上线后 30 天内）。', ''];
  if (!dockerAvailable()) { console.error('[drill] Docker 不可用，演练未运行（不算失败——本地演练装备，生产演练另行安排）。'); process.exit(0); }
  run('docker', ['compose', '-f', COMPOSE_FILE, 'down', '-v']);
  if (!run('docker', ['compose', '-f', COMPOSE_FILE, 'up', '-d', '--wait']).ok) { console.error('[drill] 临时库启动失败。'); process.exit(1); }
  const primaryPool = new pg.Pool({ connectionString: PRIMARY_URL, max: 4 });
  try {
    if (!(await warmup(PRIMARY_URL))) { console.error('[drill] 预热失败。'); process.exit(1); }
    // ① 主库造九域数据。
    await seedNineDomains(primaryPool);
    const before = await domainCounts(primaryPool);
    reportLines.push(`## ① 备份前（主库九域行数）`, '', '```json', JSON.stringify(before), '```', '');
    // ② pg_dump 备份（容器内文件，不经宿主机路径）。
    if (!run('docker', ['exec', CONTAINER, 'pg_dump', '-U', 'postgres', '-d', 'qiyu_a1_test', '-f', '/tmp/drill-backup.dump']).ok) throw new Error('pg_dump 失败');
    // ③ 主库注销清理（账本 COMPLETED）。
    const store = new PostgresStore({ pool: primaryPool });
    await store.withAccountTransaction(ACCOUNT, async (scoped) => {
      const account = scoped.account(ACCOUNT);
      account.account_status = 'CLOSING';
      const job = { deletion_job_id: scoped.next('del'), account_id: ACCOUNT, scope: 'ACCOUNT', state: 'ONLINE_DISABLED', revocation_epoch: account.revocation_epoch, physical_cleanup_state: 'PENDING_CLEANUP_WORKER', created_at: new Date().toISOString(), note: 'A4 本地恢复演练' };
      scoped.deletionJobs.set(job.deletion_job_id, job);
      registerAccountDeletionTargets(scoped, account, job);
      await runAccountDeletionCleanup(scoped, account, job, { now: new Date() });
    });
    const afterPrimary = await domainCounts(primaryPool);
    const receiptCount = Object.values(afterPrimary).every((n) => n === 0);
    reportLines.push(`## ②③ 注销清理后（主库九域应为零）`, '', '```json', JSON.stringify(afterPrimary), '```', '', `清理回执：${receiptCount ? '九域全零' : '存在残留（异常）'}`, '');
    if (!receiptCount) throw new Error(`主库清理未清零：${JSON.stringify(afterPrimary)}`);
    // ④ 恢复备份到第二库（模拟备份恢复带回数据）。
    run('docker', ['exec', CONTAINER, 'dropdb', '-U', 'postgres', '--if-exists', 'qiyu_restored']);
    if (!run('docker', ['exec', CONTAINER, 'createdb', '-U', 'postgres', 'qiyu_restored']).ok) throw new Error('createdb 失败');
    if (!run('docker', ['exec', CONTAINER, 'psql', '-U', 'postgres', '-d', 'qiyu_restored', '-f', '/tmp/drill-backup.dump', '-q']).ok) throw new Error('备份恢复失败');
    const restoredPool = new pg.Pool({ connectionString: RESTORED_URL, max: 4 });
    try {
      const restoredBefore = await domainCounts(restoredPool);
      const resurrected = Object.values(restoredBefore).some((n) => n > 0);
      reportLines.push(`## ④ 备份恢复后（恢复库九域——数据被备份带回）`, '', '```json', JSON.stringify(restoredBefore), '```', '', `复活状态：${resurrected ? '存在应删数据（重放目标）' : '无数据（异常）'}`, '');
      if (!resurrected) throw new Error('恢复库无数据，演练无意义');
      // ⑤ 账本重放：dry-run → apply。
      const dry = run(process.execPath, [path.join(__dirname, 'run-deletion-ledger-replay.js'), `--source-url=${PRIMARY_URL}`, `--target-url=${RESTORED_URL}`], { capture: true });
      const dryReport = JSON.parse(dry.stdout || '{}');
      reportLines.push(`## ⑤ 账本重放 dry-run`, '', '```json', JSON.stringify(dryReport), '```', '');
      if (!dry.ok || dryReport.applied_count !== 0) throw new Error('dry-run 不应有 applied');
      const apply = run(process.execPath, [path.join(__dirname, 'run-deletion-ledger-replay.js'), `--source-url=${PRIMARY_URL}`, `--target-url=${RESTORED_URL}`, '--apply'], { capture: true });
      const applyReport = JSON.parse(apply.stdout || '{}');
      reportLines.push(`## ⑥ 账本重放 --apply`, '', '```json', JSON.stringify(applyReport), '```', '');
      if (!apply.ok || applyReport.applied_count !== applyReport.total || (applyReport.skipped?.length ?? 0) > 0) throw new Error(`apply 未全覆盖：${apply.stdout}`);
      // ⑦ 恢复库九域清零核对。
      const restoredAfter = await domainCounts(restoredPool);
      const allZero = Object.values(restoredAfter).every((n) => n === 0);
      reportLines.push(`## ⑦ 重放后（恢复库九域应为零——删除不可被备份恢复复活）`, '', '```json', JSON.stringify(restoredAfter), '```', '', allZero ? '**结论：演练通过。**' : '**结论：演练失败——存在复活数据。**', '');
      const runDir = path.join(REPO_ROOT, 'development', 'eval', 'runs', 'deletion-recovery-drill-r1');
      fs.mkdirSync(runDir, { recursive: true });
      fs.writeFileSync(path.join(runDir, 'DRILL.md'), reportLines.join('\n') + '\n', 'utf8');
      console.log(reportLines.join('\n'));
      console.log(`\n[drill] 报告已写入 ${path.join(runDir, 'DRILL.md')}`);
      process.exitCode = allZero ? 0 : 1;
    } finally {
      await restoredPool.end();
      run('docker', ['exec', CONTAINER, 'dropdb', '-U', 'postgres', '--if-exists', 'qiyu_restored']);
    }
  } finally {
    await primaryPool.end();
    console.log('[drill] 清理临时库（down -v）。');
    run('docker', ['compose', '-f', COMPOSE_FILE, 'down', '-v']);
  }
}

main().catch((error) => { console.error('[drill] 演练失败：', error.message); process.exit(1); });

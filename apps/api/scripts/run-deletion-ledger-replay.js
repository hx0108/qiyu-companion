'use strict';

// 恢复演练 / 恢复后重放（P0 数据删除与恢复，PRD 7.0 备份行）：
// 从生产库读取删除账本（deletion_jobs + deletion_targets），在恢复出的
// 备份库上重放同等删除。默认 dry-run 只出报告；--apply 才真正执行。
//
// 用法（在能同时连到两个库的运维机上执行）：
//   node scripts/run-deletion-ledger-replay.js \
//     --source-url=postgres://.../qiyu \
//     --target-url=postgres://.../qiyu_restored \
//     [--apply]
//
// 演练记录写入 development/DELETION_RECOVERY_DRILL_RUNBOOK.md 所述台账。
// 退出码：dry-run 或全量成功 0；--apply 下存在失败/跳过 1（fail loud）。

const { Pool } = require('pg');
const { PostgresStore } = require('../src/persistence/postgres-store');
const { replayDeletionLedger } = require('../src/domain/deletion-ledger-replay');

function parseArgs(argv) {
  const value = (name) => argv.find((arg) => arg.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
  return { sourceUrl: value('source-url'), targetUrl: value('target-url'), apply: argv.includes('--apply') };
}

async function loadLedgerJobs(sourcePool) {
  // 作用域为 CONVERSATION 的删除任务不直接携带会话 ID：从账本目标
  // （deletion_targets.MESSAGES 的 target_ref）解析，解析不到的任务
  // 以 SCOPE_NOT_REPLAYABLE 如实报告而不是猜。
  const result = await sourcePool.query(`
    SELECT d.deletion_job_id, d.account_id, d.scope, d.state, d.asset_id,
      (SELECT t.target_ref FROM deletion_targets t
        WHERE t.deletion_job_id = d.deletion_job_id AND t.target_type = 'MESSAGES'
        ORDER BY t.created_at ASC LIMIT 1) AS conversation_id
    FROM deletion_jobs d
    WHERE d.deleted_at IS NULL AND d.scope IN ('ACCOUNT', 'CONVERSATION', 'MEDIA', 'RELATIONSHIP_ASSET')
    ORDER BY d.created_at ASC`);
  return result.rows.map((row) => ({
    deletion_job_id: row.deletion_job_id, account_id: row.account_id, scope: row.scope,
    state: row.state, asset_id: row.asset_id, conversation_id: row.conversation_id || null
  }));
}

async function main() {
  const { sourceUrl, targetUrl, apply } = parseArgs(process.argv.slice(2));
  if (!sourceUrl || !targetUrl) throw new Error('--source-url 与 --target-url 均为必填（源=生产账本库，目标=恢复出的备份库）');
  const sourcePool = new Pool({ connectionString: sourceUrl, max: 1 });
  const targetStore = new PostgresStore({ pool: new Pool({ connectionString: targetUrl, max: 1 }) });
  try {
    const ledgerJobs = await loadLedgerJobs(sourcePool);
    const report = await replayDeletionLedger({
      ledgerJobs,
      openAccount: (accountId, operation) => targetStore.withAccountTransaction(accountId, (scoped) => {
        const account = [...scoped.accounts.values()][0];
        if (!account) throw new Error(`备份库中找不到账户 ${accountId}`);
        return operation(scoped, account);
      }),
      apply
    });
    process.stdout.write(`${JSON.stringify({ mode: apply ? 'APPLY' : 'DRY_RUN', ...report }, null, 2)}\n`);
    if (apply && report.skipped.length > 0) process.exitCode = 1;
  } finally {
    await sourcePool.end();
    await targetStore.pool.end();
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`deletion ledger replay failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { main, loadLedgerJobs };

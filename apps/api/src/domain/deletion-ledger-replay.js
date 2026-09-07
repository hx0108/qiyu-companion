'use strict';

const { replayConversationDeletion } = require('./deletion-orchestration');

// 删除账本重放（P0 数据删除与恢复，PRD 7.0 备份行）：
// 从生产账本（deletion_jobs）读取已生效的删除决定，在恢复出的备份库上
// 重新执行同等删除。封测级为人工触发（恢复演练 / 真实恢复后立即执行）；
// 公开级才要求恢复流程自动挂接。规则：
//   1) 只重放账本中 state=COMPLETED 的任务——未完成的决定不属于备份要
//      预知的终态；
//   2) ACCOUNT 作用域重放账户清理（仅行级，不再外呼对象存储）；
//   3) CONVERSATION 作用域重放会话删除（消息物理删、派生数据失效）；
//   4) MEDIA / RELATIONSHIP_ASSET 作用域对齐行级软删状态；
//   5) dry-run 模式只报告将要执行的动作，不改任何行。
// 若重放跳过或失败任何账本项，结果必须如实带出（fail loud），由演练记录留档。

async function replayDeletionLedger({ ledgerJobs, openAccount, apply = false, now = new Date() }) {
  if (!Array.isArray(ledgerJobs)) throw new TypeError('ledgerJobs must be an array of deletion ledger entries');
  if (typeof openAccount !== 'function') throw new TypeError('openAccount(accountId, operation) is required');
  const results = [];
  const byAccount = new Map();
  for (const job of ledgerJobs) {
    if (!job || !job.account_id) { results.push({ deletion_job_id: null, applied: false, reason: 'INVALID_LEDGER_ENTRY' }); continue; }
    if (!byAccount.has(job.account_id)) byAccount.set(job.account_id, []);
    byAccount.get(job.account_id).push(job);
  }
  for (const [accountId, jobs] of byAccount) {
    await openAccount(accountId, async (store, account) => {
      for (const job of jobs) {
        if (job.state !== 'COMPLETED') { results.push({ deletion_job_id: job.deletion_job_id, scope: job.scope, applied: false, reason: 'NOT_COMPLETED_IN_LEDGER' }); continue; }
        if (!apply) { results.push({ deletion_job_id: job.deletion_job_id, scope: job.scope, applied: false, reason: 'DRY_RUN' }); continue; }
        try {
          const outcome = await replayOne(store, account, job, now);
          results.push({ deletion_job_id: job.deletion_job_id, scope: job.scope, applied: true, ...outcome });
        } catch (error) {
          results.push({ deletion_job_id: job.deletion_job_id, scope: job.scope, applied: false, reason: error.message });
        }
      }
    });
  }
  return {
    applied: apply,
    total: results.length,
    applied_count: results.filter((item) => item.applied).length,
    skipped: results.filter((item) => !item.applied),
    results
  };
}

async function replayOne(store, account, job, now) {
  if (job.scope === 'ACCOUNT') {
    const { runAccountDeletionCleanup } = require('./deletion-orchestration');
    // 账户清理幂等；备份库中的账户此时通常仍是 OPEN——把它视为 CLOSING
    // 终态对齐（账本已证明生产侧注销成立）。
    if (account.account_status === 'OPEN') account.account_status = 'CLOSING';
    let target = [...store.deletionJobs.values()].find((item) => item.deletion_job_id === job.deletion_job_id);
    if (!target) {
      target = { deletion_job_id: job.deletion_job_id, account_id: account.account_id, asset_id: null, scope: 'ACCOUNT', state: 'ONLINE_DISABLED', revocation_epoch: account.revocation_epoch, physical_cleanup_state: 'PENDING_CLEANUP_WORKER', created_at: now.toISOString(), note: '账本重放：按生产删除账本在备份库重建的删除任务。' };
      store.deletionJobs.set(target.deletion_job_id, target);
    }
    target.__replay_only = true;
    try {
      await runAccountDeletionCleanup(store, account, target, { now });
    } finally {
      delete target.__replay_only;
    }
    return { replayed: 'ACCOUNT', final_state: target.state };
  }
  if (job.scope === 'CONVERSATION' && job.conversation_id) {
    return { replayed: 'CONVERSATION', ...(await replayConversationDeletion(store, account, job.conversation_id, now.toISOString())) };
  }
  if (job.scope === 'MEDIA' && job.asset_id) {
    const asset = store.mediaAssets.get(job.asset_id);
    if (!asset || asset.account_id !== account.account_id) return { replayed: 'MEDIA', applied: false, reason: 'ASSET_NOT_IN_BACKUP' };
    if (asset.state !== 'DELETED') { asset.state = 'DELETED'; asset.deleted_at = now.toISOString(); }
    return { replayed: 'MEDIA', applied: true };
  }
  if (job.scope === 'RELATIONSHIP_ASSET' && job.asset_id) {
    const { invalidateAssetEmbedding } = require('./asset-embedding-worker');
    const asset = store.assets.get(job.asset_id);
    if (!asset || asset.account_id !== account.account_id) return { replayed: 'RELATIONSHIP_ASSET', applied: false, reason: 'ASSET_NOT_IN_BACKUP' };
    if (asset.state !== 'DELETED') { asset.state = 'DELETED'; asset.deleted_at = now.toISOString(); invalidateAssetEmbedding(store, asset.asset_id, 'deletion ledger replay'); }
    return { replayed: 'RELATIONSHIP_ASSET', applied: true };
  }
  return { replayed: null, applied: false, reason: 'SCOPE_NOT_REPLAYABLE' };
}

module.exports = { replayDeletionLedger };

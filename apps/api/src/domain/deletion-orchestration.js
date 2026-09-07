'use strict';

const { invalidateAssetEmbedding } = require('./asset-embedding-worker');
const { invalidateSummaries } = require('./conversation-summary');
const { cancelConversationSummaryJobs } = require('./conversation-summary-worker');

// 数据删除编排（P0，PRD 7.0/9.3 AC-15）：注销不再只是"在线停用"，而是
//   1) 请求时登记逐数据域删除账本（deletion_targets，含对象级回执）；
//   2) 独立清理 Worker 把账户推进到 COMPLETED：消息/摘要/候选/关系资产/
//      向量/媒体对象/OC 原文全部清理，写回执与备份截止期；
//   3) 回执对用户可见（GET /deletion-jobs/:id 含 targets 与 receipt）；
//   4) 恢复演练按删除账本重放（scripts/run-deletion-ledger-replay.js）。
// 若清理半途失败：目标账本保留 FAILED 项与 attempts，Worker 下一轮重试；
// 绝不把失败目标报告为已完成（与 content-rights 清理同一原则）。

const RECEIPT_VERSION = 'qiyu-deletion-receipt-v1';
const BACKUP_RETENTION_DAYS = 30;

const ACCOUNT_DOMAIN_TARGETS = Object.freeze([
  'MESSAGES', 'CONVERSATION_SUMMARIES', 'MEMORY_CANDIDATES',
  'RELATIONSHIP_ASSETS', 'RELATIONSHIP_ASSET_EMBEDDINGS', 'OC_IMPORTS'
]);

function registerDeletionTargets(store, deletionJob, targets, now = new Date().toISOString()) {
  const created = [];
  for (const target of targets) {
    const entry = {
      deletion_target_id: store.next('dlt'), deletion_job_id: deletionJob.deletion_job_id,
      account_id: deletionJob.account_id, target_type: target.target_type, target_ref: target.target_ref || 'ALL',
      state: 'PENDING', attempts: 0, provider_receipt: null, last_error_code: null,
      created_at: now, updated_at: now
    };
    store.deletionTargets.set(entry.deletion_target_id, entry);
    created.push(entry);
  }
  return created;
}

function findDeletionTarget(store, deletionJob, targetType, targetRef = 'ALL') {
  return [...store.deletionTargets.values()].find((target) => target.deletion_job_id === deletionJob.deletion_job_id && target.target_type === targetType && target.target_ref === targetRef);
}

function completeDeletionTarget(store, deletionJob, targetType, targetRef, receipt = null, now = new Date().toISOString()) {
  const target = findDeletionTarget(store, deletionJob, targetType, targetRef);
  if (!target) return null;
  target.state = 'COMPLETED';
  target.attempts += 1;
  target.provider_receipt = typeof receipt === 'string' ? receipt : receipt ? JSON.stringify(receipt) : target.provider_receipt;
  target.updated_at = now;
  return target;
}

function failDeletionTarget(store, deletionJob, targetType, targetRef, errorCode, now = new Date().toISOString()) {
  const target = findDeletionTarget(store, deletionJob, targetType, targetRef);
  if (!target) return null;
  target.state = 'FAILED';
  target.attempts += 1;
  target.last_error_code = String(errorCode || 'CLEANUP_FAILED').slice(0, 128);
  target.updated_at = now;
  return target;
}

// 账户注销生产清理：在账户作用域 store 内执行（内存模式由进程内 Worker、
// PG 模式由独立 Worker 的 withAccountTransaction 调用）。幂等——重放安全。
async function runAccountDeletionCleanup(store, account, deletionJob, { mediaStore = null, imageStore = null, now = new Date() } = {}) {
  if (deletionJob.scope !== 'ACCOUNT') throw new Error('runAccountDeletionCleanup requires an ACCOUNT-scope deletion job');
  if (deletionJob.state === 'COMPLETED') return deletionJob;
  if (account.account_status !== 'CLOSING' && account.account_status !== 'CLOSED') return deletionJob;
  const accountId = account.account_id;
  const nowIso = now.toISOString();

  // 1) 原始消息：物理删除（30/90 天保留期在注销面前即刻失效）。
  for (const [messageId, message] of [...store.messages]) {
    const conversation = store.conversations.get(message.conversation_id);
    if (conversation && conversation.account_id === accountId) store.messages.delete(messageId);
  }
  completeDeletionTarget(store, deletionJob, 'MESSAGES', undefined, { deleted_domain: 'messages', completed_at: nowIso }, nowIso);

  // 2) 派生摘要：请求时已 INVALIDATED（在线召回已停）；此处物理移除。
  for (const [summaryId, summary] of [...store.conversationSummaries]) {
    if (summary.account_id === accountId) store.conversationSummaries.delete(summaryId);
  }
  completeDeletionTarget(store, deletionJob, 'CONVERSATION_SUMMARIES', undefined, { deleted_domain: 'conversation_summaries', completed_at: nowIso }, nowIso);

  // 3) 候选记忆：标记删除（保留审计轨迹的状态字段）。
  for (const candidate of store.candidates.values()) {
    if (candidate.account_id === accountId && candidate.state !== 'DELETED') { candidate.state = 'DELETED'; candidate.deleted_at = nowIso; }
  }
  completeDeletionTarget(store, deletionJob, 'MEMORY_CANDIDATES', undefined, { deleted_domain: 'memory_candidates', completed_at: nowIso }, nowIso);

  // 4) 关系资产 + 向量：资产置 DELETED；向量下线（PG 模式转交 Embedding Worker）。
  let deferredVectors = 0;
  for (const asset of store.assets.values()) {
    if (asset.account_id !== accountId || asset.state === 'DELETED') continue;
    asset.state = 'DELETED';
    asset.deleted_at = nowIso;
    const cleanup = invalidateAssetEmbedding(store, asset.asset_id, 'account deleted');
    if (cleanup.deferred_to_worker) deferredVectors += 1;
  }
  completeDeletionTarget(store, deletionJob, 'RELATIONSHIP_ASSETS', undefined, { deleted_domain: 'relationship_assets', completed_at: nowIso }, nowIso);
  completeDeletionTarget(store, deletionJob, 'RELATIONSHIP_ASSET_EMBEDDINGS', undefined, { vector_cleanup: deferredVectors > 0 ? 'DEFERRED_TO_EMBEDDING_WORKER' : 'REMOVED_INLINE', deferred_vectors: deferredVectors, completed_at: nowIso }, nowIso);

  // 5) OC 导入原文：删除（导入原文不属于可保留的关系资产）。
  for (const [importId, ocImport] of [...store.ocImports]) {
    if (ocImport.account_id === accountId) store.ocImports.delete(importId);
  }
  completeDeletionTarget(store, deletionJob, 'OC_IMPORTS', undefined, { deleted_domain: 'oc_imports', completed_at: nowIso }, nowIso);

  // 6) 媒体对象：逐对象删除并写对象级回执；任一失败保留 FAILED 供重试。
  // LEDGER_REPLAY 模式（备份恢复重放）只对齐数据库行状态——对象存储与生产
  // 共用同一桶，主库删除时对象已删，重放不得再次外呼。
  const replayOnly = deletionJob.__replay_only === true;
  let objectFailures = 0;
  for (const asset of store.mediaAssets.values()) {
    if (asset.account_id !== accountId || !asset.object_key) continue;
    // 行状态先行对齐（在线即刻不可见）；但失败目标必须允许重试——上一轮
    // 对象删除失败时行已是 DELETED，不能因此跳过。
    const priorTarget = findDeletionTarget(store, deletionJob, 'MEDIA_OBJECT', asset.asset_id);
    if (asset.state === 'DELETED' && priorTarget?.state !== 'FAILED') continue;
    const privateStore = replayOnly ? null : (asset.media_type === 'IMAGE' ? imageStore : mediaStore);
    asset.state = 'DELETED';
    asset.deleted_at = nowIso;
    if (replayOnly) {
      completeDeletionTarget(store, deletionJob, 'MEDIA_OBJECT', asset.asset_id, { replay: 'row-only', object_deletion: 'already-executed-in-primary' }, nowIso);
      continue;
    }
    try {
      if (!privateStore || typeof privateStore.deleteAsset !== 'function') throw new Error('PRIVATE_STORE_UNAVAILABLE');
      await privateStore.deleteAsset(asset.object_key);
      completeDeletionTarget(store, deletionJob, 'MEDIA_OBJECT', asset.asset_id, { object_key: asset.object_key, deleted_at: nowIso }, nowIso);
    } catch (error) {
      objectFailures += 1;
      failDeletionTarget(store, deletionJob, 'MEDIA_OBJECT', asset.asset_id, error.message, nowIso);
    }
  }

  const targets = [...store.deletionTargets.values()].filter((target) => target.deletion_job_id === deletionJob.deletion_job_id);
  const failed = targets.filter((target) => target.state === 'FAILED');
  deletionJob.physical_cleanup_state = failed.length === 0 ? 'PRODUCTION_CLEANUP_COMPLETED' : 'PARTIAL_CLEANUP_OBJECTS_PENDING_RETRY';
  deletionJob.note = failed.length === 0
    ? `账户数据已按删除账本清理（消息、摘要、候选、关系资产、向量、OC 原文、媒体对象）。备份最长保留至截止期后自动清除；供应商侧留存按合同删除条款执行。`
    : `${failed.length} 个删除目标失败（保留重试）；其余目标已清理。未把失败目标报告为完成。`;
  deletionJob.backup_deadline = new Date(now.getTime() + BACKUP_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  deletionJob.receipt_version = RECEIPT_VERSION;
  if (failed.length === 0) {
    deletionJob.state = 'COMPLETED';
    account.account_status = 'CLOSED';
  }
  return deletionJob;
}

// 注销请求时登记的完整账本：数据域目标 + 已存在的媒体对象逐个登记。
function registerAccountDeletionTargets(store, account, deletionJob, now = new Date().toISOString()) {
  const targets = ACCOUNT_DOMAIN_TARGETS.map((targetType) => ({ target_type: targetType, target_ref: 'ALL' }));
  for (const asset of store.mediaAssets.values()) {
    if (asset.account_id === account.account_id && asset.state !== 'DELETED' && asset.object_key) targets.push({ target_type: 'MEDIA_OBJECT', target_ref: asset.asset_id });
  }
  return registerDeletionTargets(store, deletionJob, targets, now);
}

function deletionReceipt(store, deletionJob) {
  const targets = [...store.deletionTargets.values()]
    .filter((target) => target.deletion_job_id === deletionJob.deletion_job_id)
    .map(({ target_type, target_ref, state, attempts, provider_receipt, last_error_code, updated_at }) => ({ target_type, target_ref, state, attempts, provider_receipt, last_error_code, updated_at }));
  return {
    receipt_version: deletionJob.receipt_version || null,
    state: deletionJob.state,
    physical_cleanup_state: deletionJob.physical_cleanup_state,
    backup_deadline: deletionJob.backup_deadline || null,
    completed_targets: targets.filter((target) => target.state === 'COMPLETED').length,
    failed_targets: targets.filter((target) => target.state === 'FAILED').length,
    targets
  };
}

// 会话删除账本（deleteConversation 已在请求内完成行级清理，账本如实记录为完成）。
function registerConversationDeletionTargets(store, account, deletionJob, conversationId, now = new Date().toISOString()) {
  const targets = registerDeletionTargets(store, deletionJob, [
    { target_type: 'MESSAGES', target_ref: conversationId },
    { target_type: 'CONVERSATION_SUMMARIES', target_ref: conversationId },
    { target_type: 'MEMORY_CANDIDATES', target_ref: conversationId },
    { target_type: 'RELATIONSHIP_ASSETS', target_ref: conversationId }
  ], now);
  for (const target of targets) {
    target.state = 'COMPLETED';
    target.provider_receipt = JSON.stringify({ cleaned_inline: true, completed_at: now });
  }
  return targets;
}

// 供恢复演练/重放使用的会话清理核心（与 HTTP deleteConversation 同语义）。
function replayConversationDeletion(store, account, conversationId, now = new Date().toISOString()) {
  const conversation = store.conversations.get(conversationId);
  if (!conversation || conversation.account_id !== account.account_id) return { applied: false, reason: 'NOT_FOUND' };
  if (conversation.status === 'DELETED') return { applied: true, already: true };
  const messageIds = new Set([...store.messages.values()].filter((item) => item.conversation_id === conversationId).map((item) => item.message_id));
  const candidateIds = new Set([...store.candidates.values()].filter((item) => item.account_id === account.account_id && messageIds.has(item.source_message_id)).map((item) => item.candidate_id));
  for (const summary of invalidateSummaries([...store.conversationSummaries.values()], [...store.messages.values()], conversationId, [...messageIds], now)) store.conversationSummaries.set(summary.summary_id, summary);
  cancelConversationSummaryJobs(store, conversationId, now);
  for (const messageId of messageIds) store.messages.delete(messageId);
  for (const [feedbackId, feedback] of store.messageFeedback) if (messageIds.has(feedback.message_id)) store.messageFeedback.delete(feedbackId);
  for (const candidate of store.candidates.values()) if (candidateIds.has(candidate.candidate_id)) { candidate.state = 'DELETED'; candidate.deleted_at = now; }
  for (const asset of store.assets.values()) if (candidateIds.has(asset.source_candidate_id) && asset.state !== 'DELETED') { asset.state = 'DELETED'; asset.deleted_at = now; invalidateAssetEmbedding(store, asset.asset_id, 'conversation deletion replay'); }
  conversation.status = 'DELETED';
  conversation.deleted_at = now;
  account.revocation_epoch += 1;
  return { applied: true, already: false };
}

// Worker 驱动（内存模式进程内定时器 / PG 模式独立进程共用）：
// 找到本 store 内首个待清理的注销账本并执行，幂等可重入。
async function runNextAccountDeletionCleanup(store, { mediaStore = null, imageStore = null, now = new Date() } = {}) {
  for (const account of store.accounts.values()) {
    if (account.account_status !== 'CLOSING') continue;
    const job = [...store.deletionJobs.values()]
      .filter((item) => item.account_id === account.account_id && item.scope === 'ACCOUNT' && item.state !== 'COMPLETED' && item.state !== 'CANCELLED')
      .sort((left, right) => String(left.created_at).localeCompare(String(right.created_at)))[0];
    if (!job) continue;
    await runAccountDeletionCleanup(store, account, job, { mediaStore, imageStore, now });
    return { state: job.state, deletion_job_id: job.deletion_job_id };
  }
  return { state: 'IDLE' };
}

function startAccountDeletionCleanupWorker(store, deps = {}, { intervalMs = 60_000 } = {}) {
  const timer = setInterval(() => {
    runNextAccountDeletionCleanup(store, deps).catch(() => { /* 本地开发失败不中断服务；生产由 Worker 日志与告警接管。 */ });
  }, intervalMs);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}

module.exports = {
  RECEIPT_VERSION, BACKUP_RETENTION_DAYS, ACCOUNT_DOMAIN_TARGETS,
  registerDeletionTargets, findDeletionTarget, completeDeletionTarget, failDeletionTarget,
  registerAccountDeletionTargets, runAccountDeletionCleanup, deletionReceipt,
  registerConversationDeletionTargets, replayConversationDeletion,
  runNextAccountDeletionCleanup, startAccountDeletionCleanupWorker
};

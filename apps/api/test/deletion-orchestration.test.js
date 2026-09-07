'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DevelopmentStore } = require('../src/domain/store');
const {
  registerAccountDeletionTargets, runAccountDeletionCleanup, deletionReceipt,
  registerConversationDeletionTargets, replayConversationDeletion
} = require('../src/domain/deletion-orchestration');
const { replayDeletionLedger } = require('../src/domain/deletion-ledger-replay');

// P0 数据删除与恢复：注销必须从“仅在线停用”升级为“登记账本 → 后台清理
// → 用户可见回执 → 备份可重放”。任一断言失败都意味着 AC-15（删除回执）
// 或 PRD 7.0 备份行（恢复演练）退化。

function closingAccountFixture(store) {
  const account = store.account('acct_dev_alice');
  const conversation = { conversation_id: 'cnv_1', account_id: account.account_id, character_id: 'chr_1', status: 'OPEN', created_at: '2026-09-01T00:00:00.000Z' };
  store.conversations.set(conversation.conversation_id, conversation);
  store.messages.set('msg_1', { message_id: 'msg_1', conversation_id: 'cnv_1', actor: 'USER', text: '原始消息', created_at: '2026-09-01T00:00:00.000Z' });
  store.conversationSummaries.set('sum_1', { summary_id: 'sum_1', account_id: account.account_id, conversation_id: 'cnv_1', state: 'INVALIDATED', text: '派生摘要', created_at: '2026-09-01T00:00:00.000Z' });
  store.candidates.set('cand_1', { candidate_id: 'cand_1', account_id: account.account_id, character_id: 'chr_1', state: 'CANDIDATE', version: 1, source_message_id: 'msg_1', expires_at: '2099-01-01T00:00:00.000Z' });
  store.assets.set('ras_1', { asset_id: 'ras_1', account_id: account.account_id, character_id: 'chr_1', state: 'ACTIVE', version: 1, index_state: 'READY', source_candidate_id: 'cand_1', created_at: '2026-09-01T00:00:00.000Z' });
  store.assetEmbeddings.set('ras_1', { asset_id: 'ras_1', account_id: account.account_id, character_id: 'chr_1', embedding: [0.1], embedding_model_version: 'dev', created_at: '2026-09-01T00:00:00.000Z', updated_at: '2026-09-01T00:00:00.000Z', version: 1 });
  store.mediaAssets.set('med_1', { asset_id: 'med_1', account_id: account.account_id, character_id: 'chr_1', type: 'TTS_AUDIO', state: 'AVAILABLE', media_type: 'AUDIO', mime_type: 'audio/mpeg', object_key: 'tts/med_1.mp3', created_at: '2026-09-01T00:00:00.000Z' });
  store.mediaAssets.set('med_2', { asset_id: 'med_2', account_id: account.account_id, character_id: 'chr_1', type: 'SCENE_IMAGE', state: 'AVAILABLE', media_type: 'IMAGE', mime_type: 'image/png', object_key: 'qiyu/images/med_2.png', created_at: '2026-09-01T00:00:00.000Z' });
  store.ocImports.set('oc_1', { import_id: 'oc_1', account_id: account.account_id, source_text: 'OC 原文', state: 'IMPORTED', created_at: '2026-09-01T00:00:00.000Z' });
  account.account_status = 'CLOSING';
  const deletionJob = { deletion_job_id: 'del_1', account_id: account.account_id, asset_id: null, scope: 'ACCOUNT', state: 'ONLINE_DISABLED', revocation_epoch: account.revocation_epoch, physical_cleanup_state: 'PENDING_CLEANUP_WORKER', created_at: '2026-09-07T00:00:00.000Z', note: '' };
  store.deletionJobs.set(deletionJob.deletion_job_id, deletionJob);
  registerAccountDeletionTargets(store, account, deletionJob, deletionJob.created_at);
  return { account, deletionJob };
}

test('注销清理把全部数据域推进到 COMPLETED：行删除、对象删除、账户 CLOSED、回执完整', async () => {
  const store = new DevelopmentStore();
  const { account, deletionJob } = closingAccountFixture(store);
  const deletedKeys = [];
  const mediaStore = { async deleteAsset(key) { deletedKeys.push(`media:${key}`); } };
  const imageStore = { async deleteAsset(key) { deletedKeys.push(`image:${key}`); } };
  await runAccountDeletionCleanup(store, account, deletionJob, { mediaStore, imageStore });
  assert.equal(deletionJob.state, 'COMPLETED');
  assert.equal(account.account_status, 'CLOSED');
  assert.equal(store.messages.has('msg_1'), false, '原始消息必须物理删除');
  assert.equal(store.conversationSummaries.has('sum_1'), false, '派生摘要必须物理删除');
  assert.equal(store.ocImports.has('oc_1'), false, 'OC 原文必须物理删除');
  assert.equal(store.candidates.get('cand_1').state, 'DELETED');
  assert.equal(store.assets.get('ras_1').state, 'DELETED');
  assert.equal(store.assetEmbeddings.has('ras_1'), false, '向量必须下线');
  assert.equal(store.mediaAssets.get('med_1').state, 'DELETED');
  assert.deepEqual(deletedKeys.sort(), ['image:qiyu/images/med_2.png', 'media:tts/med_1.mp3']);
  assert.ok(deletionJob.backup_deadline, '备份截止期必须写入');
  assert.equal(deletionJob.receipt_version, 'qiyu-deletion-receipt-v1');
  const receipt = deletionReceipt(store, deletionJob);
  assert.equal(receipt.failed_targets, 0);
  assert.equal(receipt.completed_targets, receipt.targets.length);
  assert.ok(receipt.targets.length >= 8);
});

test('对象删除失败：任务保持未完成、失败目标留痕可重试，绝不虚报完成', async () => {
  const store = new DevelopmentStore();
  const { account, deletionJob } = closingAccountFixture(store);
  const mediaStore = { async deleteAsset() { throw new Error('cos unavailable'); } };
  await runAccountDeletionCleanup(store, account, deletionJob, { mediaStore, imageStore: null });
  assert.notEqual(deletionJob.state, 'COMPLETED');
  assert.equal(account.account_status, 'CLOSING', '失败时不得置 CLOSED');
  assert.equal(deletionJob.physical_cleanup_state, 'PARTIAL_CLEANUP_OBJECTS_PENDING_RETRY');
  const receipt = deletionReceipt(store, deletionJob);
  assert.ok(receipt.failed_targets >= 2, '音频与图片对象失败都要留痕');
  // 重试成功后推进到 COMPLETED（幂等重入）。
  await runAccountDeletionCleanup(store, account, deletionJob, { mediaStore: { async deleteAsset() {} }, imageStore: { async deleteAsset() {} } });
  assert.equal(deletionJob.state, 'COMPLETED');
  assert.equal(account.account_status, 'CLOSED');
});

test('恢复演练：dry-run 不改备份库；apply 按账本重放账户与媒体行状态', async () => {
  const target = new DevelopmentStore();
  const { account } = closingAccountFixture(target);
  // 备份库恢复自注销请求之前的快照：账户仍 OPEN。
  account.account_status = 'OPEN';
  const ledgerJobs = [
    { deletion_job_id: 'del_1', account_id: account.account_id, scope: 'ACCOUNT', state: 'COMPLETED' },
    { deletion_job_id: 'del_2', account_id: account.account_id, scope: 'CONVERSATION', state: 'COMPLETED', conversation_id: 'cnv_1' }
  ];
  const openAccount = (accountId, operation) => operation(target, target.account(accountId));
  const dryRun = await replayDeletionLedger({ ledgerJobs, openAccount, apply: false });
  assert.equal(dryRun.applied_count, 0);
  assert.equal(target.messages.has('msg_1'), true, 'dry-run 不得改动备份库');
  assert.equal(account.account_status, 'OPEN');

  const applied = await replayDeletionLedger({ ledgerJobs, openAccount, apply: true });
  assert.equal(applied.applied_count, 2);
  assert.equal(target.messages.has('msg_1'), false);
  assert.equal(target.ocImports.has('oc_1'), false);
  assert.equal(target.mediaAssets.get('med_1').state, 'DELETED', '重放对齐媒体行状态');
  assert.equal(account.account_status, 'CLOSED');
  assert.deepEqual(applied.skipped, []);
});

test('恢复演练：未完成账本不重放（备份不得预知未生效的删除决定）', async () => {
  const target = new DevelopmentStore();
  const { account } = closingAccountFixture(target);
  account.account_status = 'OPEN';
  const openAccount = (accountId, operation) => operation(target, target.account(accountId));
  const report = await replayDeletionLedger({
    ledgerJobs: [{ deletion_job_id: 'del_x', account_id: account.account_id, scope: 'ACCOUNT', state: 'ONLINE_DISABLED' }],
    openAccount, apply: true
  });
  assert.equal(report.applied_count, 0);
  assert.equal(report.skipped[0].reason, 'NOT_COMPLETED_IN_LEDGER');
  assert.equal(target.messages.has('msg_1'), true);
});

test('会话删除账本在请求内如实登记为完成；重放会话删除幂等', async () => {
  const store = new DevelopmentStore();
  const { account } = closingAccountFixture(store);
  const job = { deletion_job_id: 'del_c', account_id: account.account_id, scope: 'CONVERSATION', state: 'COMPLETED', created_at: '2026-09-07T00:00:00.000Z' };
  store.deletionJobs.set(job.deletion_job_id, job);
  const targets = registerConversationDeletionTargets(store, account, job, 'cnv_1', job.created_at);
  assert.ok(targets.every((item) => item.state === 'COMPLETED'));
  const first = replayConversationDeletion(store, account, 'cnv_1');
  assert.equal(first.applied, true);
  assert.equal(first.already, false);
  const second = replayConversationDeletion(store, account, 'cnv_1');
  assert.equal(second.applied, true);
  assert.equal(second.already, true, '重放必须幂等');
});

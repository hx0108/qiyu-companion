'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { DevelopmentStore } = require('../src/domain/store');
const { applyRawInteractionRetention } = require('../src/domain/retention');
const { runAccountDeletionCleanup } = require('../src/domain/deletion-orchestration');
const { confirmLifeEventFromCandidate } = require('../src/domain/life-event-service');
const { recordMessageMemoryRefs, messageMemoryReferences } = require('../src/domain/memory-reference-service');
const { createApp } = require('../src/app');
const { parseDevFlags } = require('../src/development/dev-flags');
const { generateReply } = require('../src/domain/mock-adapter');

// P1.8 联动：保留期 sweep、账户注销清理、时间线 filter=event 纳入事件投影。

const ACCOUNT = 'acct_dev_alice';
const CHARACTER = 'char_1';

function candidateWith(overrides = {}) {
  return {
    candidate_id: 'memc_1', account_id: ACCOUNT, character_id: CHARACTER, state: 'CANDIDATE', version: 1, type: 'life_event',
    normalized_value: { life_event: { title: '周五的产品经理面试', domain: 'REAL_LIFE', event_kind: 'INTERVIEW', scheduled_at: '2026-10-02T14:30:00Z' } },
    display_text: '', provider: 't', expires_at: '2026-10-30T00:00:00.000Z', source_message_id: 'msg_old', conflicts_with: [], ...overrides
  };
}

function storeWithEvent() {
  const store = new DevelopmentStore({ accountIds: [ACCOUNT] });
  store.characters.set(CHARACTER, { character_id: CHARACTER, account_id: ACCOUNT, name: '栖夏', status: 'ACTIVE' });
  store.conversations.set('conv_1', { conversation_id: 'conv_1', account_id: ACCOUNT, character_id: CHARACTER, status: 'OPEN', created_at: '2026-01-01T00:00:00.000Z' });
  store.messages.set('msg_old', { message_id: 'msg_old', conversation_id: 'conv_1', account_id: ACCOUNT, actor: 'USER', text: '我周五要面试', created_at: '2026-01-02T00:00:00.000Z', deleted_at: null });
  const { event } = confirmLifeEventFromCandidate({ store, account: store.account(ACCOUNT), candidate: candidateWith() });
  recordMessageMemoryRefs({ store, account: store.account(ACCOUNT), conversation: store.conversations.get('conv_1'), message: { message_id: 'msg_old' }, refs: [{ kind: 'LIFE_EVENT', id: event.event_id, version: 1 }] });
  store.lifeEventExtractionJobs.set('lexjob_1', { job_id: 'lexjob_1', account_id: ACCOUNT, message_id: 'msg_other', state: 'PENDING' });
  store.messages.set('msg_other', { message_id: 'msg_other', conversation_id: 'conv_1', account_id: ACCOUNT, actor: 'USER', text: 'x', created_at: '2026-01-02T00:00:00.000Z', deleted_at: null });
  return { store, event };
}

test('保留期 sweep：过期消息的引用删除、事件 source 置空、任务取消；事件本体保留', () => {
  const { store, event } = storeWithEvent();
  const result = applyRawInteractionRetention(store, store.account(ACCOUNT), new Date('2026-10-01T00:00:00.000Z'));
  assert.equal(result.expired_message_count, 2);
  assert.equal(result.memory_link_cleanup.refs_removed, 1);
  assert.equal(result.memory_link_cleanup.sources_cleared, 1);
  assert.equal(messageMemoryReferences({ store, accountId: ACCOUNT, messageId: 'msg_old' }), null);
  const survived = store.lifeEvents.get(event.event_id);
  assert.ok(survived && !survived.deleted_at, '事件本体是确认事实，保留期只断开来源链接');
  assert.equal(survived.source_message_id, null);
  assert.equal(store.lifeEventExtractionJobs.get('lexjob_1').state, 'CANCELLED');
});

test('账户注销清理：三新域 target COMPLETED，store 内 A1 数据全部清除', async () => {
  const { store } = storeWithEvent();
  const account = store.account(ACCOUNT);
  account.account_status = 'CLOSING';
  const deletionJob = { deletion_job_id: 'del_1', account_id: ACCOUNT, scope: 'ACCOUNT', state: 'PENDING', physical_cleanup_state: null };
  store.deletionJobs.set('del_1', deletionJob);
  // 注销账本目标登记（与 HTTP 路径同函数）
  const { registerAccountDeletionTargets } = require('../src/domain/deletion-orchestration');
  registerAccountDeletionTargets(store, account, deletionJob);
  await runAccountDeletionCleanup(store, account, deletionJob, { now: new Date() });
  assert.equal(store.lifeEvents.size, 0);
  assert.equal(store.lifeEventExtractionJobs.size, 0);
  assert.equal(store.messageMemoryRefs.size, 0);
  const { deletionReceipt } = require('../src/domain/deletion-orchestration');
  const receipt = deletionReceipt(store, deletionJob);
  for (const domain of ['LIFE_EVENTS', 'LIFE_EVENT_EXTRACTION_JOBS', 'MESSAGE_MEMORY_REFS']) {
    const target = receipt.targets.find((item) => item.target_type === domain);
    assert.ok(target, `账本应含 ${domain}`);
    assert.equal(target.state, 'COMPLETED', `${domain} 应完成`);
  }
});

test('时间线 filter=event 纳入生活事件投影；life_event 资产不双记；删除后不可见', async (t) => {
  const store = new DevelopmentStore({ accountIds: [ACCOUNT, 'acct_dev_bob'] });
  const app = createApp({ store, replyGenerator: generateReply, devFlags: parseDevFlags({ QIYU_DEV_FLAGS: 'LIFE_EVENTS' }) });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { app.closeAllConnections(); app.close(resolve); }));
  const base = `http://127.0.0.1:${app.address().port}`;
  const headers = { authorization: `Bearer dev-alice-token` };

  // 直接用域层种一个事件再查时间线
  store.characters.set(CHARACTER, { character_id: CHARACTER, account_id: ACCOUNT, name: '栖夏', status: 'ACTIVE' });
  const { event } = confirmLifeEventFromCandidate({ store, account: store.account(ACCOUNT), candidate: candidateWith() });
  const timeline = await (await fetch(`${base}/api/v1/timeline?filter=event`, { headers })).json();
  const entry = timeline.entries.find((item) => item.entry_type === 'LIFE_EVENT');
  assert.ok(entry, 'filter=event 应含事件投影');
  assert.equal(entry.event_id, event.event_id);
  assert.equal(entry.filter_group, 'event');
  assert.equal(entry.status, 'PLANNED');
  assert.equal(timeline.entries.filter((item) => item.entry_type === 'LIFE_EVENT').length, 1);

  const memoryOnly = await (await fetch(`${base}/api/v1/timeline?filter=memory`, { headers })).json();
  assert.equal(memoryOnly.entries.filter((item) => item.entry_type === 'LIFE_EVENT').length, 0);
  const all = await (await fetch(`${base}/api/v1/timeline`, { headers })).json();
  assert.ok(all.entries.some((item) => item.entry_type === 'LIFE_EVENT'));

  // 删除后时间线即刻不可见
  const { deleteLifeEvent } = require('../src/domain/life-event-service');
  deleteLifeEvent({ store, account: store.account(ACCOUNT), event: store.lifeEvents.get(event.event_id) });
  const afterDelete = await (await fetch(`${base}/api/v1/timeline?filter=event`, { headers })).json();
  assert.equal(afterDelete.entries.filter((item) => item.entry_type === 'LIFE_EVENT').length, 0);
});

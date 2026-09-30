'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { DevelopmentStore } = require('../src/domain/store');
const {
  confirmLifeEventFromCandidate, listLifeEvents, getLifeEvent, reviseLifeEvent, deleteLifeEvent
} = require('../src/domain/life-event-service');
const {
  buildMemoryRefs, recordMessageMemoryRefs, messageMemoryReferences, clearExpiredMessageMemoryLinks
} = require('../src/domain/memory-reference-service');

const ACCOUNT = 'acct_dev_alice';
const OTHER = 'acct_dev_bob';
const CHARACTER = 'char_su7';

function freshStore() { return new DevelopmentStore({ accountIds: [ACCOUNT, OTHER] }); }
function accountOf(store, id = ACCOUNT) { return store.account(id); }

function lifeEventCandidate(overrides = {}) {
  return {
    candidate_id: 'memc_000001', account_id: ACCOUNT, character_id: CHARACTER,
    state: 'CANDIDATE', version: 1, type: 'life_event',
    normalized_value: {
      life_event: { title: '周五的产品经理面试', domain: 'REAL_LIFE', event_kind: 'INTERVIEW', scheduled_at: '2026-10-02T14:30:00Z', timezone: 'Asia/Shanghai' }
    },
    display_text: '', provider: 'qwen-test', expires_at: '2026-10-30T00:00:00.000Z',
    source_message_id: 'msg_000009', conflicts_with: []
  };
}

function confirmVagueDateCandidate(store) {
  return confirmLifeEventFromCandidate({
    store, account: accountOf(store),
    candidate: {
      ...lifeEventCandidate(),
      normalized_value: { life_event: { title: '下周和朋友的聚餐', domain: 'REAL_LIFE', event_kind: 'OTHER', raw_time_text: '周五晚上' } }
    }
  });
}

// —— 确认链：候选 → 资产 + 投影 ——

test('life-event-service: confirm 从候选固化受控字段并写投影 version=1', () => {
  const store = freshStore();
  const { asset, event } = confirmLifeEventFromCandidate({ store, account: accountOf(store), candidate: lifeEventCandidate() });
  assert.equal(asset.type, 'life_event');
  assert.equal(asset.state, 'ACTIVE');
  assert.equal(asset.value.life_event.title, '周五的产品经理面试');
  assert.equal(asset.value.life_event.scheduled_at, '2026-10-02T14:30:00.000Z');
  assert.equal(asset.value.life_event.time_precision, 'MINUTE');
  assert.equal(asset.index_state, 'PENDING'); // 确认响应返回 PENDING，异步建索引
  assert.equal(asset.source_candidate_id, 'memc_000001');
  assert.equal(store.assets.get(asset.asset_id).asset_id, asset.asset_id);

  assert.equal(event.title, '周五的产品经理面试');
  assert.equal(event.version, 1);
  assert.equal(event.status, 'PLANNED');
  assert.equal(event.clarification_required, false);
  assert.equal(event.source_message_id, 'msg_000009');
  assert.equal(event.current_asset_id, asset.asset_id);
  assert.equal(store.lifeEvents.get(event.event_id).event_id, event.event_id);
  // 确认即进入异步索引管线（不阻塞聊天主链路）
  assert.ok([...store.assetEmbeddingJobs.values()].some((job) => job.asset_id === asset.asset_id));
});

test('life-event-service: 含糊日期候选确认后 clarification_required=true', () => {
  const store = freshStore();
  const { event } = confirmVagueDateCandidate(store);
  assert.equal(event.scheduled_at, null);
  assert.equal(event.time_precision, 'UNKNOWN');
  assert.equal(event.clarification_required, true);
});

test('life-event-service: confirm-edited 以完整修订字段覆盖并重生成展示文本', () => {
  const store = freshStore();
  const { event } = confirmLifeEventFromCandidate({
    store, account: accountOf(store), candidate: lifeEventCandidate(),
    editedFields: { title: '周五的算法岗面试', scheduled_at: '2026-10-03T09:00:00Z', timezone: 'Asia/Shanghai' }
  });
  assert.equal(event.title, '周五的算法岗面试');
  assert.equal(event.scheduled_at, '2026-10-03T09:00:00.000Z');
  assert.equal(event.time_precision, 'MINUTE');
  const asset = store.assets.get(event.current_asset_id);
  assert.match(asset.display_text, /周五的算法岗面试/);
  assert.match(asset.display_text, /2026-10-03/);
});

test('life-event-service: confirm-edited 字段不合法抛 400 VALIDATION_ERROR 且带 missing_fields', () => {
  const store = freshStore();
  assert.throws(
    () => confirmLifeEventFromCandidate({
      store, account: accountOf(store), candidate: lifeEventCandidate(),
      editedFields: { title: '', domain: 'REAL_LIFE' }
    }),
    (error) => error.status === 400 && error.code === 'VALIDATION_ERROR' && Array.isArray(error.details?.missing_fields)
  );
});

test('life-event-service: 候选 normalized_value 形状损坏时确认拒绝（不信模型写入）', () => {
  const store = freshStore();
  const broken = { ...lifeEventCandidate(), normalized_value: { life_event: { title: 'x'.repeat(81), domain: 'SHARED' } } };
  assert.throws(
    () => confirmLifeEventFromCandidate({ store, account: accountOf(store), candidate: broken }),
    (error) => error.status === 400 && error.code === 'VALIDATION_ERROR'
  );
});

// —— 列表 / 详情 ——

test('life-event-service: 列表按 updated_at 新→旧、支持 cursor 分页与角色过滤、隐藏已删除', () => {
  const store = freshStore();
  const first = confirmLifeEventFromCandidate({ store, account: accountOf(store), candidate: { ...lifeEventCandidate(), candidate_id: 'memc_a', source_message_id: 'msg_a' } }).event;
  const second = confirmLifeEventFromCandidate({ store, account: accountOf(store), candidate: { ...lifeEventCandidate(), candidate_id: 'memc_b', normalized_value: { life_event: { title: '读《三体》第三部', domain: 'REAL_LIFE', event_kind: 'READING' } }, source_message_id: 'msg_b' } }).event;

  const all = listLifeEvents({ store, accountId: ACCOUNT });
  assert.equal(all.events.length, 2);
  assert.equal(all.next_cursor, null);

  const pageOne = listLifeEvents({ store, accountId: ACCOUNT, limit: 1 });
  assert.equal(pageOne.events.length, 1);
  assert.equal(pageOne.events[0].event_id, second.event_id); // 新的在前
  assert.equal(pageOne.next_cursor, second.event_id);
  const pageTwo = listLifeEvents({ store, accountId: ACCOUNT, limit: 1, cursor: pageOne.next_cursor });
  assert.equal(pageTwo.events[0].event_id, first.event_id);
  assert.equal(pageTwo.next_cursor, null);

  const otherAccount = listLifeEvents({ store, accountId: OTHER });
  assert.equal(otherAccount.events.length, 0); // 跨账户不可见

  const byCharacter = listLifeEvents({ store, accountId: ACCOUNT, characterId: 'char_other' });
  assert.equal(byCharacter.events.length, 0);

  deleteLifeEvent({ store, account: accountOf(store), event: store.lifeEvents.get(second.event_id) });
  const afterDelete = listLifeEvents({ store, accountId: ACCOUNT });
  assert.equal(afterDelete.events.length, 1);
  assert.equal(afterDelete.events[0].event_id, first.event_id);
});

test('life-event-service: getLifeEvent 跨账户/不存在 → 404，存在 → 公开形状', () => {
  const store = freshStore();
  const { event } = confirmLifeEventFromCandidate({ store, account: accountOf(store), candidate: lifeEventCandidate() });
  const found = getLifeEvent({ store, accountId: ACCOUNT, eventId: event.event_id });
  assert.equal(found.event_id, event.event_id);
  assert.equal(found.character_id, CHARACTER);
  assert.throws(() => getLifeEvent({ store, accountId: OTHER, eventId: event.event_id }), (error) => error.status === 404 && error.code === 'RESOURCE_NOT_FOUND');
  assert.throws(() => getLifeEvent({ store, accountId: ACCOUNT, eventId: 'levt_missing' }), (error) => error.status === 404);
});

// —— 修订 ——

test('life-event-service: revise 旧资产转 SUPERSEDED、投影 version+1、新资产接链', () => {
  const store = freshStore();
  const { asset, event } = confirmLifeEventFromCandidate({ store, account: accountOf(store), candidate: lifeEventCandidate() });
  const result = reviseLifeEvent({
    store, account: accountOf(store), event,
    patch: { scheduled_at: '2026-10-05T09:00:00Z' }, expectedVersion: 1
  });
  assert.equal(result.event.version, 2);
  assert.equal(result.event.scheduled_at, '2026-10-05T09:00:00.000Z');
  assert.equal(result.event.current_asset_id, result.asset.asset_id);
  assert.notEqual(result.asset.asset_id, asset.asset_id);
  assert.equal(store.assets.get(asset.asset_id).state, 'SUPERSEDED');
  assert.equal(store.assets.get(asset.asset_id).superseded_by, result.asset.asset_id);
  assert.equal(result.asset.supersedes_asset_id, asset.asset_id);
  assert.equal(result.asset.state, 'ACTIVE');
  // 旧向量失效、新向量进入索引管线
  assert.ok([...store.assetEmbeddingJobs.values()].some((job) => job.asset_id === result.asset.asset_id));
});

test('life-event-service: revise 旧版本号 → 409 VERSION_CONFLICT', () => {
  const store = freshStore();
  const { event } = confirmLifeEventFromCandidate({ store, account: accountOf(store), candidate: lifeEventCandidate() });
  assert.throws(
    () => reviseLifeEvent({ store, account: accountOf(store), event, patch: { title: '改期' }, expectedVersion: 99 }),
    (error) => error.status === 409 && error.code === 'VERSION_CONFLICT'
  );
});

test('life-event-service: 仅改日期（哪怕改成过去）不自动改完成状态', () => {
  const store = freshStore();
  const { event } = confirmLifeEventFromCandidate({ store, account: accountOf(store), candidate: lifeEventCandidate() });
  const result = reviseLifeEvent({
    store, account: accountOf(store), event,
    patch: { scheduled_at: '2020-01-01T00:00:00Z' }, expectedVersion: 1
  });
  assert.equal(result.event.status, 'PLANNED'); // 日期经过 ≠ 已完成，状态只随显式修订
});

test('life-event-service: revise 变更 domain 缺确认 → 400 带提示字段', () => {
  const store = freshStore();
  const { event } = confirmLifeEventFromCandidate({ store, account: accountOf(store), candidate: lifeEventCandidate() });
  assert.throws(
    () => reviseLifeEvent({ store, account: accountOf(store), event, patch: { domain: 'FICTIONAL_SHARED' }, expectedVersion: 1 }),
    (error) => error.status === 400 && error.code === 'VALIDATION_ERROR' && error.details?.missing_fields?.includes('domain_change_confirmed')
  );
});

test('life-event-service: revise 已删除事件 → 409 STATE_TRANSITION_INVALID', () => {
  const store = freshStore();
  const { event } = confirmLifeEventFromCandidate({ store, account: accountOf(store), candidate: lifeEventCandidate() });
  deleteLifeEvent({ store, account: accountOf(store), event });
  assert.throws(
    () => reviseLifeEvent({ store, account: accountOf(store), event, patch: { title: 'x' }, expectedVersion: 1 }),
    (error) => error.status === 409 && error.code === 'STATE_TRANSITION_INVALID'
  );
});

// —— 删除 ——

test('life-event-service: delete 软删资产+置 deleted_at+抬 epoch+写 LIFE_EVENT 删除目标与回执', () => {
  const store = freshStore();
  const account = accountOf(store);
  const epochBefore = account.revocation_epoch;
  const { asset, event } = confirmLifeEventFromCandidate({ store, account, candidate: lifeEventCandidate() });
  const result = deleteLifeEvent({ store, account, event });
  assert.equal(result.event.deleted, true);
  assert.equal(store.assets.get(asset.asset_id).state, 'DELETED');
  assert.equal(account.revocation_epoch, epochBefore + 1);
  assert.ok(result.deletion_receipt.targets.some((target) => target.target_type === 'LIFE_EVENT' && target.state === 'COMPLETED'));
  assert.equal(result.deletion_receipt.failed_targets, 0);
  // 删除后列表/详情即刻不可见
  assert.throws(() => getLifeEvent({ store, accountId: ACCOUNT, eventId: event.event_id }), (error) => error.status === 404);
});

test('life-event-service: delete 幂等——重放返回既有回执且不再抬 epoch', () => {
  const store = freshStore();
  const account = accountOf(store);
  const { event } = confirmLifeEventFromCandidate({ store, account, candidate: lifeEventCandidate() });
  const first = deleteLifeEvent({ store, account, event });
  const epochAfterFirst = account.revocation_epoch;
  const second = deleteLifeEvent({ store, account, event: store.lifeEvents.get(event.event_id) });
  assert.equal(second.event.deleted, true);
  assert.equal(second.deletion_job.deletion_job_id, first.deletion_job.deletion_job_id);
  assert.equal(account.revocation_epoch, epochAfterFirst);
});

// —— 本轮记忆引用 ——

test('memory-reference-service: buildMemoryRefs 从 contextPack 构建并封顶截断', () => {
  const pack = {
    confirmed_assets: [{ asset_id: 'ras_1', version: 1 }, { asset_id: 'ras_2', version: 3 }],
    active_life_events: [{ event_id: 'levt_1', version: 1 }]
  };
  assert.deepEqual(buildMemoryRefs(pack), [
    { kind: 'ASSET', id: 'ras_1', version: 1 },
    { kind: 'ASSET', id: 'ras_2', version: 3 },
    { kind: 'LIFE_EVENT', id: 'levt_1', version: 1 }
  ]);
  const many = { confirmed_assets: Array.from({ length: 30 }, (_, index) => ({ asset_id: `ras_${index}`, version: 1 })) };
  assert.equal(buildMemoryRefs(many).length, 20);
  assert.deepEqual(buildMemoryRefs({}), []);
});

test('memory-reference-service: record + resolve 可用项回正文', () => {
  const store = freshStore();
  const { event } = confirmLifeEventFromCandidate({ store, account: accountOf(store), candidate: lifeEventCandidate() });
  const message = { message_id: 'msg_reply1', conversation_id: 'conv_1' };
  const conversation = { conversation_id: 'conv_1', character_id: CHARACTER };
  recordMessageMemoryRefs({ store, account: accountOf(store), conversation, message, refs: [{ kind: 'LIFE_EVENT', id: event.event_id, version: 1 }] });

  const result = messageMemoryReferences({ store, accountId: ACCOUNT, messageId: 'msg_reply1' });
  assert.equal(result.message_id, 'msg_reply1');
  assert.equal(result.references.length, 1);
  assert.equal(result.references[0].available, true);
  assert.equal(result.references[0].title, '周五的产品经理面试');

  // 跨账户/不存在统一 null（路由层转 404）
  assert.equal(messageMemoryReferences({ store, accountId: OTHER, messageId: 'msg_reply1' }), null);
  assert.equal(messageMemoryReferences({ store, accountId: ACCOUNT, messageId: 'msg_none' }), null);
});

test('memory-reference-service: 修订后旧版本引用 available:false 不回正文、删除后 DELETED', () => {
  const store = freshStore();
  const account = accountOf(store);
  const { event } = confirmLifeEventFromCandidate({ store, account, candidate: lifeEventCandidate() });
  const message = { message_id: 'msg_reply2', conversation_id: 'conv_1' };
  recordMessageMemoryRefs({ store, account, conversation: { conversation_id: 'conv_1', character_id: CHARACTER }, message, refs: [{ kind: 'LIFE_EVENT', id: event.event_id, version: 1 }] });

  reviseLifeEvent({ store, account, event, patch: { scheduled_at: '2026-10-09T09:00:00Z' }, expectedVersion: 1 });
  const afterRevise = messageMemoryReferences({ store, accountId: ACCOUNT, messageId: 'msg_reply2' });
  assert.equal(afterRevise.references[0].available, false);
  assert.equal(afterRevise.references[0].reason, 'SUPERSEDED');
  assert.equal(afterRevise.references[0].current_version, 2);
  assert.equal(afterRevise.references[0].title, undefined); // 不可用不回正文

  deleteLifeEvent({ store, account, event: store.lifeEvents.get(event.event_id) });
  const afterDelete = messageMemoryReferences({ store, accountId: ACCOUNT, messageId: 'msg_reply2' });
  assert.equal(afterDelete.references[0].available, false);
  assert.equal(afterDelete.references[0].reason, 'DELETED');
});

test('memory-reference-service: 保留期到期清理四联动（引用删/来源置空/候选过期/任务取消）', () => {
  const store = freshStore();
  const account = accountOf(store);
  const { event } = confirmVagueDateCandidate(store);
  store.candidates.set('memc_pending', { candidate_id: 'memc_pending', account_id: ACCOUNT, state: 'CANDIDATE', source_message_id: 'msg_gone' });
  store.lifeEventExtractionJobs.set('lexjob_1', { job_id: 'lexjob_1', message_id: 'msg_gone', state: 'PENDING' });
  recordMessageMemoryRefs({ store, account, conversation: { conversation_id: 'conv_1', character_id: CHARACTER }, message: { message_id: 'msg_gone', conversation_id: 'conv_1' }, refs: [{ kind: 'LIFE_EVENT', id: event.event_id, version: 1 }] });
  assert.equal(event.source_message_id, 'msg_000009'); // 换成不匹配的——上面 candidate 的 source 才是 msg_gone

  const summary = clearExpiredMessageMemoryLinks({ store, expiredMessageIds: ['msg_gone'] });
  assert.deepEqual(summary, { refs_removed: 1, sources_cleared: 0, candidates_expired: 1, jobs_cancelled: 1 });
  assert.equal(messageMemoryReferences({ store, accountId: ACCOUNT, messageId: 'msg_gone' }), null);
  assert.equal(store.candidates.get('memc_pending').state, 'EXPIRED');
  assert.equal(store.lifeEventExtractionJobs.get('lexjob_1').state, 'CANCELLED');

  // 事件 source_message_id 命中过期消息时置空（事件本体保留）
  const summary2 = clearExpiredMessageMemoryLinks({ store, expiredMessageIds: ['msg_000009'] });
  assert.equal(summary2.sources_cleared, 1);
  assert.equal(store.lifeEvents.get(event.event_id).source_message_id, null);
  assert.ok(store.lifeEvents.get(event.event_id).deleted_at === null);
});

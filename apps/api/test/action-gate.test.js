'use strict';
// 六项能力 A3：action-gate 审批与执行单测。硬门禁锚点（§4.6/§9.1）：
// 白名单外动作 400；审批绑定 parameters_digest——审批后参数变化必须重新
// 批准；授权过期原审批不能执行；同一次用户确认=审批+执行两状态（透明记录）。
const test = require('node:test');
const assert = require('node:assert/strict');
const { DevelopmentStore } = require('../src/domain/store');
const {
  ACTION_TYPE_REGISTRY, canonicalParametersDigest, proposeAction, approveAction,
  rejectAction, cancelAction, assertExecutable, recordTransparentAction, lapseIfExpired,
  publicActionRequest
} = require('../src/domain/action-gate');

const ACCOUNT = 'acct_dev_alice';
const CHARACTER = 'char_1';
const NOW = new Date('2026-10-01T08:00:00.000Z');
const PLAN_ID = 'cpl_000001';

function freshStore() {
  const store = new DevelopmentStore({ accountIds: [ACCOUNT] });
  store.characters.set(CHARACTER, { character_id: CHARACTER, account_id: ACCOUNT, name: '栖夏', status: 'ACTIVE' });
  return store;
}

test('action-gate: 白名单只含 ACCEPT_PLAN（映射 WRITE_MEMORY）；未知动作 400 ACTION_TYPE_UNKNOWN', () => {
  assert.deepEqual(Object.keys(ACTION_TYPE_REGISTRY), ['ACCEPT_PLAN']);
  assert.equal(ACTION_TYPE_REGISTRY.ACCEPT_PLAN.permission, 'WRITE_MEMORY');
  const store = freshStore();
  assert.throws(
    () => proposeAction({ store, accountId: ACCOUNT, characterId: CHARACTER, actionType: 'SEND_EMAIL', targetRef: PLAN_ID, idempotencyKey: 'k1', now: NOW }),
    (error) => error.status === 400 && error.code === 'ACTION_TYPE_UNKNOWN'
  );
  // 模型能想到的发明形态同样拒绝。
  for (const invented of ['DELETE_ACCOUNT', 'EXECUTE_ARBITRARY_TOOL', 'READ_ALL_MESSAGES']) {
    assert.throws(() => proposeAction({ store, accountId: ACCOUNT, characterId: CHARACTER, actionType: invented, targetRef: PLAN_ID, idempotencyKey: `k-${invented}`, now: NOW }));
  }
});

test('action-gate: canonicalParametersDigest 服务器规范化——键序无关、时间归一、默认值填齐', () => {
  const left = canonicalParametersDigest({ b: 1, a: { y: [1, 2], x: 's' }, at: new Date('2026-10-01T08:00:00.000Z') });
  const right = canonicalParametersDigest({ a: { x: 's', y: [1, 2] }, at: new Date('2026-10-01T08:00:00Z'), b: 1 });
  assert.equal(left, right, '键序与时间形态归一后一致');
  assert.notEqual(left, canonicalParametersDigest({ b: 2, a: { y: [1, 2], x: 's' }, at: new Date('2026-10-01T08:00:00.000Z') }), '参数变化 digest 变化');
});

test('action-gate: 提议→批准→执行前重验全链；审批后参数变化/版本漂移/过期原审批不能执行', () => {
  const store = freshStore();
  const parameters = { expected_version: 1, support_mode: 'PRACTICE_TOGETHER' };
  const { action } = proposeAction({ store, accountId: ACCOUNT, characterId: CHARACTER, actionType: 'ACCEPT_PLAN', targetRef: PLAN_ID, targetVersion: 1, parameters, idempotencyKey: 'accept-1', now: NOW });
  assert.equal(action.state, 'PROPOSED');
  assert.equal(action.expires_at, new Date(NOW.getTime() + 15 * 60000).toISOString(), '默认 15 分钟');

  // 未批准不可执行。
  assert.equal(assertExecutable({ action, parameters }).executable, false);

  const approved = approveAction({ store, action, now: NOW });
  assert.equal(approved.state, 'APPROVED');
  assert.equal(approved.approved_at, NOW.toISOString());

  // 审批后参数变化：digest 不一致 → 拒绝。
  const tampered = assertExecutable({ action: approved, parameters: { ...parameters, expected_version: 2 }, now: NOW });
  assert.equal(tampered.executable, false);
  assert.equal(tampered.reason, 'PARAMETERS_CHANGED');

  // 目标版本漂移：TARGET_VERSION_MISMATCH。
  assert.equal(assertExecutable({ action: approved, parameters, currentTargetVersion: 3, now: NOW }).reason, 'TARGET_VERSION_MISMATCH');

  // 过期：15 分钟后原审批不能执行，且惰性裁决置 EXPIRED。
  const later = new Date(NOW.getTime() + 16 * 60000);
  const expiredDecision = assertExecutable({ action: approved, parameters, now: later });
  assert.equal(expiredDecision.reason, 'EXPIRED');
  const lapsed = lapseIfExpired(approved, store, later);
  assert.equal(lapsed.state, 'EXPIRED');
  assert.equal(store.actionRequests.get(approved.action_id).state, 'EXPIRED');

  // 账户非开放/暂停/安全模式：执行前重验拒绝。
  const store2 = freshStore();
  const approved2 = approveAction({ store: store2, action: proposeAction({ store: store2, accountId: ACCOUNT, characterId: CHARACTER, actionType: 'ACCEPT_PLAN', targetRef: PLAN_ID, parameters, idempotencyKey: 'accept-2', now: NOW }).action, now: NOW });
  const pausedAccount = { account_status: 'OPEN', user_pause_state: 'PAUSED', safety_mode: 'R0_NORMAL' };
  assert.equal(assertExecutable({ action: approved2, parameters, account: pausedAccount, now: NOW }).reason, 'USER_PAUSED');
  const safetyAccount = { account_status: 'OPEN', user_pause_state: 'ACTIVE', safety_mode: 'R2_LIMITED' };
  assert.equal(assertExecutable({ action: approved2, parameters, account: safetyAccount, now: NOW }).reason, 'SAFETY_MODE');

  // 全部通过：executable。
  const okAccount = { account_status: 'OPEN', user_pause_state: 'ACTIVE', safety_mode: 'R0_NORMAL' };
  assert.deepEqual(assertExecutable({ action: approved2, parameters, currentTargetVersion: null, account: okAccount, now: NOW }), { executable: true, reason: null });
});

test('action-gate: 域级幂等——同 (account, idempotency_key) 重放返回既有行', () => {
  const store = freshStore();
  const first = proposeAction({ store, accountId: ACCOUNT, characterId: CHARACTER, actionType: 'ACCEPT_PLAN', targetRef: PLAN_ID, parameters: { expected_version: 1 }, idempotencyKey: 'idem-1', now: NOW });
  const second = proposeAction({ store, accountId: ACCOUNT, characterId: CHARACTER, actionType: 'ACCEPT_PLAN', targetRef: PLAN_ID, parameters: { expected_version: 1 }, idempotencyKey: 'idem-1', now: NOW });
  assert.equal(second.replayed, true);
  assert.equal(second.action.action_id, first.action.action_id);
  assert.equal([...store.actionRequests.values()].length, 1);
});

test('action-gate: reject/cancel 状态约束；approve 只收 PROPOSED', () => {
  const store = freshStore();
  const { action } = proposeAction({ store, accountId: ACCOUNT, characterId: CHARACTER, actionType: 'ACCEPT_PLAN', targetRef: PLAN_ID, parameters: {}, idempotencyKey: 'r1', now: NOW });
  const approved = approveAction({ store, action, now: NOW });
  assert.throws(() => approveAction({ store, action: approved, now: NOW }), (error) => error.code === 'ACTION_STATE_CONFLICT', '重复批准拒绝');
  const rejected = rejectAction({ store, action: approved, now: NOW });
  assert.equal(rejected.state, 'REJECTED');
  assert.throws(() => cancelAction({ store, action: rejected, now: NOW }), (error) => error.code === 'ACTION_STATE_CONFLICT', '终态不能取消');

  const store2 = freshStore();
  const { action: another } = proposeAction({ store: store2, accountId: ACCOUNT, characterId: CHARACTER, actionType: 'ACCEPT_PLAN', targetRef: PLAN_ID, parameters: {}, idempotencyKey: 'r2', now: NOW });
  assert.equal(cancelAction({ store: store2, action: another, now: NOW }).state, 'CANCELLED');
});

test('action-gate: 透明记录（同一次用户确认=审批+执行两状态）；执行失败如实 FAILED', async () => {
  const store = freshStore();
  const succeed = await recordTransparentAction({
    store, accountId: ACCOUNT, characterId: CHARACTER, actionType: 'ACCEPT_PLAN',
    targetRef: PLAN_ID, targetVersion: 1, parameters: { expected_version: 1 },
    idempotencyKey: 'plan:cpl_1:accept:1',
    execute: () => ({ result_ref: `companion-plans/${PLAN_ID}` }),
    now: NOW
  });
  assert.equal(succeed.action.state, 'SUCCEEDED');
  assert.equal(succeed.action.approved_at, NOW.toISOString(), '审批状态独立记录');
  assert.equal(succeed.action.executed_at >= succeed.action.approved_at, true);
  assert.equal(succeed.action.result_ref, `companion-plans/${PLAN_ID}`);

  const replay = await recordTransparentAction({
    store, accountId: ACCOUNT, characterId: CHARACTER, actionType: 'ACCEPT_PLAN',
    targetRef: PLAN_ID, targetVersion: 1, parameters: { expected_version: 1 },
    idempotencyKey: 'plan:cpl_1:accept:1',
    execute: () => { throw new Error('不应重复执行'); },
    now: NOW
  });
  assert.equal(replay.replayed, true, '同幂等键重放不重复执行');

  const failed = await recordTransparentAction({
    store, accountId: ACCOUNT, characterId: CHARACTER, actionType: 'ACCEPT_PLAN',
    targetRef: 'cpl_2', targetVersion: 1, parameters: { expected_version: 1 },
    idempotencyKey: 'plan:cpl_2:accept:1',
    execute: () => { const error = new Error('版本冲突'); error.code = 'VERSION_CONFLICT'; throw error; },
    now: NOW
  }).catch((error) => error.code === 'VERSION_CONFLICT' ? { thrown: true } : Promise.reject(error));
  assert.equal(failed.thrown, true, '执行异常照常向上抛');
  const failedRow = [...store.actionRequests.values()].find((item) => item.idempotency_key === 'plan:cpl_2:accept:1');
  assert.equal(failedRow.state, 'FAILED');
  assert.equal(failedRow.failure_code, 'VERSION_CONFLICT', '失败码如实记录，不伪装成功');
});

test('action-gate: publicActionRequest 投影不含参数正文（只透出状态与关联）', () => {
  const store = freshStore();
  const { action } = proposeAction({ store, accountId: ACCOUNT, characterId: CHARACTER, actionType: 'ACCEPT_PLAN', targetRef: PLAN_ID, parameters: { secret_hint: '不应出现' }, idempotencyKey: 'p1', now: NOW });
  const projection = publicActionRequest(action);
  assert.equal(projection.parameters, undefined);
  assert.equal(JSON.stringify(projection).includes('不应出现'), false);
  assert.equal(projection.state, 'PROPOSED');
});

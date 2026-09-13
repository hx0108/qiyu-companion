'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DevelopmentStore } = require('../src/domain/store');
const {
  CALL_IDLE_TIMEOUT_MS,
  CALL_MAX_DURATION_MS,
  CallSessionError,
  activeCallForAccount,
  callTurns,
  createCall,
  createTurn,
  endCall,
  ensureCallWithinLimits,
  ownCall,
  ownTurn,
  pickGreeting,
  publicCall,
  reapExpiredCalls,
  requireActiveCall,
  settleTurn,
  transitionTurn
} = require('../src/domain/call-session');

const NOW = new Date('2026-09-13T12:00:00.000Z');

function startedCall(store, { accountId = 'acct_dev_alice', startedMinutesAgo = 0, lastActivityMinutesAgo = 0 } = {}) {
  const startedAt = new Date(NOW.getTime() - startedMinutesAgo * 60000);
  const call = createCall(store, { accountId, conversationId: 'conv_000001', characterId: 'chr_000001', now: startedAt });
  call.last_activity_at = new Date(NOW.getTime() - lastActivityMinutesAgo * 60000).toISOString();
  return call;
}

// 回合在真实链路中按 CREATED→UPLOADING→FINALIZED→TRANSCRIBING→THINKING→SPEAKING
// 推进（全在 SSE produce 内）；终局结算只从 THINKING/SPEAKING 发生。
function turnInProgress(store, call) {
  const turn = createTurn(store, call, { now: NOW });
  transitionTurn(store, turn, 'UPLOADING', {}, NOW);
  transitionTurn(store, turn, 'FINALIZED', {}, NOW);
  transitionTurn(store, turn, 'TRANSCRIBING', {}, NOW);
  transitionTurn(store, turn, 'THINKING', {}, NOW);
  transitionTurn(store, turn, 'SPEAKING', {}, NOW);
  return turn;
}

test('通话生命周期：创建→唯一活跃约束→挂断→不可重复结束', () => {
  const store = new DevelopmentStore();
  const call = createCall(store, { accountId: 'acct_dev_alice', conversationId: 'conv_000001', characterId: 'chr_000001', now: NOW });
  assert.equal(call.state, 'ACTIVE');
  assert.equal(activeCallForAccount(store, 'acct_dev_alice').call_id, call.call_id);
  assert.throws(() => createCall(store, { accountId: 'acct_dev_alice', conversationId: 'conv_000001', characterId: 'chr_000001', now: NOW }),
    (error) => error instanceof CallSessionError && error.code === 'CALL_ALREADY_ACTIVE');
  assert.deepEqual(publicCall(call).turn_count, 0);
  endCall(store, call, { reason: 'USER_HANGUP', now: NOW });
  assert.equal(call.state, 'ENDED');
  assert.equal(call.end_reason, 'USER_HANGUP');
  assert.equal(activeCallForAccount(store, 'acct_dev_alice'), null);
  assert.throws(() => endCall(store, call, { reason: 'USER_HANGUP', now: NOW }),
    (error) => error instanceof CallSessionError && error.code === 'CALL_ALREADY_ENDED');
  // 结束后可以再次发起：唯一约束只针对 ACTIVE。
  const next = createCall(store, { accountId: 'acct_dev_alice', conversationId: 'conv_000001', characterId: 'chr_000001', now: NOW });
  assert.notEqual(next.call_id, call.call_id);
});

test('归属校验：他人通话与不存在通话一律 CALL_NOT_FOUND，不泄露存在性', () => {
  const store = new DevelopmentStore();
  const call = createCall(store, { accountId: 'acct_dev_alice', conversationId: 'conv_000001', characterId: 'chr_000001', now: NOW });
  assert.throws(() => ownCall(store, 'acct_dev_bob', call.call_id), (error) => error.code === 'CALL_NOT_FOUND');
  assert.throws(() => ownCall(store, 'acct_dev_alice', 'call_999999'), (error) => error.code === 'CALL_NOT_FOUND');
  const turn = createTurn(store, call, { now: NOW });
  assert.throws(() => ownTurn(store, { ...call, call_id: 'call_999999' }, turn.turn_id), (error) => error.code === 'CALL_TURN_NOT_FOUND');
});

test('回合必须携带账户归属：PG 持久化的 RLS WITH CHECK 以 account_id 判行，缺失即落库被拒', () => {
  const store = new DevelopmentStore();
  const call = createCall(store, { accountId: 'acct_dev_alice', conversationId: 'conv_000001', characterId: 'chr_000001', now: NOW });
  const turn = createTurn(store, call, { now: NOW });
  assert.equal(turn.account_id, 'acct_dev_alice');
});

test('回合生命周期：同通话同时只有一个未终局回合；终局后可开新回合', () => {
  const store = new DevelopmentStore();
  const call = startedCall(store);
  const turn = createTurn(store, call, { now: NOW });
  assert.equal(turn.state, 'CREATED');
  assert.equal(turn.turn_index, 1);
  assert.throws(() => createTurn(store, call, { now: NOW }),
    (error) => error instanceof CallSessionError && error.code === 'CALL_TURN_OPEN_EXISTS');
  transitionTurn(store, turn, 'UPLOADING', {}, NOW);
  transitionTurn(store, turn, 'FINALIZED', {}, NOW);
  transitionTurn(store, turn, 'TRANSCRIBING', {}, NOW);
  transitionTurn(store, turn, 'THINKING', {}, NOW);
  transitionTurn(store, turn, 'SPEAKING', {}, NOW);
  settleTurn(store, call, turn, { state: 'COMPLETED', asrSeconds: 5, ttsSeconds: 8, now: NOW });
  assert.equal(turn.state, 'COMPLETED');
  const second = createTurn(store, call, { now: NOW });
  assert.equal(second.turn_index, 2);
  assert.equal(call.turn_count, 2);
  assert.deepEqual(callTurns(store, call.call_id).map((item) => item.turn_index), [1, 2]);
});

test('回合状态机：非法转移被拒；终局后不可再转移', () => {
  const store = new DevelopmentStore();
  const call = startedCall(store);
  const turn = createTurn(store, call, { now: NOW });
  assert.throws(() => transitionTurn(store, turn, 'SPEAKING', {}, NOW), (error) => error.code === 'CALL_TURN_STATE_INVALID');
  transitionTurn(store, turn, 'UPLOADING', {}, NOW);
  transitionTurn(store, turn, 'FINALIZED', {}, NOW);
  transitionTurn(store, turn, 'TRANSCRIBING', {}, NOW);
  transitionTurn(store, turn, 'THINKING', {}, NOW);
  transitionTurn(store, turn, 'SPEAKING', {}, NOW);
  settleTurn(store, call, turn, { state: 'INTERRUPTED', interrupted: true, ttsSeconds: 3, now: NOW });
  assert.equal(turn.interrupted, true);
  assert.equal(turn.failure_code, null); // 打断是正常终态而非失败
  assert.equal(call.interrupted_turn_count, 1);
  assert.throws(() => transitionTurn(store, turn, 'COMPLETED', {}, NOW), (error) => error.code === 'CALL_TURN_STATE_INVALID');
});

test('结算用量计入通话累计：打断回合单独计数', () => {
  const store = new DevelopmentStore();
  const call = startedCall(store);
  const first = turnInProgress(store, call);
  settleTurn(store, call, first, { state: 'COMPLETED', asrSeconds: 5, ttsSeconds: 8, now: NOW });
  const second = turnInProgress(store, call);
  settleTurn(store, call, second, { state: 'INTERRUPTED', interrupted: true, asrSeconds: 4, ttsSeconds: 2, now: NOW });
  assert.equal(call.asr_seconds_used, 9);
  assert.equal(call.tts_seconds_used, 10);
  assert.equal(call.interrupted_turn_count, 1);
});

test('惰性上限判定：超时长上限与空闲超时自动结束，端点内可见原因', () => {
  const store = new DevelopmentStore();
  const capped = startedCall(store, { startedMinutesAgo: CALL_MAX_DURATION_MS / 60000 + 1 });
  const result = ensureCallWithinLimits(store, capped, NOW);
  assert.deepEqual([result.endedNow, result.call.end_reason], [true, 'DURATION_CAP']);
  assert.equal(ensureCallWithinLimits(store, result.call, NOW).endedNow, false);

  const idle = startedCall(store, { lastActivityMinutesAgo: CALL_IDLE_TIMEOUT_MS / 60000 + 1 });
  const idleResult = ensureCallWithinLimits(store, idle, NOW);
  assert.deepEqual([idleResult.endedNow, idleResult.call.end_reason], [true, 'IDLE_TIMEOUT']);

  const healthy = startedCall(store, {});
  assert.equal(ensureCallWithinLimits(store, healthy, NOW).endedNow, false);
});

test('reapExpiredCalls：清扫孤儿活跃通话，已结束的不动', () => {
  const store = new DevelopmentStore();
  const orphan = startedCall(store, { lastActivityMinutesAgo: 10 });
  const ended = startedCall(store, { accountId: 'acct_dev_bob' });
  endCall(store, ended, { reason: 'USER_HANGUP', now: NOW });
  const reaped = reapExpiredCalls(store, NOW);
  assert.deepEqual(reaped.map((call) => call.call_id), [orphan.call_id]);
  assert.equal(orphan.end_reason, 'IDLE_TIMEOUT');
});

test('已结束通话不能再开回合；requireActiveCall 拦截', () => {
  const store = new DevelopmentStore();
  const call = startedCall(store);
  endCall(store, call, { reason: 'USER_HANGUP', now: NOW });
  assert.throws(() => createTurn(store, call, { now: NOW }), (error) => error.code === 'CALL_ALREADY_ENDED');
  assert.throws(() => requireActiveCall(call), (error) => error.code === 'CALL_ALREADY_ENDED');
});

test('开场问候：按世界情绪选模板、确定性轮换、未知情绪回中性', () => {
  assert.match(pickGreeting({ moodCode: 'HAPPY', seed: 0 }).text, /我/);
  assert.equal(pickGreeting({ moodCode: 'HAPPY', seed: 0 }).mood_code, 'HAPPY');
  assert.equal(pickGreeting({ moodCode: 'HAPPY', seed: 1 }).text, pickGreeting({ moodCode: 'HAPPY', seed: 1 }).text);
  assert.equal(pickGreeting({ moodCode: 'UNKNOWN_MOOD' }).mood_code, 'NEUTRAL');
  assert.equal(pickGreeting({}).mood_code, 'NEUTRAL');
});

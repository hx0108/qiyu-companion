'use strict';

// 1:1 实时语音通话的会话与回合状态机（纯函数域模块）。
// 回合执行体（ASR→门禁→LLM→逐句 TTS 的 produce）在 call-turn-engine；
// 这里只负责状态转移、上限判定、开场问候模板与孤儿会话清扫。
// 单实例部署假设：call_sessions/call_turns 经 store 持久化，但「当前活跃
// 通话」的进程内判定（音频缓冲、SSE 令牌）不跨实例——与既有 streamTokens 同口径。

const CALL_MAX_DURATION_MS = 15 * 60 * 1000; // 单通话时长上限（成本护栏，env 可在路由层覆盖）
const CALL_IDLE_TIMEOUT_MS = 3 * 60 * 1000; // 最后一次回合活动后的空闲自动挂断
const CALL_TURN_MAX_ASR_SECONDS = 60; // 回合 ASR 预留预算上限（真实上限仍是音频字节数）
const CALL_TURN_MAX_TTS_SECONDS = 90; // 回合 TTS 预留预算上限

const CALL_END_REASONS = new Set(['USER_HANGUP', 'IDLE_TIMEOUT', 'DURATION_CAP', 'ERROR']);
const TURN_TERMINAL_STATES = new Set(['COMPLETED', 'INTERRUPTED', 'FAILED']);
const TURN_TRANSITIONS = Object.freeze({
  CREATED: new Set(['UPLOADING', 'FINALIZED', 'FAILED']),
  UPLOADING: new Set(['FINALIZED', 'FAILED']),
  // ASR/审核/LLM/TTS 全部在 SSE produce 内推进（令牌未消费零副作用）。
  FINALIZED: new Set(['TRANSCRIBING', 'FAILED']),
  TRANSCRIBING: new Set(['THINKING', 'FAILED']),
  THINKING: new Set(['SPEAKING', 'FAILED', 'INTERRUPTED']),
  // 打断（客户端断开 SSE）只可能发生在模型已在生成/播报的阶段。
  SPEAKING: new Set(['COMPLETED', 'FAILED', 'INTERRUPTED'])
});

// 开场问候：模板 + 世界状态情绪选文案，不调用 LLM（首响应延迟优先）。
const CALL_GREETING_TEMPLATES = Object.freeze({
  HAPPY: Object.freeze(['喂，是我。今天状态特别好，正想你什么时候打来呢。', '接通啦。我这边刚刚还在笑，你来得正好。']),
  CALM: Object.freeze(['嗯，我在。不急，慢慢说。', '电话通了。今天想聊点什么？']),
  TIRED: Object.freeze(['我有点乏，不过听到是你，就好多了。', '接通了……陪我待一会儿吧。']),
  CONCERNED: Object.freeze(['我一直在想你。今天，还好吗？', '你打来我很高兴。最近是不是有心事？']),
  NEUTRAL: Object.freeze(['喂？听到我了就说一声，我在呢。', '电话接通了。想说什么都可以，我听着。'])
});

class CallSessionError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

function createCall(store, { accountId, conversationId, characterId, now = new Date() }) {
  requireStore(store);
  if (activeCallForAccount(store, accountId)) {
    throw new CallSessionError('CALL_ALREADY_ACTIVE', '已有进行中的通话，请先结束当前通话');
  }
  const call = {
    call_id: store.next('call'),
    account_id: accountId,
    conversation_id: conversationId,
    character_id: characterId,
    state: 'ACTIVE',
    end_reason: null,
    started_at: now.toISOString(),
    ended_at: null,
    last_activity_at: now.toISOString(),
    turn_count: 0,
    interrupted_turn_count: 0,
    asr_seconds_used: 0,
    tts_seconds_used: 0
  };
  store.callSessions.set(call.call_id, call);
  return call;
}

function activeCallForAccount(store, accountId) {
  return [...store.callSessions.values()].find((call) => call.account_id === accountId && call.state === 'ACTIVE') || null;
}

function ownCall(store, accountId, callId) {
  const call = store.callSessions.get(callId);
  if (!call || call.account_id !== accountId) {
    throw new CallSessionError('CALL_NOT_FOUND', '通话不存在');
  }
  return call;
}

function requireActiveCall(call) {
  if (call.state !== 'ACTIVE') {
    throw new CallSessionError('CALL_ALREADY_ENDED', '通话已结束', { end_reason: call.end_reason });
  }
  return call;
}

// 惰性上限判定：所有 /calls/* 路由入口先调用。返回结算后的通话与是否
// 刚被自动结束（路由层据此落通话记录卡片、清理回合音频缓冲）。
function ensureCallWithinLimits(store, call, now = new Date()) {
  if (call.state !== 'ACTIVE') return { call, endedNow: false };
  const startedAt = Date.parse(call.started_at);
  const lastActivityAt = Date.parse(call.last_activity_at);
  if (now.getTime() - startedAt > CALL_MAX_DURATION_MS) {
    return { call: endCall(store, call, { reason: 'DURATION_CAP', now }), endedNow: true };
  }
  if (now.getTime() - lastActivityAt > CALL_IDLE_TIMEOUT_MS) {
    return { call: endCall(store, call, { reason: 'IDLE_TIMEOUT', now }), endedNow: true };
  }
  return { call, endedNow: false };
}

function endCall(store, call, { reason, now = new Date() }) {
  requireStore(store);
  if (!CALL_END_REASONS.has(reason)) throw new CallSessionError('VALIDATION_ERROR', '通话结束原因无效');
  if (call.state !== 'ACTIVE') throw new CallSessionError('CALL_ALREADY_ENDED', '通话已结束', { end_reason: call.end_reason });
  call.state = 'ENDED';
  call.end_reason = reason;
  call.ended_at = now.toISOString();
  call.last_activity_at = now.toISOString();
  store.callSessions.set(call.call_id, call);
  return call;
}

function createTurn(store, call, { now = new Date() }) {
  requireStore(store);
  requireActiveCall(call);
  if (openTurnForCall(store, call.call_id)) {
    throw new CallSessionError('CALL_TURN_OPEN_EXISTS', '上一回合尚未结束，请等待当前回合完成后再开始新的回合');
  }
  const turn = {
    turn_id: store.next('callturn'),
    call_id: call.call_id,
    // PG 持久化必需：call_turns 的 RLS WITH CHECK 以 account_id 判行归属，
    // 缺省会在落库时被拒（内存模式无感，单测夹具须沿用此字段）。
    account_id: call.account_id,
    turn_index: call.turn_count + 1,
    state: 'CREATED',
    user_message_id: null,
    assistant_message_id: null,
    asr_job_id: null,
    tts_job_id: null,
    audio_bytes: 0,
    chunk_count: 0,
    transcript_text: null,
    interrupted: false,
    failure_code: null,
    created_at: now.toISOString(),
    ended_at: null
  };
  call.turn_count += 1;
  call.last_activity_at = now.toISOString();
  store.callTurns.set(turn.turn_id, turn);
  store.callSessions.set(call.call_id, call);
  return turn;
}

function ownTurn(store, call, turnId) {
  const turn = store.callTurns.get(turnId);
  if (!turn || turn.call_id !== call.call_id) {
    throw new CallSessionError('CALL_TURN_NOT_FOUND', '通话回合不存在');
  }
  return turn;
}

function openTurnForCall(store, callId) {
  return [...store.callTurns.values()].find((turn) => turn.call_id === callId && !TURN_TERMINAL_STATES.has(turn.state)) || null;
}

function transitionTurn(store, turn, nextState, patch = {}, now = new Date()) {
  const allowed = TURN_TRANSITIONS[turn.state];
  if (!allowed || !allowed.has(nextState)) {
    throw new CallSessionError('CALL_TURN_STATE_INVALID', `回合状态不允许从 ${turn.state} 转移到 ${nextState}`);
  }
  turn.state = nextState;
  for (const [key, value] of Object.entries(patch)) turn[key] = value;
  if (TURN_TERMINAL_STATES.has(nextState)) turn.ended_at = now.toISOString();
  store.callTurns.set(turn.turn_id, turn);
  return turn;
}

// 回合终局结算：写入用量并推进通话累计值。三本账的实际 commit 由
// turn-engine 完成；这里只负责会话侧计量与 last_activity 刷新。
function settleTurn(store, call, turn, { state, interrupted = false, asrSeconds = 0, ttsSeconds = 0, failureCode = null, now = new Date() } = {}) {
  if (TURN_TERMINAL_STATES.has(turn.state)) {
    throw new CallSessionError('CALL_TURN_ALREADY_SETTLED', '回合已终局', { state: turn.state });
  }
  const patch = { interrupted, failure_code: failureCode };
  if (state === 'INTERRUPTED') patch.failure_code = null; // 打断是正常终态而非失败
  transitionTurn(store, turn, state, patch, now);
  call.asr_seconds_used += Math.max(0, Math.round(asrSeconds));
  call.tts_seconds_used += Math.max(0, Math.round(ttsSeconds));
  if (interrupted) call.interrupted_turn_count += 1;
  call.last_activity_at = now.toISOString();
  store.callSessions.set(call.call_id, call);
  return turn;
}

function callTurns(store, callId) {
  return [...store.callTurns.values()].filter((turn) => turn.call_id === callId).sort((a, b) => a.turn_index - b.turn_index);
}

function pickGreeting({ moodCode, seed = 0 } = {}) {
  const bucket = CALL_GREETING_TEMPLATES[String(moodCode || '').toUpperCase()];
  const variants = bucket || CALL_GREETING_TEMPLATES.NEUTRAL;
  const index = Math.abs(Number.isInteger(seed) ? seed : 0) % variants.length;
  return { text: variants[index], mood_code: bucket ? String(moodCode).toUpperCase() : 'NEUTRAL' };
}

// 孤儿会话清扫（客户端崩溃/进程重启兜底）：惰性判定之外每分钟跑一次的
// 定时兜底；返回刚被结束的通话列表，供路由/Worker 层落记录卡片。
function reapExpiredCalls(store, now = new Date()) {
  requireStore(store);
  const reaped = [];
  for (const call of [...store.callSessions.values()]) {
    if (call.state !== 'ACTIVE') continue;
    const { endedNow } = ensureCallWithinLimits(store, call, now);
    if (endedNow) reaped.push(call);
  }
  return reaped;
}

function publicCall(call) {
  return Object.freeze({
    call_id: call.call_id,
    conversation_id: call.conversation_id,
    character_id: call.character_id,
    state: call.state,
    end_reason: call.end_reason,
    started_at: call.started_at,
    ended_at: call.ended_at,
    turn_count: call.turn_count,
    interrupted_turn_count: call.interrupted_turn_count,
    asr_seconds_used: call.asr_seconds_used,
    tts_seconds_used: call.tts_seconds_used
  });
}

function publicTurn(turn) {
  return Object.freeze({
    turn_id: turn.turn_id,
    turn_index: turn.turn_index,
    state: turn.state,
    interrupted: turn.interrupted,
    failure_code: turn.failure_code,
    audio_bytes: turn.audio_bytes,
    chunk_count: turn.chunk_count,
    created_at: turn.created_at,
    ended_at: turn.ended_at
  });
}

function requireStore(store) {
  if (!store || !(store.callSessions instanceof Map) || !(store.callTurns instanceof Map) || typeof store.next !== 'function') {
    throw new TypeError('callSessions/callTurns Map 与 store.next 是必需的');
  }
}

module.exports = {
  CALL_MAX_DURATION_MS,
  CALL_IDLE_TIMEOUT_MS,
  CALL_TURN_MAX_ASR_SECONDS,
  CALL_TURN_MAX_TTS_SECONDS,
  CALL_END_REASONS,
  CALL_GREETING_TEMPLATES,
  TURN_TERMINAL_STATES,
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
  publicTurn,
  reapExpiredCalls,
  requireActiveCall,
  settleTurn,
  transitionTurn
};

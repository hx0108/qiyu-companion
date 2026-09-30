'use strict';

const { createHash } = require('node:crypto');

// 六项能力 A3（方案 §4.6）：独立行动权限的最小 action gate。角色提议不等
// 于执行成功——模型只能输出受控意图与参数候选；白名单、资源归属、当前
// 版本、必要授权、安全模式与额度核对归本模块。新增动作必须明确映射到
// SEND_MESSAGE/WRITE_MEMORY/DATA_RIGHTS 等既有准入语义，不默认放行未知
// 动作（白名单在域层拥有，迁移 067 不加 CHECK 枚举）。

// 首批动作注册表：显式审批入口只收 ACCEPT_PLAN。计划暂停/恢复/取消按
// §4.6「暂停与数据权利动作按既有语义保持可达」走专用路由直达（经
// recordTransparentAction 透明留痕），不进显式入口。日历类型留给 B1。
const ACTION_TYPE_REGISTRY = Object.freeze({
  ACCEPT_PLAN: Object.freeze({ permission: 'WRITE_MEMORY', description: '接受一份计划草案（绑定草案版本与参数）' })
});
// 默认审批期限 15 分钟（§4.6）。
const ACTION_EXPIRY_MINUTES = 15;
const ACTION_TERMINAL_STATES = Object.freeze(['SUCCEEDED', 'FAILED', 'REJECTED', 'EXPIRED', 'CANCELLED']);

// 服务器规范化参数哈希：键排序 + ISO 时间 + 默认值填齐后 sha256。审批绑定
// 的是这个 digest——审批后参数变化（digest 不一致）必须重新批准。本地实现
// 不复用 app.js stableHash（那是 HTTP 幂等键的 body 哈希，语义不同）。
function canonicalizeValue(value) {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonicalizeValue);
  if (typeof value === 'object') {
    const entries = Object.entries(value).filter(([, item]) => item !== undefined).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return entries.map(([key, item]) => [key, canonicalizeValue(item)]);
  }
  return value;
}

function canonicalParametersDigest(parameters) {
  const canonical = JSON.stringify(canonicalizeValue(parameters ?? {}));
  return createHash('sha256').update(canonical).digest('hex');
}

// 显式提议（POST /action-requests）：白名单外 400；归属与准入语义由调用方
// （路由层 ownX + authorize）先行校验，本函数只做类型注册表核对与幂等查重。
function proposeAction({ store, accountId, characterId, actionType, targetRef, targetVersion = null, parameters = {}, idempotencyKey, now = new Date() } = {}) {
  const registered = ACTION_TYPE_REGISTRY[actionType];
  if (!registered) {
    const error = new Error(`未知动作类型：${String(actionType)}（白名单：${Object.keys(ACTION_TYPE_REGISTRY).join('/')}）`);
    error.status = 400;
    error.code = 'ACTION_TYPE_UNKNOWN';
    error.expose = true;
    throw error;
  }
  // 域级幂等：同 (account, idempotency_key) 返回既有行（迁移 067 全量唯一）。
  const existing = [...store.actionRequests.values()].find((item) => item.account_id === accountId && item.idempotency_key === idempotencyKey);
  if (existing) return { action: existing, replayed: true };
  const action = {
    action_id: store.next('arq'), account_id: accountId, character_id: characterId,
    action_type: actionType, target_ref: targetRef, target_version: targetVersion,
    parameters_digest: canonicalParametersDigest(parameters),
    state: 'PROPOSED', expires_at: new Date(now.getTime() + ACTION_EXPIRY_MINUTES * 60000).toISOString(),
    result_ref: null, failure_code: null, idempotency_key: idempotencyKey,
    approved_at: null, executed_at: null, created_at: now.toISOString(), updated_at: now.toISOString()
  };
  store.actionRequests.set(action.action_id, Object.freeze(action));
  return { action, replayed: false };
}

// 惰性过期裁决：非终态且超时 → EXPIRED（查询/审批/执行路径共用；不建后台清扫）。
function lapseIfExpired(action, store, now = new Date()) {
  if (!action || ACTION_TERMINAL_STATES.includes(action.state)) return action;
  if (new Date(action.expires_at).getTime() > now.getTime()) return action;
  const lapsed = Object.freeze({ ...action, state: 'EXPIRED', updated_at: now.toISOString() });
  store.actionRequests.set(action.action_id, lapsed);
  return lapsed;
}

// 批准：绑定批准时刻的参数与目标版本。PROPOSED 才可批准；已过期拒绝。
function approveAction({ store, action, now = new Date() } = {}) {
  const current = lapseIfExpired(action, store, now);
  if (current.state === 'EXPIRED') {
    const error = new Error('审批期限已过（15 分钟），请让角色重新提议');
    error.status = 409;
    error.code = 'ACTION_EXPIRED';
    error.expose = true;
    throw error;
  }
  if (current.state !== 'PROPOSED') {
    const error = new Error(`当前状态 ${current.state} 不能批准`);
    error.status = 409;
    error.code = 'ACTION_STATE_CONFLICT';
    error.expose = true;
    throw error;
  }
  const approved = Object.freeze({ ...current, state: 'APPROVED', approved_at: now.toISOString(), updated_at: now.toISOString() });
  store.actionRequests.set(approved.action_id, approved);
  return approved;
}

function rejectAction({ store, action, now = new Date() } = {}) {
  if (action.state === 'SUCCEEDED' || action.state === 'EXECUTING') {
    const error = new Error(`当前状态 ${action.state} 不能拒绝`);
    error.status = 409;
    error.code = 'ACTION_STATE_CONFLICT';
    error.expose = true;
    throw error;
  }
  const rejected = Object.freeze({ ...action, state: 'REJECTED', updated_at: now.toISOString() });
  store.actionRequests.set(rejected.action_id, rejected);
  return rejected;
}

function cancelAction({ store, action, now = new Date() } = {}) {
  if (ACTION_TERMINAL_STATES.includes(action.state)) {
    const error = new Error(`终态 ${action.state} 不能取消`);
    error.status = 409;
    error.code = 'ACTION_STATE_CONFLICT';
    error.expose = true;
    throw error;
  }
  const cancelled = Object.freeze({ ...action, state: 'CANCELLED', updated_at: now.toISOString() });
  store.actionRequests.set(cancelled.action_id, cancelled);
  return cancelled;
}

// 执行前短事务重验（照 evaluateFollowupPublish 的失败码风格，返回裁决而非
// 布尔）：状态、digest 一致、未过期、目标版本仍匹配、账户仍开放。任何一项
// 不符 → 原审批作废，必须重新提议。
function assertExecutable({ action, parameters = null, currentTargetVersion = null, account = null, now = new Date() } = {}) {
  const fail = (reason) => ({ executable: false, reason });
  if (!action) return fail('ACTION_NOT_FOUND');
  if (action.state !== 'APPROVED') return fail(action.state === 'EXECUTING' ? 'ALREADY_EXECUTING' : `STATE_${action.state}`);
  if (new Date(action.expires_at).getTime() <= now.getTime()) return fail('EXPIRED');
  if (parameters !== null) {
    const digest = canonicalParametersDigest(parameters);
    if (digest !== action.parameters_digest) return fail('PARAMETERS_CHANGED');
  }
  if (currentTargetVersion !== null && action.target_version !== null && Number(currentTargetVersion) !== Number(action.target_version)) return fail('TARGET_VERSION_MISMATCH');
  if (account && account.account_status !== 'OPEN') return fail('ACCOUNT_NOT_OPEN');
  if (account && account.user_pause_state === 'PAUSED') return fail('USER_PAUSED');
  if (account && account.safety_mode && account.safety_mode !== 'R0_NORMAL') return fail('SAFETY_MODE');
  return { executable: true, reason: null };
}

// 同一次用户确认 = 审批 + 执行两个状态（§4.6）：计划五条 action 路由在
// ACTION_EXECUTION 开开启时透明落一行。白名单不适用于此——透明记录的是已经
// 由专用路由 + authorize + 状态机把关过的用户确认操作；白名单（注册表）只
// 约束显式入口 POST /action-requests。幂等键域级规范
// plan:{plan_id}:{action}:{plan.version}——调用方只在成功后记录（失败不占
// 幂等键，重试可重新执行）。
async function recordTransparentAction({ store, accountId, characterId, actionType, targetRef, targetVersion, parameters = {}, idempotencyKey, execute, now = new Date() } = {}) {
  const existing = [...store.actionRequests.values()].find((item) => item.account_id === accountId && item.idempotency_key === idempotencyKey);
  if (existing) return { action: existing, replayed: true, result: null };
  const executing = Object.freeze({
    action_id: store.next('arq'), account_id: accountId, character_id: characterId ?? null,
    action_type: actionType, target_ref: targetRef, target_version: targetVersion ?? null,
    parameters_digest: canonicalParametersDigest(parameters),
    state: 'EXECUTING', expires_at: new Date(now.getTime() + ACTION_EXPIRY_MINUTES * 60000).toISOString(),
    result_ref: null, failure_code: null, idempotency_key: idempotencyKey,
    approved_at: now.toISOString(), executed_at: null,
    created_at: now.toISOString(), updated_at: now.toISOString()
  });
  store.actionRequests.set(executing.action_id, executing);
  try {
    const result = await execute();
    const succeeded = Object.freeze({ ...executing, state: 'SUCCEEDED', result_ref: result?.result_ref ?? null, executed_at: now.toISOString(), updated_at: now.toISOString() });
    store.actionRequests.set(succeeded.action_id, succeeded);
    return { action: succeeded, replayed: false, result };
  } catch (error) {
    const failed = Object.freeze({ ...executing, state: 'FAILED', failure_code: error?.code ?? 'EXECUTION_FAILED', executed_at: now.toISOString(), updated_at: now.toISOString() });
    store.actionRequests.set(failed.action_id, failed);
    throw error;
  }
}

function publicActionRequest(action) {
  return {
    action_id: action.action_id, action_type: action.action_type,
    target_ref: action.target_ref, target_version: action.target_version ?? null,
    state: action.state, expires_at: action.expires_at,
    result_ref: action.result_ref ?? null, failure_code: action.failure_code ?? null,
    approved_at: action.approved_at ?? null, executed_at: action.executed_at ?? null,
    created_at: action.created_at, idempotency_key: action.idempotency_key
  };
}

module.exports = {
  ACTION_TYPE_REGISTRY, ACTION_EXPIRY_MINUTES, ACTION_TERMINAL_STATES,
  canonicalParametersDigest, proposeAction, lapseIfExpired,
  approveAction, rejectAction, cancelAction, assertExecutable,
  recordTransparentAction, publicActionRequest
};

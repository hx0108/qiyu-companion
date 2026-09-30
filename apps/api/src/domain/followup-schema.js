'use strict';

// 六项能力 A2（方案 §4.2）：事件级跟进许可的受控字段校验层。确认事件 ≠
// 允许提醒——许可绑定用户确认的具体事件版本与时间窗口，规则引擎（非模型）
// 拥有投递决定权，本层只做确定性字段裁决。

const FOLLOWUP_KINDS = Object.freeze(['BEFORE_EVENT', 'AFTER_EVENT']);
// 复用既有 6 类主动触发（方案：不新增"模型觉得你需要关心"）：
// 事前/准点提醒走约定提醒；事后关心走现实行动确认。
const FOLLOWUP_KIND_TO_TRIGGER = Object.freeze({
  BEFORE_EVENT: 'CONFIRMED_APPOINTMENT',
  AFTER_EVENT: 'CONFIRMED_REALITY_ACTION'
});
// 默认触发时刻（用户拍板 2026-09-30）：事前=事件准点；事后=事件后 2 小时。
const DEFAULT_BEFORE_OFFSET_MINUTES = 0;
const DEFAULT_AFTER_OFFSET_MINUTES = 120;
// 允许窗口：due_at 过后多久内仍可投递（顺延上限），默认 24 小时。
const DEFAULT_WINDOW_HOURS = 24;
const FOLLOWUP_TEXT_MAX = 200;

function isParseableTimestamp(value) {
  if (typeof value !== 'string' || !value.trim()) return false;
  const parsed = Date.parse(value.trim());
  return Number.isFinite(parsed);
}

// PUT /life-events/{id}/followup 的请求校验与默认值派生。
// 硬拒绝（errors，不进许可创建）：
// - 事件 timezone 为空（时区未知不调度，方案 §4.2）
// - clarification_required（未确认时间不得开提醒）
// - 事件 status=CANCELLED；BEFORE_EVENT 要求 PLANNED（已完成的没有"事前"）
// - 派生 due_at <= now（不补发过时提醒）
function validateFollowupGrantRequest(raw, { event, now = new Date() } = {}) {
  const errors = [];
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};

  if (!event || typeof event !== 'object') {
    return { ok: false, errors: [{ field: 'event', reason: '事件不存在' }], value: null };
  }
  if (!event.timezone) errors.push({ field: 'timezone', reason: '事件未确认时区，不调度跟进' });
  if (event.clarification_required === true) errors.push({ field: 'scheduled_at', reason: '事件时间待确认，先补全时间再开启提醒' });
  if (event.status === 'CANCELLED') errors.push({ field: 'status', reason: '已取消的事件不能开启提醒' });

  const followupKind = source.followup_kind;
  if (!FOLLOWUP_KINDS.includes(followupKind)) errors.push({ field: 'followup_kind', reason: `只能是 ${FOLLOWUP_KINDS.join('/')}` });
  if (followupKind === 'BEFORE_EVENT' && event.status && event.status !== 'PLANNED') {
    errors.push({ field: 'followup_kind', reason: '事前提醒只适用于计划中的事件' });
  }

  let dueAt = null;
  if (source.due_at !== undefined && source.due_at !== null && source.due_at !== '') {
    if (!isParseableTimestamp(source.due_at)) errors.push({ field: 'due_at', reason: '必须是可解析的时间' });
    else dueAt = new Date(source.due_at).toISOString();
  } else {
    if (!event.scheduled_at) {
      errors.push({ field: 'due_at', reason: '事件无确切时间，开启提醒必须提供 due_at' });
    } else {
      const offsetMinutes = followupKind === 'AFTER_EVENT' ? DEFAULT_AFTER_OFFSET_MINUTES : DEFAULT_BEFORE_OFFSET_MINUTES;
      dueAt = new Date(new Date(event.scheduled_at).getTime() + offsetMinutes * 60000).toISOString();
    }
  }

  let allowedFrom = null;
  if (source.allowed_from !== undefined && source.allowed_from !== null && source.allowed_from !== '') {
    if (!isParseableTimestamp(source.allowed_from)) errors.push({ field: 'allowed_from', reason: '必须是可解析的时间' });
    else allowedFrom = new Date(source.allowed_from).toISOString();
  } else {
    allowedFrom = now.toISOString();
  }

  let expiresAt = null;
  if (source.expires_at !== undefined && source.expires_at !== null && source.expires_at !== '') {
    if (!isParseableTimestamp(source.expires_at)) errors.push({ field: 'expires_at', reason: '必须是可解析的时间' });
    else expiresAt = new Date(source.expires_at).toISOString();
  } else {
    expiresAt = dueAt ? new Date(new Date(dueAt).getTime() + DEFAULT_WINDOW_HOURS * 3600000).toISOString() : null;
  }

  if (dueAt && expiresAt && new Date(expiresAt) <= new Date(dueAt)) errors.push({ field: 'expires_at', reason: '必须晚于触发时刻' });
  if (allowedFrom && expiresAt && new Date(expiresAt) <= new Date(allowedFrom)) errors.push({ field: 'expires_at', reason: '必须晚于允许起点' });
  if (dueAt && new Date(dueAt) <= now) errors.push({ field: 'due_at', reason: '已过期的触发时刻不补发（可显式给未来的 due_at）' });

  if (errors.length > 0) return { ok: false, errors, value: null };
  return {
    ok: true,
    errors: [],
    value: { followup_kind: followupKind, due_at: dueAt, allowed_from: allowedFrom, expires_at: expiresAt }
  };
}

// 模型措辞输出校验：只收 { text }；文本不得超长、必须含事件标题子串
//（模型只在模板槽内改写，不得脱离事实自由发挥）。
function validateFollowupComposerOutput(raw, { eventTitle } = {}) {
  const text = typeof raw?.text === 'string' ? raw.text.trim() : '';
  if (!text) return { ok: false, reason: 'EMPTY_TEXT' };
  if (text.length > FOLLOWUP_TEXT_MAX) return { ok: false, reason: 'TOO_LONG' };
  const title = String(eventTitle ?? '').trim();
  if (title && !text.includes(title)) return { ok: false, reason: 'MISSING_EVENT_TITLE' };
  return { ok: true, value: { text } };
}

module.exports = {
  FOLLOWUP_KINDS, FOLLOWUP_KIND_TO_TRIGGER,
  DEFAULT_BEFORE_OFFSET_MINUTES, DEFAULT_AFTER_OFFSET_MINUTES, DEFAULT_WINDOW_HOURS, FOLLOWUP_TEXT_MAX,
  validateFollowupGrantRequest, validateFollowupComposerOutput
};

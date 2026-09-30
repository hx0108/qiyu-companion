'use strict';

// 生活事件（六项能力 A1）受控字段的唯一校验层。提取 Worker 的模型输出与
// HTTP 修订（PATCH/confirm-edited）都要过这里——模型只是候选生产者，字段
// 合法性由确定性代码裁决（技术设计"模型不持有执行权"）。

const LIFE_EVENT_DOMAINS = Object.freeze(['REAL_LIFE', 'FICTIONAL_SHARED']);
const LIFE_EVENT_KINDS = Object.freeze(['INTERVIEW', 'READING', 'CREATION', 'OTHER']);
const LIFE_EVENT_STATUSES = Object.freeze(['PLANNED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED']);
const LIFE_EVENT_TIME_PRECISIONS = Object.freeze(['UNKNOWN', 'DATE', 'MINUTE']);
const LIFE_EVENT_TITLE_MAX = 80;
const LIFE_EVENT_RAW_TIME_MAX = 80;
// PATCH 白名单：允许用户修订的字段（版本号/归属/审计字段不在此列）。
const LIFE_EVENT_REVISION_FIELDS = Object.freeze(['title', 'event_kind', 'domain', 'scheduled_at', 'timezone', 'time_precision', 'status', 'clarification_required', 'domain_change_confirmed']);

let cachedTimezoneSet = null;
// Intl.supportedValuesOf('timeZone') 在首次调用后固化，避免每条校验重建集合。
function knownTimezones() {
  if (cachedTimezoneSet) return cachedTimezoneSet;
  const values = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];
  cachedTimezoneSet = Object.freeze(new Set([...values, 'UTC'])); // UTC 是保留名，不在名单内但必须合法
  return cachedTimezoneSet;
}
function isValidIanaTimezone(value) {
  return typeof value === 'string' && knownTimezones().has(value);
}

// ISO 串携带的精度：只有日期（无 T 时段）→ DATE；带 HH:mm → MINUTE；
// 无 scheduled_at → UNKNOWN。显式 T00:00 按用户给了确切午夜时刻处理（MINUTE）。
function resolveTimePrecision(scheduledAt) {
  if (typeof scheduledAt !== 'string' || !scheduledAt.trim()) return 'UNKNOWN';
  return /T\d{2}:\d{2}/.test(scheduledAt.trim()) ? 'MINUTE' : 'DATE';
}

function isParseableDate(value) {
  if (typeof value !== 'string' || !value.trim()) return false;
  const parsed = Date.parse(value.trim());
  return Number.isFinite(parsed);
}

// 确定性隐私脱敏（2026-09-30 真实验收发现：提示词红线「机构名不入 title」对
// qwen3.8-flash 是概率性的——「协和医院」「XX公司」后缀型机构名会漏进 title）。
// 只作用于模型提取路径（validateLifeEventCandidateOutput）；用户确认/修订时
// 自己写的标题不脱敏（自己的数据自己决定）。无后缀专名（如公司简称）无法
// 穷举，由「候选须用户确认才成为事实」这道既有防线兜底（确认卡可见可编辑）。
const ORGANIZATION_NAME_PATTERN = /[一-龥A-Za-z0-9]{2}(?:有限公司|股份有限公司|股份公司|集团公司|集团|公司|医院|诊所|卫生院|银行|支行|学院|大学|中学|小学|研究所)/gu;
function sanitizeLifeEventTitle(title) {
  return String(title ?? '')
    .replace(ORGANIZATION_NAME_PATTERN, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// 提取器单条输出的校验与归一化。返回 { valid, errors, value }：
// - errors: [{ field, reason }]（app 层映射 400 VALIDATION_ERROR + details.missing_fields）
// - value: 受控字段（含确定性推导的 time_precision 与 needs_time_confirmation）
// 含糊日期策略（方案 9.1）：模型给 raw_time_text 而给不出 ISO，或自报
// time_uncertain → needs_time_confirmation=true，事件仍可确认，日期由用户补。
function validateLifeEventCandidateOutput(item, { now = new Date() } = {}) {
  const errors = [];
  const source = item && typeof item === 'object' && !Array.isArray(item) ? item : {};
  const rawTitle = typeof source.title === 'string' ? source.title.trim() : '';
  // 机构名脱敏后再参与校验：脱敏后为空视为该候选无效（整条丢弃由调用方处理）。
  const title = rawTitle ? sanitizeLifeEventTitle(rawTitle) : '';
  if (!title) errors.push({ field: 'title', reason: '必填' });
  else if (title.length > LIFE_EVENT_TITLE_MAX) errors.push({ field: 'title', reason: `不能超过 ${LIFE_EVENT_TITLE_MAX} 字` });

  const domain = source.domain;
  if (!LIFE_EVENT_DOMAINS.includes(domain)) errors.push({ field: 'domain', reason: `只能是 ${LIFE_EVENT_DOMAINS.join('/')}` });

  const eventKind = source.event_kind === undefined || source.event_kind === null ? 'OTHER' : source.event_kind;
  if (!LIFE_EVENT_KINDS.includes(eventKind)) errors.push({ field: 'event_kind', reason: `只能是 ${LIFE_EVENT_KINDS.join('/')}` });

  let scheduledAt = null;
  if (source.scheduled_at !== undefined && source.scheduled_at !== null && source.scheduled_at !== '') {
    if (!isParseableDate(source.scheduled_at)) errors.push({ field: 'scheduled_at', reason: '必须是可解析的日期时间' });
    else scheduledAt = new Date(source.scheduled_at).toISOString();
  }

  let timezone = null;
  if (source.timezone !== undefined && source.timezone !== null && source.timezone !== '') {
    if (!isValidIanaTimezone(source.timezone)) errors.push({ field: 'timezone', reason: '必须是有效的 IANA 时区' });
    else timezone = source.timezone;
  }

  const rawTimeText = typeof source.raw_time_text === 'string' ? source.raw_time_text.trim().slice(0, LIFE_EVENT_RAW_TIME_MAX) : '';
  const timeUncertain = source.time_uncertain === true;
  const needsTimeConfirmation = timeUncertain || (!scheduledAt && Boolean(rawTimeText));

  if (errors.length > 0) return { valid: false, errors, value: null };
  return {
    valid: true,
    errors: [],
    value: {
      title, domain, event_kind: eventKind,
      scheduled_at: scheduledAt,
      timezone,
      time_precision: resolveTimePrecision(scheduledAt),
      needs_time_confirmation: needsTimeConfirmation,
      raw_time_text: rawTimeText || null,
      status: 'PLANNED'
    },
    extracted_at: now.toISOString()
  };
}

// PATCH /life-events/{id} 与 confirm-edited 的字段校验。current 为当前受控
// 字段（部分字段可缺省继承）。返回 { ok, errors, value, domain_change_required }：
// - 未知字段直接报错（防拼写错误静默丢失修订）
// - domain 变更必须随请求携带 domain_change_confirmed=true（虚构↔现实归属
//   影响事件的可用性语义，方案 §4.1）
// - 清空 scheduled_at → time_precision 归 UNKNOWN 且 clarification_required
//   置 true（无日期的现实事件必须回头补时间，不静默变成"随时"）
function validateLifeEventRevisionFields(patch, { current = {} } = {}) {
  const errors = [];
  const source = patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {};
  const unknownFields = Object.keys(source).filter((key) => !LIFE_EVENT_REVISION_FIELDS.includes(key));
  for (const field of unknownFields) errors.push({ field, reason: '不是可修订字段' });

  const merged = {
    title: current.title ?? '',
    event_kind: current.event_kind ?? 'OTHER',
    domain: current.domain ?? 'REAL_LIFE',
    scheduled_at: current.scheduled_at ?? null,
    timezone: current.timezone ?? null,
    time_precision: current.time_precision ?? 'UNKNOWN',
    status: current.status ?? 'PLANNED',
    clarification_required: current.clarification_required ?? false
  };

  if (source.title !== undefined) {
    const title = typeof source.title === 'string' ? source.title.trim() : '';
    if (!title) errors.push({ field: 'title', reason: '不能为空' });
    else if (title.length > LIFE_EVENT_TITLE_MAX) errors.push({ field: 'title', reason: `不能超过 ${LIFE_EVENT_TITLE_MAX} 字` });
    else merged.title = title;
  }
  if (source.event_kind !== undefined && source.event_kind !== null) {
    if (!LIFE_EVENT_KINDS.includes(source.event_kind)) errors.push({ field: 'event_kind', reason: `只能是 ${LIFE_EVENT_KINDS.join('/')}` });
    else merged.event_kind = source.event_kind;
  }
  if (source.domain !== undefined && source.domain !== null) {
    if (!LIFE_EVENT_DOMAINS.includes(source.domain)) errors.push({ field: 'domain', reason: `只能是 ${LIFE_EVENT_DOMAINS.join('/')}` });
    else merged.domain = source.domain;
  }
  if (source.scheduled_at !== undefined) {
    if (source.scheduled_at === null || source.scheduled_at === '') {
      merged.scheduled_at = null;
      merged.time_precision = 'UNKNOWN';
      merged.clarification_required = true; // 清空日期 = 需要回头补时间
    } else if (!isParseableDate(source.scheduled_at)) {
      errors.push({ field: 'scheduled_at', reason: '必须是可解析的日期时间' });
    } else {
      merged.scheduled_at = new Date(source.scheduled_at).toISOString();
      merged.time_precision = resolveTimePrecision(source.scheduled_at);
      // 补全确切日期即解除"待补时间"标记（除非请求显式要求保留）。
      if (source.clarification_required === undefined) merged.clarification_required = false;
    }
  }
  if (source.timezone !== undefined) {
    if (source.timezone === null || source.timezone === '') merged.timezone = null;
    else if (!isValidIanaTimezone(source.timezone)) errors.push({ field: 'timezone', reason: '必须是有效的 IANA 时区' });
    else merged.timezone = source.timezone;
  }
  if (source.time_precision !== undefined && source.time_precision !== null) {
    if (!LIFE_EVENT_TIME_PRECISIONS.includes(source.time_precision)) errors.push({ field: 'time_precision', reason: `只能是 ${LIFE_EVENT_TIME_PRECISIONS.join('/')}` });
    else merged.time_precision = source.time_precision;
  }
  if (source.status !== undefined && source.status !== null) {
    if (!LIFE_EVENT_STATUSES.includes(source.status)) errors.push({ field: 'status', reason: `只能是 ${LIFE_EVENT_STATUSES.join('/')}` });
    else merged.status = source.status;
  }
  if (source.clarification_required !== undefined) {
    if (typeof source.clarification_required !== 'boolean') errors.push({ field: 'clarification_required', reason: '必须是布尔值' });
    else merged.clarification_required = source.clarification_required;
  }

  const domainChanged = source.domain !== undefined && source.domain !== null && source.domain !== (current.domain ?? 'REAL_LIFE');
  const domainChangeRequired = domainChanged && source.domain_change_confirmed !== true;
  if (domainChangeRequired) errors.push({ field: 'domain_change_confirmed', reason: '变更现实/虚构归属需显式确认' });

  if (errors.length > 0) return { ok: false, errors, value: null, domain_change_required: domainChangeRequired };
  return { ok: true, errors: [], value: merged, domain_change_required: false };
}

module.exports = {
  LIFE_EVENT_DOMAINS, LIFE_EVENT_KINDS, LIFE_EVENT_STATUSES, LIFE_EVENT_TIME_PRECISIONS,
  LIFE_EVENT_TITLE_MAX, LIFE_EVENT_REVISION_FIELDS, ORGANIZATION_NAME_PATTERN,
  isValidIanaTimezone, resolveTimePrecision, sanitizeLifeEventTitle,
  validateLifeEventCandidateOutput, validateLifeEventRevisionFields
};

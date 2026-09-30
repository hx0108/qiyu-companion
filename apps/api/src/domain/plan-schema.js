'use strict';

// 六项能力 A3（方案 §4.4）：共同计划的受控字段校验层。计划建议不自动成为
// 用户承诺——模型只产草案候选，类型、时长与依赖由代码限制；医疗、危机、
// 法律或财务决策不纳入普通计划（首批只有面试模板，无对应模板即结构性排除）。

// 首批唯一模板：面试准备。新增阅读/创作模板必须各有独立场景评测后才开放。
const PLAN_TEMPLATES = Object.freeze({
  INTERVIEW_PREP_V1: Object.freeze({
    template_version: 'INTERVIEW_PREP_V1',
    title_max: 80,
    // 模型失败时的固定三步兜底草案（可编辑；接受前不建立计划）。
    fallback_steps: Object.freeze([
      Object.freeze({ title: '练一次自我介绍（对着手机录 3 分钟）', estimated_minutes: 20 }),
      Object.freeze({ title: '梳理这段经历里最想讲的两个故事', estimated_minutes: 30 }),
      Object.freeze({ title: '准备 3 个想问对方的问题', estimated_minutes: 15 })
    ])
  })
});
// 支持方式三选（§4.4）：陪练 / 拆步骤 / 只听我说。只听模式不生成待办。
const SUPPORT_MODES = Object.freeze(['PRACTICE_TOGETHER', 'BREAK_DOWN_STEPS', 'LISTEN_ONLY']);
const SUPPORT_MODE_LABELS = Object.freeze({ PRACTICE_TOGETHER: '一起陪练', BREAK_DOWN_STEPS: '拆成小步骤', LISTEN_ONLY: '只听我说' });
const PLAN_STEP_MIN = 1;
const PLAN_STEP_MAX = 5;
const STEP_TITLE_MAX = 80;
const PLAN_TITLE_MAX = 80;
const STEP_MINUTES_MIN = 5;
const STEP_MINUTES_MAX = 180;
// 草案过期：最长 30 天（§6.3 未接受计划草案）。惰性裁决——读只标注，
// accept 时硬拒（读路径不写库）。
const DRAFT_TTL_DAYS = 30;

function httpError(status, code, message, details) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  error.expose = true;
  if (details) error.details = details;
  return error;
}

// 文本防线（与卡片一致的最小集）：拒绝标记起始符、链接协议与控制字符。
// 卡片渲染的完整消毒在 artifact-card.sanitizeCardTextField；这里拒绝模型
// 提议输出携带任何 HTML/脚本/链接形态（§9.1「模型返回任意 HTML → 拒绝」）。
function containsUnsafeText(text) {
  const value = String(text ?? '');
  return value.includes('<') || /https?:\/\//i.test(value) || /javascript:/i.test(value) || /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(value);
}

function validateStepShape(step, errors, field) {
  if (!step || typeof step !== 'object') {
    errors.push({ field, reason: '步骤必须是对象' });
    return;
  }
  const title = typeof step.title === 'string' ? step.title.trim() : '';
  if (!title) errors.push({ field, reason: '步骤标题不能为空' });
  else if (title.length > STEP_TITLE_MAX) errors.push({ field, reason: `步骤标题不超过 ${STEP_TITLE_MAX} 字` });
  else if (containsUnsafeText(title)) errors.push({ field, reason: '步骤标题不允许 HTML、脚本或链接' });
  const minutes = step.estimated_minutes;
  if (minutes !== undefined && minutes !== null) {
    if (!Number.isInteger(minutes) || minutes < STEP_MINUTES_MIN || minutes > STEP_MINUTES_MAX) {
      errors.push({ field, reason: `预计时长须为 ${STEP_MINUTES_MIN}-${STEP_MINUTES_MAX} 分钟` });
    }
  }
}

// POST /companion-plans 请求校验：模板白名单、支持方式、事件归属（可选）。
// 事件可空（§4.4「没有事件也可由用户新建」）；available_minutes 只做提示
// 参考，不据此裁剪步骤数（草案可编辑）。
function validatePlanDraftRequest(raw, { event = null } = {}) {
  const errors = [];
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const template = PLAN_TEMPLATES[source.template_version];
  if (!template) errors.push({ field: 'template_version', reason: `只能是 ${Object.keys(PLAN_TEMPLATES).join('/')}` });
  const supportMode = source.support_mode;
  if (!SUPPORT_MODES.includes(supportMode)) errors.push({ field: 'support_mode', reason: `只能是 ${SUPPORT_MODES.join('/')}` });
  if (event != null && (typeof event !== 'object' || event.deleted_at)) {
    errors.push({ field: 'event_id', reason: '事件不存在或已删除' });
  }
  if (event != null && event.status === 'CANCELLED') {
    errors.push({ field: 'event_id', reason: '已取消的事件不能再开准备计划' });
  }
  if (Number.isInteger(source.available_minutes) && (source.available_minutes < 0 || source.available_minutes > 1440)) {
    errors.push({ field: 'available_minutes', reason: '可用时间须为 0-1440 分钟' });
  }
  if (errors.length > 0) return { ok: false, errors, value: null };
  return {
    ok: true,
    errors: [],
    value: { template_version: source.template_version, support_mode: supportMode, event_id: event ? event.event_id : null, available_minutes: Number.isInteger(source.available_minutes) ? source.available_minutes : null }
  };
}

// 模型提议输出校验（plan-composer 模型槽）：{ title, steps:[{title, estimated_minutes}] }。
// 步骤数 1-5、长度/时长受限、不得携带 HTML/脚本/链接。只听模式不调用模型，
// 不会出现 steps=[] 的提议输出。
function validatePlanProposalOutput(raw) {
  const errors = [];
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const title = typeof source.title === 'string' ? source.title.trim() : '';
  if (!title) errors.push({ field: 'title', reason: '标题不能为空' });
  else if (title.length > PLAN_TITLE_MAX) errors.push({ field: 'title', reason: `标题不超过 ${PLAN_TITLE_MAX} 字` });
  else if (containsUnsafeText(title)) errors.push({ field: 'title', reason: '标题不允许 HTML、脚本或链接' });
  if (!Array.isArray(source.steps)) errors.push({ field: 'steps', reason: 'steps 必须是数组' });
  else if (source.steps.length < PLAN_STEP_MIN || source.steps.length > PLAN_STEP_MAX) {
    errors.push({ field: 'steps', reason: `步骤数须为 ${PLAN_STEP_MIN}-${PLAN_STEP_MAX}` });
  } else {
    source.steps.forEach((step, index) => validateStepShape(step, errors, `steps[${index}]`));
  }
  if (errors.length > 0) return { ok: false, errors, value: null };
  return {
    ok: true,
    errors: [],
    value: {
      title,
      steps: source.steps.map((step) => ({ title: step.title.trim(), estimated_minutes: Number.isInteger(step.estimated_minutes) ? step.estimated_minutes : null }))
    }
  };
}

// PATCH /companion-plans/{id}/steps/{stepId} 字段白名单：标题/时长/状态。
// expected_version 是计划的聚合锁（解构在路由层，不进白名单）。
function validateStepPatch(raw) {
  const errors = [];
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const patch = {};
  if (source.title !== undefined) {
    const title = typeof source.title === 'string' ? source.title.trim() : '';
    if (!title) errors.push({ field: 'title', reason: '标题不能为空' });
    else if (title.length > STEP_TITLE_MAX) errors.push({ field: 'title', reason: `标题不超过 ${STEP_TITLE_MAX} 字` });
    else if (containsUnsafeText(title)) errors.push({ field: 'title', reason: '标题不允许 HTML、脚本或链接' });
    else patch.title = title;
  }
  if (source.estimated_minutes !== undefined) {
    if (source.estimated_minutes === null) patch.estimated_minutes = null;
    else if (!Number.isInteger(source.estimated_minutes) || source.estimated_minutes < STEP_MINUTES_MIN || source.estimated_minutes > STEP_MINUTES_MAX) {
      errors.push({ field: 'estimated_minutes', reason: `预计时长须为 ${STEP_MINUTES_MIN}-${STEP_MINUTES_MAX} 分钟或留空` });
    } else patch.estimated_minutes = source.estimated_minutes;
  }
  if (source.state !== undefined) {
    if (!['TODO', 'DONE', 'SKIPPED'].includes(source.state)) errors.push({ field: 'state', reason: '只能是 TODO/DONE/SKIPPED' });
    else patch.state = source.state;
  }
  if (errors.length > 0) return { ok: false, errors, value: null };
  return { ok: true, errors: [], value: patch };
}

// POST /{id}/accept 请求校验：expected_version + 可选 followup 子对象。
// followup 子对象复用 validateFollowupGrantRequest 全部规则（due_at 缺省
// 派生、不补发过时、BEFORE_EVENT 要求 PLANNED）——接受计划开提醒与单独
// 开提醒走同一套裁决，不因为是计划附带的就放松。
function validateAcceptRequest(raw, { event, now = new Date() } = {}) {
  const errors = [];
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  if (!Number.isInteger(source.expected_version) || source.expected_version < 1) {
    errors.push({ field: 'expected_version', reason: '必须是正整数' });
  }
  let followup = null;
  if (source.followup !== undefined && source.followup !== null) {
    const { validateFollowupGrantRequest } = require('./followup-schema');
    const validation = validateFollowupGrantRequest(source.followup, { event, now });
    if (!validation.ok) {
      for (const item of validation.errors) errors.push({ field: `followup.${item.field}`, reason: item.reason });
    } else {
      followup = validation.value;
    }
  }
  if (errors.length > 0) return { ok: false, errors, value: null };
  return { ok: true, errors: [], value: { expected_version: source.expected_version, followup } };
}

module.exports = {
  PLAN_TEMPLATES, SUPPORT_MODES, SUPPORT_MODE_LABELS,
  PLAN_STEP_MIN, PLAN_STEP_MAX, PLAN_TITLE_MAX, STEP_TITLE_MAX,
  STEP_MINUTES_MIN, STEP_MINUTES_MAX, DRAFT_TTL_DAYS,
  containsUnsafeText, httpError,
  validatePlanDraftRequest, validatePlanProposalOutput, validateStepPatch, validateAcceptRequest
};

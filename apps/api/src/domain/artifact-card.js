'use strict';

// 六项能力 A3（方案 §4.5）：交互成果卡片——事件/计划的视图，不存第二份
// 可编辑事实。固定组件 EVENT_V1/PLAN_V1/READING_LOG_V1 由本模块现场渲染；
// 只允许文本、受控步骤和服务端动作 ID，拒绝 HTML、脚本、任意链接、未知
// 动作与跨账户引用（归属校验在路由 ownArtifact，这里只校验内容与动作）。

const CARD_TYPES = Object.freeze(['EVENT_V1', 'PLAN_V1', 'READING_LOG_V1']);
const SOURCE_TYPES = Object.freeze(['LIFE_EVENT', 'COMPANION_PLAN']);
const CARD_TEXT_MAX = 200;

// 动作白名单：每个动作映射真实路由（前端按钮只带动作 ID，method+path 由
// 服务端计算——模型与客户端都不能发明路由）。可用集按 source 状态收敛。
const CARD_ACTIONS = Object.freeze({
  OPEN_EVENT: Object.freeze({ method: 'GET', path: '/api/v1/life-events/{id}' }),
  OPEN_PLAN: Object.freeze({ method: 'GET', path: '/api/v1/companion-plans/{id}' }),
  ACCEPT_PLAN: Object.freeze({ method: 'POST', path: '/api/v1/companion-plans/{id}/accept' }),
  PAUSE_PLAN: Object.freeze({ method: 'POST', path: '/api/v1/companion-plans/{id}/pause' }),
  RESUME_PLAN: Object.freeze({ method: 'POST', path: '/api/v1/companion-plans/{id}/resume' }),
  CANCEL_PLAN: Object.freeze({ method: 'POST', path: '/api/v1/companion-plans/{id}/cancel' }),
  COMPLETE_PLAN: Object.freeze({ method: 'POST', path: '/api/v1/companion-plans/{id}/complete' })
});

// 文本消毒（§4.5「服务器拒绝 HTML、脚本、任意链接」）：出现在卡片文本里的
// 标记起始符、链接协议与控制字符一律拒绝整张卡——不是转义后放行。宁可不
// 渲染，不渲染出可执行结构。
function sanitizeCardTextField(value, field) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return { ok: false, reason: `${field} 不能为空` };
  if (text.length > CARD_TEXT_MAX) return { ok: false, reason: `${field} 超过 ${CARD_TEXT_MAX} 字` };
  if (text.includes('<') || /https?:\/\//i.test(text) || /javascript:/i.test(text) || /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(text)) {
    return { ok: false, reason: `${field} 不允许 HTML、脚本或链接` };
  }
  return { ok: true, value: text };
}

function sanitizeCardSteps(steps) {
  if (!Array.isArray(steps) || steps.length === 0) return { ok: false, reason: 'steps 不能为空' };
  if (steps.length > 5) return { ok: false, reason: 'steps 最多 5 项' };
  const cleaned = [];
  for (const step of steps) {
    const title = sanitizeCardTextField(step?.title, '步骤标题');
    if (!title.ok) return title;
    if (step.estimated_minutes !== undefined && step.estimated_minutes !== null
      && (!Number.isInteger(step.estimated_minutes) || step.estimated_minutes < 5 || step.estimated_minutes > 180)) {
      return { ok: false, reason: '步骤时长须为 5-180 分钟' };
    }
    if (!['TODO', 'DONE', 'SKIPPED'].includes(step.state)) return { ok: false, reason: '步骤状态只能是 TODO/DONE/SKIPPED' };
    cleaned.push({ step_id: step.step_id, title: title.value, estimated_minutes: step.estimated_minutes ?? null, state: step.state });
  }
  return { ok: true, value: cleaned };
}

// —— 三个固定组件的构建（从 source 现场渲染）——

// EVENT_V1：任意已确认生活事件的卡片视图。虚构域事件带 FICTIONAL_SHARED
// 标签（不伪装成现实经历）。
function buildEventCard({ card, event } = {}) {
  const title = sanitizeCardTextField(event?.title, '事件标题');
  if (!title.ok) return { ok: false, reason: title.reason };
  return {
    ok: true,
    value: {
      schema_version: 'EVENT_V1',
      artifact_id: card.artifact_id,
      type: 'EVENT_V1',
      source: { type: 'LIFE_EVENT', id: event.event_id, version: event.version },
      title: title.value,
      domain: event.domain,
      status: event.status,
      scheduled_at: event.scheduled_at ?? null,
      timezone: event.timezone ?? null,
      fictional: event.domain === 'FICTIONAL_SHARED',
      actions: eventCardActions(event)
    }
  };
}

function eventCardActions(event) {
  const actions = ['OPEN_EVENT'];
  // 事件卡只读展示；对绑定计划的入口在时间线条目上（计划状态驱动），不在
  // 事件卡上发明计划动作。
  return actions;
}

// READING_LOG_V1：共同阅读记录（source 也是事件，event_kind=READING）。
function buildReadingLogCard({ card, event } = {}) {
  const title = sanitizeCardTextField(event?.title, '阅读标题');
  if (!title.ok) return { ok: false, reason: title.reason };
  return {
    ok: true,
    value: {
      schema_version: 'READING_LOG_V1',
      artifact_id: card.artifact_id,
      type: 'READING_LOG_V1',
      source: { type: 'LIFE_EVENT', id: event.event_id, version: event.version },
      title: title.value,
      status: event.status,
      scheduled_at: event.scheduled_at ?? null,
      note: '共同阅读记录是事件视图；阅读感想如需保存为独立内容须单独确认并纳入资产保留规则。',
      actions: eventCardActions(event)
    }
  };
}

// PLAN_V1：计划卡片（草案与进行中都用同一组件，actions 按状态收敛）。
function buildPlanCard({ card, plan, steps = [] } = {}) {
  const title = sanitizeCardTextField(plan?.title, '计划标题');
  if (!title.ok) return { ok: false, reason: title.reason };
  const cleanedSteps = sanitizeCardSteps(steps);
  if (!cleanedSteps.ok) return { ok: false, reason: cleanedSteps.reason };
  return {
    ok: true,
    value: {
      schema_version: 'PLAN_V1',
      artifact_id: card.artifact_id,
      type: 'PLAN_V1',
      source: { type: 'COMPANION_PLAN', id: plan.plan_id, version: plan.version },
      title: title.value,
      plan_state: plan.state,
      support_mode: plan.support_mode,
      steps: cleanedSteps.value,
      actions: planCardActions(plan)
    }
  };
}

function planCardActions(plan) {
  // 动作可用集按计划状态收敛：草案只有接受（编辑走计划页）；进行中可暂停/
  // 完成/取消；暂停可恢复/取消；终态只剩查看。
  if (plan.state === 'DRAFT') return ['OPEN_PLAN', 'ACCEPT_PLAN'];
  if (plan.state === 'ACTIVE') return ['OPEN_PLAN', 'PAUSE_PLAN', 'COMPLETE_PLAN', 'CANCEL_PLAN'];
  if (plan.state === 'PAUSED') return ['OPEN_PLAN', 'RESUME_PLAN', 'CANCEL_PLAN'];
  return ['OPEN_PLAN'];
}

// 未知动作拒绝（渲染前与导出前都过这道）。
function validateCardActions(actions) {
  if (!Array.isArray(actions) || actions.length === 0) return { ok: false, reason: '卡片必须携带至少一个动作' };
  for (const action of actions) {
    if (!CARD_ACTIONS[action]) return { ok: false, reason: `未知动作 ${String(action)}` };
  }
  return { ok: true, value: actions };
}

// —— 导出（Markdown；JSON 导出直接序列化卡片值）——
function renderCardMarkdown(card) {
  if (!card || typeof card !== 'object') return '';
  const lines = [`# ${card.title ?? ''}`, '', `- 类型：${card.type}`, `- 来源：${card.source?.type} v${card.source?.version ?? '?'}`];
  if (card.type === 'EVENT_V1' || card.type === 'READING_LOG_V1') {
    lines.push(`- 状态：${card.status ?? ''}`);
    if (card.scheduled_at) lines.push(`- 时间：${card.scheduled_at}`);
    if (card.fictional) lines.push('- 归属：共同虚构（非现实经历）');
  }
  if (card.type === 'PLAN_V1') {
    lines.push(`- 计划状态：${card.plan_state ?? ''}`);
    if (Array.isArray(card.steps) && card.steps.length > 0) {
      lines.push('', '## 步骤');
      for (const step of card.steps) {
        const mark = step.state === 'DONE' ? 'x' : step.state === 'SKIPPED' ? '-' : ' ';
        const minutes = step.estimated_minutes ? `（约 ${step.estimated_minutes} 分钟）` : '';
        lines.push(`- [${mark}] ${step.title}${minutes}`);
      }
    }
  }
  if (card.note) lines.push('', `> ${card.note}`);
  lines.push('', '---', '由栖语导出；卡片是事件/计划的视图，内容以应用内当前状态为准。');
  return lines.join('\n');
}

module.exports = {
  CARD_TYPES, SOURCE_TYPES, CARD_ACTIONS, CARD_TEXT_MAX,
  sanitizeCardTextField, sanitizeCardSteps, validateCardActions,
  buildEventCard, buildReadingLogCard, buildPlanCard, renderCardMarkdown
};

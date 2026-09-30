'use strict';

const { PLAN_TEMPLATES, DRAFT_TTL_DAYS, httpError } = require('./plan-schema');
const { grantFollowup, revokeFollowupGrantById } = require('./followup-service');
const { recordOperationMetric } = require('./operation-metrics');

// 六项能力 A3（方案 §4.4）：共同计划的投影唯一写者。除本模块外任何代码
// 不得写 store.companionPlans / store.companionPlanSteps / store.artifactCards。
// 计划建议不自动成为用户承诺：createPlanDraft 只产 DRAFT；accept 才建立
// 计划，且接受不自动授权提醒——followup 子对象单独校验并走 A2 grantFollowup。
// 暂停原子撤销 linked 许可（只撤那一条，不碰同事件上用户独立开启的提醒）；
// 恢复只提示重新开启、不补发。事件联动由 app.js 路由层在修订/删除成功后
// 同事务调用（不进 life-event-service，尊重其投影唯一写者头注）。

const PLAN_NON_TERMINAL_STATES = Object.freeze(['DRAFT', 'ACTIVE', 'PAUSED']);

function findPlan(store, accountId, planId) {
  const plan = store.companionPlans.get(planId);
  return plan && plan.account_id === accountId ? plan : null;
}

function planSteps(store, planId) {
  return [...store.companionPlanSteps.values()]
    .filter((step) => step.plan_id === planId)
    .sort((left, right) => left.step_order - right.step_order);
}

function isDraftExpired(plan, now = new Date()) {
  return plan.state === 'DRAFT' && plan.expires_at != null && new Date(plan.expires_at).getTime() <= now.getTime();
}

// —— 卡片身份行（一源一卡，幂等）——
// 内容永不落库（GET /artifacts/{id} 现场渲染）；EVENT_V1/READING_LOG_V1 挂
// 事件确认路径、PLAN_V1 挂草案路径，均以 ARTIFACT_CARDS 开关守卫（关=不产卡）。
function ensureArtifactCard({ store, accountId, characterId, type, sourceType, sourceId, sourceVersion, now = new Date() } = {}) {
  const existing = [...store.artifactCards.values()].find((card) =>
    card.account_id === accountId && card.source_type === sourceType && card.source_id === sourceId);
  if (existing) return existing;
  const card = {
    artifact_id: store.next('art'), account_id: accountId, character_id: characterId ?? null,
    type, source_type: sourceType, source_id: sourceId, source_version: sourceVersion,
    schema_version: type, created_at: now.toISOString()
  };
  store.artifactCards.set(card.artifact_id, Object.freeze(card));
  return card;
}

// —— 草案创建 ——

// 模型/模板提议落成 DRAFT：同事件旧 DRAFT supersede（重复提案是正常操作，
// 不报错）；同事件已有 ACTIVE/PAUSED → 409（先暂停/取消再重新开始，不催促
// 完成也无并行计划）。无事件草案（event_id=null）不受唯一约束，可并存。
// 每次草案创建写一条 provider='companion-card' 聊天消息（卡片壳+附件），让
// 提议出现在对话里——但卡片只是视图，接受/编辑都在计划页或卡片动作上。
function createPlanDraft({ store, account, event = null, validated, proposal, createCard = true, now = new Date() } = {}) {
  if (event) {
    const open = [...store.companionPlans.values()].find((plan) =>
      plan.account_id === account.account_id && plan.event_id === event.event_id
      && (plan.state === 'ACTIVE' || plan.state === 'PAUSED'));
    if (open) {
      const error = httpError(409, 'PLAN_ALREADY_OPEN', '这件事已有一个进行中或暂停中的计划；先暂停或取消它，再重新开始');
      error.details = { current_plan: publicPlan(open, planSteps(store, open.plan_id)) };
      throw error;
    }
  }
  let superseded = 0;
  if (event) {
    for (const plan of store.companionPlans.values()) {
      if (plan.account_id === account.account_id && plan.event_id === event.event_id && plan.state === 'DRAFT') {
        store.companionPlans.set(plan.plan_id, Object.freeze({ ...plan, state: 'CANCELLED', state_reason: 'superseded', cancelled_at: now.toISOString(), version: plan.version + 1, updated_at: now.toISOString() }));
        superseded += 1;
      }
    }
  }
  const template = PLAN_TEMPLATES[validated.template_version] ?? PLAN_TEMPLATES.INTERVIEW_PREP_V1;
  const nowIso = now.toISOString();
  // 角色落点：事件绑定时取事件角色；无事件草案取账户当前 ACTIVE 角色
  //（account 域对象不携带 character_id，从 store 解析）。
  const characterId = event ? event.character_id : (typeof store.activeCharacter === 'function' ? store.activeCharacter(account.account_id)?.character_id ?? null : null);
  const plan = {
    plan_id: store.next('cpl'), account_id: account.account_id, character_id: characterId,
    event_id: event ? event.event_id : null, template_version: validated.template_version,
    support_mode: validated.support_mode, title: proposal.title,
    version: 1, state: 'DRAFT', linked_followup_grant_id: null, state_reason: null,
    expires_at: new Date(now.getTime() + DRAFT_TTL_DAYS * 86400000).toISOString(),
    accepted_at: null, paused_at: null, completed_at: null, cancelled_at: null,
    created_at: nowIso, updated_at: nowIso
  };
  store.companionPlans.set(plan.plan_id, Object.freeze(plan));
  proposal.steps.forEach((step, index) => {
    const stepRow = {
      step_id: store.next('cstep'), plan_id: plan.plan_id, account_id: account.account_id,
      step_order: index + 1, title: step.title, estimated_minutes: step.estimated_minutes ?? null,
      state: 'TODO', version: 1, created_at: nowIso, updated_at: nowIso
    };
    store.companionPlanSteps.set(stepRow.step_id, Object.freeze(stepRow));
  });
  // 卡片身份行 + 卡片消息（视图，不是第二份事实）；ARTIFACT_CARDS 关闭时
  // 不产卡（计划功能不受损，草案只在计划页可见）。
  let card = null;
  if (createCard) {
    card = ensureArtifactCard({ store, accountId: account.account_id, characterId, type: 'PLAN_V1', sourceType: 'COMPANION_PLAN', sourceId: plan.plan_id, sourceVersion: 1, now });
    writePlanCardMessage({ store, accountId: account.account_id, plan, card, now });
  }
  recordOperationMetric(store, {
    accountId: account.account_id, capability: 'COMPANION_PLAN_PROPOSAL',
    provider: proposal.provider, modelVersion: proposal.model_version, outcome: 'COMPLETED'
  });
  return { plan, steps: planSteps(store, plan.plan_id), card, superseded: { drafts_cancelled: superseded } };
}

// 聊天内卡片消息（照 A2 主动消息的落点选择）：最新非删除会话，无则新建。
function writePlanCardMessage({ store, accountId, plan, card, now = new Date() } = {}) {
  let conversation = [...store.conversations.values()]
    .filter((item) => item.account_id === accountId && item.character_id === plan.character_id && item.status !== 'DELETED')
    .sort((left, right) => (left.created_at < right.created_at ? 1 : -1))[0];
  if (!conversation) {
    const conversationId = store.next('cnv');
    conversation = { conversation_id: conversationId, account_id: accountId, character_id: plan.character_id, status: 'OPEN', created_at: now.toISOString() };
    store.conversations.set(conversationId, conversation);
  }
  const message = {
    message_id: store.next('msg'), conversation_id: conversation.conversation_id, actor: 'ASSISTANT',
    text: `我拟了一份小计划：「${plan.title}」。还只是草案，你可以改，也可以不开始。`,
    provider: 'companion-card', model_version: 'companion-card-v1', ai_generated: false,
    attachments: [{ type: 'companion-card', artifact_id: card.artifact_id, card_type: card.type }],
    created_at: now.toISOString(),
    retention_expires_at: new Date(now.getTime() + (store.accounts.get(accountId)?.raw_interaction_retention_days ?? 90) * 86400000).toISOString()
  };
  store.messages.set(message.message_id, Object.freeze(message));
  return message;
}

// —— 状态机（五条 action 路由的域实现）——

function transitionPlan(store, plan, fromStates, patch, now = new Date()) {
  const current = store.companionPlans.get(plan.plan_id);
  if (!current || !fromStates.includes(current.state)) {
    const error = httpError(409, 'PLAN_STATE_CONFLICT', `当前状态 ${current?.state ?? '不存在'} 不允许此操作`);
    error.details = { current_plan: current ? publicPlan(current, planSteps(store, current.plan_id)) : null };
    throw error;
  }
  const next = Object.freeze({ ...current, ...patch, version: current.version + 1, updated_at: now.toISOString() });
  store.companionPlans.set(next.plan_id, next);
  return next;
}

function expectVersion(plan, expectedVersion, store) {
  if (expectedVersion !== plan.version) {
    const error = httpError(409, 'VERSION_CONFLICT', '计划版本冲突');
    error.details = { current_plan: publicPlan(plan, planSteps(store, plan.plan_id)) };
    throw error;
  }
}

// 接受草案：DRAFT→ACTIVE；可选 followup 子对象（已过 validateAcceptRequest
// 的全量裁决）单独走 A2 grantFollowup——接受计划 ≠ 自动开提醒，勾选才开。
function acceptPlan({ store, account, plan, validated, event = null, now = new Date() } = {}) {
  expectVersion(plan, validated.expected_version, store);
  if (isDraftExpired(plan, now)) {
    throw httpError(409, 'PLAN_DRAFT_EXPIRED', '草案已超过 30 天未接受；请让角色重新提议一份');
  }
  const accepted = transitionPlan(store, plan, ['DRAFT'], {
    state: 'ACTIVE', expires_at: null, accepted_at: now.toISOString(), state_reason: null
  }, now);
  let linkedGrant = null;
  if (validated.followup && event) {
    const granted = grantFollowup({ store, account, event, validated: validated.followup, now });
    linkedGrant = granted.grant;
    store.companionPlans.set(accepted.plan_id, Object.freeze({ ...accepted, linked_followup_grant_id: granted.grant ? granted.grant.grant_id : null }));
  }
  return { plan: store.companionPlans.get(accepted.plan_id), steps: planSteps(store, accepted.plan_id), linked_grant: linkedGrant };
}

// 暂停：ACTIVE→PAUSED，原子撤销 linked 许可（只撤这一条——同事件可能还有
// 用户独立开启的提醒，不归计划管）。恢复不补发，只提示重新选择。
function pausePlan({ store, plan, now = new Date() } = {}) {
  const paused = transitionPlan(store, plan, ['ACTIVE'], { state: 'PAUSED', paused_at: now.toISOString() }, now);
  let revoked = { grants_revoked: 0, jobs_cancelled: 0 };
  if (paused.linked_followup_grant_id) {
    revoked = revokeFollowupGrantById({ store, accountId: plan.account_id, grantId: paused.linked_followup_grant_id, now });
  }
  return { plan: store.companionPlans.get(paused.plan_id), steps: planSteps(store, paused.plan_id), followup_revoked: revoked };
}

// 恢复：PAUSED→ACTIVE。不重新授权提醒（用户决策：恢复时只展示重新开启
// 入口）；linked 记录随撤销清空，重开走事件卡/计划页的显式勾选。
function resumePlan({ store, plan, now = new Date() } = {}) {
  const resumed = transitionPlan(store, plan, ['PAUSED'], {
    state: 'ACTIVE', paused_at: null, linked_followup_grant_id: null
  }, now);
  return { plan: store.companionPlans.get(resumed.plan_id), steps: planSteps(store, resumed.plan_id), reminder_hint: '如需到期提醒，请重新开启（不补发暂停期间的提醒）' };
}

// 取消：任意非终态→CANCELLED；linked 许可一并撤销（计划没了，随计划开的
// 提醒也不该再发）。暂停/取消始终可用，不要求完成率。
function cancelPlan({ store, plan, now = new Date() } = {}) {
  const cancelled = transitionPlan(store, plan, PLAN_NON_TERMINAL_STATES, {
    state: 'CANCELLED', cancelled_at: now.toISOString()
  }, now);
  let revoked = { grants_revoked: 0, jobs_cancelled: 0 };
  if (cancelled.linked_followup_grant_id) {
    revoked = revokeFollowupGrantById({ store, accountId: plan.account_id, grantId: cancelled.linked_followup_grant_id, now });
  }
  return { plan: store.companionPlans.get(cancelled.plan_id), steps: planSteps(store, cancelled.plan_id), followup_revoked: revoked };
}

// 完成：要求步骤全部终态（DONE/SKIPPED）或用户显式 confirm——完成不按聊天
// 情绪自动判断（§4.4）。linked 许可保留：提醒绑定的是事件本身（A2 语义），
// 提前完成准备不等于事件消失，关提醒走事件卡。
function completePlan({ store, plan, confirm = false, now = new Date() } = {}) {
  const steps = planSteps(store, plan.plan_id);
  if (!confirm && steps.some((step) => step.state === 'TODO')) {
    throw httpError(409, 'PLAN_STEPS_PENDING', '还有未完成的步骤；全部完成/跳过后才能标记完成，或显式确认提前结束');
  }
  const completed = transitionPlan(store, plan, ['ACTIVE'], { state: 'COMPLETED', completed_at: now.toISOString() }, now);
  return { plan: store.companionPlans.get(completed.plan_id), steps: planSteps(store, completed.plan_id) };
}

// —— 步骤编辑（PATCH /{id}/steps/{stepId}；expected_version 是计划聚合锁）——
function patchPlanStep({ store, plan, stepId, expectedVersion, patch, now = new Date() } = {}) {
  expectVersion(plan, expectedVersion, store);
  const step = store.companionPlanSteps.get(stepId);
  if (!step || step.plan_id !== plan.plan_id) throw httpError(404, 'RESOURCE_NOT_FOUND', '步骤不存在');
  if (plan.state !== 'DRAFT' && plan.state !== 'ACTIVE') {
    const error = httpError(409, 'PLAN_STATE_CONFLICT', `当前状态 ${plan.state} 不允许编辑步骤`);
    error.details = { current_plan: publicPlan(plan, planSteps(store, plan.plan_id)) };
    throw error;
  }
  store.companionPlanSteps.set(stepId, Object.freeze({ ...step, ...patch, version: step.version + 1, updated_at: now.toISOString() }));
  const next = Object.freeze({ ...plan, version: plan.version + 1, updated_at: now.toISOString() });
  store.companionPlans.set(plan.plan_id, next);
  return { plan: next, step: store.companionPlanSteps.get(stepId) };
}

// —— 查询 ——

function listPlans({ store, accountId, eventId = null, now = new Date() } = {}) {
  return [...store.companionPlans.values()]
    .filter((plan) => plan.account_id === accountId && (eventId === null || plan.event_id === eventId))
    .sort((left, right) => (left.updated_at < right.updated_at ? 1 : -1))
    .map((plan) => publicPlan(plan, planSteps(store, plan.plan_id), { now }));
}

function getPlan({ store, accountId, planId, now = new Date() } = {}) {
  const plan = findPlan(store, accountId, planId);
  if (!plan) return null;
  return publicPlan(plan, planSteps(store, plan.plan_id), { now });
}

// —— 事件联动（app.js 路由层在修订/删除成功后同事务调用）——

// 事件转 CANCELLED：ACTIVE 计划→PAUSED（提示用户决定是否继续练习）；
// DRAFT→CANCELLED。linked 许可无需处理——修订本身已使旧版本许可失效
//（A2 invalidateFollowupsOnRevision 在同一路由先行执行）。
function pausePlansOnEventCancellation({ store, event, now = new Date() } = {}) {
  let paused = 0;
  let cancelled = 0;
  for (const plan of store.companionPlans.values()) {
    if (plan.account_id !== event.account_id || plan.event_id !== event.event_id) continue;
    if (plan.state === 'ACTIVE') {
      store.companionPlans.set(plan.plan_id, Object.freeze({ ...plan, state: 'PAUSED', paused_at: now.toISOString(), state_reason: 'event_cancelled', version: plan.version + 1, updated_at: now.toISOString() }));
      paused += 1;
    } else if (plan.state === 'DRAFT') {
      store.companionPlans.set(plan.plan_id, Object.freeze({ ...plan, state: 'CANCELLED', cancelled_at: now.toISOString(), state_reason: 'event_cancelled', version: plan.version + 1, updated_at: now.toISOString() }));
      cancelled += 1;
    }
  }
  return { plans_paused: paused, plans_cancelled: cancelled };
}

// 事件删除：派生计划非终态全 CANCELLED、卡片行清理（视图随源下线）；
// linked 许可已由 A2 revokeFollowupsOnDeletion 全量撤销（删除联动先行）。
function cleanupPlansOnEventDeletion({ store, event, now = new Date() } = {}) {
  let cancelled = 0;
  const planIds = [];
  for (const plan of store.companionPlans.values()) {
    if (plan.account_id !== event.account_id || plan.event_id !== event.event_id) continue;
    planIds.push(plan.plan_id);
    if (PLAN_NON_TERMINAL_STATES.includes(plan.state)) {
      store.companionPlans.set(plan.plan_id, Object.freeze({ ...plan, state: 'CANCELLED', cancelled_at: now.toISOString(), state_reason: 'event_deleted', version: plan.version + 1, updated_at: now.toISOString() }));
      cancelled += 1;
    }
  }
  let cardsRemoved = 0;
  for (const [artifactId, card] of store.artifactCards.entries()) {
    const isEventCard = card.source_type === 'LIFE_EVENT' && card.source_id === event.event_id;
    const isPlanCard = card.source_type === 'COMPANION_PLAN' && planIds.includes(card.source_id);
    if (card.account_id === event.account_id && (isEventCard || isPlanCard)) {
      store.artifactCards.delete(artifactId);
      cardsRemoved += 1;
    }
  }
  return { plans_cancelled: cancelled, cards_removed: cardsRemoved };
}

// —— 投影 ——

function publicPlan(plan, steps = [], { now = new Date() } = {}) {
  const projection = {
    plan_id: plan.plan_id, event_id: plan.event_id ?? null,
    template_version: plan.template_version, support_mode: plan.support_mode,
    title: plan.title, version: plan.version, state: plan.state,
    state_reason: plan.state_reason ?? null,
    expires_at: plan.expires_at ?? null,
    accepted_at: plan.accepted_at ?? null, paused_at: plan.paused_at ?? null,
    completed_at: plan.completed_at ?? null, cancelled_at: plan.cancelled_at ?? null,
    created_at: plan.created_at, updated_at: plan.updated_at,
    steps: steps.map(publicStep),
    reminder: plan.linked_followup_grant_id ? { linked_grant_id: plan.linked_followup_grant_id, regrant_available: plan.state === 'ACTIVE' || plan.state === 'PAUSED' } : null
  };
  if (isDraftExpired(plan, now)) projection.expired = true;
  return projection;
}

function publicStep(step) {
  return {
    step_id: step.step_id, step_order: step.step_order, title: step.title,
    estimated_minutes: step.estimated_minutes ?? null, state: step.state,
    version: step.version, created_at: step.created_at, updated_at: step.updated_at
  };
}

function publicArtifactCard(card) {
  return {
    artifact_id: card.artifact_id, type: card.type, source_type: card.source_type,
    source_id: card.source_id, source_version: card.source_version,
    schema_version: card.schema_version, created_at: card.created_at
  };
}

module.exports = {
  PLAN_NON_TERMINAL_STATES,
  findPlan, planSteps, isDraftExpired, ensureArtifactCard,
  createPlanDraft, acceptPlan, pausePlan, resumePlan, cancelPlan, completePlan,
  patchPlanStep, listPlans, getPlan,
  pausePlansOnEventCancellation, cleanupPlansOnEventDeletion,
  publicPlan, publicStep, publicArtifactCard
};

'use strict';
// 六项能力 A3：plan-service 状态机与联动单测。硬门禁锚点（§9.1/用户决策）：
// 计划建议不自动成为用户承诺（草案才建立）；接受不自动开提醒（勾选才走
// A2 grantFollowup）；暂停原子撤 linked 许可且不碰同事件独立许可；恢复不
// 补发；完成需步骤全终态或显式确认；事件取消→PAUSED/删→清理派生。
const test = require('node:test');
const assert = require('node:assert/strict');
const { DevelopmentStore } = require('../src/domain/store');
const {
  createPlanDraft, acceptPlan, pausePlan, resumePlan, cancelPlan, completePlan,
  patchPlanStep, listPlans, getPlan, ensureArtifactCard,
  pausePlansOnEventCancellation, cleanupPlansOnEventDeletion
} = require('../src/domain/plan-service');
const { validatePlanDraftRequest, validateAcceptRequest } = require('../src/domain/plan-schema');
const { grantFollowup } = require('../src/domain/followup-service');
const { validateFollowupGrantRequest } = require('../src/domain/followup-schema');

const ACCOUNT = 'acct_dev_alice';
const CHARACTER = 'char_1';
const NOW = new Date('2026-10-01T08:00:00.000Z');
const EVENT = { event_id: 'levt_1', account_id: ACCOUNT, character_id: CHARACTER, version: 1, timezone: 'Asia/Shanghai', clarification_required: false, status: 'PLANNED', scheduled_at: '2026-10-02T06:30:00.000Z', title: '周五的产品经理面试', deleted_at: null, domain: 'REAL_LIFE', event_kind: 'INTERVIEW' };

function freshStore() {
  const store = new DevelopmentStore({ accountIds: [ACCOUNT] });
  store.characters.set(CHARACTER, { character_id: CHARACTER, account_id: ACCOUNT, name: '栖夏', status: 'ACTIVE' });
  store.lifeEvents.set(EVENT.event_id, EVENT);
  return store;
}

const PROPOSAL = { title: '面试前，一起准备', steps: [
  { title: '练一次自我介绍', estimated_minutes: 20 },
  { title: '梳理两个故事', estimated_minutes: 30 },
  { title: '准备 3 个问题', estimated_minutes: 15 }
], provider: 'template', model_version: 'plan-template-v1' };

function draftRequest(overrides = {}) {
  return validatePlanDraftRequest({ template_version: 'INTERVIEW_PREP_V1', support_mode: 'PRACTICE_TOGETHER', ...overrides }, { event: EVENT }).value;
}

function acceptedWithFollowup(store, { dueAt = '2026-10-02T06:30:00.000Z' } = {}) {
  const created = createPlanDraft({ store, account: store.account(ACCOUNT), event: EVENT, validated: draftRequest(), proposal: PROPOSAL, now: NOW });
  const validated = validateAcceptRequest({ expected_version: created.plan.version, followup: { followup_kind: 'BEFORE_EVENT', due_at: dueAt } }, { event: EVENT, now: NOW }).value;
  return acceptPlan({ store, account: store.account(ACCOUNT), plan: created.plan, validated, event: EVENT, now: NOW });
}

test('plan-service: 草案创建只产 DRAFT + 卡片行 + 卡片消息；同事件重复提案 supersede 旧草案', () => {
  const store = freshStore();
  const first = createPlanDraft({ store, account: store.account(ACCOUNT), event: EVENT, validated: draftRequest(), proposal: PROPOSAL, now: NOW });
  assert.equal(first.plan.state, 'DRAFT');
  assert.equal(first.steps.length, 3);
  assert.equal(first.steps.map((step) => step.state).every((state) => state === 'TODO'), true);
  assert.ok(first.plan.expires_at, '草案带 30 天过期窗');
  // 卡片身份行 + 聊天卡片消息（视图）。
  const card = [...store.artifactCards.values()].find((item) => item.source_id === first.plan.plan_id);
  assert.ok(card && card.type === 'PLAN_V1');
  const cardMessage = [...store.messages.values()].find((message) => message.provider === 'companion-card');
  assert.ok(cardMessage, '草案创建写一条卡片消息');
  assert.deepEqual(cardMessage.attachments, [{ type: 'companion-card', artifact_id: card.artifact_id, card_type: 'PLAN_V1' }]);
  assert.equal(cardMessage.ai_generated, false);

  const second = createPlanDraft({ store, account: store.account(ACCOUNT), event: EVENT, validated: draftRequest(), proposal: PROPOSAL, now: NOW });
  assert.equal(second.superseded.drafts_cancelled, 1, '同事件旧 DRAFT 被 supersede（正常重提不报错）');
  assert.equal(getPlan({ store, accountId: ACCOUNT, planId: first.plan.plan_id }).state, 'CANCELLED');
});

test('plan-service: 同事件已有 ACTIVE/PAUSED 计划时新提案 409（无并行计划）', () => {
  const store = freshStore();
  acceptedWithFollowup(store);
  assert.throws(
    () => createPlanDraft({ store, account: store.account(ACCOUNT), event: EVENT, validated: draftRequest(), proposal: PROPOSAL, now: NOW }),
    (error) => error.code === 'PLAN_ALREADY_OPEN' && error.details?.current_plan?.state === 'ACTIVE'
  );
});

test('plan-service: accept 状态机——不带 followup 不产生任何许可（接受≠开提醒）；带 followup 落 linked 许可', () => {
  const store = freshStore();
  const created = createPlanDraft({ store, account: store.account(ACCOUNT), event: EVENT, validated: draftRequest(), proposal: PROPOSAL, now: NOW });
  const plain = acceptPlan({ store, account: store.account(ACCOUNT), plan: created.plan, validated: validateAcceptRequest({ expected_version: 1 }, { event: EVENT, now: NOW }).value, event: EVENT, now: NOW });
  assert.equal(plain.plan.state, 'ACTIVE');
  assert.equal(plain.plan.linked_followup_grant_id, null);
  assert.equal([...store.followupGrants.values()].length, 0, '不勾选提醒=零许可零任务');

  const store2 = freshStore();
  const outcome = acceptedWithFollowup(store2);
  assert.equal(outcome.plan.state, 'ACTIVE');
  assert.equal(outcome.linked_grant.state, 'ACTIVE');
  assert.equal(outcome.plan.linked_followup_grant_id, outcome.linked_grant.grant_id);
  const job = [...store2.followupJobs.values()][0];
  assert.equal(job.state, 'PENDING');
  assert.equal(job.event_id, EVENT.event_id);
});

test('plan-service: accept 版本冲突 409 回传 current_plan；草案过期 409', () => {
  const store = freshStore();
  const created = createPlanDraft({ store, account: store.account(ACCOUNT), event: EVENT, validated: draftRequest(), proposal: PROPOSAL, now: NOW });
  assert.throws(
    () => acceptPlan({ store, account: store.account(ACCOUNT), plan: created.plan, validated: validateAcceptRequest({ expected_version: 99 }, { event: EVENT, now: NOW }).value, event: EVENT, now: NOW }),
    (error) => error.code === 'VERSION_CONFLICT' && error.details?.current_plan?.version === 1
  );
  // 过期：读路径只标注（读不写库），accept 硬拒。
  const later = new Date(NOW.getTime() + 31 * 86400000);
  const projection = getPlan({ store, accountId: ACCOUNT, planId: created.plan.plan_id, now: later });
  assert.equal(projection.expired, true);
  assert.equal(store.companionPlans.get(created.plan.plan_id).state, 'DRAFT', '读路径不写库');
  assert.throws(
    () => acceptPlan({ store, account: store.account(ACCOUNT), plan: created.plan, validated: validateAcceptRequest({ expected_version: 1 }, { event: EVENT, now: later }).value, event: EVENT, now: later }),
    (error) => error.code === 'PLAN_DRAFT_EXPIRED'
  );
});

test('plan-service: 暂停原子撤 linked 许可（在途任务取消）且不碰同事件独立许可；恢复不补发', () => {
  const store = freshStore();
  const outcome = acceptedWithFollowup(store);
  // 用户在事件上独立开启的第二条许可（AFTER_EVENT）不归计划管。
  const independent = grantFollowup({
    store, account: store.account(ACCOUNT), event: EVENT,
    validated: validateFollowupGrantRequest({ followup_kind: 'AFTER_EVENT' }, { event: EVENT, now: NOW }).value, now: NOW
  });
  const paused = pausePlan({ store, plan: outcome.plan, now: NOW });
  assert.equal(paused.plan.state, 'PAUSED');
  assert.equal(paused.followup_revoked.grants_revoked, 1);
  assert.equal(paused.followup_revoked.jobs_cancelled, 1);
  assert.equal(store.followupGrants.get(outcome.linked_grant.grant_id).state, 'REVOKED', 'linked 许可撤销');
  assert.equal(store.followupGrants.get(independent.grant.grant_id).state, 'ACTIVE', '独立许可存活');
  const linkedJob = [...store.followupJobs.values()].find((job) => job.grant_id === outcome.linked_grant.grant_id);
  assert.equal(linkedJob.state, 'CANCELLED');

  const resumed = resumePlan({ store, plan: paused.plan, now: NOW });
  assert.equal(resumed.plan.state, 'ACTIVE');
  assert.equal(resumed.plan.linked_followup_grant_id, null, '恢复清空 linked 记录');
  assert.match(resumed.reminder_hint, /重新开启/);
  assert.equal([...store.followupJobs.values()].filter((job) => job.state === 'PENDING').length, 1, '不补发：只剩独立许可那条在途任务');
});

test('plan-service: 完成需步骤全终态或显式 confirm；取消任意非终态可用并撤 linked', () => {
  const store = freshStore();
  const outcome = acceptedWithFollowup(store);
  assert.throws(() => completePlan({ store, plan: outcome.plan, now: NOW }), (error) => error.code === 'PLAN_STEPS_PENDING');
  const done = completePlan({ store, plan: outcome.plan, confirm: true, now: NOW });
  assert.equal(done.plan.state, 'COMPLETED');
  assert.equal(store.followupGrants.get(outcome.linked_grant.grant_id).state, 'ACTIVE', '完成保留事件提醒（提醒绑定事件本身）');

  const store2 = freshStore();
  const outcome2 = acceptedWithFollowup(store2);
  const cancelled = cancelPlan({ store: store2, plan: outcome2.plan, now: NOW });
  assert.equal(cancelled.plan.state, 'CANCELLED');
  assert.equal(cancelled.followup_revoked.grants_revoked, 1, '取消随计划撤 linked 许可');

  const store3 = freshStore();
  const draft = createPlanDraft({ store: store3, account: store3.account(ACCOUNT), event: EVENT, validated: draftRequest(), proposal: PROPOSAL, now: NOW });
  assert.equal(cancelPlan({ store: store3, plan: draft.plan, now: NOW }).plan.state, 'CANCELLED', '草案也可直接取消');
});

test('plan-service: PATCH 步骤走计划聚合锁（expected_version=计划版本）并 bump 双版本；终态计划拒编辑', () => {
  const store = freshStore();
  const created = createPlanDraft({ store, account: store.account(ACCOUNT), event: EVENT, validated: draftRequest(), proposal: PROPOSAL, now: NOW });
  const patched = patchPlanStep({ store, plan: created.plan, stepId: created.steps[0].step_id, expectedVersion: 1, patch: { title: '改练英文自我介绍', state: 'DONE' }, now: NOW });
  assert.equal(patched.step.title, '改练英文自我介绍');
  assert.equal(patched.step.state, 'DONE');
  assert.equal(patched.plan.version, 2, '计划版本 bump');
  assert.equal(patched.step.version, 2, '步骤版本 bump');
  assert.throws(
    () => patchPlanStep({ store, plan: patched.plan, stepId: created.steps[1].step_id, expectedVersion: 1, patch: { state: 'DONE' }, now: NOW }),
    (error) => error.code === 'VERSION_CONFLICT', '旧计划版本拒绝'
  );
  assert.throws(
    () => patchPlanStep({ store, plan: patched.plan, stepId: 'nope', expectedVersion: 2, patch: { state: 'DONE' }, now: NOW }),
    (error) => error.status === 404, '伪造 stepId 404'
  );
  const accepted = acceptPlan({ store, account: store.account(ACCOUNT), plan: patched.plan, validated: validateAcceptRequest({ expected_version: 2 }, { event: EVENT, now: NOW }).value, event: EVENT, now: NOW });
  const cancelledPlan = cancelPlan({ store, plan: accepted.plan, now: NOW });
  assert.throws(
    () => patchPlanStep({ store, plan: cancelledPlan.plan, stepId: created.steps[1].step_id, expectedVersion: cancelledPlan.plan.version, patch: { state: 'DONE' }, now: NOW }),
    (error) => error.code === 'PLAN_STATE_CONFLICT', '终态计划拒编辑'
  );
});

test('plan-service: 只听模式不生成待办（steps 空、可接受、完成需 confirm）', () => {
  const store = freshStore();
  const created = createPlanDraft({
    store, account: store.account(ACCOUNT), event: EVENT,
    validated: draftRequest({ support_mode: 'LISTEN_ONLY' }),
    proposal: { title: '只听你说', steps: [], provider: 'template', model_version: 'plan-template-v1' }, now: NOW
  });
  assert.equal(created.steps.length, 0);
  const accepted = acceptPlan({ store, account: store.account(ACCOUNT), plan: created.plan, validated: validateAcceptRequest({ expected_version: 1 }, { event: EVENT, now: NOW }).value, event: EVENT, now: NOW });
  assert.equal(completePlan({ store, plan: accepted.plan, confirm: true, now: NOW }).plan.state, 'COMPLETED');
});

test('plan-service: 事件联动——转 CANCELLED 时 ACTIVE→PAUSED/DRAFT→CANCELLED；删除时非终态清理+卡片下线', () => {
  const store = freshStore();
  const outcome = acceptedWithFollowup(store);
  const draftForOther = createPlanDraft({
    store, account: store.account(ACCOUNT),
    event: { ...EVENT, event_id: 'levt_2', title: '读书' },
    validated: draftRequest(), proposal: PROPOSAL, now: NOW
  });
  const pauseOutcome = pausePlansOnEventCancellation({ store, event: EVENT, now: NOW });
  assert.equal(pauseOutcome.plans_paused, 1);
  assert.equal(store.companionPlans.get(outcome.plan.plan_id).state, 'PAUSED');
  assert.equal(store.companionPlans.get(outcome.plan.plan_id).state_reason, 'event_cancelled');
  assert.equal(store.companionPlans.get(draftForOther.plan.plan_id).state, 'DRAFT', '其他事件的计划不受影响');

  const cleanup = cleanupPlansOnEventDeletion({ store, event: EVENT, now: NOW });
  assert.equal(cleanup.plans_cancelled, 1, 'PAUSED 计划随事件删除清理');
  assert.equal(cleanup.cards_removed >= 1, true, '事件卡与派生计划卡下线');
  assert.equal([...store.artifactCards.values()].some((card) => card.source_id === EVENT.event_id), false, '事件卡不残留');
  assert.equal([...store.artifactCards.values()].some((card) => card.source_id === outcome.plan.plan_id), false, '计划卡不残留');
});

test('plan-service: ensureArtifactCard 幂等（一源一卡）；无事件草案取账户 ACTIVE 角色落点', () => {
  const store = freshStore();
  const account = store.account(ACCOUNT);
  const first = ensureArtifactCard({ store, accountId: ACCOUNT, characterId: CHARACTER, type: 'EVENT_V1', sourceType: 'LIFE_EVENT', sourceId: EVENT.event_id, sourceVersion: 1, now: NOW });
  const second = ensureArtifactCard({ store, accountId: ACCOUNT, characterId: CHARACTER, type: 'EVENT_V1', sourceType: 'LIFE_EVENT', sourceId: EVENT.event_id, sourceVersion: 2, now: NOW });
  assert.equal(first.artifact_id, second.artifact_id, '同源重放返回同一行');
  assert.equal([...store.artifactCards.values()].length, 1);

  const noEvent = createPlanDraft({ store, account, event: null, validated: validatePlanDraftRequest({ template_version: 'INTERVIEW_PREP_V1', support_mode: 'BREAK_DOWN_STEPS' }, { event: null }).value, proposal: PROPOSAL, now: NOW });
  assert.equal(noEvent.plan.event_id, null);
  assert.equal(noEvent.plan.character_id, CHARACTER, '无事件草案落 ACTIVE 角色上');
  assert.equal(listPlans({ store, accountId: ACCOUNT, now: NOW }).length, 1, '本 store 只有无事件草案一个计划');
});

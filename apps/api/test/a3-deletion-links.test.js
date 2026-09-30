'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { DevelopmentStore } = require('../src/domain/store');
const { runAccountDeletionCleanup, registerAccountDeletionTargets, deletionReceipt } = require('../src/domain/deletion-orchestration');
const { confirmLifeEventFromCandidate } = require('../src/domain/life-event-service');
const { createPlanDraft, acceptPlan, ensureArtifactCard } = require('../src/domain/plan-service');
const { validatePlanDraftRequest, validateAcceptRequest } = require('../src/domain/plan-schema');
const { grantFollowup } = require('../src/domain/followup-service');
const { validateFollowupGrantRequest } = require('../src/domain/followup-schema');
const { createApp } = require('../src/app');
const { parseDevFlags } = require('../src/development/dev-flags');
const { generateReply } = require('../src/domain/mock-adapter');

// A3 数据权利联动：注销账本覆盖七新域（含 A2 三域欠账补齐）、导出含
// A1/A2/A3 全部数据段、事件删除派生清理后导出无残留。

const ACCOUNT = 'acct_dev_alice';
const CHARACTER = 'char_1';
const NOW = new Date('2026-10-01T08:00:00.000Z');
const EVENT = { event_id: 'levt_1', account_id: ACCOUNT, character_id: CHARACTER, version: 1, timezone: 'Asia/Shanghai', clarification_required: false, status: 'PLANNED', scheduled_at: '2026-10-02T06:30:00.000Z', title: '周五的产品经理面试', deleted_at: null, domain: 'REAL_LIFE', event_kind: 'INTERVIEW' };

const PROPOSAL = { title: '面试前，一起准备', steps: [
  { title: '练一次自我介绍', estimated_minutes: 20 },
  { title: '梳理两个故事', estimated_minutes: 30 }
], provider: 'template', model_version: 'plan-template-v1' };

function seededStore() {
  const store = new DevelopmentStore({ accountIds: [ACCOUNT] });
  store.characters.set(CHARACTER, { character_id: CHARACTER, account_id: ACCOUNT, name: '栖夏', status: 'ACTIVE' });
  store.conversations.set('conv_1', { conversation_id: 'conv_1', account_id: ACCOUNT, character_id: CHARACTER, status: 'OPEN', created_at: '2026-01-01T00:00:00.000Z' });
  store.lifeEvents.set(EVENT.event_id, EVENT);
  // A2 域：一条许可+任务+槽位。
  grantFollowup({
    store, account: store.account(ACCOUNT), event: EVENT,
    validated: validateFollowupGrantRequest({ followup_kind: 'BEFORE_EVENT' }, { event: EVENT, now: NOW }).value, now: NOW
  });
  // A3 域：草案→接受、事件卡、显式审批行。
  const draft = createPlanDraft({
    store, account: store.account(ACCOUNT), event: EVENT,
    validated: validatePlanDraftRequest({ template_version: 'INTERVIEW_PREP_V1', support_mode: 'PRACTICE_TOGETHER' }, { event: EVENT }).value,
    proposal: PROPOSAL, now: NOW
  });
  acceptPlan({
    store, account: store.account(ACCOUNT), plan: draft.plan,
    validated: validateAcceptRequest({ expected_version: 1 }, { event: EVENT, now: NOW }).value, event: EVENT, now: NOW
  });
  ensureArtifactCard({ store, accountId: ACCOUNT, characterId: CHARACTER, type: 'EVENT_V1', sourceType: 'LIFE_EVENT', sourceId: EVENT.event_id, sourceVersion: 1, now: NOW });
  store.actionRequests.set('arq_1', { action_id: 'arq_1', account_id: ACCOUNT, character_id: CHARACTER, action_type: 'ACCEPT_PLAN', target_ref: draft.plan.plan_id, target_version: 1, parameters_digest: 'x', state: 'PROPOSED', expires_at: '2026-10-01T09:00:00.000Z', result_ref: null, failure_code: null, idempotency_key: 'k1', approved_at: null, executed_at: null, created_at: NOW.toISOString(), updated_at: NOW.toISOString() });
  return { store, planId: draft.plan.plan_id };
}

test('A3 注销账本：七新域（A2 三域欠账 + A3 四域）全部登记并 COMPLETED，数据清空', async () => {
  const { store } = seededStore();
  const account = store.account(ACCOUNT);
  account.account_status = 'CLOSING';
  const deletionJob = { deletion_job_id: 'del_1', account_id: ACCOUNT, scope: 'ACCOUNT', state: 'PENDING', physical_cleanup_state: null };
  store.deletionJobs.set('del_1', deletionJob);
  registerAccountDeletionTargets(store, account, deletionJob);
  await runAccountDeletionCleanup(store, account, deletionJob, { now: NOW });
  const receipt = deletionReceipt(store, deletionJob);
  for (const domain of ['FOLLOWUP_GRANTS', 'FOLLOWUP_JOBS', 'PROACTIVE_DAILY_SLOTS', 'COMPANION_PLANS', 'COMPANION_PLAN_STEPS', 'ARTIFACT_CARDS', 'ACTION_REQUESTS']) {
    const target = receipt.targets.find((item) => item.target_type === domain);
    assert.ok(target, `账本应含 ${domain}`);
    assert.equal(target.state, 'COMPLETED', `${domain} 应完成`);
  }
  assert.equal(store.followupGrants.size, 0);
  assert.equal(store.followupJobs.size, 0);
  assert.equal(store.companionPlans.size, 0);
  assert.equal(store.companionPlanSteps.size, 0);
  assert.equal(store.artifactCards.size, 0);
  assert.equal(store.actionRequests.size, 0);
  assert.equal([...store.proactiveDailySlots.keys()].length, 0);
  assert.equal(deletionJob.state, 'COMPLETED');
});

test('A3 关系档案导出：含 life_events/followups/companion_plans/artifact_cards/action_requests 五段', async (t) => {
  const { store } = seededStore();
  const app = createApp({ store, replyGenerator: generateReply, devFlags: parseDevFlags({ QIYU_DEV_FLAGS: 'LIFE_EVENTS' }) });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { app.closeAllConnections(); app.close(resolve); }));
  const headers = { authorization: 'Bearer dev-alice-token' };
  const response = await fetch(`http://127.0.0.1:${app.address().port}/api/v1/data-exports/relationship-profile`, { headers });
  assert.equal(response.status, 200);
  const exported = (await response.json()).export;
  assert.equal(exported.life_events.length, 1);
  assert.equal(exported.followups.grants.length, 1);
  assert.equal(exported.companion_plans.length, 1);
  assert.equal(exported.companion_plans[0].steps.length, 2, '计划导出含步骤');
  assert.equal(exported.artifact_cards.length, 2, '事件卡+计划卡');
  assert.equal(exported.action_requests.length, 1);
  assert.equal(JSON.stringify(exported.action_requests).includes('parameters'), false, '审批导出无参数正文');
});

test('A3 事件删除派生清理后导出无残留内容（删除回执含 plans_cleaned_up）', async (t) => {
  const { store, planId } = seededStore();
  // 直改账户准入状态（告知已展示+年龄通过），免去 HTTP 准备旅程。
  store.account(ACCOUNT).required_notice.state = 'DISPLAYED';
  store.account(ACCOUNT).required_notice.displayed_at = NOW.toISOString();
  store.account(ACCOUNT).age_status = 'AGE_PASS';
  const app = createApp({ store, replyGenerator: generateReply, devFlags: parseDevFlags({ QIYU_DEV_FLAGS: 'LIFE_EVENTS,COMPANION_PLANS,ARTIFACT_CARDS' }) });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { app.closeAllConnections(); app.close(resolve); }));
  const base = `http://127.0.0.1:${app.address().port}`;
  const headers = { authorization: 'Bearer dev-alice-token', 'content-type': 'application/json' };
  const deletion = await fetch(`${base}/api/v1/life-events/${EVENT.event_id}`, { method: 'DELETE', headers: { ...headers, 'idempotency-key': 'del' } });
  const deletionBody = await deletion.json();
  assert.equal(deletion.status, 202);
  assert.equal(deletionBody.plans_cleaned_up.plans_cancelled, 1);
  assert.equal(deletionBody.plans_cleaned_up.cards_removed, 2, '事件卡+计划卡随源下线');
  const exportResponse = await fetch(`${base}/api/v1/data-exports/relationship-profile`, { headers });
  const exported = (await exportResponse.json()).export;
  assert.equal(exported.life_events.length, 0, '删除后导出无事件');
  assert.equal(exported.companion_plans.find((plan) => plan.plan_id === planId).state, 'CANCELLED', '计划终态保留（确认事实留痕）但卡片已下线');
  assert.equal(exported.artifact_cards.length, 0, '删除后导出无卡片');
});

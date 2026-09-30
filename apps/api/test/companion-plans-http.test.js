'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { DevelopmentStore } = require('../src/domain/store');
const { parseDevFlags } = require('../src/development/dev-flags');
const { generateReply } = require('../src/domain/mock-adapter');
const { confirmLifeEventFromCandidate } = require('../src/domain/life-event-service');

// A3 HTTP 旅程：草案（不建立计划不开提醒）→ 编辑步骤 → 接受（可选 followup）
// → 暂停/恢复/完成/取消 → 卡片视图与导出 → 显式审批入口（白名单/15 分钟/
// digest 重验）→ 事件联动（取消→PAUSED、删除→派生清理）→ 开关门禁 404。

const FLAGS = parseDevFlags({ QIYU_DEV_FLAGS: 'LIFE_EVENTS,MEMORY_REFERENCES,FOLLOWUP_DISPATCH,COMPANION_PLANS,ARTIFACT_CARDS,ACTION_EXECUTION' });

async function startServer(flags = FLAGS) {
  const store = new DevelopmentStore();
  const app = createApp({ store, devFlags: flags, replyGenerator: generateReply });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.address().port}`;
  const headers = { authorization: 'Bearer dev-alice-token', 'content-type': 'application/json' };
  const notices = await (await fetch(`${base}/api/v1/required-notices`, { headers })).json();
  const notice = notices.notices[0];
  await fetch(`${base}/api/v1/required-notices/${notice.notice_id}/displayed`, { method: 'POST', headers: { ...headers, 'idempotency-key': 'n' }, body: JSON.stringify({ notice_version: notice.notice_version }) });
  await fetch(`${base}/api/v1/age/declarations`, { method: 'POST', headers: { ...headers, 'idempotency-key': 'a' }, body: JSON.stringify({ date_of_birth: '1990-01-01', confirmed_18_plus: true }) });
  const character = (await (await fetch(`${base}/api/v1/characters`, { method: 'POST', headers: { ...headers, 'idempotency-key': 'c' }, body: JSON.stringify({ name: '栖夏' }) })).json()).character;
  await fetch(`${base}/api/v1/conversations`, { method: 'POST', headers: { ...headers, 'idempotency-key': 'v' }, body: JSON.stringify({ character_id: character.character_id }) });
  const event = confirmLifeEventFromCandidate({
    store, account: store.account('acct_dev_alice'),
    candidate: {
      candidate_id: 'memc_p1', account_id: 'acct_dev_alice', character_id: character.character_id, state: 'CANDIDATE', version: 1, type: 'life_event',
      normalized_value: { life_event: { title: '周五的产品经理面试', domain: 'REAL_LIFE', event_kind: 'INTERVIEW', scheduled_at: '2026-10-02T06:30:00Z', timezone: 'Asia/Shanghai' } },
      display_text: '', provider: 't', expires_at: '2099-01-01', source_message_id: 'msg_p1', conflicts_with: []
    }
  }).event;
  return { app, store, base, headers, character, event };
}

function post(base, headers, path, body, key) {
  return fetch(`${base}${path}`, { method: 'POST', headers: { ...headers, 'idempotency-key': key }, body: JSON.stringify(body) });
}

test('A3 HTTP：草案→卡片消息→接受（不带/带 followup）→暂停撤 linked→恢复不补发→完成', async (t) => {
  const server = await startServer();
  t.after(() => new Promise((resolve) => { server.app.closeAllConnections(); server.app.close(resolve); }));
  const { base, headers, store, event } = server;

  const draftResponse = await post(base, headers, '/api/v1/companion-plans', { template_version: 'INTERVIEW_PREP_V1', support_mode: 'PRACTICE_TOGETHER', event_id: event.event_id }, 'd1');
  assert.equal(draftResponse.status, 201);
  const draft = await draftResponse.json();
  assert.equal(draft.plan.state, 'DRAFT');
  assert.equal(draft.plan.steps.length, 3);
  assert.match(draft.note, /草案/);
  assert.ok(draft.card.artifact_id, 'ARTIFACT_CARDS 开启时草案带卡片身份');
  const cardMessage = [...store.messages.values()].find((message) => message.provider === 'companion-card');
  assert.ok(cardMessage, '草案创建写聊天卡片消息');
  assert.equal(cardMessage.attachments[0].artifact_id, draft.card.artifact_id);

  // 编辑一步再接受。
  const patchResponse = await fetch(`${base}/api/v1/companion-plans/${draft.plan.plan_id}/steps/${draft.plan.steps[0].step_id}`, {
    method: 'PATCH', headers: { ...headers, 'idempotency-key': 's1' }, body: JSON.stringify({ expected_version: draft.plan.version, title: '改练英文自我介绍' })
  });
  assert.equal(patchResponse.status, 200);
  const patched = await patchResponse.json();
  assert.equal(patched.plan.version, draft.plan.version + 1);

  const acceptResponse = await post(base, headers, `/api/v1/companion-plans/${draft.plan.plan_id}/accept`, {
    expected_version: patched.plan.version,
    followup: { followup_kind: 'BEFORE_EVENT' }
  }, 'a1');
  assert.equal(acceptResponse.status, 200);
  const accepted = await acceptResponse.json();
  assert.equal(accepted.plan.state, 'ACTIVE');
  assert.equal(accepted.linked_grant.state, 'ACTIVE');
  assert.equal(accepted.action_recorded, true, 'ACTION_EXECUTION 开启时透明留痕');
  const grantRow = [...store.followupGrants.values()].find((grant) => grant.grant_id === accepted.linked_grant.grant_id);
  assert.equal(grantRow.event_id, event.event_id);

  // 透明留痕行：PLAN_ACCEPT SUCCEEDED，幂等键含计划版本。
  const auditRow = [...store.actionRequests.values()].find((row) => row.idempotency_key.startsWith(`plan:${draft.plan.plan_id}:accept:`));
  assert.equal(auditRow.state, 'SUCCEEDED');
  assert.equal(auditRow.action_type, 'PLAN_ACCEPT');

  // 暂停：撤 linked 许可与在途任务。
  const pauseResponse = await post(base, headers, `/api/v1/companion-plans/${draft.plan.plan_id}/pause`, { expected_version: accepted.plan.version }, 'p1');
  const paused = await pauseResponse.json();
  assert.equal(paused.plan.state, 'PAUSED');
  assert.equal(paused.followup_revoked.grants_revoked, 1);
  assert.equal([...store.followupJobs.values()].filter((job) => job.grant_id === accepted.linked_grant.grant_id)[0].state, 'CANCELLED');

  const resumeResponse = await post(base, headers, `/api/v1/companion-plans/${draft.plan.plan_id}/resume`, { expected_version: paused.plan.version }, 'r1');
  const resumed = await resumeResponse.json();
  assert.equal(resumed.plan.state, 'ACTIVE');
  assert.match(resumed.note, /不补发/);
  assert.equal([...store.followupJobs.values()].filter((job) => job.state === 'PENDING').length, 0, '不补发：恢复后零在途任务');

  // 完成：步骤未全终态 409，confirm 后 200。
  const blocked = await post(base, headers, `/api/v1/companion-plans/${draft.plan.plan_id}/complete`, {}, 'c1');
  assert.equal(blocked.status, 409);
  assert.equal((await blocked.json()).error.code, 'PLAN_STEPS_PENDING');
  const done = await (await post(base, headers, `/api/v1/companion-plans/${draft.plan.plan_id}/complete`, { confirm: true }, 'c2')).json();
  assert.equal(done.plan.state, 'COMPLETED');
});

test('A3 HTTP：接受不带 followup 零许可；FOLLOWUP_DISPATCH 关时带 followup 400；重复提案/已开启 409', async (t) => {
  const server = await startServer();
  t.after(() => new Promise((resolve) => { server.app.closeAllConnections(); server.app.close(resolve); }));
  const { base, headers, store, event } = server;

  const draft = await (await post(base, headers, '/api/v1/companion-plans', { template_version: 'INTERVIEW_PREP_V1', support_mode: 'LISTEN_ONLY', event_id: event.event_id }, 'd2')).json();
  assert.equal(draft.plan.steps.length, 0, '只听模式零待办');
  const accepted = await (await post(base, headers, `/api/v1/companion-plans/${draft.plan.plan_id}/accept`, { expected_version: draft.plan.version }, 'a2')).json();
  assert.equal(accepted.linked_grant, null);
  assert.equal([...store.followupGrants.values()].length, 0, '接受≠开提醒');

  // 已有 ACTIVE 计划：新提案 409 带当前计划。
  const conflict = await post(base, headers, '/api/v1/companion-plans', { template_version: 'INTERVIEW_PREP_V1', support_mode: 'PRACTICE_TOGETHER', event_id: event.event_id }, 'd3');
  assert.equal(conflict.status, 409);
  const conflictBody = await conflict.json();
  assert.equal(conflictBody.error.code, 'PLAN_ALREADY_OPEN');
  assert.equal(conflictBody.error.details.current_plan.state, 'ACTIVE');

  // FOLLOWUP_DISPATCH 关：accept 带 followup 400（独立 flag server）。
  const noFollowupFlags = parseDevFlags({ QIYU_DEV_FLAGS: 'LIFE_EVENTS,COMPANION_PLANS' });
  const other = await startServer(noFollowupFlags);
  t.after(() => new Promise((resolve) => { other.app.closeAllConnections(); other.app.close(resolve); }));
  const draft2 = await (await post(other.base, other.headers, '/api/v1/companion-plans', { template_version: 'INTERVIEW_PREP_V1', support_mode: 'PRACTICE_TOGETHER', event_id: other.event.event_id }, 'd4')).json();
  const rejected = await post(other.base, other.headers, `/api/v1/companion-plans/${draft2.plan.plan_id}/accept`, { expected_version: draft2.plan.version, followup: { followup_kind: 'BEFORE_EVENT' } }, 'a3');
  assert.equal(rejected.status, 400);
  assert.match((await rejected.json()).error.message, /跟进调度未开启/);
});

test('A3 HTTP：卡片视图/Markdown 导出/伪造 404/跨账户隔离；时间线带 artifact_id 与 plan 概要', async (t) => {
  const server = await startServer();
  t.after(() => new Promise((resolve) => { server.app.closeAllConnections(); server.app.close(resolve); }));
  const { base, headers, event } = server;

  const draft = await (await post(base, headers, '/api/v1/companion-plans', { template_version: 'INTERVIEW_PREP_V1', support_mode: 'PRACTICE_TOGETHER', event_id: event.event_id }, 'd5')).json();
  await post(base, headers, `/api/v1/companion-plans/${draft.plan.plan_id}/accept`, { expected_version: draft.plan.version }, 'a5');

  const cardResponse = await fetch(`${base}/api/v1/artifacts/${draft.card.artifact_id}`, { headers });
  assert.equal(cardResponse.status, 200);
  const card = (await cardResponse.json()).card;
  assert.equal(card.type, 'PLAN_V1');
  assert.deepEqual(card.actions, ['OPEN_PLAN', 'PAUSE_PLAN', 'COMPLETE_PLAN', 'CANCEL_PLAN']);

  const markdownResponse = await fetch(`${base}/api/v1/artifacts/${draft.card.artifact_id}?format=markdown`, { headers });
  assert.equal(markdownResponse.status, 200);
  assert.match(markdownResponse.headers.get('content-type'), /text\/markdown/);
  const markdown = await markdownResponse.text();
  assert.match(markdown, /- \[ \] /, 'Markdown 含步骤勾选形态');

  // 伪造 id 404。
  const missing = await fetch(`${base}/api/v1/artifacts/art_999999`, { headers });
  assert.equal(missing.status, 404);
  // 伪造计划/步骤/审批 404。
  assert.equal((await post(base, headers, '/api/v1/companion-plans/cpl_999999/accept', { expected_version: 1 }, 'x1')).status, 404);
  assert.equal((await fetch(`${base}/api/v1/action-requests/arq_999999`, { headers })).status, 404);

  // 时间线：事件条目带计划概要；artifact_id 指事件卡（本测试事件经域层种子
  // 而非 HTTP 确认路径，未产事件卡——草案卡是 COMPANION_PLAN 源的另一张卡）。
  const timeline = await (await fetch(`${base}/api/v1/timeline?filter=event`, { headers })).json();
  const entry = timeline.entries.find((item) => item.event_id === event.event_id);
  assert.equal(entry.artifact_id, null, '事件卡身份行不存在时为 null');
  assert.ok(entry.plan, '事件条目携带计划概要');
  assert.equal(entry.plan.state, 'ACTIVE');
  assert.equal(entry.plan.plan_id, draft.plan.plan_id);
});

test('A3 HTTP：显式审批——未知动作 400；ACCEPT_PLAN 提议→批准→执行；过期与目标版本漂移拒绝', async (t) => {
  const server = await startServer();
  t.after(() => new Promise((resolve) => { server.app.closeAllConnections(); server.app.close(resolve); }));
  const { base, headers } = server;

  const unknown = await post(base, headers, '/api/v1/action-requests', { action_type: 'SEND_EMAIL', target_ref: 'x', idempotency_key: 'u1' }, 'u1');
  assert.equal(unknown.status, 400);
  assert.equal((await unknown.json()).error.code, 'ACTION_TYPE_UNKNOWN');

  const draft = await (await post(base, headers, '/api/v1/companion-plans', { template_version: 'INTERVIEW_PREP_V1', support_mode: 'PRACTICE_TOGETHER' }, 'd6')).json();
  const proposed = await (await post(base, headers, '/api/v1/action-requests', {
    action_type: 'ACCEPT_PLAN', target_ref: draft.plan.plan_id, target_version: draft.plan.version,
    parameters: { expected_version: draft.plan.version }, idempotency_key: 'ar1'
  }, 'ar1')).json();
  assert.equal(proposed.action_request.state, 'PROPOSED');
  assert.match(proposed.note, /15 分钟/);

  // 目标版本漂移：先 PATCH step 使 plan.version+1，批准时重验拒绝。
  await fetch(`${base}/api/v1/companion-plans/${draft.plan.plan_id}/steps/${draft.plan.steps[0].step_id}`, {
    method: 'PATCH', headers: { ...headers, 'idempotency-key': 's6' }, body: JSON.stringify({ expected_version: draft.plan.version, title: '改一步' })
  });
  const drifted = await post(base, headers, `/api/v1/action-requests/${proposed.action_request.action_id}/approve`, {}, 'ap1');
  assert.equal(drifted.status, 409);
  const driftedBody = await drifted.json();
  assert.equal(driftedBody.error.code, 'ACTION_NOT_EXECUTABLE');
  assert.equal(driftedBody.error.details.reason, 'TARGET_VERSION_MISMATCH');

  // 重新提议对齐新版本 → 批准执行 SUCCEEDED。
  const aligned = await (await post(base, headers, '/api/v1/action-requests', {
    action_type: 'ACCEPT_PLAN', target_ref: draft.plan.plan_id, target_version: draft.plan.version + 1,
    parameters: { expected_version: draft.plan.version + 1 }, idempotency_key: 'ar2'
  }, 'ar2')).json();
  const approved = await (await post(base, headers, `/api/v1/action-requests/${aligned.action_request.action_id}/approve`, {}, 'ap2')).json();
  assert.equal(approved.action_request.state, 'SUCCEEDED');
  assert.equal(approved.result.plan.state, 'ACTIVE');

  // 幂等重放：同 idempotency_key 返回既有行。
  const replayed = await (await post(base, headers, '/api/v1/action-requests', {
    action_type: 'ACCEPT_PLAN', target_ref: draft.plan.plan_id, target_version: draft.plan.version + 1,
    parameters: { expected_version: draft.plan.version + 1 }, idempotency_key: 'ar2'
  }, 'ar2b')).json();
  assert.equal(replayed.replayed, true);

  // 过期路径：直接把行 expires_at 改到过去，approve 409。
  const expiring = await (await post(base, headers, '/api/v1/action-requests', {
    action_type: 'ACCEPT_PLAN', target_ref: 'cpl_unused', target_version: 1, parameters: {}, idempotency_key: 'ar3'
  }, 'ar3')).json();
  const row = server.store.actionRequests.get(expiring.action_request.action_id);
  server.store.actionRequests.set(row.action_id, Object.freeze({ ...row, expires_at: '2020-01-01T00:00:00Z' }));
  const lapsed = await post(base, headers, `/api/v1/action-requests/${row.action_id}/approve`, {}, 'ap3');
  assert.equal(lapsed.status, 409);
  assert.match((await lapsed.json()).error.message, /过期|重新提议/);
  // GET 惰性裁决置 EXPIRED。
  const statusResponse = await fetch(`${base}/api/v1/action-requests/${row.action_id}`, { headers });
  assert.equal((await statusResponse.json()).action_request.state, 'EXPIRED');

  // reject 与 cancel 直达。
  const cancellable = await (await post(base, headers, '/api/v1/action-requests', { action_type: 'ACCEPT_PLAN', target_ref: 'cpl_unused2', target_version: 1, parameters: {}, idempotency_key: 'ar4' }, 'ar4')).json();
  assert.equal((await (await post(base, headers, `/api/v1/action-requests/${cancellable.action_request.action_id}/reject`, {}, 'rj4')).json()).action_request.state, 'REJECTED');
  const cancellable2 = await (await post(base, headers, '/api/v1/action-requests', { action_type: 'ACCEPT_PLAN', target_ref: 'cpl_unused3', target_version: 1, parameters: {}, idempotency_key: 'ar5' }, 'ar5')).json();
  assert.equal((await (await post(base, headers, `/api/v1/action-requests/${cancellable2.action_request.action_id}/cancel`, {}, 'cl5')).json()).action_request.state, 'CANCELLED');
});

test('A3 HTTP：事件联动——PATCH 转 CANCELLED 响应带 plans_paused 且计划 PAUSED；删除清理派生+卡片下线', async (t) => {
  const server = await startServer();
  t.after(() => new Promise((resolve) => { server.app.closeAllConnections(); server.app.close(resolve); }));
  const { base, headers, event } = server;

  const draft = await (await post(base, headers, '/api/v1/companion-plans', { template_version: 'INTERVIEW_PREP_V1', support_mode: 'PRACTICE_TOGETHER', event_id: event.event_id }, 'd7')).json();
  await post(base, headers, `/api/v1/companion-plans/${draft.plan.plan_id}/accept`, { expected_version: draft.plan.version }, 'a7');

  const cancelEvent = await fetch(`${base}/api/v1/life-events/${event.event_id}`, {
    method: 'PATCH', headers: { ...headers, 'idempotency-key': 'ev1' },
    body: JSON.stringify({ expected_version: event.version, status: 'CANCELLED' })
  });
  const cancelBody = await cancelEvent.json();
  assert.equal(cancelEvent.status, 200);
  assert.equal(cancelBody.plans_paused.plans_paused, 1);
  const planAfter = await (await fetch(`${base}/api/v1/companion-plans/${draft.plan.plan_id}`, { headers })).json();
  assert.equal(planAfter.plan.state, 'PAUSED');
  assert.equal(planAfter.plan.state_reason, 'event_cancelled');

  // 删除事件：计划清理 + 卡片 404。
  const deleteResponse = await fetch(`${base}/api/v1/life-events/${event.event_id}`, { method: 'DELETE', headers: { ...headers, 'idempotency-key': 'ev2' } });
  const deleteBody = await deleteResponse.json();
  assert.equal(deleteResponse.status, 202);
  assert.equal(deleteBody.plans_cleaned_up.plans_cancelled, 1);
  assert.equal(deleteBody.plans_cleaned_up.cards_removed >= 1, true);
  const goneCard = await fetch(`${base}/api/v1/artifacts/${draft.card.artifact_id}`, { headers });
  assert.equal(goneCard.status, 404, '卡片随源下线');
});

test('A3 HTTP：开关关闭 404（路由不存在）；数据权利导出不受开关影响仍 200', async (t) => {
  const flagsOff = parseDevFlags({ QIYU_DEV_FLAGS: 'LIFE_EVENTS' });
  const server = await startServer(flagsOff);
  t.after(() => new Promise((resolve) => { server.app.closeAllConnections(); server.app.close(resolve); }));
  const { base, headers } = server;
  assert.equal((await post(base, headers, '/api/v1/companion-plans', { template_version: 'INTERVIEW_PREP_V1', support_mode: 'PRACTICE_TOGETHER' }, 'off1')).status, 404);
  assert.equal((await fetch(`${base}/api/v1/artifacts/art_000001`, { headers })).status, 404);
  assert.equal((await post(base, headers, '/api/v1/action-requests', { action_type: 'ACCEPT_PLAN', target_ref: 'x', idempotency_key: 'off2' }, 'off2')).status, 404);
  // 数据权利入口仍可用（关闭开关数据权利仍可达，A3 完成标准）。
  const exportResponse = await fetch(`${base}/api/v1/data-exports/relationship-profile`, { headers });
  assert.equal(exportResponse.status, 200);
  const exported = (await exportResponse.json()).export;
  assert.ok(Array.isArray(exported.companion_plans));
  assert.ok(Array.isArray(exported.action_requests));
});

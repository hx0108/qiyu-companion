'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { DevelopmentStore } = require('../src/domain/store');
const { parseDevFlags } = require('../src/development/dev-flags');
const { generateReply } = require('../src/domain/mock-adapter');
const { confirmLifeEventFromCandidate } = require('../src/domain/life-event-service');
const { runNextFollowupJob } = require('../src/domain/followup-worker');

// A2 HTTP 旅程：确认事件（≠允许提醒）→ PUT followup（默认派生/409/幂等）
// → GET 状态 → Worker 到期投递聊天流+来源 → 改期联动计数 → 撤销 202 →
// 开关门禁 404 → 手动触发与 Worker 共享每日一条。

const FLAGS = parseDevFlags({ QIYU_DEV_FLAGS: 'LIFE_EVENTS,MEMORY_REFERENCES,FOLLOWUP_DISPATCH' });

async function startServer() {
  const store = new DevelopmentStore();
  const app = createApp({ store, devFlags: FLAGS, replyGenerator: generateReply });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.address().port}`;
  const headers = { authorization: 'Bearer dev-alice-token', 'content-type': 'application/json' };
  const notices = await (await fetch(`${base}/api/v1/required-notices`, { headers })).json();
  const notice = notices.notices[0];
  await (await fetch(`${base}/api/v1/required-notices/${notice.notice_id}/displayed`, { method: 'POST', headers: { ...headers, 'idempotency-key': 'n' }, body: JSON.stringify({ notice_version: notice.notice_version }) })).json();
  await (await fetch(`${base}/api/v1/age/declarations`, { method: 'POST', headers: { ...headers, 'idempotency-key': 'a' }, body: JSON.stringify({ date_of_birth: '1990-01-01', confirmed_18_plus: true }) })).json();
  const character = (await (await fetch(`${base}/api/v1/characters`, { method: 'POST', headers: { ...headers, 'idempotency-key': 'c' }, body: JSON.stringify({ name: '栖夏' }) })).json()).character;
  // 账户主动偏好对齐事件时区（+8：测试时刻 06:31Z=14:31 白天，不落默认静默窗）。
  store.account('acct_dev_alice').proactive_preferences = { enabled: true, quiet_start_hour: 23, quiet_end_hour: 8, timezone_offset_minutes: 480 };
  const conversation = (await (await fetch(`${base}/api/v1/conversations`, { method: 'POST', headers: { ...headers, 'idempotency-key': 'v' }, body: JSON.stringify({ character_id: character.character_id }) })).json()).conversation;
  // 种一个已确认事件（未来时间，带 IANA 时区）
  const event = confirmLifeEventFromCandidate({
    store, account: store.account('acct_dev_alice'),
    candidate: {
      candidate_id: 'memc_f1', account_id: 'acct_dev_alice', character_id: character.character_id, state: 'CANDIDATE', version: 1, type: 'life_event',
      normalized_value: { life_event: { title: '周五的产品经理面试', domain: 'REAL_LIFE', event_kind: 'INTERVIEW', scheduled_at: '2026-10-02T06:30:00Z', timezone: 'Asia/Shanghai' } },
      display_text: '', provider: 't', expires_at: '2099-01-01', source_message_id: 'msg_f1', conflicts_with: []
    }
  }).event;
  return { app, store, base, headers, character, conversation, event };
}

test('A2 HTTP：PUT 旅程——确认≠允许、默认派生、409 带当前值、幂等重放、仅站内声明', async (t) => {
  const server = await startServer();
  t.after(() => new Promise((resolve) => { server.app.closeAllConnections(); server.app.close(resolve); }));
  const { base, headers, event } = server;

  // 开启前状态：无生效许可
  const before = await (await fetch(`${base}/api/v1/life-events/${event.event_id}/followup`, { headers })).json();
  assert.equal(before.active_grant, null);
  assert.equal(before.push_configured, false);

  const key = `f1-${Math.random()}`;
  const options = {
    method: 'PUT',
    headers: { ...headers, 'idempotency-key': key },
    body: JSON.stringify({ expected_version: 1, followup_kind: 'BEFORE_EVENT' })
  };
  const granted = await (await fetch(`${base}/api/v1/life-events/${event.event_id}/followup`, options)).json();
  assert.equal(granted.grant.state, 'ACTIVE');
  assert.equal(granted.grant.followup_kind, 'BEFORE_EVENT');
  assert.equal(granted.job.due_at, '2026-10-02T06:30:00.000Z'); // 默认=事件准点
  assert.equal(granted.job.local_date, '2026-10-02');
  assert.equal(granted.channel, 'IN_APP');
  assert.match(granted.note, /未配置 Push/);

  // 同键幂等重放：HTTP 幂等层原样返回首次响应（含 replayed:false）
  const replay = await (await fetch(`${base}/api/v1/life-events/${event.event_id}/followup`, options)).json();
  assert.equal(replay.job.job_id, granted.job.job_id);
  // 不同键同 body：域层任务唯一键幂等（不产生第二个任务）
  const again = await (await fetch(`${base}/api/v1/life-events/${event.event_id}/followup`, {
    method: 'PUT', headers: { ...headers, 'idempotency-key': `f1b-${Math.random()}` },
    body: JSON.stringify({ expected_version: 1, followup_kind: 'BEFORE_EVENT' })
  })).json();
  assert.equal(again.replayed, true);
  assert.equal(again.job.job_id, granted.job.job_id);

  // 旧版本号 409 带当前事件
  const conflict = await fetch(`${base}/api/v1/life-events/${event.event_id}/followup`, {
    method: 'PUT', headers: { ...headers, 'idempotency-key': `f2-${Math.random()}` },
    body: JSON.stringify({ expected_version: 99, followup_kind: 'BEFORE_EVENT' })
  });
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).error.code, 'VERSION_CONFLICT');

  // 时间待确认事件拒绝开启
  const { confirmLifeEventFromCandidate } = require('../src/domain/life-event-service');
  const vague = confirmLifeEventFromCandidate({
    store: server.store, account: server.store.account('acct_dev_alice'),
    candidate: {
      candidate_id: 'memc_f2', account_id: 'acct_dev_alice', character_id: server.character.character_id, state: 'CANDIDATE', version: 1, type: 'life_event',
      normalized_value: { life_event: { title: '含糊事件', domain: 'REAL_LIFE', event_kind: 'OTHER', raw_time_text: ' sometime', time_uncertain: true } },
      display_text: '', provider: 't', expires_at: '2099-01-01', source_message_id: 'msg_f2', conflicts_with: []
    }
  }).event;
  const rejected = await fetch(`${base}/api/v1/life-events/${vague.event_id}/followup`, {
    method: 'PUT', headers: { ...headers, 'idempotency-key': `f3-${Math.random()}` },
    body: JSON.stringify({ expected_version: 1, followup_kind: 'BEFORE_EVENT', due_at: '2026-10-05T02:00:00Z' })
  });
  assert.equal(rejected.status, 400);
  const rejectedBody = await rejected.json();
  assert.equal(rejectedBody.error.code, 'VALIDATION_ERROR');
  assert.ok(rejectedBody.error.details.missing_fields.includes('scheduled_at'));
});

test('A2 HTTP：Worker 到期投递进聊天流（provider=proactive-followup+来源引用+主动消息审计），改期联动与撤销', async (t) => {
  const server = await startServer();
  t.after(() => new Promise((resolve) => { server.app.closeAllConnections(); server.app.close(resolve); }));
  const { base, headers, event, store } = server;
  await (await fetch(`${base}/api/v1/life-events/${event.event_id}/followup`, {
    method: 'PUT', headers: { ...headers, 'idempotency-key': `g1-${Math.random()}` },
    body: JSON.stringify({ expected_version: 1, followup_kind: 'BEFORE_EVENT', allowed_from: '2026-10-01T00:00:00Z' })
  })).json();

  // 推进时钟到到期后，drain 内存 Worker（无模型→模板措辞）
  const outcome = await runNextFollowupJob({ store, composer: null, workerId: 'test-worker', now: new Date('2026-10-02T06:31:00.000Z') });
  assert.equal(outcome.state, 'PUBLISHED');
  const followupMessage = [...store.messages.values()].find((message) => message.provider === 'proactive-followup');
  assert.ok(followupMessage, '聊天流应出现主动消息');
  assert.equal(followupMessage.conversation_id, server.conversation.conversation_id);
  assert.match(followupMessage.text, /周五的产品经理面试/);
  // 来源引用 + 主动消息审计双写
  const { messageMemoryReferences } = require('../src/domain/memory-reference-service');
  const refs = messageMemoryReferences({ store, accountId: 'acct_dev_alice', messageId: followupMessage.message_id });
  assert.equal(refs.references[0].kind, 'LIFE_EVENT');
  assert.equal(refs.references[0].available, true);
  const audit = [...store.proactiveMessages.values()].find((item) => item.kind === 'NORMAL');
  assert.ok(audit, '应写主动消息审计（频控统计源）');
  assert.equal(audit.template_slot, 'CONFIRMED_APPOINTMENT');
  // 当日槽位被占用
  assert.ok(store.proactiveDailySlots.has(`acct_dev_alice:2026-10-02`));

  // 同日第二个任务（另一事件）到期 → 每日一条 → EXPIRED 不补发
  const { grantFollowup } = require('../src/domain/followup-service');
  const second = confirmLifeEventFromCandidate({
    store, account: store.account('acct_dev_alice'),
    candidate: {
      candidate_id: 'memc_f3', account_id: 'acct_dev_alice', character_id: server.character.character_id, state: 'CANDIDATE', version: 1, type: 'life_event',
      normalized_value: { life_event: { title: '读书会', domain: 'REAL_LIFE', event_kind: 'READING', scheduled_at: '2026-10-02T08:00:00Z', timezone: 'Asia/Shanghai' } },
      display_text: '', provider: 't', expires_at: '2099-01-01', source_message_id: 'msg_f3', conflicts_with: []
    }
  }).event;
  grantFollowup({
    store, account: store.account('acct_dev_alice'), event: second,
    validated: { followup_kind: 'BEFORE_EVENT', due_at: '2026-10-02T08:00:00.000Z', allowed_from: '2026-10-01T00:00:00.000Z', expires_at: '2026-10-03T08:00:00.000Z' },
    now: new Date('2026-10-01T00:00:00Z')
  });
  const throttled = await runNextFollowupJob({ store, composer: null, workerId: 'test-worker', now: new Date('2026-10-02T08:01:00.000Z') });
  assert.equal(throttled.state, 'EXPIRED');
  assert.equal(throttled.reason, 'DAILY_LIMIT_REACHED');

  // 改期联动：PATCH 修订 → followup_invalidated 计数 + 旧许可撤销
  const revised = await (await fetch(`${base}/api/v1/life-events/${event.event_id}`, {
    method: 'PATCH', headers: { ...headers, 'idempotency-key': `r1-${Math.random()}` },
    body: JSON.stringify({ expected_version: 1, scheduled_at: '2026-10-05T06:30:00Z' })
  })).json();
  assert.deepEqual(revised.followup_invalidated, { grants_revoked: 1, jobs_cancelled: 0 }); // 已 PUBLISHED 的不算在途

  // 撤销 202
  const revoked = await fetch(`${base}/api/v1/life-events/${event.event_id}/followup`, {
    method: 'DELETE', headers: { ...headers, 'idempotency-key': `d1-${Math.random()}` }
  });
  assert.equal(revoked.status, 202);
});

test('A2 HTTP：FOLLOWUP_DISPATCH 单独关闭 → followup 路由不存在（事件路由仍可用）', async (t) => {
  const store = new DevelopmentStore();
  const app = createApp({ store, devFlags: parseDevFlags({ QIYU_DEV_FLAGS: 'LIFE_EVENTS' }), replyGenerator: generateReply });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { app.closeAllConnections(); app.close(resolve); }));
  const base = `http://127.0.0.1:${app.address().port}`;
  const headers = { authorization: 'Bearer dev-alice-token' };
  const events = await fetch(`${base}/api/v1/life-events`, { headers });
  assert.equal(events.status, 200);
  const followup = await fetch(`${base}/api/v1/life-events/levt_x/followup`, { headers });
  assert.equal(followup.status, 404);
  assert.equal((await followup.json()).error.code, 'ROUTE_NOT_FOUND');
});

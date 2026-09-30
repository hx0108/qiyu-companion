'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { DevelopmentStore } = require('../src/domain/store');
const { parseDevFlags } = require('../src/development/dev-flags');
const { generateReply } = require('../src/domain/mock-adapter');
const { runNextLifeEventExtractionJob } = require('../src/domain/life-event-extraction-worker');

// A1 HTTP 旅程（P1.6）：提取→确认→列表→详情→修订（409/成功）→删除回执；
// confirm-edited 字段合同与跨账户 404。走内存 worker 手动 drain 模拟异步提取。

const FLAGS = parseDevFlags({ QIYU_DEV_FLAGS: 'LIFE_EVENTS,MEMORY_REFERENCES' });

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
  const characterResponse = await fetch(`${base}/api/v1/characters`, { method: 'POST', headers: { ...headers, 'idempotency-key': 'c' }, body: JSON.stringify({ name: '栖夏' }) });
  const character = (await characterResponse.json()).character;
  const conversationResponse = await fetch(`${base}/api/v1/conversations`, { method: 'POST', headers: { ...headers, 'idempotency-key': 'v' }, body: JSON.stringify({ character_id: character.character_id }) });
  const conversation = (await conversationResponse.json()).conversation;
  return { app, store, base, headers, character, conversation };
}

const INTERVIEW_CANDIDATES = [{
  title: '周五的产品经理面试', domain: 'REAL_LIFE', event_kind: 'INTERVIEW',
  scheduled_at: null, timezone: 'Asia/Shanghai', raw_time_text: '周五', time_uncertain: true
}];

async function sendAndExtract(server) {
  const response = await fetch(`${server.base}/api/v1/conversations/${server.conversation.conversation_id}/messages`, {
    method: 'POST',
    headers: { ...server.headers, 'idempotency-key': `m-${Math.random()}` },
    body: JSON.stringify({ content: { text: '我周五要去做产品经理的面试，好紧张' } })
  });
  await response.json(); // 消费响应体，避免 keep-alive socket 悬挂进程
  assert.equal(response.status, 201);
  await runNextLifeEventExtractionJob({
    store: server.store, extractionGenerator: async () => ({ candidates: INTERVIEW_CANDIDATES, provider: 'mock-extractor' }), now: new Date()
  });
  const list = await (await fetch(`${server.base}/api/v1/memory-candidates`, { headers: server.headers })).json();
  return list.candidates.find((item) => item.type === 'life_event');
}

test('A1 HTTP 旅程：确认（含糊日期）→列表→详情→改期 409/成功→删除回执', async (t) => {
  const server = await startServer();
  t.after(() => new Promise((resolve) => { server.app.closeAllConnections(); server.app.close(resolve); }));
  const candidate = await sendAndExtract(server);
  assert.ok(candidate, '提取 worker 应产出 life_event 候选');

  // 1) 确认（含糊日期：raw_time_text 无 ISO）→ clarification_required=true
  const confirmKey = `confirm-${Math.random()}`;
  const confirmResponse = await fetch(`${server.base}/api/v1/memory-candidates/${candidate.candidate_id}/confirm`, {
    method: 'POST', headers: { ...server.headers, 'idempotency-key': confirmKey },
    body: JSON.stringify({ expected_version: candidate.version })
  });
  assert.equal(confirmResponse.status, 201);
  const confirmed = await confirmResponse.json();
  assert.equal(confirmed.candidate.state, 'CONFIRMED');
  assert.equal(confirmed.asset.type, 'life_event');
  assert.equal(confirmed.event.clarification_required, true);
  assert.equal(confirmed.event.time_precision, 'UNKNOWN');
  const eventId = confirmed.event.event_id;

  // 2) 列表 + 详情
  const listResponse = await fetch(`${server.base}/api/v1/life-events`, { headers: server.headers });
  assert.equal(listResponse.status, 200);
  const listBody = await listResponse.json();
  assert.equal(listBody.events.length, 1);
  assert.equal(listBody.events[0].event_id, eventId);
  const detail = await (await fetch(`${server.base}/api/v1/life-events/${eventId}`, { headers: server.headers })).json();
  assert.equal(detail.event.event_id, eventId);
  assert.equal(detail.event.title, '周五的产品经理面试');

  // 3) 改期：旧版本 409 且响应回传当前值（客户端保留草稿重试）
  const conflictResponse = await fetch(`${server.base}/api/v1/life-events/${eventId}`, {
    method: 'PATCH', headers: { ...server.headers, 'idempotency-key': `p1-${Math.random()}` },
    body: JSON.stringify({ expected_version: 99, scheduled_at: '2026-10-05T09:00:00Z', timezone: 'Asia/Shanghai' })
  });
  assert.equal(conflictResponse.status, 409);
  const conflictBody = await conflictResponse.json();
  assert.equal(conflictBody.error.code, 'VERSION_CONFLICT');
  assert.equal(conflictBody.error.details.current_event.version, 1);

  // 3b) 正确版本改期成功：版本+1、精度 MINUTE、状态不自动变
  const reviseResponse = await fetch(`${server.base}/api/v1/life-events/${eventId}`, {
    method: 'PATCH', headers: { ...server.headers, 'idempotency-key': `p2-${Math.random()}` },
    body: JSON.stringify({ expected_version: 1, scheduled_at: '2026-10-05T09:00:00Z', timezone: 'Asia/Shanghai' })
  });
  assert.equal(reviseResponse.status, 200);
  const revised = await reviseResponse.json();
  assert.equal(revised.event.version, 2);
  assert.equal(revised.event.scheduled_at, '2026-10-05T09:00:00.000Z');
  assert.equal(revised.event.time_precision, 'MINUTE');
  assert.equal(revised.event.status, 'PLANNED');

  // 4) 删除：202 + 回执；列表即刻不可见
  const deleteResponse = await fetch(`${server.base}/api/v1/life-events/${eventId}`, {
    method: 'DELETE', headers: { ...server.headers, 'idempotency-key': `d-${Math.random()}` }
  });
  assert.equal(deleteResponse.status, 202);
  const deleted = await deleteResponse.json();
  assert.equal(deleted.event.deleted, true);
  assert.equal(deleted.deletion_receipt.failed_targets, 0);
  assert.ok(deleted.deletion_receipt.targets.some((item) => item.target_type === 'LIFE_EVENT'));
  const afterDelete = await (await fetch(`${server.base}/api/v1/life-events`, { headers: server.headers })).json();
  assert.equal(afterDelete.events.length, 0);
  const goneDetail = await fetch(`${server.base}/api/v1/life-events/${eventId}`, { headers: server.headers });
  assert.equal(goneDetail.status, 404);
});

test('A1 HTTP：confirm-edited 要求完整 life_event 字段集，缺字段 400 带清单', async (t) => {
  const server = await startServer();
  t.after(() => new Promise((resolve) => { server.app.closeAllConnections(); server.app.close(resolve); }));
  const candidate = await sendAndExtract(server);
  const missingBody = await fetch(`${server.base}/api/v1/memory-candidates/${candidate.candidate_id}/confirm-edited`, {
    method: 'POST', headers: { ...server.headers, 'idempotency-key': `ce1-${Math.random()}` },
    body: JSON.stringify({ expected_version: candidate.version, display_text: '只有展示文本' })
  });
  assert.equal(missingBody.status, 400);
  const missing = await missingBody.json();
  assert.equal(missing.error.code, 'VALIDATION_ERROR');
  assert.deepEqual(missing.error.details.missing_fields, ['life_event']);

  // 完整字段集：确认即生效，事件字段与提交一致
  const edited = await (await fetch(`${server.base}/api/v1/memory-candidates/${candidate.candidate_id}/confirm-edited`, {
    method: 'POST', headers: { ...server.headers, 'idempotency-key': `ce2-${Math.random()}` },
    body: JSON.stringify({
      expected_version: candidate.version,
      life_event: { title: '周五的算法岗面试', domain: 'REAL_LIFE', event_kind: 'INTERVIEW', scheduled_at: '2026-10-03T09:00:00Z', timezone: 'Asia/Shanghai' }
    })
  })).json();
  assert.equal(edited.candidate.state, 'CONFIRMED_EDITED');
  assert.equal(edited.event.title, '周五的算法岗面试');
  assert.equal(edited.event.scheduled_at, '2026-10-03T09:00:00.000Z');
  assert.equal(edited.event.clarification_required, false);
});

test('A1 HTTP：confirm 幂等重放（同 idempotency-key 返回同一结果，不产生第二个事件）', async (t) => {
  const server = await startServer();
  t.after(() => new Promise((resolve) => { server.app.closeAllConnections(); server.app.close(resolve); }));
  const candidate = await sendAndExtract(server);
  const key = `idem-${Math.random()}`;
  const options = {
    method: 'POST',
    headers: { ...server.headers, 'idempotency-key': key },
    body: JSON.stringify({ expected_version: candidate.version })
  };
  const first = await fetch(`${server.base}/api/v1/memory-candidates/${candidate.candidate_id}/confirm`, options);
  assert.equal(first.status, 201);
  const replay = await fetch(`${server.base}/api/v1/memory-candidates/${candidate.candidate_id}/confirm`, options);
  assert.equal(replay.status, 201);
  const replayBody = await replay.json();
  assert.equal(replayBody.event.event_id, (await first.json()).event.event_id);
  const list = await (await fetch(`${server.base}/api/v1/life-events`, { headers: server.headers })).json();
  assert.equal(list.events.length, 1);
});

test('A1 HTTP：跨账户 404（bob 看不到 alice 的事件），memory-references 关闭即不存在', async (t) => {
  const server = await startServer();
  t.after(() => new Promise((resolve) => { server.app.closeAllConnections(); server.app.close(resolve); }));
  const candidate = await sendAndExtract(server);
  const confirmed = await (await fetch(`${server.base}/api/v1/memory-candidates/${candidate.candidate_id}/confirm`, {
    method: 'POST', headers: { ...server.headers, 'idempotency-key': `x-${Math.random()}` },
    body: JSON.stringify({ expected_version: candidate.version })
  })).json();
  const crossAccount = await fetch(`${server.base}/api/v1/life-events/${confirmed.event.event_id}`, {
    headers: { authorization: 'Bearer dev-bob-token' }
  });
  assert.equal(crossAccount.status, 404);
  assert.equal((await crossAccount.json()).error.code, 'RESOURCE_NOT_FOUND');

  // 事件尚未注入过消息 → memory-references 查无记录（404），这是正常态。
  const assistantMessages = [...server.store.messages.values()].filter((message) => message.actor === 'ASSISTANT' && message.provider === 'mock');
  const refResponse = await fetch(`${server.base}/api/v1/messages/${assistantMessages[0].message_id}/memory-references`, { headers: server.headers });
  assert.equal(refResponse.status, 404);
});

test('A1 HTTP：MEMORY_REFERENCES 单独关闭时 life-events 路由仍可用，引用路由不存在', async (t) => {
  const store = new DevelopmentStore();
  const app = createApp({ store, devFlags: parseDevFlags({ QIYU_DEV_FLAGS: 'LIFE_EVENTS' }), replyGenerator: generateReply });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { app.closeAllConnections(); app.close(resolve); }));
  const base = `http://127.0.0.1:${app.address().port}`;
  const headers = { authorization: 'Bearer dev-alice-token' };
  const lifeEvents = await fetch(`${base}/api/v1/life-events`, { headers });
  assert.equal(lifeEvents.status, 200);
  const references = await fetch(`${base}/api/v1/messages/msg_x/memory-references`, { headers });
  assert.equal(references.status, 404);
  assert.equal((await references.json()).error.code, 'ROUTE_NOT_FOUND');
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { DevelopmentStore } = require('../src/domain/store');
const { parseDevFlags } = require('../src/development/dev-flags');
const { generateReply } = require('../src/domain/mock-adapter');
const { runNextLifeEventExtractionJob } = require('../src/domain/life-event-extraction-worker');
const { buildMessages } = require('../src/providers/qwen-adapter');

// 来源注入与快照（六项能力 A1 P1.7）：开关开启时事件进上下文、注入项随助手
// 消息落库、GET memory-references 可追溯；来源修订/删除后旧引用只回不可用
// 标记。开关关闭时 prompt 与既有文本逐字一致。

const FLAGS = parseDevFlags({ QIYU_DEV_FLAGS: 'LIFE_EVENTS,MEMORY_REFERENCES' });
const INTERVIEW = [{ title: '周五的产品经理面试', domain: 'REAL_LIFE', event_kind: 'INTERVIEW', scheduled_at: null, timezone: 'Asia/Shanghai', raw_time_text: '周五', time_uncertain: true }];

async function setup() {
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
  const conversation = (await (await fetch(`${base}/api/v1/conversations`, { method: 'POST', headers: { ...headers, 'idempotency-key': 'v' }, body: JSON.stringify({ character_id: character.character_id }) })).json()).conversation;
  return { app, store, base, headers, character, conversation };
}

async function extractAndConfirm(server) {
  const response = await fetch(`${server.base}/api/v1/conversations/${server.conversation.conversation_id}/messages`, {
    method: 'POST', headers: { ...server.headers, 'idempotency-key': `m-${Math.random()}` },
    body: JSON.stringify({ content: { text: '我周五要去面试' } })
  });
  await response.json();
  await runNextLifeEventExtractionJob({ store: server.store, extractionGenerator: async () => ({ candidates: INTERVIEW, provider: 'mock' }), now: new Date() });
  const candidate = (await (await fetch(`${server.base}/api/v1/memory-candidates`, { headers: server.headers })).json()).candidates.find((item) => item.type === 'life_event');
  const confirmed = await (await fetch(`${server.base}/api/v1/memory-candidates/${candidate.candidate_id}/confirm`, {
    method: 'POST', headers: { ...server.headers, 'idempotency-key': `cf-${Math.random()}` },
    body: JSON.stringify({ expected_version: candidate.version })
  })).json();
  return confirmed.event;
}

test('注入与快照：确认事件后发消息，助手消息带 LIFE_EVENT 引用且可用', async (t) => {
  const server = await setup();
  t.after(() => new Promise((resolve) => { server.app.closeAllConnections(); server.app.close(resolve); }));
  await extractAndConfirm(server);
  const reply = await fetch(`${server.base}/api/v1/conversations/${server.conversation.conversation_id}/messages`, {
    method: 'POST', headers: { ...server.headers, 'idempotency-key': `m2-${Math.random()}` },
    body: JSON.stringify({ content: { text: '帮我加油打打气' } })
  });
  const replyBody = await reply.json();
  assert.equal(reply.status, 201);
  const references = await (await fetch(`${server.base}/api/v1/messages/${replyBody.assistant_message.message_id}/memory-references`, { headers: server.headers })).json();
  assert.equal(references.message_id, replyBody.assistant_message.message_id);
  const lifeEventRef = references.references.find((item) => item.kind === 'LIFE_EVENT');
  assert.ok(lifeEventRef, '应注入已确认事件');
  assert.equal(lifeEventRef.available, true);
  assert.equal(lifeEventRef.title, '周五的产品经理面试');
  assert.equal(references.context_bundle_version, 'memory-refs.v1');
});

test('注入与快照：事件修订后旧引用 SUPERSEDED、删除后 DELETED（不回正文）', async (t) => {
  const server = await setup();
  t.after(() => new Promise((resolve) => { server.app.closeAllConnections(); server.app.close(resolve); }));
  const event = await extractAndConfirm(server);
  const reply = await (await fetch(`${server.base}/api/v1/conversations/${server.conversation.conversation_id}/messages`, {
    method: 'POST', headers: { ...server.headers, 'idempotency-key': `m2-${Math.random()}` },
    body: JSON.stringify({ content: { text: '帮我加油' } })
  })).json();
  const messageId = reply.assistant_message.message_id;

  await (await fetch(`${server.base}/api/v1/life-events/${event.event_id}`, {
    method: 'PATCH', headers: { ...server.headers, 'idempotency-key': `p-${Math.random()}` },
    body: JSON.stringify({ expected_version: 1, scheduled_at: '2026-10-05T09:00:00Z' })
  })).json();
  const afterRevise = await (await fetch(`${server.base}/api/v1/messages/${messageId}/memory-references`, { headers: server.headers })).json();
  const supersededRef = afterRevise.references.find((item) => item.kind === 'LIFE_EVENT');
  assert.equal(supersededRef.available, false);
  assert.equal(supersededRef.reason, 'SUPERSEDED');
  assert.equal(supersededRef.current_version, 2);
  assert.equal(supersededRef.title, undefined);

  await (await fetch(`${server.base}/api/v1/life-events/${event.event_id}`, {
    method: 'DELETE', headers: { ...server.headers, 'idempotency-key': `d-${Math.random()}` }
  })).json();
  const afterDelete = await (await fetch(`${server.base}/api/v1/messages/${messageId}/memory-references`, { headers: server.headers })).json();
  assert.equal(afterDelete.references.find((item) => item.kind === 'LIFE_EVENT').reason, 'DELETED');
});

test('注入与快照：无资产无事件时不落引用行（空引用不是错误）', async (t) => {
  const server = await setup();
  t.after(() => new Promise((resolve) => { server.app.closeAllConnections(); server.app.close(resolve); }));
  const reply = await (await fetch(`${server.base}/api/v1/conversations/${server.conversation.conversation_id}/messages`, {
    method: 'POST', headers: { ...server.headers, 'idempotency-key': `m-${Math.random()}` },
    body: JSON.stringify({ content: { text: '随便聊聊' } })
  })).json();
  assert.equal([...server.store.messageMemoryRefs.values()].length, 0);
  const missing = await fetch(`${server.base}/api/v1/messages/${reply.assistant_message.message_id}/memory-references`, { headers: server.headers });
  assert.equal(missing.status, 404);
});

test('prompt 一致性：无 asset_id 时记忆块文本与 v1 逐字一致；有 asset_id/事件时才出现标注与事件块', () => {
  const legacyContext = { confirmed_assets: [{ type: 'memory', display_text: '用户养了一只橘猫', version: 1 }] };
  const legacy = buildMessages('你好', legacyContext);
  assert.match(legacy[0].content, /- 用户养了一只橘猫/u);
  assert.doesNotMatch(legacy[0].content, /\[\w{4}\/v1\]/u);
  assert.doesNotMatch(legacy[0].content, /active-life-event-data/u);

  const enrichedContext = {
    confirmed_assets: [{ asset_id: 'ras_abcd1234', type: 'memory', display_text: '用户养了一只橘猫', version: 1 }],
    active_life_events: [{ event_id: 'levt_abcd1234', version: 1, domain: 'REAL_LIFE', status: 'PLANNED', title: '周五的产品经理面试', scheduled_at: null, time_precision: 'UNKNOWN' }]
  };
  const enriched = buildMessages('你好', enrichedContext);
  assert.match(enriched[0].content, /- \[1234\/v1\] 用户养了一只橘猫/u);
  assert.match(enriched[0].content, /active-life-event-data/u);
  assert.match(enriched[0].content, /时间待用户确认，不得自行编造/u);
  assert.doesNotMatch(enriched[0].content, /undefined/u);
});

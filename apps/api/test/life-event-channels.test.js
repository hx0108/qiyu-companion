'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { DevelopmentStore } = require('../src/domain/store');
const { parseDevFlags } = require('../src/development/dev-flags');
const { generateReply } = require('../src/domain/mock-adapter');

// 三通道接线（六项能力 A1 P1.5）：开关开启时用户消息落库即入队提取任务；
// 关闭时不产生任何任务行。通话通道的验证在 call-turn-engine.test.js。

const LIFE_FLAGS = parseDevFlags({ QIYU_DEV_FLAGS: 'LIFE_EVENTS' });

async function seedConversation(base) {
  const headers = { authorization: 'Bearer dev-alice-token', 'content-type': 'application/json' };
  const notices = await (await fetch(`${base}/api/v1/required-notices`, { headers })).json();
  const notice = notices.notices[0];
  await fetch(`${base}/api/v1/required-notices/${notice.notice_id}/displayed`, {
    method: 'POST', headers: { ...headers, 'idempotency-key': `notice-${Math.random()}` }, body: JSON.stringify({ notice_version: notice.notice_version })
  });
  await fetch(`${base}/api/v1/age/declarations`, {
    method: 'POST', headers: { ...headers, 'idempotency-key': `age-${Math.random()}` }, body: JSON.stringify({ date_of_birth: '1990-01-01', confirmed_18_plus: true })
  });
  const characterResponse = await fetch(`${base}/api/v1/characters`, {
    method: 'POST',
    headers: { ...headers, 'idempotency-key': `char-${Math.random()}` },
    body: JSON.stringify({ name: '栖夏' })
  });
  const character = (await characterResponse.json()).character;
  const conversationResponse = await fetch(`${base}/api/v1/conversations`, {
    method: 'POST',
    headers: { ...headers, 'idempotency-key': `conv-${Math.random()}` },
    body: JSON.stringify({ character_id: character.character_id })
  });
  return (await conversationResponse.json()).conversation;
}

async function sendMessage(base, conversation, body) {
  return fetch(`${base}/api/v1/conversations/${conversation.conversation_id}/messages`, {
    method: 'POST',
    headers: { authorization: 'Bearer dev-alice-token', 'content-type': 'application/json', 'idempotency-key': `msg-${Math.random()}` },
    body: JSON.stringify(body)
  });
}

test('三通道·文字非流式（行为断言）：任务入队可经 store 观察到', async (t) => {
  const store = new DevelopmentStore();
  const app = createApp({ store, devFlags: LIFE_FLAGS, replyGenerator: generateReply });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.address().port}`;
  const conversation = await seedConversation(base);
  await sendMessage(base, conversation, { content: { text: '我周五要去面试' } });
  const jobs = [...store.lifeEventExtractionJobs.values()];
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].state, 'PENDING');
  assert.equal(jobs[0].account_id, 'acct_dev_alice');
  const userMessages = [...store.messages.values()].filter((message) => message.actor === 'USER');
  assert.equal(jobs[0].message_id, userMessages.at(-1).message_id);

  // 白名单外账户不入队（开关带账户白名单时）。
  const scopedFlags = parseDevFlags({ QIYU_DEV_FLAGS: 'LIFE_EVENTS', QIYU_DEV_FLAG_ACCOUNTS: 'acct_dev_bob' });
  const scopedStore = new DevelopmentStore();
  const scopedApp = createApp({ store: scopedStore, devFlags: scopedFlags, replyGenerator: generateReply });
  await new Promise((resolve) => scopedApp.listen(0, '127.0.0.1', resolve));
  t.after(() => scopedApp.close());
  const scopedBase = `http://127.0.0.1:${scopedApp.address().port}`;
  const scopedConversation = await seedConversation(scopedBase);
  await sendMessage(scopedBase, scopedConversation, { content: { text: '我周五要去面试' } });
  assert.equal([...scopedStore.lifeEventExtractionJobs.values()].length, 0);
});

test('三通道·开关关闭：发消息不产生任何提取任务（默认 devFlags 全关）', async (t) => {
  const store = new DevelopmentStore();
  const app = createApp({ store, replyGenerator: generateReply });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.address().port}`;
  const conversation = await seedConversation(base);
  const response = await sendMessage(base, conversation, { content: { text: '我周五要去面试' } });
  assert.equal(response.status, 201);
  assert.equal([...store.lifeEventExtractionJobs.values()].length, 0);
});

test('三通道·SSE 受理：stream:true 用户消息落库带保留期并同事务入队提取任务', async (t) => {
  const store = new DevelopmentStore();
  const app = createApp({
    store, devFlags: LIFE_FLAGS, replyGenerator: generateReply,
    streamingReplyGenerator: { generateStream: async () => {} }
  });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.address().port}`;
  const conversation = await seedConversation(base);
  const response = await sendMessage(base, conversation, { content: { text: '我周五要去面试' }, stream: true });
  assert.equal(response.status, 202);
  const userMessage = [...store.messages.values()].filter((message) => message.actor === 'USER').at(-1);
  assert.ok(userMessage.retention_expires_at, 'SSE 用户消息此前漏设 retention_expires_at，本次修复后必须有');
  const jobs = [...store.lifeEventExtractionJobs.values()];
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].message_id, userMessage.message_id);

  // 开关关闭的 SSE：消息保留期同样必须存在（修复与开关无关），任务为零。
  const offStore = new DevelopmentStore();
  const offApp = createApp({
    store: offStore, replyGenerator: generateReply,
    streamingReplyGenerator: { generateStream: async () => {} }
  });
  await new Promise((resolve) => offApp.listen(0, '127.0.0.1', resolve));
  t.after(() => offApp.close());
  const offBase = `http://127.0.0.1:${offApp.address().port}`;
  const offConversation = await seedConversation(offBase);
  await sendMessage(offBase, offConversation, { content: { text: '我周五要去面试' }, stream: true });
  const offMessage = [...offStore.messages.values()].filter((message) => message.actor === 'USER').at(-1);
  assert.ok(offMessage.retention_expires_at);
  assert.equal([...offStore.lifeEventExtractionJobs.values()].length, 0);
});

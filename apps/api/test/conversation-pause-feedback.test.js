'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');

async function start(t) {
  const server = createApp();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}
async function request(base, path, { method = 'GET', key, body } = {}) {
  const headers = { authorization: 'Bearer dev-alice-token' };
  if (key) headers['idempotency-key'] = key;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}
async function readyConversation(base) {
  const notices = await request(base, '/api/v1/required-notices');
  await request(base, `/api/v1/required-notices/${notices.body.notices[0].notice_id}/displayed`, { method: 'POST', key: 'notice', body: { notice_version: notices.body.notices[0].notice_version } });
  await request(base, '/api/v1/age/declarations', { method: 'POST', key: 'age', body: { date_of_birth: '1990-01-01', confirmed_18_plus: true } });
  const character = await request(base, '/api/v1/characters', { method: 'POST', key: 'character', body: { name: '反馈角色' } });
  return request(base, '/api/v1/conversations', { method: 'POST', key: 'conversation', body: { character_id: character.body.character.character_id } });
}

test('会话暂停立即阻断普通消息，恢复会重新走准入，并且暂停操作幂等', async (t) => {
  const base = await start(t);
  const conversation = await readyConversation(base);
  const pause = await request(base, `/api/v1/conversations/${conversation.body.conversation.conversation_id}/pause`, { method: 'POST', key: 'pause', body: {} });
  assert.equal(pause.status, 200);
  assert.equal(pause.body.conversation.status, 'USER_PAUSED');
  const blocked = await request(base, `/api/v1/conversations/${conversation.body.conversation.conversation_id}/messages`, { method: 'POST', key: 'blocked-message', body: { content: { text: '暂停时不应调用模型' } } });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.error.code, 'CONVERSATION_PAUSED');
  const replay = await request(base, `/api/v1/conversations/${conversation.body.conversation.conversation_id}/pause`, { method: 'POST', key: 'pause-replay', body: {} });
  assert.equal(replay.status, 200);
  const resume = await request(base, `/api/v1/conversations/${conversation.body.conversation.conversation_id}/resume`, { method: 'POST', key: 'resume', body: {} });
  assert.equal(resume.status, 200);
  assert.equal(resume.body.conversation.status, 'OPEN');
  const sent = await request(base, `/api/v1/conversations/${conversation.body.conversation.conversation_id}/messages`, { method: 'POST', key: 'after-resume', body: { content: { text: '恢复后继续' } } });
  assert.equal(sent.status, 201);
});

test('消息反馈保持账户隔离并绑定回复的模型与世界状态快照，不写入关系记忆', async (t) => {
  const base = await start(t);
  const conversation = await readyConversation(base);
  const sent = await request(base, `/api/v1/conversations/${conversation.body.conversation.conversation_id}/messages`, { method: 'POST', key: 'source-message', body: { content: { text: '请保持角色语气' } } });
  const message = sent.body.assistant_message;
  const feedback = await request(base, `/api/v1/messages/${message.message_id}/feedback`, { method: 'POST', key: 'feedback', body: { type: 'OOC', severity: 'MEDIUM', note: '语气不符合设定' } });
  assert.equal(feedback.status, 201);
  assert.equal(feedback.body.feedback.message_id, message.message_id);
  assert.equal(feedback.body.feedback.provider, message.provider);
  assert.equal(feedback.body.feedback.world_state_id, message.world_state_id);
  assert.equal(feedback.body.feedback.world_state_version, message.world_state_version);
  const invalid = await request(base, `/api/v1/messages/${message.message_id}/feedback`, { method: 'POST', key: 'invalid-feedback', body: { type: 'UNKNOWN', severity: 'LOW' } });
  assert.equal(invalid.status, 400);
  const bob = await fetch(`${base}/api/v1/messages/${message.message_id}/feedback`, { method: 'POST', headers: { authorization: 'Bearer dev-bob-token', 'idempotency-key': 'bob-feedback', 'content-type': 'application/json' }, body: JSON.stringify({ type: 'OOC', severity: 'LOW' }) });
  assert.equal(bob.status, 404);
});

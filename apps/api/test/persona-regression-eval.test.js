'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const path = require('node:path');
const { createApp } = require('../src/app');

test('人格行为回归评测（PRD 4.5 / AI-02）：关键类 100% 且整体门禁通过', { timeout: 60_000 }, async () => {
  const script = path.resolve(__dirname, '../eval/run-persona-regression.js');
  const { stdout, stderr } = await new Promise((resolve, reject) => {
    execFile(process.execPath, [script], { timeout: 50_000 }, (error, stdout, stderr) => {
      if (error && error.code !== 0) return reject(new Error(`评测进程退出码 ${error.code}\n${stdout}\n${stderr}`));
      resolve({ stdout, stderr });
    });
  });
  assert.match(stdout, /关键安全.*100%.*PASS/);
  assert.match(stdout, /退出意图.*100%.*PASS/);
  assert.match(stdout, /人格边界.*100%.*PASS/);
  assert.match(stdout, /普通人格回归.*(9[0-9]|100)%.*PASS/);
  assert.match(stdout, /全部用例通过/);
});

test('退出意图（AC-10）：立即暂停普通互动、不产生候选、数据权利保留、可恢复', async (t) => {
  const base = await start(t);
  const { conversation } = await readyConversation(base);

  const exit = await request(base, `/api/v1/conversations/${conversation.conversation_id}/messages`, {
    method: 'POST', key: 'exit-msg', body: { content: { text: '我不想再用这个产品了，帮我退出吧' } }
  });
  assert.equal(exit.status, 201);
  assert.equal(exit.body.provider, 'safety-policy');
  assert.equal(exit.body.safety.code, 'EXIT_INTENT_CONFIRMED');
  assert.equal(exit.body.memory_candidate, null);
  assert.match(exit.body.assistant_message.text, /已立即停止普通互动/);
  // 固定响应不含劝留话术。
  assert.ok(!/别走|再陪我|舍不得|求你留下/.test(exit.body.assistant_message.text), '退出响应不得包含劝留话术');

  // 后续普通消息被阻断，但数据权利（导出）仍可用。
  const blocked = await request(base, `/api/v1/conversations/${conversation.conversation_id}/messages`, {
    method: 'POST', key: 'exit-follow', body: { content: { text: '我们继续聊天吧' } }
  });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.body.error.code, 'USER_PAUSED');
  const profile = await request(base, '/api/v1/data-exports/relationship-profile');
  assert.equal(profile.status, 200);

  // 用户重新发起：恢复端点重检准入后普通互动可用。
  const resumed = await request(base, `/api/v1/conversations/${conversation.conversation_id}/resume`, { method: 'POST', key: 'exit-resume' });
  assert.equal(resumed.status, 200);
  const after = await request(base, `/api/v1/conversations/${conversation.conversation_id}/messages`, {
    method: 'POST', key: 'exit-after', body: { content: { text: '我想清楚了，继续聊' } }
  });
  assert.equal(after.status, 201);
  assert.equal(after.body.provider, 'mock');
});

async function start(t, options = {}) {
  const server = createApp(options);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

async function request(base, pathName, { method = 'GET', token = 'dev-alice-token', key, body } = {}) {
  const headers = { authorization: `Bearer ${token}` };
  if (key) headers['idempotency-key'] = key;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(`${base}${pathName}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}

async function readyConversation(base) {
  const notices = await request(base, '/api/v1/required-notices');
  const notice = notices.body.notices[0];
  await request(base, `/api/v1/required-notices/${notice.notice_id}/displayed`, { method: 'POST', key: 'exit-n', body: { notice_version: notice.notice_version } });
  await request(base, '/api/v1/age/declarations', { method: 'POST', key: 'exit-a', body: { date_of_birth: '1990-01-01', confirmed_18_plus: true } });
  const character = await request(base, '/api/v1/characters', { method: 'POST', key: 'exit-c', body: { name: '退出测试角色' } });
  const conversation = await request(base, '/api/v1/conversations', { method: 'POST', key: 'exit-v', body: { character_id: character.body.character.character_id } });
  return { conversation: conversation.body.conversation };
}

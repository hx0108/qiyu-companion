'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { DevelopmentStore } = require('../src/domain/store');
const { createSummary } = require('../src/domain/conversation-summary');

async function start(t, options = {}) {
  const server = createApp(options);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

async function request(base, path, { method = 'GET', token = 'dev-alice-token', key, body } = {}) {
  const headers = { authorization: `Bearer ${token}` };
  if (key) headers['idempotency-key'] = key;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}

function replyFor(text) {
  return {
    provider: 'spy', model_version: 'spy-v1', reply_text: `回复：${text}`, ai_generated: true,
    disclaimer: '测试生成器。', memory_candidate: { type: 'development_note', normalized_value: { text }, display_text: `你提到：“${text}”` }
  };
}

async function readyConversation(base, token = 'dev-alice-token', prefix = 'setup') {
  const notices = await request(base, '/api/v1/required-notices', { token });
  const notice = notices.body.notices[0];
  await request(base, `/api/v1/required-notices/${notice.notice_id}/displayed`, { method: 'POST', token, key: `${prefix}-notice`, body: { notice_version: notice.notice_version } });
  await request(base, '/api/v1/age/declarations', { method: 'POST', token, key: `${prefix}-age`, body: { date_of_birth: '1990-01-01', confirmed_18_plus: true } });
  const character = await request(base, '/api/v1/characters', { method: 'POST', token, key: `${prefix}-character`, body: { name: `${prefix} 角色` } });
  const conversation = await request(base, '/api/v1/conversations', { method: 'POST', token, key: `${prefix}-conversation`, body: { character_id: character.body.character.character_id } });
  return { character: character.body.character, conversation: conversation.body.conversation };
}

test('会话与角色列表只返回本人未删除资源', async (t) => {
  const base = await start(t);
  const ready = await readyConversation(base);
  const mine = await request(base, '/api/v1/characters');
  assert.equal(mine.status, 200);
  assert.ok(mine.body.characters.some((item) => item.character_id === ready.character.character_id));
  const conversations = await request(base, '/api/v1/conversations');
  assert.equal(conversations.status, 200);
  assert.ok(conversations.body.conversations.some((item) => item.conversation_id === ready.conversation.conversation_id));

  // 另一个开发账户看不到 alice 的角色与会话。
  const bob = await request(base, '/api/v1/characters', { token: 'dev-bob-token' });
  assert.equal(bob.status, 200);
  assert.equal(bob.body.characters.length, 0);
  const bobConversations = await request(base, '/api/v1/conversations', { token: 'dev-bob-token' });
  assert.equal(bobConversations.body.conversations.length, 0);
});

test('消息历史按时间升序返回并支持游标分页', async (t) => {
  const base = await start(t);
  const { conversation } = await readyConversation(base);
  for (let index = 1; index <= 6; index += 1) {
    const sent = await request(base, `/api/v1/conversations/${conversation.conversation_id}/messages`, {
      method: 'POST', key: `msg-${index}`, body: { content: { text: `第${index}条` } }
    });
    assert.equal(sent.status, 201);
  }
  const firstPage = await request(base, `/api/v1/conversations/${conversation.conversation_id}/messages?limit=4`);
  assert.equal(firstPage.status, 200);
  assert.equal(firstPage.body.messages.length, 4);
  assert.deepEqual(firstPage.body.messages.map((item) => item.text).filter((text) => text.startsWith('第')), ['第5条', '第6条']);
  assert.ok(firstPage.body.next_cursor);

  const olderPage = await request(base, `/api/v1/conversations/${conversation.conversation_id}/messages?limit=8&cursor=${firstPage.body.next_cursor}`);
  assert.equal(olderPage.body.messages.length, 8);
  assert.ok(olderPage.body.messages.some((item) => item.text === '第1条'));
  assert.equal(olderPage.body.next_cursor, null);

  const invalidCursor = await request(base, `/api/v1/conversations/${conversation.conversation_id}/messages?cursor=msg_missing`);
  assert.equal(invalidCursor.status, 404);
});

test('单条消息终态可按 ID 读取且仅限本人会话', async (t) => {
  const base = await start(t);
  const { conversation } = await readyConversation(base);
  const sent = await request(base, `/api/v1/conversations/${conversation.conversation_id}/messages`, {
    method: 'POST', key: 'single', body: { content: { text: '单条查询' } }
  });
  const assistantId = sent.body.assistant_message.message_id;
  const fetched = await request(base, `/api/v1/messages/${assistantId}`);
  assert.equal(fetched.status, 200);
  assert.equal(fetched.body.message.message_id, assistantId);
  assert.equal(fetched.body.message.ai_generated, true);

  const foreign = await request(base, `/api/v1/messages/${assistantId}`, { token: 'dev-bob-token' });
  assert.equal(foreign.status, 404);
  const missing = await request(base, '/api/v1/messages/msg_does_not_exist');
  assert.equal(missing.status, 404);
});

test('发送消息时模型收到上下文包：角色、有限历史与已确认资产', async (t) => {
  const observed = [];
  const base = await start(t, {
    replyGenerator: async (text, context) => {
      observed.push({ text, context });
      return replyFor(text);
    }
  });
  const { character, conversation } = await readyConversation(base);
  await request(base, `/api/v1/conversations/${conversation.conversation_id}/messages`, { method: 'POST', key: 'ctx-1', body: { content: { text: '我喜欢雨天' } } });

  // 确认候选后，第二轮上下文应包含已确认资产。
  const candidates = await request(base, '/api/v1/memory-candidates');
  const candidate = candidates.body.candidates[0];
  await request(base, `/api/v1/memory-candidates/${candidate.candidate_id}/confirm`, { method: 'POST', key: 'ctx-confirm', body: { expected_version: candidate.version } });

  await request(base, `/api/v1/conversations/${conversation.conversation_id}/messages`, { method: 'POST', key: 'ctx-2', body: { content: { text: '今天也在下雨' } } });
  assert.equal(observed.length, 2);

  const first = observed[0];
  assert.equal(first.text, '我喜欢雨天');
  assert.equal(first.context.prompt_bundle_version, 'pb_1.0_dev');
  assert.equal(first.context.character.character_id, character.character_id);
  assert.equal(first.context.conversation_id, conversation.conversation_id);
  assert.deepEqual(first.context.recent_context, []);
  assert.deepEqual(first.context.confirmed_assets, []);

  const second = observed[1];
  assert.equal(second.text, '今天也在下雨');
  assert.equal(second.context.recent_context.length, 2);
  assert.equal(second.context.recent_context[0].actor, 'USER');
  assert.equal(second.context.recent_context[0].text, '我喜欢雨天');
  assert.equal(second.context.recent_context[1].actor, 'ASSISTANT');
  assert.equal(second.context.confirmed_assets.length, 1);
  assert.equal(second.context.confirmed_assets[0].display_text, candidate.display_text);
});

test('有效摘要进入上下文后，只保留摘要边界之后的近消息；删除会立即使摘要失效', async (t) => {
  const observed = [];
  const store = new DevelopmentStore();
  const base = await start(t, { store, replyGenerator: async (text, context) => { observed.push(context); return replyFor(text); } });
  const { conversation } = await readyConversation(base, 'dev-alice-token', 'summary-context');
  await request(base, `/api/v1/conversations/${conversation.conversation_id}/messages`, { method: 'POST', key: 'summary-1', body: { content: { text: '第一段历史' } } });
  const source = [...store.messages.values()].filter((message) => message.conversation_id === conversation.conversation_id);
  const summary = createSummary({ summaryId: 'sum_context', accountId: 'acct_dev_alice', conversationId: conversation.conversation_id, messages: source, revocationEpoch: 0, text: '用户已开始第一段对话。', modelRouteId: 'qwen3.8-flash', promptVersion: 'conversation-summary.v1', retentionExpiresAt: '2027-01-01T00:00:00.000Z' });
  store.conversationSummaries.set(summary.summary_id, summary);
  await request(base, `/api/v1/conversations/${conversation.conversation_id}/messages`, { method: 'POST', key: 'summary-2', body: { content: { text: '摘要之后的新消息' } } });
  assert.equal(observed.at(-1).conversation_summary.summary_id, 'sum_context');
  assert.deepEqual(observed.at(-1).recent_context, []);
  await request(base, `/api/v1/conversations/${conversation.conversation_id}`, { method: 'DELETE', key: 'summary-delete' });
  assert.equal(store.conversationSummaries.get('sum_context').state, 'INVALIDATED');
});

test('删除会话后历史接口不再返回该会话消息', async (t) => {
  const base = await start(t);
  const { conversation } = await readyConversation(base);
  await request(base, `/api/v1/conversations/${conversation.conversation_id}/messages`, { method: 'POST', key: 'del-1', body: { content: { text: '将被删除' } } });
  await request(base, `/api/v1/conversations/${conversation.conversation_id}`, { method: 'DELETE', key: 'del-conv' });

  const conversations = await request(base, '/api/v1/conversations');
  assert.equal(conversations.body.conversations.length, 0);
  const history = await request(base, `/api/v1/conversations/${conversation.conversation_id}/messages`);
  assert.equal(history.status, 404);
});

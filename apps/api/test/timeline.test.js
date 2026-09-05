'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');

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

function replyFor(text, displayText) {
  return {
    provider: 'spy', model_version: 'spy-v1', reply_text: `回复：${text}`, ai_generated: true, disclaimer: '测试生成器。',
    memory_candidate: { type: 'development_note', normalized_value: { text }, display_text: displayText ?? `你提到：“${text}”` }
  };
}

async function setup(base, prefix) {
  const notices = await request(base, '/api/v1/required-notices');
  const notice = notices.body.notices[0];
  await request(base, `/api/v1/required-notices/${notice.notice_id}/displayed`, { method: 'POST', key: `${prefix}-n`, body: { notice_version: notice.notice_version } });
  await request(base, '/api/v1/age/declarations', { method: 'POST', key: `${prefix}-a`, body: { date_of_birth: '1990-01-01', confirmed_18_plus: true } });
  const character = await request(base, '/api/v1/characters', { method: 'POST', key: `${prefix}-c`, body: { name: `${prefix} 角色` } });
  const conversation = await request(base, '/api/v1/conversations', { method: 'POST', key: `${prefix}-v`, body: { character_id: character.body.character.character_id } });
  return { character: character.body.character, conversation: conversation.body.conversation };
}

async function confirmFirstCandidate(base, prefix, conversationId, text, displayText) {
  await request(base, `/api/v1/conversations/${conversationId}/messages`, { method: 'POST', key: `${prefix}-m`, body: { content: { text } } });
  const candidates = await request(base, '/api/v1/memory-candidates');
  const candidate = candidates.body.candidates[0];
  const confirmed = await request(base, `/api/v1/memory-candidates/${candidate.candidate_id}/confirm`, { method: 'POST', key: `${prefix}-conf`, body: { expected_version: candidate.version } });
  return { candidate, asset: confirmed.body.asset };
}

test('时间线返回有效资产并按时间倒序，支持筛选，被替代版本不出现', async (t) => {
  const base = await start(t);
  const { conversation } = await setup(base, 'tl');
  const first = await confirmFirstCandidate(base, 'tl1', conversation.conversation_id, '我喜欢雨天', '你提到：我喜欢雨天');
  const second = await confirmFirstCandidate(base, 'tl2', conversation.conversation_id, '我养了一只猫', '你提到：我养了一只猫');

  const timeline = await request(base, '/api/v1/timeline');
  assert.equal(timeline.status, 200);
  assert.equal(timeline.body.entries.length, 2);
  assert.equal(timeline.body.entries[0].asset_id, second.asset.asset_id);
  assert.equal(timeline.body.entries[0].entry_type, 'CONFIRMED_ASSET');
  assert.equal(timeline.body.entries[0].filter_group, 'memory');

  // 修订第一个资产后，旧版本退出时间线，新版本以最新时间进入。
  const revised = await request(base, `/api/v1/relationship-assets/${first.asset.asset_id}`, {
    method: 'PATCH', key: 'tl-revise', body: { expected_version: 1, display_text: '你提到：我最喜欢雨天' }
  });
  assert.equal(revised.status, 200);
  assert.equal(revised.body.asset.state, 'SUPERSEDED');
  assert.equal(revised.body.revision.state, 'ACTIVE');
  assert.equal(revised.body.revision.supersedes_asset_id, first.asset.asset_id);

  const after = await request(base, '/api/v1/timeline');
  assert.equal(after.body.entries.length, 2);
  assert.ok(!after.body.entries.some((entry) => entry.asset_id === first.asset.asset_id));
  assert.ok(after.body.entries.some((entry) => entry.asset_id === revised.body.revision.asset_id));

  const memoryOnly = await request(base, '/api/v1/timeline?filter=memory');
  assert.equal(memoryOnly.body.entries.length, 2);
  const badFilter = await request(base, '/api/v1/timeline?filter=nothing');
  assert.equal(badFilter.status, 400);
});

test('修订资产需要版本匹配，且召回只包含新版本', async (t) => {
  const observed = [];
  const base = await start(t, {
    replyGenerator: async (text, context) => {
      observed.push(context);
      return replyFor(text);
    }
  });
  const { conversation } = await setup(base, 'rv');
  const { asset } = await confirmFirstCandidate(base, 'rv1', conversation.conversation_id, '我喜欢雨天', '你提到：我喜欢雨天');

  const conflict = await request(base, `/api/v1/relationship-assets/${asset.asset_id}`, { method: 'PATCH', key: 'rv-conflict', body: { expected_version: 99, display_text: '改' } });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.error.code, 'VERSION_CONFLICT');

  await request(base, `/api/v1/relationship-assets/${asset.asset_id}`, { method: 'PATCH', key: 'rv-ok', body: { expected_version: 1, display_text: '你提到：我最喜欢雨天的声音' } });
  const recall = await request(base, '/api/v1/memory-recall');
  assert.equal(recall.body.assets.length, 1);
  assert.equal(recall.body.assets[0].display_text, '你提到：我最喜欢雨天的声音');

  await request(base, `/api/v1/conversations/${conversation.conversation_id}/messages`, { method: 'POST', key: 'rv-msg', body: { content: { text: '再聊聊' } } });
  assert.equal(observed.at(-1).confirmed_assets.length, 1);
  assert.equal(observed.at(-1).confirmed_assets[0].display_text, '你提到：我最喜欢雨天的声音');
});

test('相似候选标记与确认资产的冲突，由用户决定有效版本（AC-06）', async (t) => {
  const base = await start(t);
  const { conversation } = await setup(base, 'cf');
  await confirmFirstCandidate(base, 'cf1', conversation.conversation_id, '我喜欢雨天', '你提到：我喜欢雨天');

  // 发送相似但不同的陈述，产生的新候选应带 conflicts_with。
  const sent = await request(base, `/api/v1/conversations/${conversation.conversation_id}/messages`, {
    method: 'POST', key: 'cf-m2', body: { content: { text: '我喜欢雨天的声音' } }
  });
  assert.equal(sent.status, 201);
  assert.equal(sent.body.memory_candidate.conflicts_with.length, 1);
  assert.equal(sent.body.memory_candidate.conflicts_with[0].display_text, '你提到：“我喜欢雨天”');

  // 无关候选不误报。
  await request(base, `/api/v1/conversations/${conversation.conversation_id}/messages`, {
    method: 'POST', key: 'cf-m3', body: { content: { text: '我下周要去爬山' } }
  });
  const candidates = await request(base, '/api/v1/memory-candidates');
  const unrelated = candidates.body.candidates.find((item) => item.display_text.includes('爬山'));
  assert.equal(unrelated.conflicts_with.length, 0);
});

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
async function readyCharacter(base, prefix = 'world') {
  const notices = await request(base, '/api/v1/required-notices');
  const notice = notices.body.notices[0];
  await request(base, `/api/v1/required-notices/${notice.notice_id}/displayed`, { method: 'POST', key: `${prefix}-notice`, body: { notice_version: notice.notice_version } });
  await request(base, '/api/v1/age/declarations', { method: 'POST', key: `${prefix}-age`, body: { date_of_birth: '1990-01-01', confirmed_18_plus: true } });
  const created = await request(base, '/api/v1/characters', { method: 'POST', key: `${prefix}-character`, body: { name: '世界状态角色' } });
  return created.body.character;
}

test('世界状态只允许白名单短期情境字段、乐观更新与重置', async (t) => {
  const base = await start(t);
  const character = await readyCharacter(base);
  const initial = await request(base, `/api/v1/characters/${character.character_id}/world-state`);
  assert.equal(initial.status, 200);
  assert.equal(initial.body.world_state.mood_code, 'NEUTRAL');
  assert.equal(initial.body.world_state.location_code, 'UNSPECIFIED');
  assert.equal(initial.body.world_state.state_version, 1);

  const updated = await request(base, `/api/v1/characters/${character.character_id}/world-state`, {
    method: 'PATCH', key: 'world-update', body: { expected_version: 1, mood_code: 'CALM', location_code: 'CAFE', expires_at: new Date(Date.now() + 60_000).toISOString() }
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.world_state.state_version, 2);
  assert.equal(updated.body.world_state.mood_code, 'CALM');
  assert.equal(updated.body.world_state.location_code, 'CAFE');

  const conflict = await request(base, `/api/v1/characters/${character.character_id}/world-state`, { method: 'PATCH', key: 'world-conflict', body: { expected_version: 1, mood_code: 'HAPPY' } });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.error.code, 'VERSION_CONFLICT');

  const unsafe = await request(base, `/api/v1/characters/${character.character_id}/world-state`, { method: 'PATCH', key: 'world-unsafe', body: { expected_version: 2, source: 'MODEL_PATCH' } });
  assert.equal(unsafe.status, 400);
  const wardrobe = await request(base, `/api/v1/characters/${character.character_id}/world-state`, { method: 'PATCH', key: 'world-wardrobe', body: { expected_version: 2, wardrobe_asset_id: 'asset_unreviewed' } });
  assert.equal(wardrobe.status, 409);

  const reset = await request(base, `/api/v1/characters/${character.character_id}/world-state/reset`, { method: 'POST', key: 'world-reset', body: {} });
  assert.equal(reset.status, 200);
  assert.equal(reset.body.reset, true);
  assert.equal(reset.body.world_state.mood_code, 'NEUTRAL');
  assert.equal(reset.body.world_state.location_code, 'UNSPECIFIED');
  assert.equal(reset.body.world_state.state_version, 3);
});

test('世界状态进入模型上下文，但模型回复不能自行改写它', async (t) => {
  const observed = [];
  const base = await start(t, { replyGenerator: async (text, context) => {
    observed.push(context.world_state);
    return { provider: 'spy', model_version: 'v1', reply_text: `回复：${text}`, ai_generated: true, disclaimer: '测试', memory_candidate: { type: 'development_note', normalized_value: { text }, display_text: text, world_state_patch_candidate: { mood_code: 'HAPPY' } } };
  } });
  const character = await readyCharacter(base, 'world-context');
  await request(base, `/api/v1/characters/${character.character_id}/world-state`, { method: 'PATCH', key: 'world-context-update', body: { expected_version: 1, mood_code: 'TIRED', location_code: 'LIBRARY' } });
  const conversation = await request(base, '/api/v1/conversations', { method: 'POST', key: 'world-context-conversation', body: { character_id: character.character_id } });
  const sent = await request(base, `/api/v1/conversations/${conversation.body.conversation.conversation_id}/messages`, { method: 'POST', key: 'world-context-message', body: { content: { text: '你好' } } });
  assert.equal(sent.status, 201);
  assert.deepEqual(observed[0], { world_state_id: observed[0].world_state_id, state_version: 2, mood_code: 'TIRED', location_code: 'LIBRARY', wardrobe_asset_id: null, active_event_refs: [], expires_at: null, reset_at: observed[0].reset_at, updated_at: observed[0].updated_at });
  const after = await request(base, `/api/v1/characters/${character.character_id}/world-state`);
  assert.equal(after.body.world_state.mood_code, 'TIRED');
  assert.equal(after.body.world_state.state_version, 2);
});

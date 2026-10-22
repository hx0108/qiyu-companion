'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { DevelopmentStore } = require('../src/domain/store');

async function setup(t) {
  const store = new DevelopmentStore();
  const server = createApp({ store });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let serial = 0;
  const request = async (route, body, { token = 'dev-alice-token', key } = {}) => {
    const r = await fetch(origin + '/api/v1' + route, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'idempotency-key': key || `restore-test-${++serial}` }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  const notices = await request('/required-notices');
  const notice = notices.body.notices[0];
  await request(`/required-notices/${notice.notice_id}/displayed`, { notice_version: notice.notice_version });
  await request('/age/declarations', { date_of_birth: '1990-01-01', confirmed_18_plus: true });
  const created = await request('/characters', { name: 'Synthetic', persona: { personality: 'Quiet', gender: 'male' } });
  const id = created.body.character.character_id;
  await request(`/characters/${id}/persona-versions`, { expected_version: 1, persona: { personality: 'Lively', gender: 'female' }, note: 'self edit' });
  return { store, request, id, route: `/characters/${id}/persona-versions/1/restore` };
}

test('self restore makes a new active version from server snapshot and retains history, name and audit context', async t => {
  const { store, request, id, route } = await setup(t);
  const result = await request(route, { expected_version: 2, confirm: true, reason: 'Prefer original' });
  assert.equal(result.status, 201);
  assert.equal(result.body.character.version, 3);
  assert.equal(result.body.character.active_persona_version, 3);
  assert.equal(result.body.character.name, 'Synthetic');
  assert.equal(result.body.character.persona.personality, 'Quiet');
  assert.equal(result.body.character.persona.gender, 'male');
  assert.equal(result.body.persona_version.restored_from_version, 1);
  assert.equal(result.body.character.persona_history.length, 3);
  assert.equal(store.characters.get(id).persona_history[0].state, 'RETIRED');
  assert.equal(store.characters.get(id).persona_history[1].state, 'RETIRED');
  assert.equal((await request(`/characters/${id}`)).body.character.persona_restore_supported, true);
});

test('restore requires confirmation and current optimistic version; failed requests do not mutate', async t => {
  const { request, id, route } = await setup(t);
  assert.equal((await request(route, { expected_version: 2, confirm: false, reason: 'test' })).status, 400);
  assert.equal((await request(route, { expected_version: 2, confirm: true, reason: '' })).status, 400);
  assert.equal((await request(route, { expected_version: 1, confirm: true, reason: 'stale' })).status, 409);
  assert.equal((await request(`/characters/${id}`)).body.character.version, 2);
});

test('restore isolates owners and refuses unreleased drafts or arbitrary snapshot data', async t => {
  const { request, id, route } = await setup(t);
  assert.equal((await request(route, { expected_version: 2, confirm: true, reason: 'other' }, { token: 'dev-bob-token' })).status, 404);
  await request(`/characters/${id}/persona-versions`, { expected_version: 2, persona: { personality: 'Unreleased' }, release_mode: 'draft', note: 'draft' });
  assert.equal((await request(`/characters/${id}/persona-versions/3/restore`, { expected_version: 2, confirm: true, reason: 'draft' })).status, 409);
  assert.equal((await request(route, { expected_version: 2, confirm: true, reason: 'original', persona: { personality: 'Injected' } })).status, 400);
  const restored = await request(route, { expected_version: 2, confirm: true, reason: 'original' });
  assert.equal(restored.status, 201);
  assert.equal(restored.body.character.persona.personality, 'Quiet', 'client data never substitutes the historical server snapshot');
});

test('idempotent retry does not duplicate restored versions', async t => {
  const { request, id, route } = await setup(t);
  const body = { expected_version: 2, confirm: true, reason: 'retry' };
  const first = await request(route, body, { key: 'same-restore' });
  const retry = await request(route, body, { key: 'same-restore' });
  assert.equal(first.status, 201);
  assert.deepEqual(retry.body, first.body);
  assert.equal((await request(`/characters/${id}`)).body.character.persona_history.length, 3);
});

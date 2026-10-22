'use strict';
// Synthetic provider wire, real localhost HTTP/WS/SSE, actual browser-client parser.
// AudioContext/microphone are stubs: this does not claim browser acoustic acceptance.
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const WebSocket = require('ws');
const { createApp } = require('../src/app');
const { DevelopmentStore } = require('../src/domain/store');
const { VolcengineRealtimeAdapter } = require('../src/providers/volcengine-realtime-adapter');

const uint = value => { const bytes = Buffer.alloc(4); bytes.writeUInt32BE(value); return bytes; };
function frame(event, payload, id) {
  const binary = Buffer.isBuffer(payload), bytes = binary ? payload : Buffer.from(JSON.stringify(payload));
  return Buffer.concat([Buffer.from([0x11, binary ? 0xb4 : 0x94, binary ? 0 : 16, 0]), uint(event), uint(Buffer.byteLength(id)), Buffer.from(id), uint(bytes.length), bytes]);
}
class ProviderWire extends EventEmitter {
  constructor() { super(); this.readyState = 1; this.bufferedAmount = 0; this.uploads = 0; }
  send(bytes) {
    const event = bytes.readUInt32BE(4);
    if (event === 1) queueMicrotask(() => this.emit('message', frame(50, {}, 'connect'), true));
    if (event === 100) {
      const size = bytes.readUInt32BE(8); this.sessionId = bytes.subarray(12, 12 + size).toString();
      this.startPayload = JSON.parse(bytes.subarray(16 + size).toString());
      queueMicrotask(() => this.feed(150, {}));
    }
    if (event === 200) this.uploads++;
  }
  feed(event, payload) { this.emit('message', frame(event, payload, this.sessionId), true); }
  terminate() { this.readyState = 3; this.emit('close'); }
}
async function until(predicate, message) {
  const deadline = Date.now() + 2000;
  while (!predicate()) { assert.ok(Date.now() < deadline, message); await new Promise(resolve => setTimeout(resolve, 10)); }
}
async function fixture(t, { relationship, gender, speaker } = {}) {
  const wire = new ProviderWire(), events = [], schedules = [], audits = [];
  const provider = new VolcengineRealtimeAdapter({ apiKey: 'synthetic-not-real', ...(speaker ? { speaker } : {}), wsFactory: () => { queueMicrotask(() => wire.emit('open')); return wire; } });
  const store = new DevelopmentStore();
  const server = createApp({ store, trialAuthEnabled: true, trialAuth: { resolveAccessToken: async token => token === 'synthetic' ? 'acct_dev_alice' : null },
    realtimeCallEnabled: true, realtimeProvider: provider, summaryEnabled: false, textModerator: async input => { audits.push(input.direction); return { decision: 'PASS' }; } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  let client;
  t.after(async () => { await client?.end(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  let key = 0;
  async function api(route, method = 'GET', body) {
    const response = await fetch(base + '/api/v1' + route, { method, headers: { authorization: 'Bearer synthetic', 'content-type': 'application/json', 'idempotency-key': `wire-${++key}` }, body: body === undefined ? undefined : JSON.stringify(body) });
    const result = await response.json(); assert.ok(response.ok, `${route}: ${response.status} ${result.error?.code}`); return result;
  }
  for (const notice of (await api('/required-notices')).notices) await api(`/required-notices/${notice.notice_id}/displayed`, 'POST', { notice_version: notice.notice_version });
  await api('/age/declarations', 'POST', { date_of_birth: '1990-01-01', confirmed_18_plus: true });
  const character = (await api('/characters', 'POST', { name: '林语', ...(gender ? { persona: { gender } } : {}) })).character;
  if (relationship) store.characters.get(character.character_id).persona.relationship_to_user = relationship;
  const conversation = (await api('/conversations', 'POST', { character_id: character.character_id })).conversation;
  const source = fs.readFileSync(path.resolve(__dirname, '../../web/realtime-call-client.js'), 'utf8').replace(/^import .*;$/m, '').replace(/export /g, '');
  const Client = vm.runInNewContext(`${source}\nRealtimeCallClient`, { Uint8Array, performance, AbortController, TextDecoder, atob, setTimeout, clearTimeout, URL, location: { href: base }, crypto: require('node:crypto').webcrypto });
  client = new Client({ apiBase: base + '/api/v1', authHeaders: () => ({ authorization: 'Bearer synthetic' }), conversationId: conversation.conversation_id,
    fetchImpl: (url, options) => fetch(new URL(url, base), options), socketFactory: (url, protocols) => new WebSocket(url, protocols, { headers: { Origin: base } }),
    contextFactory: () => ({ currentTime: 0, async resume() {}, async close() {} }),
    micFactory: () => ({ async start() {}, stop() {}, setUploading() {} }),
    playerFactory: () => ({ enqueue(bytes) { schedules.push(bytes); return 0; }, stop() {} }), onEvent: event => events.push(event) });
  await client.start();
  return { wire, store, client, events, schedules, audits };
}
function speech(wire, question, text = '你好。') {
  wire.feed(450, { question_id: question });
  wire.feed(451, { results: [{ text, is_interim: false }] }); wire.feed(459, {});
}
function answer(wire, question, reply, { finish = true, text = '你好呀。' } = {}) {
  wire.feed(550, { question_id: question, reply_id: reply, content: text });
  wire.feed(559, { question_id: question, reply_id: reply });
  wire.feed(350, { question_id: question, reply_id: reply, text: '', tts_type: 'default' });
  wire.feed(352, Buffer.from([1, 0, 2, 0]));
  if (finish) { wire.feed(351, { question_id: question, reply_id: reply }); wire.feed(359, { question_id: question, reply_id: reply }); }
}

test('saved male and female persona selects corresponding provider voice across HTTP registry and wire', async t => {
  for (const [gender, override, expected] of [
    ['male', undefined, 'zh_male_yunzhou_jupiter_bigtts'],
    ['female', undefined, 'zh_female_vv_jupiter_bigtts'],
    ['male', 'zh_female_vv_jupiter_bigtts', 'zh_male_yunzhou_jupiter_bigtts'],
    ['female', 'zh_male_xiaotian_jupiter_bigtts', 'zh_female_vv_jupiter_bigtts']
  ]) {
    const f = await fixture(t, { gender, speaker: override });
    assert.equal(f.wire.startPayload.tts.speaker, expected);
    assert.match(f.wire.startPayload.dialog.system_role, new RegExp(`"性别":"${gender}"`));
    await f.client.end();
  }
});

test('romantic relationship conflict stays silent across wire SSE and client while the next turn plays', async t => {
  const f = await fixture(t, { relationship: '男女朋友' });
  speech(f.wire, 'q-bad', '我们是什么关系？');
  answer(f.wire, 'q-bad', 'r-bad', { text: '我们只是好朋友。' });
  await until(() => f.events.some(event => event.type === 'turn-failed') || f.client.closed, 'relationship rejection did not reach client');
  assert.equal(f.client.closed, false); assert.equal(f.schedules.length, 0);
  assert.ok(f.events.some(event => event.type === 'turn-failed' && event.code === 'OOC_RELATIONSHIP_CONFLICT'));
  assert.equal([...f.store.messages.values()].some(message => message.text === '我们只是好朋友。'), false);
  assert.equal([...f.store.messages.values()].filter(message => message.provider === 'volcengine-realtime').length, 0);
  speech(f.wire, 'q-good', '再说说我们的关系。');
  answer(f.wire, 'q-good', 'r-good', { text: '我们是恋人，我在呢。' });
  await until(() => f.events.some(event => event.type === 'response-complete') || f.client.closed, 'next reply did not complete');
  assert.equal(f.client.closed, false); assert.equal(f.schedules.length, 1);
});

test('provider wire traverses real HTTP SSE and native client for twelve audited rounds', async t => {
  const f = await fixture(t);
  for (let round = 1; round <= 12; round++) {
    speech(f.wire, `q${round}`); answer(f.wire, `q${round}`, `r${round}`);
    await until(() => f.events.filter(event => event.type === 'response-complete').length === round || f.client.closed, 'response did not arrive');
    assert.equal(f.client.closed, false); assert.equal(f.schedules.length, round);
    f.client.uploadChunk(new Uint8Array(3200));
  }
  await until(() => f.wire.uploads === 12, 'real microphone websocket did not reach provider adapter');
  assert.equal([...f.store.messages.values()].filter(message => message.provider === 'volcengine-realtime').length, 24);
  assert.equal(f.audits.filter(direction => direction === 'INPUT').length, 12);
  assert.equal(f.audits.filter(direction => direction === 'OUTPUT').length, 12);
});

test('PCM preceding sealed reply text stays silent until text is complete and audited', async t => {
  const f = await fixture(t); speech(f.wire, 'delayed-text');
  const ids = { question_id: 'delayed-text', reply_id: 'delayed-text-reply' };
  f.wire.feed(550, { ...ids, content: '你好呀。' });
  f.wire.feed(350, { ...ids, text: '', tts_type: 'default' });
  f.wire.feed(352, Buffer.from([1, 0, 2, 0])); f.wire.feed(351, ids);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(f.client.closed, false, 'normal asynchronous text/audio order must not hang up');
  assert.equal(f.schedules.length, 0, 'unsealed response must not schedule any audio');
  assert.equal(f.events.filter(event => event.type === 'text' && event.role === 'assistant').length, 0);
  f.wire.feed(559, ids); f.wire.feed(359, ids);
  await until(() => f.events.some(event => event.type === 'response-complete') || f.client.closed, 'sealed reply did not complete');
  assert.equal(f.client.closed, false); assert.equal(f.schedules.length, 1);
  assert.equal([...f.store.messages.values()].filter(message => message.provider === 'volcengine-realtime').length, 2);
});

test('late interrupted sentence tail does not end or erase the new wire/client reply', async t => {
  const f = await fixture(t);
  speech(f.wire, 'old'); answer(f.wire, 'old', 'old-reply', { finish: false });
  await until(() => f.schedules.length === 1 || f.client.closed, 'first sentence did not arrive');
  speech(f.wire, 'new'); answer(f.wire, 'new', 'new-reply', { finish: false });
  // Old TTS metadata may arrive after a new active sentence starts. It cannot
  // close or erase the new sentence, nor authorize stale audio for playback.
  f.wire.feed(351, { question_id: 'old', reply_id: 'old-reply' });
  f.wire.feed(359, { question_id: 'old', reply_id: 'old-reply' });
  f.wire.feed(352, Buffer.from([3, 0]));
  f.wire.feed(351, { question_id: 'new', reply_id: 'new-reply' });
  f.wire.feed(359, { question_id: 'new', reply_id: 'new-reply' });
  await until(() => f.events.some(event => event.type === 'response-complete') || f.client.closed, 'interrupted reply did not settle');
  assert.equal(f.client.closed, false); assert.equal(f.schedules.length, 3);
  assert.equal([...f.store.messages.values()].filter(message => message.provider === 'volcengine-realtime').length, 2);
  const before = f.schedules.length;
  // A complete stale wire sentence, including its untagged PCM, is discarded.
  f.wire.feed(350, { question_id: 'old', reply_id: 'old-reply', text: '过时回复。', tts_type: 'default' });
  f.wire.feed(352, Buffer.from([9, 0])); f.wire.feed(351, { question_id: 'old', reply_id: 'old-reply' });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(f.client.closed, false); assert.equal(f.schedules.length, before);
  assert.ok(f.audits.includes('INPUT')); assert.ok(f.audits.includes('OUTPUT'));
});

test('empty ASR wire turn does not persist a fabricated message or prevent the next real turn', async t => {
  const f = await fixture(t);
  f.wire.feed(450, { question_id: 'noise' });
  f.wire.feed(451, { results: [] }); f.wire.feed(459, {});
  speech(f.wire, 'after-noise'); answer(f.wire, 'after-noise', 'after-noise-reply');
  await until(() => f.events.filter(event => event.type === 'response-complete').length === 1 || f.client.closed, 'next turn after noise did not arrive');
  assert.equal(f.client.closed, false); assert.equal(f.schedules.length, 1);
  const messages = [...f.store.messages.values()].filter(message => message.provider === 'volcengine-realtime');
  assert.equal(messages.length, 2, 'only the completed, audited exchange persists');
  assert.equal(f.audits.filter(direction => direction === 'INPUT').length, 1);
  assert.equal(f.audits.filter(direction => direction === 'OUTPUT').length, 1);
});

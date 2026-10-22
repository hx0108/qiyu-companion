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

async function rawRequest(base, path) {
  const response = await fetch(`${base}${path}`);
  return { status: response.status, contentType: response.headers.get('content-type'), csp: response.headers.get('content-security-policy'), text: await response.text() };
}

async function displayAndPass(base, token = 'dev-alice-token', prefix = 'setup') {
  const notices = await request(base, '/api/v1/required-notices', { token });
  const notice = notices.body.notices[0];
  const displayed = await request(base, `/api/v1/required-notices/${notice.notice_id}/displayed`, {
    method: 'POST', token, key: `${prefix}-notice`, body: { notice_version: notice.notice_version }
  });
  assert.equal(displayed.status, 200);
  const age = await request(base, '/api/v1/age/declarations', {
    method: 'POST', token, key: `${prefix}-age`, body: { date_of_birth: '1990-01-01', confirmed_18_plus: true }
  });
  assert.equal(age.body.status, 'AGE_PASS');
}

async function readyConversation(base, token = 'dev-alice-token', prefix = 'setup') {
  await displayAndPass(base, token, prefix);
  const character = await request(base, '/api/v1/characters', { method: 'POST', token, key: `${prefix}-character`, body: { name: `${prefix} 角色` } });
  assert.equal(character.status, 201);
  const conversation = await request(base, '/api/v1/conversations', { method: 'POST', token, key: `${prefix}-conversation`, body: { character_id: character.body.character.character_id } });
  assert.equal(conversation.status, 201);
  return { character: character.body.character, conversation: conversation.body.conversation };
}


const mediaStore = { async createPendingJob() {}, async updateJob() {}, async putAudio({ bytes }) { return { objectKey: 'tts/stream.mp3', checksum: 'a'.repeat(64), byteLength: bytes.length, mimeType: 'audio/mpeg' }; } };
async function source(t, options) {
  const base = await start(t, { replyGenerator: async (text) => ({ reply_text: text, provider: 'mock', ai_generated: true }), mediaStore, ...options });
  const { conversation } = await readyConversation(base);
  const result = await request(base, `/api/v1/conversations/${conversation.conversation_id}/messages`, { method: 'POST', key: 'msg', body: { content: { text: '你今天怎么样？' } } });
  return { base, message: result.body.assistant_message.message_id };
}
function streamRequest(base, message, key = 'stream-1', token = 'dev-alice-token', signal) {
  return fetch(`${base}/api/v1/messages/${message}/tts-stream`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'idempotency-key': key, 'content-type': 'application/json' }, body: '{}', signal });
}
test('first click emits audio before synthesis finishes; final job persists and replay synthesizes/charges only once', async (t) => {
  let finish, calls = 0, charges = 0, commits = 0;
  const wait = new Promise((resolve) => { finish = resolve; });
  const { base, message } = await source(t, {
    ttsGenerator: async ({ onAudioSegment }) => { calls += 1; onAudioSegment(Buffer.from('first')); await wait; return { asset: { bytes: Buffer.from('first-last'), mimeType: 'audio/mpeg' }, providerRequestId: 'tts1' }; },
    imageEntitlementService: { reserve() { charges += 1; return { entitlement_id: 'quota' }; }, commit() { commits += 1; }, release() {} }
  });
  const response = await streamRequest(base, message);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-accel-buffering'), 'no');
  const reader = response.body.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  assert.match(first, /event: tts.audio/);
  assert.doesNotMatch(first, /tts.completed/);
  assert.equal(commits, 0);
  finish(); let remaining = '';
  for (;;) { const { value, done } = await reader.read(); if (done) break; remaining += new TextDecoder().decode(value); }
  assert.match(remaining, /"state":"COMPLETED"/);
  const repeated = await streamRequest(base, message, 'stream-2');
  assert.match(await repeated.text(), /"state":"COMPLETED"/);
  assert.equal(calls, 1); assert.equal(charges, 1); assert.equal(commits, 1);
});
test('stream enforces source ownership and output moderation before any audio/provider call', async (t) => {
  let calls = 0;
  const { base, message } = await source(t, {
    ttsGenerator: async () => { calls += 1; throw new Error('must never call'); },
    textModerator: async ({ direction }) => ({ decision: direction === 'TTS_OUTPUT' ? 'BLOCK' : 'PASS', policyVersion: 'p1' })
  });
  await displayAndPass(base, 'dev-bob-token', 'bob');
  const foreign = await streamRequest(base, message, 'foreign', 'dev-bob-token'); assert.equal(foreign.status, 404);
  const response = await streamRequest(base, message); const events = await response.text();
  assert.match(events, /"state":"BLOCKED"/); assert.doesNotMatch(events, /tts.audio/); assert.equal(calls, 0);
});
test('aggregate-only basic TTS still emits one playable audio event', async (t) => {
  const { base, message } = await source(t, { ttsGenerator: async () => ({ asset: { bytes: Buffer.from('basic-mp3'), mimeType: 'audio/mpeg' }, providerRequestId: 'tts-basic' }) });
  const response = await streamRequest(base, message); const events = await response.text();
  assert.match(events, /event: tts.audio/); assert.match(events, /"state":"COMPLETED"/);
});

test('simultaneous stream requests for the same source share synthesis and one quota reservation', async (t) => {
  let finish, calls = 0, reserves = 0;
  const wait = new Promise((resolve) => { finish = resolve; });
  const { base, message } = await source(t, {
    ttsGenerator: async ({ onAudioSegment }) => { calls += 1; onAudioSegment(Buffer.from('first')); await wait; return { asset: { bytes: Buffer.from('all'), mimeType: 'audio/mpeg' }, providerRequestId: 'one' }; },
    imageEntitlementService: { reserve() { reserves += 1; return { entitlement_id: 'quota' }; }, commit() {}, release() {} }
  });
  const first = await streamRequest(base, message);
  const reader = first.body.getReader(); await reader.read();
  const second = streamRequest(base, message, 'parallel');
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(calls, 1); assert.equal(reserves, 1); finish();
  while (!(await reader.read()).done) {}
  assert.match(await (await second).text(), /"state":"COMPLETED"/);
  assert.equal(calls, 1); assert.equal(reserves, 1);
});
test('cancel after audio delivery commits only delivered MP3 duration capped by reservation', async (t) => {
  let settled, committed = 0, reserved = 0, releases = 0;
  const settledPromise = new Promise((resolve) => { settled = resolve; });
  const frame = Buffer.alloc(417); frame.set([255, 251, 144, 0]);
  const { base, message } = await source(t, {
    ttsGenerator: async ({ onAudioSegment, signal }) => {
      onAudioSegment(Buffer.concat(Array(40).fill(frame)));
      await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('cancel'), { code: 'TTS_STREAM_ABORTED' })), { once: true }));
    },
    imageEntitlementService: { reserve({ quantity }) { reserved = quantity; return { entitlement_id: 'quota' }; }, commit({ quantity }) { committed = quantity; settled(); }, release() { releases += 1; settled(); } }
  });
  const controller = new AbortController(); const response = await streamRequest(base, message, 'cancel', 'dev-alice-token', controller.signal);
  await response.body.getReader().read(); controller.abort(); await settledPromise;
  assert.equal(committed, Math.min(2, reserved)); assert.equal(releases, 0);
});
test('cancel before first audio returns the entire reserved quota', async (t) => {
  let started, settled, committed = 0, releases = 0;
  const startPromise = new Promise((resolve) => { started = resolve; });
  const settlePromise = new Promise((resolve) => { settled = resolve; });
  const { base, message } = await source(t, {
    ttsGenerator: async ({ signal }) => {
      started(); await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('cancel'), { code: 'TTS_STREAM_ABORTED' })), { once: true }));
    },
    imageEntitlementService: { reserve() { return { entitlement_id: 'quota' }; }, commit() { committed += 1; settled(); }, release() { releases += 1; settled(); } }
  });
  const controller = new AbortController(); const response = streamRequest(base, message, 'no-audio-cancel', 'dev-alice-token', controller.signal);
  const failure = response.catch((error) => error); await startPromise; controller.abort(); await failure; await settlePromise;
  assert.equal(committed, 0); assert.equal(releases, 1);
});

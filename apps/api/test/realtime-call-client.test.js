'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
function load({ strictDefaultFetch, timers = {} } = {}) {
  const source = fs.readFileSync(path.resolve(__dirname, '../../web/realtime-call-client.js'), 'utf8').replace(/^import .*;$/m, '').replace(/export /g, '');
  const setup = strictDefaultFetch ? 'globalThis.fetch = function(...args) { if (this !== globalThis) throw new Error("Illegal invocation"); return globalThis.strictDefaultFetch(...args); };\n' : '';
  return vm.runInNewContext(`${setup}${source}\nRealtimeCallClient`, { Uint8Array, performance, AbortController, TextDecoder, atob, btoa, strictDefaultFetch,
    setTimeout: timers.setTimeout || setTimeout, clearTimeout: timers.clearTimeout || clearTimeout, URL, location: { href: 'https://qiyu.example.test/chat' }, CALL_VAD_SPEAK_THRESHOLD: 0.045, CALL_BARGE_IN_THRESHOLD: 0.12, crypto: require('node:crypto').webcrypto });
}
const wait = () => new Promise((resolve) => setImmediate(resolve));

test('first call prepares its conversation after synchronously unlocking audio, without sending text', async () => {
  const f = fixture(); const order=[];
  f.context.resume=async()=>{order.push('audio');};
  f.client.conversationId=null;
  f.client.prepareConversation=async()=>{order.push('conversation');return 'first-call-conversation';};
  const pending=f.client.start();
  assert.deepEqual(order,['audio'], 'audio resume stays in the user gesture call stack');
  await pending;
  assert.deepEqual(order,['audio','conversation']);
  assert.match(f.calls[0].url,/conversations\/first-call-conversation\/realtime-calls$/);
  assert.equal(f.calls.some(call=>call.url.includes('/messages')),false);
  await f.client.end();
});

test('conversation preparation failure does not create a paid session or open the microphone', async () => {
  const f=fixture(); f.client.prepareConversation=async()=>{throw new Error('conversation unavailable');};
  await assert.rejects(f.client.start(),/conversation unavailable/);
  assert.equal(f.calls.length,0); assert.equal(f.micStarts,0); assert.equal(f.context.state,'closed');
});

test('hangup during conversation preparation cancels before any paid session is created', async () => {
  const f=fixture(); let ready;
  f.client.prepareConversation=()=>new Promise(resolve=>{ready=resolve;});
  const started=f.client.start(); await wait(); await f.client.end(); ready('late-conversation'); await started;
  assert.equal(f.calls.length,0); assert.equal(f.micStarts,0); assert.equal(f.context.state,'closed');
});

test('unconfirmed recognition asks to repeat without ending the call or stopping a newer question', async () => {
  const f = fixture(); await f.client.start(); sentence(f);
  f.client.handleEvent('realtime.input-skipped', { question_id: 'q1', code: 'ASR_UNCONFIRMED' });
  assert.equal(f.client.closed, false); assert.equal(f.client.phase, 'ready');
  assert.ok(f.events.some(event => event.type === 'turn-failed' && event.code === 'ASR_UNCONFIRMED'));
  const next = sentence(f, 'q2', 'r2', 's2'); f.client.handleEvent('realtime.audio', next);
  const player = f.players.at(-1);
  f.client.handleEvent('realtime.input-skipped', { question_id: 'q1', code: 'ASR_UNCONFIRMED' });
  assert.equal(player.stopped, false); assert.equal(player.enqueued.length, 1);
  await f.client.end();
});

test('relationship rejection stops the reply without closing and the next question can play', async () => {
  const f = fixture(); await f.client.start();
  const audio = sentence(f); f.client.handleEvent('realtime.audio', audio);
  const old = f.players.at(-1);
  f.client.handleEvent('realtime.response-rejected', { question_id: 'q1', reply_id: 'r1', code: 'OOC_RELATIONSHIP_CONFLICT' });
  assert.equal(old.stopped, true); assert.equal(f.client.closed, false); assert.equal(f.client.phase, 'ready');
  assert.ok(f.events.some(event => event.type === 'turn-failed' && event.code === 'OOC_RELATIONSHIP_CONFLICT'));
  f.client.handleEvent('realtime.audio', audio);
  assert.equal(f.players.at(-1).enqueued.length, 0);
  const next = sentence(f, 'q2', 'r2', 's2'); f.client.handleEvent('realtime.audio', next);
  const current = f.players.at(-1);
  f.client.handleEvent('realtime.response-rejected', { question_id: 'q1', reply_id: 'r1', code: 'OOC_RELATIONSHIP_CONFLICT' });
  assert.equal(current.stopped, false); assert.equal(current.enqueued.length, 1);
  assert.equal(f.client.closed, false); await f.client.end();
});

test('malformed relationship rejection cannot stop arbitrary active playback', async () => {
  const f = fixture(); await f.client.start(); sentence(f);
  assert.throws(() => f.client.handleEvent('realtime.response-rejected', { question_id: 'q1', code: 'OOC_RELATIONSHIP_CONFLICT' }));
  assert.throws(() => f.client.handleEvent('realtime.response-rejected', { question_id: 'q1', reply_id: 'r1', code: 'UNKNOWN_CODE' }));
  await f.client.end();
});
function fixture({ ready = true, slowUpload = false, timers } = {}) {
  const calls = []; const events = []; const players = []; let streamController; let micStarts = 0; let micStops = 0;
  const socket = { readyState: 1, bufferedAmount: 0, frames: [], send(frame) {
    this.frames.push(frame);
    if (!slowUpload) queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ type: 'audio.ack', next_sequence: new DataView(frame.buffer).getUint32(0, false) + 1 }) }));
  }, close() { this.readyState = 3; this.onclose?.(); } };
  const context = { currentTime: 1, state: 'running', async resume() {}, async close() { this.state = 'closed'; } };
  const mic = { bucket: [], stream: { getAudioTracks: () => [track] }, async start() { micStarts++; }, stop() { micStops++; }, setUploading(value) { this.uploading = value; } };
  const track = { enabled: true };
  const json = (data) => ({ ok: true, async json() { return data; } });
  const emit = (type, data) => streamController.enqueue(new TextEncoder().encode(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`));
  const fetchImpl = async (url, options) => {
    calls.push({ url, ...options });
    if (url.endsWith('/realtime-calls')) return json({ session_id: 'rt_test', stream_url: '/api/v1/realtime-calls/rt_test/stream', max_duration_ms: 60000, max_responses: 10,
      audio_socket_url: '/api/v1/realtime-calls/rt_test/audio-socket', audio_socket_ticket: 'synthetic_ticket_not_a_real_credential', audio_socket_protocol: 'qiyu-realtime-v1' });
    if (url.endsWith('/stream')) return { ok: true, body: new ReadableStream({ start(controller) {
      streamController = controller;
      if (ready) emit('realtime.ready', {});
    } }) };
    if (slowUpload && url.endsWith('/audio')) return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
    return json({});
  };
  const Client = load({ timers });
  const client = new Client({ apiBase: '/api/v1', authHeaders: () => ({ authorization: 'Bearer synthetic' }), conversationId: 'synthetic-conversation', fetchImpl,
    socketFactory: (url, protocols) => { socket.url = url; socket.protocols = protocols; queueMicrotask(() => socket.onopen?.()); return socket; },
    onEvent: (event) => events.push(event), contextFactory: () => context, micFactory: (options) => { mic.options = options; return mic; },
    playerFactory: () => { const player = { enqueued: [], stopped: false, enqueue(bytes) { this.enqueued.push(bytes); return 1.015; }, stop() { this.stopped = true; } }; players.push(player); return player; } });
  return { client, calls, events, players, context, mic, track, emit, socket, get micStarts() { return micStarts; }, get micStops() { return micStops; } };
}
function sentence(f, question = 'q1', reply = 'r1', segment = 's1') {
  f.client.handleEvent('realtime.speech-start', { question_id: question });
  f.client.handleEvent('realtime.text', { text: '你好。', question_id: question, reply_id: reply, segment_id: segment });
  return { question_id: question, reply_id: reply, segment_id: segment, audio_base64: 'AQACAA==', sample_rate: 24000, format: 'pcm_s16le', ai_generated: true };
}

test('native client waits for stream readiness before opening microphone and streams 100ms PCM', async () => {
  const f = fixture({ ready: false }); const started = f.client.start(); await wait();
  assert.equal(f.micStarts, 0); assert.equal(f.client.phase, 'ringing');
  f.emit('realtime.ready', {}); await started;
  assert.equal(f.micStarts, 1); assert.equal(f.mic.options.chunkMs, 100); assert.equal(f.mic.options.rawPcm, true);
  f.mic.options.onChunk(new Uint8Array([1, 0, 2, 0]).buffer); await wait();
  assert.equal(new DataView(f.socket.frames[0].buffer).getUint32(0, false), 0);
  assert.deepEqual([...f.socket.frames[0].subarray(4)], [1, 0, 2, 0]);
  assert.equal(f.socket.url, 'wss://qiyu.example.test/api/v1/realtime-calls/rt_test/audio-socket');
  assert.equal(f.socket.protocols[0], 'qiyu-realtime-v1'); assert.equal(f.socket.url.includes('ticket'), false);
  assert.equal(f.calls.some((call) => call.url.endsWith('/audio')), false);
  await f.client.end();
});
test('first native PCM schedules immediately, diagnostics explicitly exclude acoustic verification', async () => {
  const f = fixture(); await f.client.start();
  const audio = sentence(f); f.client.lastSpeechAt = performance.now() - 400; f.client.handleEvent('realtime.audio', audio);
  assert.equal(f.players.at(-1).enqueued.length, 1); assert.equal(f.client.lastTurnTiming.acousticOnsetVerified, false);
  assert.ok(f.client.lastTurnTiming.firstScheduledMs >= 400 && f.client.lastTurnTiming.firstScheduledMs < 1000);
  await f.client.end();
});
test('unknown/unapproved audio cannot play and cross-question late audio is discarded', async () => {
  const f = fixture(); await f.client.start();
  const audio = sentence(f); assert.throws(() => f.client.handleEvent('realtime.audio', { ...audio, segment_id: 'unapproved' }));
  f.client.handleEvent('realtime.speech-start', { question_id: 'q2' });
  f.client.handleEvent('realtime.audio', audio); assert.equal(f.players.at(-1).enqueued.length, 0);
  await f.client.end();
});
test('local barge-in stops queued PCM and late old reply never restarts; connection remains for next turn', async () => {
  const f = fixture(); await f.client.start(); const audio = sentence(f); f.client.handleEvent('realtime.audio', audio);
  const old = f.players.at(-1); f.client.handleEnergy(0.2, 1000); f.client.handleEnergy(0.2, 1160);
  assert.equal(old.stopped, true); assert.equal(f.client.phase, 'recording');
  f.client.handleEvent('realtime.audio', audio); assert.equal(f.players.at(-1).enqueued.length, 0);
  const next = sentence(f, 'q2', 'r2', 's2'); f.client.handleEvent('realtime.audio', next);
  f.client.handleEvent('realtime.response-completed', { reply_id: 'r2', completed_rounds: 2 });
  assert.equal(f.client.closed, false); assert.equal(f.players.at(-1).enqueued.length, 1);
  await f.client.end();
});
test('mute disables live tracks and hangup clears tracks audio queues and late callbacks', async () => {
  const f = fixture(); await f.client.start(); f.client.setMuted(true); assert.equal(f.track.enabled, false);
  f.client.setMuted(false); assert.equal(f.track.enabled, true);
  const audio = sentence(f); f.client.handleEvent('realtime.audio', audio); await f.client.hangup();
  assert.equal(f.context.state, 'closed'); assert.ok(f.micStops >= 1); assert.equal(f.socket.readyState, 3);
  const count = f.players.at(-1).enqueued.length; f.client.handleEvent('realtime.audio', audio);
  assert.equal(f.players.at(-1).enqueued.length, count); assert.equal(f.client.phase, 'ended');
});
test('delayed acknowledgements beyond one second recover without dropping or replaying audio', async () => {
  const f = fixture({ slowUpload: true }); await f.client.start();
  for (let index = 0; index < 25; index++) f.client.uploadChunk(new Uint8Array(3200).fill(index));
  assert.equal(f.client.closed, false); assert.equal(f.socket.frames.length, 20); assert.equal(f.client.uploadQueue.length, 5);
  f.socket.onmessage({ data: JSON.stringify({ type: 'audio.ack', next_sequence: 20 }) });
  assert.equal(f.socket.frames.length, 25); assert.equal(f.client.uploadQueue.length, 0);
  assert.deepEqual(f.socket.frames.map(frame => new DataView(frame.buffer).getUint32(0, false)), Array.from({ length: 25 }, (_, index) => index));
  assert.deepEqual(f.socket.frames.map(frame => frame[4]), Array.from({ length: 25 }, (_, index) => index));
  await f.client.end();
});
test('temporary socket congestion queues audio then resumes on the existing connection', async () => {
  const f = fixture(); await f.client.start(); f.socket.bufferedAmount = 40000;
  for (let index = 0; index < 12; index++) f.client.uploadChunk(new Uint8Array(3200));
  assert.equal(f.client.closed, false); assert.equal(f.socket.frames.length, 0);
  f.socket.bufferedAmount = 0; await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(f.socket.frames.length, 12); assert.equal(f.client.closed, false);
  await f.client.end();
});
test('sustained upload congestion is bounded to three seconds and never reconnects or retries', async () => {
  const f = fixture({ slowUpload: true }); await f.client.start();
  for (let index = 0; index < 31; index++) f.client.uploadChunk(new Uint8Array(3200));
  await wait(); assert.equal(f.client.closed, true); assert.equal(f.socket.frames.length, 20);
  assert.equal(f.client.uploadQueue.length, 0); assert.equal(f.client.inflightBytes, 0);
  assert.equal(f.calls.filter(call => call.url.endsWith('/realtime-calls')).length, 1);
  assert.equal(f.calls.filter(call => call.url.endsWith('/end')).length, 1);
});
test('a server duration contract above sixty seconds has no competing client cutoff and twelve replies continue', async () => {
  const timers = [];
  const f = fixture({ timers: { setTimeout: (callback, delay) => { timers.push({ callback, delay }); return setTimeout(callback, delay); } } });
  await f.client.start();
  assert.equal(timers.some(timer => timer.delay === 60000), false);
  for (let round = 1; round <= 12; round++) {
    sentence(f, `q${round}`, `r${round}`, `s${round}`);
    f.client.handleEvent('realtime.response-completed', { reply_id: `r${round}`, completed_rounds: round });
  }
  assert.equal(f.client.closed, false); assert.equal(f.events.filter(event => event.type === 'response-complete').length, 12);
  await f.client.end();
});
test('server closure ends capture without reconnect and bounded end request is sent once', async () => {
  const f = fixture(); await f.client.start(); f.emit('realtime.closed', { reason: 'DURATION_CAP' });
  await wait(); await f.client.end();
  assert.equal(f.client.phase, 'ended'); assert.equal(f.calls.filter((call) => call.url.endsWith('/realtime-calls')).length, 1);
  assert.equal(f.calls.filter((call) => call.url.endsWith('/end')).length, 1);
});
test('actual registry SSE names and correlation fields drive native client through two responses', async () => {
  const { RealtimeCallRegistry } = require('../src/domain/realtime-call');
  const f = fixture(); await f.client.start(); let providerEvent;
  const registry = new RealtimeCallRegistry({ provider: { async createSession({ onEvent }) { providerEvent = onEvent; return { close() {} }; } }, transact: async () => ({ canContinue: true }) });
  const item = registry.create({ accountId: 'synthetic', conversationId: 'synthetic', context: { character: { name: '林语', persona: {} } }, reservation: {} });
  const connection = registry.connect(item, (event, data) => f.client.handleEvent(event, data)); await wait();
  async function send(event) { providerEvent(event); await item.chain; }
  try {
    for (const suffix of ['1', '2']) {
      const questionId = `q${suffix}`; const replyId = `r${suffix}`; const segmentId = `s${suffix}`;
      await send({ type: 'speech-start', questionId });
      await send({ type: 'transcript', role: 'user', final: true, questionId, text: '你好。' });
      await send({ type: 'sentence-start', questionId, replyId, segmentId, text: '你好呀。' });
      await send({ type: 'audio', questionId, replyId, segmentId, bytes: Buffer.from([1, 0]), format: 'pcm_s16le', sampleRate: 24000 });
      await send({ type: 'sentence-end', questionId, replyId, segmentId });
      await send({ type: 'response-complete', questionId, replyId });
    }
    assert.equal(item.completedRounds, 2); assert.equal(f.client.closed, false);
    assert.equal(f.events.filter((event) => event.type === 'response-complete').length, 2);
    assert.equal(f.players.filter((player) => player.enqueued.length).length, 2);
  } finally { await registry.close(item); await connection; await f.client.end(); }
});
test('HUD ended callback may reenter hangup without duplicate close requests', async () => {
  const f = fixture(); await f.client.start(); const listener = f.client.onEvent;
  f.client.onEvent = (event) => { listener(event); if (event.type === 'ended') f.client.hangup(); };
  await f.client.hangup(); assert.equal(f.calls.filter((call) => call.url.endsWith('/end')).length, 1);
});
test('default browser fetch keeps Window receiver instead of being rebound to client instance', async () => {
  let requests = 0;
  const Client = load({ strictDefaultFetch: async () => { requests++; return { ok: true, async json() { return { accepted: true }; } }; } });
  const client = new Client({ authHeaders: () => ({}), conversationId: 'synthetic' });
  const result = await client.request('/synthetic', {});
  assert.equal(result.accepted, true); assert.equal(requests, 1);
});

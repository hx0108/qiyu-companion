'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.resolve(__dirname, '../../web/app.js'), 'utf8');
function harness() {
  const requests = [];
  const state = { route: 'chat', character: { version: 1, persona: { gender: 'female' } }, messages: [], audioUrls: new Map() };
  const code = source.slice(source.indexOf('let preparedMessageAudio ='), source.indexOf('async function synthesizeMessageAudio'));
  const context = { state, AbortController, DOMException, TextDecoder, render() {}, URL: { revokeObjectURL() {} },
    conversationId: () => 'conv1', characterId: () => 'character1', messageId: m => m?.message_id,
    authenticatedHeaders: () => new Headers(), uuid: () => 'key', API_BASE: '/api/v1',
    apiError: (message, status) => Object.assign(new Error(message), { status }),
    apiAudio: async () => ({ url: 'blob:synthetic', bytes: new Uint8Array([1]) }),
    fetch: async (url, options) => {
      let controller;
      const body = new ReadableStream({ start(value) { controller = value; } });
      options.signal.addEventListener('abort', () => controller.error(new DOMException('Cancelled', 'AbortError')), { once: true });
      const request = { url, options, send(event, data) { controller.enqueue(new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)); }, close() { controller.close(); } };
      requests.push(request);
      return { ok: true, body };
    },
  };
  const api = vm.runInNewContext(`${code}\n({prepareMessageAudio, preparedAudioEvents, prewarmLatestMessageAudio, invalidatePreparedMessageAudio})`, context);
  const message = { message_id: 'reply1', actor: 'ASSISTANT', text: '你好。' }; state.messages.push(message);
  return { ...api, state, message, requests };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
function complete(request) { request.send('tts.completed', { tts_job: { state: 'COMPLETED', result_asset_id: 'asset1' } }); request.close(); }
test('click subscribes to prewarming and receives first bytes before synthesis finishes, with one provider request', async () => {
  const h = harness(); h.prewarmLatestMessageAudio(h.message); await tick();
  const task = h.prepareMessageAudio(h.message), events = h.preparedAudioEvents(task);
  h.requests[0].send('tts.audio', { audio_base64: 'AQ==' });
  assert.equal((await events.next()).value.event, 'tts.audio'); assert.equal(task.done, false); assert.equal(h.requests.length, 1);
  complete(h.requests[0]); await task.completion;
  assert.equal(h.state.audioUrls.get('reply1').bytes[0], 1);
});
test('prewarm never plays audio, and only newest short ordinary assistant reply is eligible', async () => {
  const h = harness(); h.state.messages.push({ message_id: 'new', actor: 'ASSISTANT', text: 'new' });
  h.prewarmLatestMessageAudio(h.message); h.prewarmLatestMessageAudio(h.state.messages[1] = { message_id: 'new', actor: 'ASSISTANT', text: 'x'.repeat(501) });
  await tick(); assert.equal(h.requests.length, 0);
});
test('automatic failure is not retried by re-render/requeue; explicit click may retry', async () => {
  const h = harness(); h.prewarmLatestMessageAudio(h.message); await tick();
  const task = h.prepareMessageAudio(h.message);
  h.requests[0].send('tts.completed', { tts_job: { state: 'FAILED', failure_code: 'ENTITLEMENT_QUOTA_EXCEEDED' } }); h.requests[0].close(); await task.completion;
  h.prewarmLatestMessageAudio(h.message); await tick(); assert.equal(h.requests.length, 1);
  const retry = h.prepareMessageAudio(h.message); await tick(); assert.equal(h.requests.length, 2); complete(h.requests[1]); await retry.completion;
});
test('successive replies serialize requests and abort superseded synthesis', async () => {
  const h = harness(); h.prewarmLatestMessageAudio(h.message); await tick();
  const next = { message_id: 'reply2', actor: 'ASSISTANT', text: '第二句' }; h.state.messages.push(next); h.prewarmLatestMessageAudio(next); await tick();
  assert.equal(h.requests[0].options.signal.aborted, true); assert.equal(h.requests.length, 2);
  complete(h.requests[1]); await h.prepareMessageAudio(next).completion;
});
test('leaving chat or changing voice version invalidates in-flight warmup', async () => {
  for (const mutate of [h => { h.state.route = 'call'; }, h => { h.state.character.version++; }, h => { h.state.character.persona.gender = 'male'; }]) {
    const h = harness(); h.prewarmLatestMessageAudio(h.message); await tick(); mutate(h); h.invalidatePreparedMessageAudio();
    assert.equal(h.requests[0].options.signal.aborted, true);
  }
});
test('prewarm starts only from persisted final reply paths; history and render never synthesize automatically', () => {
  assert.match(source, /state\.messages\[index\] = finalMessage;\s*prewarmLatestMessageAudio\(finalMessage\)/);
  assert.match(source, /prewarmLatestMessageAudio\(assistant\)/);
  const render = source.slice(source.indexOf('function render()'), source.indexOf('function render()') + 300);
  assert.doesNotMatch(render, /prewarmLatestMessageAudio|prepareMessageAudio\(/);
});

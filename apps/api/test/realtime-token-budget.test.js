'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { DevelopmentStore } = require('../src/domain/store');
const { estimateInputTokens, usageKey, usageDate } = require('../src/domain/daily-chat-usage');

async function fixture(t, { rollbackNativeCommit = false } = {}) {
  const store = new DevelopmentStore(); let providerOptions;
  const server = createApp({ store, trialAuthEnabled: true, trialAuth: { resolveAccessToken: async () => 'acct_dev_alice' }, realtimeCallEnabled: true,
    realtimeProvider: { model: 'synthetic', async createSession(options) { providerOptions = options; return { close() {}, sendAudio() {} }; } }, textModerator: async () => ({ decision: 'PASS' }), summaryEnabled: false });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const base = `http://127.0.0.1:${server.address().port}`; let key = 0, sessionId, reader;
  const request = async (route, body) => { const response = await fetch(base + '/api/v1' + route, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: 'Bearer synthetic', 'content-type': 'application/json', 'idempotency-key': `budget-${++key}` }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: response.status, data: await response.json() }; };
  t.after(async () => { if (sessionId) await request(`/realtime-calls/${sessionId}/end`, {}); await reader?.cancel(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  for (const notice of (await request('/required-notices')).data.notices) await request(`/required-notices/${notice.notice_id}/displayed`, { notice_version: notice.notice_version });
  await request('/age/declarations', { date_of_birth: '1990-01-01', confirmed_18_plus: true });
  const character = (await request('/characters', { name: '林语' })).data.character;
  const conversation = (await request('/conversations', { character_id: character.character_id })).data.conversation;
  if (rollbackNativeCommit) {
    let armed = true;
    store.withAccountTransaction = async (_accountId, operation) => {
      const snapshots = ['dailyChatUsage', 'messages', 'candidates'].map(name => [name, structuredClone(store[name])]);
      const result = await operation(store);
      if (armed && [...store.messages.values()].some(item => item.provider === 'volcengine-realtime')) {
        armed = false;
        for (const [name, snapshot] of snapshots) { store[name].clear(); for (const [id, item] of snapshot) store[name].set(id, item); }
        throw Object.assign(new Error('synthetic post-operation database commit failure'), { code: 'SYNTHETIC_COMMIT_FAILED' });
      }
      return result;
    };
  }
  let pending = '';
  async function event() {
    while (!pending.includes('\n\n')) { const next = await reader.read(); if (next.done) throw new Error('SSE closed before event'); pending += new TextDecoder().decode(next.value); }
    const boundary = pending.indexOf('\n\n'), block = pending.slice(0, boundary); pending = pending.slice(boundary + 2);
    return { type: block.match(/^event: (.+)/m)?.[1], data: JSON.parse(block.match(/^data: (.+)/m)?.[1] || '{}') };
  }
  return { store, character, conversation, request, get options() { return providerOptions; }, get usage() { return [...store.dailyChatUsage.values()][0]; }, event,
    async start() { const result = await request(`/conversations/${conversation.conversation_id}/realtime-calls`, {}); assert.equal(result.status, 201); sessionId = result.data.session_id; const response = await fetch(base + result.data.stream_url, { headers: { authorization: 'Bearer synthetic' } }); reader = response.body.getReader(); assert.equal((await event()).type, 'realtime.ready'); } };
}
function addClippedMemory(f) {
  f.store.assets.set('clipped-budget-memory', { asset_id: 'clipped-budget-memory', account_id: 'acct_dev_alice', character_id: f.character.character_id, type: 'memory', state: 'ACTIVE', version: 1, display_text: '未注入记忆'.repeat(3000) });
}

test('native token reservation counts the transmitted prompt rather than clipped memory and source metadata', async t => {
  const f = await fixture(t); addClippedMemory(f); await f.start();
  assert.equal(f.options.instructions.includes('未注入记忆'), false);
  const sent = JSON.stringify({ instructions: f.options.instructions, context: f.options.context, speaking_style: f.options.speakingStyle });
  assert.equal(f.usage.reserved_input_tokens, estimateInputTokens(sent + '语'.repeat(2000)));
});

test('a rolled-back native message commit restores its reservation before close settles the ledger', async t => {
  const f = await fixture(t, { rollbackNativeCommit: true }); await f.start();
  const fields = { questionId: 'rollback-q', replyId: 'rollback-r', segmentId: 'rollback-s' };
  for (const event of [{ type: 'speech-start' }, { type: 'transcript', role: 'user', final: true, text: '今天想聊聊。' }, { type: 'sentence-start', text: '我在听。' }, { type: 'audio', bytes: Buffer.from([1, 0]), sampleRate: 24000, format: 'pcm_s16le' }, { type: 'sentence-end' }, { type: 'response-complete' }]) f.options.onEvent({ ...fields, ...event });
  let closed;
  for (;;) { const event = await f.event(); if (event.type === 'realtime.closed') { closed = event.data; break; } }
  assert.equal(closed.reason, 'SYNTHETIC_COMMIT_FAILED');
  assert.equal(f.usage.reserved_input_tokens, 0, 'database rollback must not strand the previous live reservation');
  assert.equal(f.usage.chat_rounds, 1, 'already delivered audio settles once despite message rollback');
  assert.equal([...f.store.messages.values()].filter(item => item.provider === 'volcengine-realtime').length, 0);
});

test('a full allowed user utterance uses the same transmitted prompt budget and completes despite clipped memory', async t => {
  const f = await fixture(t); addClippedMemory(f); await f.start();
  const first = f.usage.reserved_input_tokens, userText = '云'.repeat(2000), assistantText = '我在听。';
  const ids = { questionId: 'q-budget', replyId: 'r-budget', segmentId: 's-budget' };
  for (const event of [{ type: 'speech-start' }, { type: 'transcript', role: 'user', final: true, text: userText }, { type: 'sentence-start', text: assistantText }, { type: 'audio', bytes: Buffer.from([1, 0]), sampleRate: 24000, format: 'pcm_s16le' }, { type: 'sentence-end' }, { type: 'response-complete' }]) f.options.onEvent({ ...ids, ...event });
  for (;;) { const item = await f.event(); assert.notEqual(item.type, 'realtime.closed', item.data.reason); if (item.type === 'realtime.response-completed') break; }
  const sent = JSON.stringify({ instructions: f.options.instructions, context: f.options.context });
  const consumed = Math.ceil((Buffer.byteLength(sent, 'utf8') + Buffer.byteLength(JSON.stringify({ role: 'user', text: userText }), 'utf8')) / 2);
  assert.equal(f.usage.billed_input_tokens, consumed);
  assert.ok(consumed < first, 'unused input headroom must be released rather than billed');
  const delta = Math.ceil(Buffer.byteLength(JSON.stringify([{ role: 'user', text: userText }, { role: 'assistant', text: assistantText }]), 'utf8') / 2);
  assert.equal(f.usage.reserved_input_tokens, first + delta);
  assert.equal([...f.store.messages.values()].filter(item => item.provider === 'volcengine-realtime').length, 2);
});

test('interrupted known dialogue expands the next reservation once and duplicated speech starts do not recount it', async t => {
  const f = await fixture(t); await f.start(); const first = f.usage.reserved_input_tokens;
  const userText = '今天想聊聊。', assistantText = '我在听。', ids = { questionId: 'old-q', replyId: 'old-r', segmentId: 'old-s' };
  for (const event of [{ type: 'speech-start' }, { type: 'transcript', role: 'user', final: true, text: userText }, { type: 'sentence-start', text: assistantText }, { type: 'audio', bytes: Buffer.from([1, 0]), sampleRate: 24000, format: 'pcm_s16le' }]) f.options.onEvent({ ...ids, ...event });
  while ((await f.event()).type !== 'realtime.audio') {}
  f.options.onEvent({ type: 'speech-start', questionId: 'empty-q' });
  f.options.onEvent({ type: 'speech-start', questionId: 'empty-q' });
  f.options.onEvent({ type: 'speech-start', questionId: 'next-q' });
  f.options.onEvent({ type: 'transcript', role: 'user', final: true, questionId: 'next-q', text: '接着说。' });
  for (;;) { const event = await f.event(); assert.notEqual(event.type, 'realtime.closed', event.data.reason); if (event.type === 'realtime.transcript' && event.data.question_id === 'next-q') break; }
  const delta = Math.ceil(Buffer.byteLength(JSON.stringify([{ role: 'user', text: userText }, { role: 'assistant', text: assistantText }]), 'utf8') / 2);
  assert.equal(f.usage.reserved_input_tokens, first + delta);
  assert.equal(f.usage.chat_rounds, 2, 'one audible interrupted round plus the next reservation');
  assert.equal([...f.store.messages.values()].filter(item => item.provider === 'volcengine-realtime').length, 0, 'interrupted dialogue is context only, not completed history');
});

test('exhausted daily rounds or token quota rejects native dial with HTTP 429', async t => {
  for (const [rounds, tokens, code] of [[100, 0, 'DAILY_CHAT_LIMIT_REACHED'], [0, 320000, 'TOKEN_LIMIT_REACHED']]) {
    const f = await fixture(t), now = new Date(), accountId = 'acct_dev_alice';
    f.store.dailyChatUsage.set(usageKey(accountId, now), { account_id: accountId, usage_date: usageDate(now), chat_rounds: rounds, billed_input_tokens: tokens, reserved_input_tokens: 0, updated_at: now.toISOString() });
    const result = await f.request(`/conversations/${f.conversation.conversation_id}/realtime-calls`, {});
    assert.equal(result.status, 429); assert.equal(result.data.error.code, code);
    assert.equal(f.options, undefined, 'quota exhaustion must not open the paid provider');
  }
});

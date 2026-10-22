'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { DevelopmentStore } = require('../src/domain/store');

async function fixture(t, overrides = {}) {
  const store = new DevelopmentStore(); let providerOptions; let sent = 0;
  const provider = { model: 'mock-native', async createSession(options) {
    providerOptions = options;
    return { close() {}, async sendAudio() { sent += 1; } };
  } };
  const server = createApp({ store, trialAuthEnabled: true, trialAuth: { resolveAccessToken: async (token) => token === 'alice' ? 'acct_dev_alice' : token === 'bob' ? 'acct_dev_bob' : null }, voiceCallEnabled: true, asrTranscriber: async () => ({ text: '你好' }), realtimeCallEnabled: true, realtimeProvider: provider, textModerator: async () => ({ decision: 'PASS' }), ...overrides });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  let key = 0;
  const request = async (path, method = 'GET', body, token = 'alice') => {
    const response = await fetch(base + '/api/v1' + path, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'idempotency-key': `test-${++key}` }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const notice = (await request('/required-notices')).body.notices[0];
  await request(`/required-notices/${notice.notice_id}/displayed`, 'POST', { notice_version: notice.notice_version });
  await request('/age/declarations', 'POST', { date_of_birth: '1990-01-01', confirmed_18_plus: true });
  const character = (await request('/characters', 'POST', { name: '林语' })).body.character;
  const conversation = (await request('/conversations', 'POST', { character_id: character.character_id })).body.conversation;
  return { store, request, base, conversation, character, get options() { return providerOptions; }, get sent() { return sent; } };
}

async function nextEvent(reader, state, expected) {
  for (;;) {
    while (state.buffer.includes('\n\n')) {
      const index = state.buffer.indexOf('\n\n'); const block = state.buffer.slice(0, index); state.buffer = state.buffer.slice(index + 2);
      if (block.includes(`event: ${expected}\n`)) return JSON.parse(block.split('\n').find((line) => line.startsWith('data: ')).slice(6));
    }
    const { value, done } = await reader.read();
    if (done) throw new Error(`stream ended before ${expected}`);
    state.buffer += new TextDecoder().decode(value);
  }
}

test('a completed native call message can be replayed through the ordinary TTS stream', async (t) => {
  let ttsCalls = 0;
  const f = await fixture(t, {
    ttsGenerator: async ({ onAudioSegment }) => {
      ttsCalls += 1; const bytes = Buffer.from('synthetic-local-mp3'); onAudioSegment?.(bytes);
      return { asset: { bytes, mimeType: 'audio/mpeg' }, providerRequestId: 'local-replay' };
    },
    mediaStore: { async createPendingJob() {}, async updateJob() {}, async putAudio({ bytes }) { return { objectKey: 'test/native-replay.mp3', checksum: 'a'.repeat(64), byteLength: bytes.length, mimeType: 'audio/mpeg' }; } }
  });
  const created = await f.request(`/conversations/${f.conversation.conversation_id}/realtime-calls`, 'POST', {});
  const stream = await fetch(f.base + created.body.stream_url, { headers: { authorization: 'Bearer alice' } });
  const reader = stream.body.getReader(); const state = { buffer: '' }; await nextEvent(reader, state, 'realtime.ready');
  const questionId = 'replay-q', replyId = 'replay-r', segmentId = 'replay-s';
  for (const event of [
    { type: 'speech-start', questionId },
    { type: 'transcript', role: 'user', text: '你好。', final: true, questionId },
    { type: 'sentence-start', text: '你好呀。', questionId, replyId, segmentId },
    { type: 'audio', bytes: Buffer.alloc(480), sampleRate: 24000, format: 'pcm_s16le', questionId, replyId, segmentId },
    { type: 'sentence-end', questionId, replyId, segmentId },
    { type: 'response-complete', questionId, replyId }
  ]) f.options.onEvent(event);
  await nextEvent(reader, state, 'realtime.response-completed');
  await f.request(`/realtime-calls/${created.body.session_id}/end`, 'POST', {}); await nextEvent(reader, state, 'realtime.closed');
  const message = [...f.store.messages.values()].find(item => item.provider === 'volcengine-realtime' && item.actor === 'ASSISTANT');
  const replay = await fetch(`${f.base}/api/v1/messages/${message.message_id}/tts-stream`, { method: 'POST', headers: { authorization: 'Bearer alice', 'idempotency-key': 'native-replay', 'content-type': 'application/json' }, body: '{}' });
  const replayEvents = await replay.text();
  assert.match(replayEvents, /event: tts.audio/, replayEvents);
  assert.match(replayEvents, /"state":"COMPLETED"/);
  assert.equal(ttsCalls, 1);
});

test('historical native messages without a recorded scene snapshot fail explicitly without inventing current state', async (t) => {
  let ttsCalls = 0;
  const f = await fixture(t, {
    ttsGenerator: async ({ onAudioSegment }) => {
      ttsCalls += 1; const bytes = Buffer.from('synthetic-legacy-mp3'); onAudioSegment?.(bytes);
      return { asset: { bytes, mimeType: 'audio/mpeg' }, providerRequestId: 'local-legacy' };
    },
    mediaStore: { async createPendingJob() {}, async updateJob() {}, async putAudio({ bytes }) { return { objectKey: 'test/native-legacy.mp3', checksum: 'b'.repeat(64), byteLength: bytes.length, mimeType: 'audio/mpeg' }; } }
  });
  const message = { message_id: f.store.next('msg'), conversation_id: f.conversation.conversation_id, actor: 'ASSISTANT', text: '这是一段历史通话台词。', provider: 'volcengine-realtime', model_version: '1.2.1.1', ai_generated: true, created_at: '2026-10-16T00:00:00.000Z', world_state_id: null, world_state_version: null };
  f.store.messages.set(message.message_id, message);
  const replay = await fetch(`${f.base}/api/v1/messages/${message.message_id}/tts-stream`, { method: 'POST', headers: { authorization: 'Bearer alice', 'idempotency-key': 'legacy-native-replay', 'content-type': 'application/json' }, body: '{}' });
  const replayEvents = await replay.text();
  assert.match(replayEvents, /event: message.failed/, replayEvents);
  assert.match(replayEvents, /"code":"MULTIMODAL_SOURCE_SNAPSHOT_MISSING"/);
  assert.doesNotMatch(replayEvents, /event: tts.audio/);
  assert.equal(ttsCalls, 0);
  assert.equal(message.world_state_id, null, 'a replay must not invent the historical scene snapshot');
  assert.equal(message.world_state_version, null);
});

test('native trial HTTP streams twelve audited rounds, persists messages and releases unused reservation', async (t) => {
  const f = await fixture(t);
  const result = await f.request(`/conversations/${f.conversation.conversation_id}/realtime-calls`, 'POST', {});
  assert.equal(result.status, 201); assert.equal(result.body.max_responses, null); assert.equal(result.body.max_duration_ms, 900000); assert.equal(result.body.mode, 'native-realtime');
  assert.equal((await f.request(`/conversations/${f.conversation.conversation_id}/calls`, 'POST', {})).status, 409);
  const id = result.body.session_id;
  const response = await fetch(f.base + result.body.stream_url, { headers: { authorization: 'Bearer alice' } });
  assert.equal(response.status, 200); const reader = response.body.getReader(); const state = { buffer: '' };
  await nextEvent(reader, state, 'realtime.ready');
  assert.ok(Array.isArray(f.options.context)); assert.ok(f.options.instructions.length <= 4000);
  assert.equal((await f.request(`/realtime-calls/${id}/audio`, 'POST', { sequence: 0, audio_base64: Buffer.alloc(3200).toString('base64') }, 'bob')).status, 404);
  assert.equal((await f.request(`/realtime-calls/${id}/audio`, 'POST', { sequence: 0, audio_base64: Buffer.alloc(3200).toString('base64') })).status, 200);
  assert.equal(f.sent, 1);
  for (let round = 1; round <= 12; round += 1) {
    const questionId = `q${round}`, replyId = `r${round}`, segmentId = `s${round}`;
    f.options.onEvent({ type: 'speech-start', questionId });
    f.options.onEvent({ type: 'transcript', role: 'user', text: '你好。', final: false, questionId });
    f.options.onEvent({ type: 'transcript', role: 'user', text: '你好。', final: true, questionId });
    f.options.onEvent({ type: 'sentence-start', text: '你好呀。', questionId, replyId, segmentId });
    f.options.onEvent({ type: 'audio', bytes: Buffer.alloc(480), sampleRate: 24000, format: 'pcm_s16le', questionId, replyId, segmentId });
    f.options.onEvent({ type: 'sentence-end', questionId, replyId, segmentId });
    f.options.onEvent({ type: 'response-complete', questionId, replyId });
    const completed = await nextEvent(reader, state, 'realtime.response-completed'); assert.equal(completed.completed_rounds, round);
  }
  assert.equal([...f.store.messages.values()].filter((message) => message.provider === 'volcengine-realtime').length, 24);
  await f.request(`/realtime-calls/${id}/end`, 'POST', {});
  await nextEvent(reader, state, 'realtime.closed');
  const usage = [...f.store.dailyChatUsage.values()][0];
  assert.equal(usage.chat_rounds, 12); assert.equal(usage.reserved_input_tokens, 0);
  assert.equal(f.store.entitlementLedgers.size, 0);
});

test('native dial carries the active romantic persona and address preference into the provider system role', async (t) => {
  const f = await fixture(t);
  const character = f.store.characters.get(f.character.character_id);
  character.persona = { ...character.persona, relationship_to_user: '用户的女朋友', personality: '温柔但有主见', expression_style: '亲密自然' };
  f.store.userPreferences.set(`acct_dev_alice:${character.character_id}`, { account_id: 'acct_dev_alice', character_id: character.character_id, address_terms: { character_to_user: '亲爱的' }, version: 1 });
  const result = await f.request(`/conversations/${f.conversation.conversation_id}/realtime-calls`, 'POST', {});
  assert.equal(result.status, 201);
  const response = await fetch(f.base + result.body.stream_url, { headers: { authorization: 'Bearer alice' } });
  const reader = response.body.getReader(); const state = { buffer: '' };
  await nextEvent(reader, state, 'realtime.ready');
  assert.match(f.options.instructions, /"与用户的关系":"用户的女朋友"/);
  assert.match(f.options.instructions, /温柔但有主见/);
  assert.match(f.options.instructions, /亲爱的/);
  assert.match(f.options.instructions, /不得默认成好朋友或普通助手/);
  assert.match(f.options.speakingStyle, /亲密自然/);
  assert.match(f.options.speakingStyle, /亲爱的/);
  await f.request(`/realtime-calls/${result.body.session_id}/end`, 'POST', {});
  await nextEvent(reader, state, 'realtime.closed');
});

test('native wrong relationship is not played or persisted and a correct subsequent round stays on the same call', async (t) => {
  const f = await fixture(t);
  const candidateCountBefore = f.store.candidates.size;
  f.store.characters.get(f.character.character_id).persona.relationship_to_user = '用户的女朋友';
  const result = await f.request(`/conversations/${f.conversation.conversation_id}/realtime-calls`, 'POST', {});
  const response = await fetch(f.base + result.body.stream_url, { headers: { authorization: 'Bearer alice' } });
  const reader = response.body.getReader(); const state = { buffer: '' }; await nextEvent(reader, state, 'realtime.ready');
  const publishRound = (number, text, userText = '我们是什么关系？') => {
    const questionId = `q${number}`, replyId = `r${number}`, segmentId = `s${number}`;
    for (const event of [{ type: 'speech-start', questionId }, { type: 'transcript', role: 'user', text: userText, final: true, questionId }, { type: 'sentence-start', text, questionId, replyId, segmentId }, { type: 'audio', bytes: Buffer.alloc(480), sampleRate: 24000, format: 'pcm_s16le', questionId, replyId, segmentId }, { type: 'sentence-end', questionId, replyId, segmentId }, { type: 'response-complete', questionId, replyId }]) f.options.onEvent(event);
  };
  publishRound(1, '我们只是好朋友。');
  assert.deepEqual(await nextEvent(reader, state, 'realtime.response-rejected'), { question_id: 'q1', reply_id: 'r1', code: 'OOC_RELATIONSHIP_CONFLICT' });
  await nextEvent(reader, state, 'realtime.response-skipped');
  assert.equal([...f.store.messages.values()].filter(m => m.provider === 'volcengine-realtime').length, 0);
  assert.equal(f.store.candidates.size, candidateCountBefore);
  assert.equal([...f.store.dailyChatUsage.values()][0].chat_rounds, 1); // One live reservation; the rejected round was released.
  publishRound(2, '我们是恋人呀。');
  assert.equal((await nextEvent(reader, state, 'realtime.response-completed')).completed_rounds, 1);
  const messages = [...f.store.messages.values()].filter(m => m.provider === 'volcengine-realtime');
  assert.equal(messages.length, 2); assert.equal(messages.find(m => m.actor === 'ASSISTANT').text, '我们是恋人呀。');
  publishRound(3, '我们只是好朋友。', '我们分手吧。');
  assert.equal((await nextEvent(reader, state, 'realtime.response-completed')).completed_rounds, 2);
  assert.equal([...f.store.messages.values()].filter(m => m.provider === 'volcengine-realtime').length, 4);
  await f.request(`/realtime-calls/${result.body.session_id}/end`, 'POST', {}); await nextEvent(reader, state, 'realtime.closed');
  assert.equal([...f.store.dailyChatUsage.values()][0].chat_rounds, 2);
  assert.equal([...f.store.dailyChatUsage.values()][0].reserved_input_tokens, 0);
});

test('native unavailable, nontrial and missing moderator are explicit and no provider call happens', async (t) => {
  for (const overrides of [{ realtimeCallEnabled: false }, { realtimeProvider: null }, { textModerator: null }]) {
    const f = await fixture(t, overrides);
    const response = await f.request(`/conversations/${f.conversation.conversation_id}/realtime-calls`, 'POST', {});
    assert.equal(response.status, 503); assert.equal(f.options, undefined);
  }
});

test('native capture stops on account pause and no raw audio is persisted', async (t) => {
  const f = await fixture(t);
  const created = await f.request(`/conversations/${f.conversation.conversation_id}/realtime-calls`, 'POST', {});
  const response = await fetch(f.base + created.body.stream_url, { headers: { authorization: 'Bearer alice' } });
  const reader = response.body.getReader(); const state = { buffer: '' }; await nextEvent(reader, state, 'realtime.ready');
  f.store.account('acct_dev_alice').user_pause_state = 'PAUSED';
  await new Promise(resolve => setTimeout(resolve, 300));
  const upload = await f.request(`/realtime-calls/${created.body.session_id}/audio`, 'POST', { sequence: 0, audio_base64: Buffer.alloc(3200).toString('base64') });
  assert.equal(upload.status, 403); assert.equal(f.sent, 0);
  await f.request(`/realtime-calls/${created.body.session_id}/end`, 'POST', {}); await nextEvent(reader, state, 'realtime.closed');
  assert.equal(f.store.mediaAssets.size, 0);
});

test('background event creation and embedding metadata preserve a call, but an injected fact revision stops it', async t => {
  const f = await fixture(t);
  const asset = { asset_id: 'asset_injected', account_id: 'acct_dev_alice', character_id: f.character.character_id, type: 'boundary', state: 'ACTIVE', version: 1, display_text: '不要替我决定工作。' };
  f.store.assets.set(asset.asset_id, asset);
  const created = await f.request(`/conversations/${f.conversation.conversation_id}/realtime-calls`, 'POST', {});
  const response = await fetch(f.base + created.body.stream_url, { headers: { authorization: 'Bearer alice' } });
  const reader = response.body.getReader(); const state = { buffer: '' }; await nextEvent(reader, state, 'realtime.ready');
  assert.ok(f.options.instructions.includes(asset.display_text));
  f.store.lifeEvents.set('background', { event_id: 'background', account_id: 'acct_dev_alice', character_id: f.character.character_id, status: 'PLANNED', version: 1, title: '后台新增经历' });
  asset.index_state = 'READY'; asset.embedding_model = 'background-index';
  const upload = await f.request(`/realtime-calls/${created.body.session_id}/audio`, 'POST', { sequence: 0, audio_base64: Buffer.alloc(3200).toString('base64') });
  assert.equal(upload.status, 200); assert.equal(f.sent, 1);
  asset.version = 2; asset.display_text = '新边界。';
  await new Promise(resolve => setTimeout(resolve, 300));
  const rejected = await f.request(`/realtime-calls/${created.body.session_id}/audio`, 'POST', { sequence: 1, audio_base64: Buffer.alloc(3200).toString('base64') });
  assert.equal(rejected.status, 409); assert.equal(rejected.body.error.code, 'REALTIME_CONTEXT_CHANGED');
  assert.equal(f.sent, 1);
  assert.equal((await nextEvent(reader, state, 'realtime.closed')).reason, 'REALTIME_CONTEXT_CHANGED');
});

test('facts clipped by prompt budget and older messages outside bridge/history do not invalidate a call', async t => {
  const f = await fixture(t);
  const huge = { asset_id: 'clipped', account_id: 'acct_dev_alice', character_id: f.character.character_id, type: 'memory', state: 'ACTIVE', version: 1, display_text: '超长未注入事实'.repeat(900) };
  f.store.assets.set(huge.asset_id, huge);
  for (let index = 0; index < 100; index++) {
    const id = `old-${String(index).padStart(3, '0')}`;
    f.store.messages.set(id, { message_id: id, conversation_id: f.conversation.conversation_id, actor: index % 2 ? 'ASSISTANT' : 'USER', text: `历史${index}`, created_at: '2026-10-01T00:00:00Z' });
  }
  const created = await f.request(`/conversations/${f.conversation.conversation_id}/realtime-calls`, 'POST', {});
  const response = await fetch(f.base + created.body.stream_url, { headers: { authorization: 'Bearer alice' } });
  const reader = response.body.getReader(); const state = { buffer: '' }; await nextEvent(reader, state, 'realtime.ready');
  assert.equal(f.options.instructions.includes('超长未注入事实'), false);
  assert.equal(f.options.instructions.includes('old-000'), false);
  huge.version++; huge.display_text = '被裁掉事实修改';
  f.store.messages.get('old-000').text = '未注入旧消息修改';
  assert.equal((await f.request(`/realtime-calls/${created.body.session_id}/audio`, 'POST', { sequence: 0, audio_base64: Buffer.alloc(3200).toString('base64') })).status, 200);
  await f.request(`/realtime-calls/${created.body.session_id}/end`, 'POST', {});
  assert.equal((await nextEvent(reader, state, 'realtime.closed')).reason, 'USER_HANGUP');
});

test('an injected summary retains its underlying message revocation checks', async t => {
  const f = await fixture(t);
  const messages = Array.from({ length: 60 }, (_, index) => ({ message_id: `summary-${String(index).padStart(3, '0')}`, conversation_id: f.conversation.conversation_id, actor: index % 2 ? 'ASSISTANT' : 'USER', text: `来源${index}`, created_at: '2026-10-01T00:00:00Z' }));
  for (const message of messages) f.store.messages.set(message.message_id, message);
  const summary = require('../src/domain/conversation-summary').createSummary({ summaryId: 'summary-source', accountId: 'acct_dev_alice', conversationId: f.conversation.conversation_id, messages, revocationEpoch: f.store.account('acct_dev_alice').revocation_epoch, text: '已核验摘要', modelRouteId: 'mock', promptVersion: 'v2', retentionExpiresAt: '2099-01-01T00:00:00Z' });
  f.store.conversationSummaries.set(summary.summary_id, summary);
  const created = await f.request(`/conversations/${f.conversation.conversation_id}/realtime-calls`, 'POST', {});
  const response = await fetch(f.base + created.body.stream_url, { headers: { authorization: 'Bearer alice' } });
  const reader = response.body.getReader(); const state = { buffer: '' }; await nextEvent(reader, state, 'realtime.ready');
  assert.ok(f.options.instructions.includes('已核验摘要'));
  messages[0].text = '摘要来源已修改';
  await new Promise(resolve => setTimeout(resolve, 300));
  const result = await f.request(`/realtime-calls/${created.body.session_id}/audio`, 'POST', { sequence: 0, audio_base64: Buffer.alloc(3200).toString('base64') });
  assert.equal(result.status, 409); assert.equal(f.sent, 0);
  assert.equal((await nextEvent(reader, state, 'realtime.closed')).reason, 'REALTIME_CONTEXT_CHANGED');
});

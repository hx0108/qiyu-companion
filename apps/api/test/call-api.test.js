'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');

// 1:1 通话路由层测试：灰度开关、受理前预检、开场问候、回合边录边传全链、
// 挂断结算与通话记录卡片。回合编排本体（ASR/审核/LLM/TTS/打断/账本）在
// call-turn-engine.test.js 覆盖；这里验证路由协议与状态机接线。

function fakeAsr(text = '今天心情怎么样') {
  return async ({ bytes }) => {
    assert.ok(bytes.length > 0, 'ASR 应收到封账后的完整音频');
    return { text, providerRequestId: 'asr-1' };
  };
}

function fakeStreamingGenerator(fragments) {
  return {
    async generateStream(text, context, onFragment, signal) {
      let sent = '';
      for (const fragment of fragments) {
        if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
        const approved = await onFragment(fragment);
        if (approved === false) throw Object.assign(new Error('intercepted'), { code: 'QWEN_STREAM_INTERCEPTED' });
        sent += fragment;
      }
      return { provider: 'fake-stream', model_version: 'fake-stream-v1', reply_text: sent, usage: { input_tokens: 10, output_tokens: 5 }, ai_generated: true, memory_candidate: null };
    }
  };
}

// basic 聚合合同（无 synthesizeStream）：整句返回，但通过 onAudioSegment 回调
// 逐段下发，模拟流式适配器的即时回调口径。
function fakeTts() {
  return async ({ onAudioSegment }) => {
    onAudioSegment?.(Buffer.from('mp3-frame'));
    return { asset: { bytes: Buffer.from('mp3-frame') }, providerRequestId: 'tts-1' };
  };
}

async function start(t, options = {}) {
  const server = createApp(options);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

async function request(base, pathName, { method = 'GET', token = 'dev-alice-token', key, body } = {}) {
  const headers = { authorization: `Bearer ${token}` };
  if (key) headers['idempotency-key'] = key;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(`${base}${pathName}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}

async function grantTrial(base, prefix) {
  // 试用发放要求年龄准入已完成：必须在 readyConversation 之后调用。
  const trial = await request(base, '/api/v1/subscription-trials', { method: 'POST', key: `${prefix}-trial` });
  assert.ok([200, 201].includes(trial.status), `试用开通应成功：${trial.status}`);
  return trial;
}

async function readyConversation(base, prefix = 'call') {
  const notices = await request(base, '/api/v1/required-notices');
  const notice = notices.body.notices[0];
  await request(base, `/api/v1/required-notices/${notice.notice_id}/displayed`, { method: 'POST', key: `${prefix}-n`, body: { notice_version: notice.notice_version } });
  await request(base, '/api/v1/age/declarations', { method: 'POST', key: `${prefix}-a`, body: { date_of_birth: '1990-01-01', confirmed_18_plus: true } });
  const character = await request(base, '/api/v1/characters', { method: 'POST', key: `${prefix}-c`, body: { name: `${prefix} 角色` } });
  const conversation = await request(base, '/api/v1/conversations', { method: 'POST', key: `${prefix}-v`, body: { character_id: character.body.character.character_id } });
  return conversation.body.conversation.conversation_id;
}

async function startCall(base, conversationId, key) {
  return request(base, `/api/v1/conversations/${conversationId}/calls`, { method: 'POST', key });
}

async function uploadChunk(base, callId, turnId, chunkIndex, bytes, { token = 'dev-alice-token' } = {}) {
  return request(base, `/api/v1/calls/${callId}/turns/${turnId}/audio-chunks`, {
    method: 'POST', token, body: { chunk_index: chunkIndex, audio_base64: Buffer.from(bytes).toString('base64') }
  });
}

async function readSse(base, streamUrl, token = 'dev-alice-token') {
  const response = await fetch(`${base}${streamUrl}`, { headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream' } });
  const raw = await response.text();
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  assert.equal(response.headers.get('x-accel-buffering'), 'no', '必须禁用反代缓冲');
  const events = [];
  for (const block of raw.split(/\r?\n\r?\n/)) {
    const lines = block.split(/\r?\n/).filter(Boolean);
    const eventLine = lines.find((line) => line.startsWith('event:'));
    const dataLine = lines.find((line) => line.startsWith('data:'));
    if (eventLine && dataLine) events.push({ event: eventLine.slice(6).trim(), data: JSON.parse(dataLine.slice(5)) });
  }
  return events;
}

test('通话创建受灰度开关控制：关闭时 404 且 trial-access 不透出，开启时透出', async (t) => {
  const offBase = await start(t, { asrTranscriber: fakeAsr() });
  const accessOff = await request(offBase, '/api/v1/trial-access');
  assert.equal(accessOff.body.voice_call_enabled, false);
  const offConversation = await readyConversation(offBase, 'flagoff');
  const off = await startCall(offBase, offConversation, 'flagoff-call');
  assert.equal(off.status, 404);
  assert.equal(off.body.error.code, 'VOICE_CALL_DISABLED');

  const onBase = await start(t, { asrTranscriber: fakeAsr(), voiceCallEnabled: true });
  const accessOn = await request(onBase, '/api/v1/trial-access');
  assert.equal(accessOn.body.voice_call_enabled, true);
});

test('受理前预检：未配置 ASR 返回 503，语音额度不足返回 409（不创建通话）', async (t) => {
  const noAsrBase = await start(t, { voiceCallEnabled: true });
  const noAsrConversation = await readyConversation(noAsrBase, 'noasr');
  const noAsr = await startCall(noAsrBase, noAsrConversation, 'noasr-call');
  assert.equal(noAsr.status, 503);
  assert.equal(noAsr.body.error.code, 'ASR_PROVIDER_UNAVAILABLE');

  const noQuotaBase = await start(t, { asrTranscriber: fakeAsr(), voiceCallEnabled: true });
  const noQuotaConversation = await readyConversation(noQuotaBase, 'noquota');
  const noQuota = await startCall(noQuotaBase, noQuotaConversation, 'noquota-call');
  assert.equal(noQuota.status, 409);
  assert.equal(noQuota.body.error.code, 'ENTITLEMENT_QUOTA_EXCEEDED');
  const sessions = await request(noQuotaBase, '/api/v1/calls/call_000001');
  assert.equal(sessions.status, 404, '预检失败不得留下通话行');
});

test('开场问候：模板文案同步返回，SSE 走同一音频管线，令牌一次性', async (t) => {
  const base = await start(t, { asrTranscriber: fakeAsr(), ttsGenerator: fakeTts(), voiceCallEnabled: true });
  const conversationId = await readyConversation(base, 'greet');
  await grantTrial(base, 'greet');
  const started = await startCall(base, conversationId, 'greet-call');
  assert.equal(started.status, 201);
  const { call, greeting } = started.body;
  assert.equal(call.state, 'ACTIVE');
  assert.ok(greeting.text.length > 0, '问候文案同步可得');
  assert.equal(greeting.stream.mode, 'call-turn');

  const events = await readSse(base, greeting.stream.stream_url);
  const accepted = events.find((item) => item.event === 'call.turn.accepted');
  const texts = events.filter((item) => item.event === 'call.turn.text');
  const audios = events.filter((item) => item.event === 'call.turn.audio');
  const completed = events.find((item) => item.event === 'call.turn.completed');
  assert.equal(accepted.data.kind, 'greeting');
  assert.deepEqual(texts.map((item) => item.data.text), [greeting.text], 'SSE 文本与受理响应同源');
  assert.ok(audios.length >= 1, '问候应下发音频段');
  assert.equal(audios[0].data.format, 'mp3');
  assert.ok(Buffer.from(audios[0].data.audio_base64, 'base64').length > 0);
  assert.equal(completed.data.greeting, true);
  assert.ok(completed.data.assistant_message_id);

  // 问候消息落库（provider=call-greeting）且带通话标记。
  const messages = await request(base, `/api/v1/conversations/${conversationId}/messages`);
  const greetingMessage = messages.body.messages.find((item) => item.provider === 'call-greeting');
  assert.ok(greetingMessage, '问候应落一条 assistant 消息');
  assert.equal(greetingMessage.call_session_id, call.call_id);

  const replay = await fetch(`${base}${greeting.stream.stream_url}`, { headers: { authorization: 'Bearer dev-alice-token' } });
  assert.equal(replay.status, 409, '问候流令牌一次性');
});

test('回合全链：创建→分块上传→封账→SSE（转写/字幕/音频/completed）→通话记录卡片；活跃期重复发起 409；挂断幂等', async (t) => {
  const base = await start(t, {
    asrTranscriber: fakeAsr('今天心情怎么样'),
    streamingReplyGenerator: fakeStreamingGenerator(['今天也还不错。', '你休息了吗。']),
    ttsGenerator: fakeTts(),
    voiceCallEnabled: true
  });
  const conversationId = await readyConversation(base, 'turn');
  await grantTrial(base, 'turn');
  const started = await startCall(base, conversationId, 'turn-call');
  assert.equal(started.status, 201);
  const callId = started.body.call.call_id;

  // 活跃期再次发起：单账户单 ACTIVE 通话。
  const second = await startCall(base, conversationId, 'turn-call-2');
  assert.equal(second.status, 409);
  assert.equal(second.body.error.code, 'CALL_ALREADY_ACTIVE');

  // 创建回合：UPLOADING + 上行约束。
  const turnCreated = await request(base, `/api/v1/calls/${callId}/turns`, { method: 'POST', key: 'turn-1' });
  assert.equal(turnCreated.status, 201);
  const turn = turnCreated.body.turn;
  assert.equal(turn.state, 'UPLOADING');
  assert.equal(turnCreated.body.upload.mime_type, 'audio/wav');
  assert.equal(turnCreated.body.upload.max_total_bytes, 2000000);
  assert.ok(turnCreated.body.upload.chunk_hint_bytes > 0);

  // 上一回合未终局时不能再开新回合。
  const overlap = await request(base, `/api/v1/calls/${callId}/turns`, { method: 'POST', key: 'turn-2' });
  assert.equal(overlap.status, 409);
  assert.equal(overlap.body.error.code, 'CALL_TURN_OPEN_EXISTS');

  // 未知回合/他人账户的分块上传：404（不泄漏存在性）。
  const unknownTurn = await uploadChunk(base, callId, 'turn_unknown', 0, 'x');
  assert.equal(unknownTurn.status, 404);
  const stranger = await uploadChunk(base, callId, turn.turn_id, 0, 'x', { token: 'dev-bob-token' });
  assert.equal(stranger.status, 404);

  // 乱序块 409，且不破坏序号（补上正确序号仍可继续）。
  const outOfOrder = await uploadChunk(base, callId, turn.turn_id, 3, 'x');
  assert.equal(outOfOrder.status, 409);
  const chunk0 = await uploadChunk(base, callId, turn.turn_id, 0, 'a'.repeat(64000));
  assert.equal(chunk0.status, 200);
  assert.deepEqual(chunk0.body, { turn_id: turn.turn_id, received_bytes: 64000, chunks: 1 });

  // 封账：FINALIZED + 一次性回合流令牌。
  const finalized = await request(base, `/api/v1/calls/${callId}/turns/${turn.turn_id}/finalize`, { method: 'POST', key: 'finalize-1' });
  assert.equal(finalized.status, 202);
  assert.equal(finalized.body.turn.state, 'FINALIZED');
  assert.equal(finalized.body.turn.audio_bytes, 64000);
  assert.equal(finalized.body.turn.chunk_count, 1);
  assert.equal(finalized.body.stream.mode, 'call-turn');
  // 封账后再传块：缓冲已关闭，409。
  const lateChunk = await uploadChunk(base, callId, turn.turn_id, 1, 'x');
  assert.equal(lateChunk.status, 409);

  // 消费回合 SSE：accepted→transcript→text×2→audio→completed(usage)。
  const events = await readSse(base, finalized.body.stream.stream_url);
  const acceptedEvent = events.find((item) => item.event === 'call.turn.accepted');
  const transcript = events.find((item) => item.event === 'call.turn.transcript');
  const texts = events.filter((item) => item.event === 'call.turn.text');
  const audios = events.filter((item) => item.event === 'call.turn.audio');
  const completed = events.find((item) => item.event === 'call.turn.completed');
  assert.equal(acceptedEvent.data.turn_id, turn.turn_id);
  assert.equal(transcript.data.text, '今天心情怎么样');
  assert.deepEqual(texts.map((item) => item.data.text), ['今天也还不错。', '你休息了吗。']);
  assert.ok(audios.length >= 2, '两个句子至少各一段音频');
  for (const audio of audios) {
    assert.equal(audio.data.turn_id, turn.turn_id);
    assert.equal(audio.data.format, 'mp3');
    assert.equal(audio.data.last, false);
  }
  assert.ok(completed.data.usage, '日额度应已提交并回传 usage');
  assert.ok(completed.data.assistant_message_id);

  // 回放令牌一次性。
  const replay = await fetch(`${base}${finalized.body.stream.stream_url}`, { headers: { authorization: 'Bearer dev-alice-token' } });
  assert.equal(replay.status, 409);

  // 终态对账：turn COMPLETED、日额度 1 轮、消息带通话标记。
  const detail = await request(base, `/api/v1/calls/${callId}`);
  assert.equal(detail.body.call.state, 'ACTIVE');
  const settledTurn = detail.body.turns.find((item) => item.turn_id === turn.turn_id);
  assert.equal(settledTurn.state, 'COMPLETED');
  const usage = await request(base, '/api/v1/usage/daily');
  assert.equal(usage.body.usage.chat_rounds, 1);
  const messages = await request(base, `/api/v1/conversations/${conversationId}/messages`);
  const callMessages = messages.body.messages.filter((item) => item.call_session_id === callId);
  assert.ok(callMessages.some((item) => item.actor === 'USER' && item.text === '今天心情怎么样'), '转写应以 USER 消息落库');
  assert.ok(callMessages.some((item) => item.actor === 'ASSISTANT' && item.text === '今天也还不错。你休息了吗。'), '回复应落库并带通话标记');

  // 挂断：ENDED/USER_HANGUP + 通话记录卡片；重复挂断幂等、不重复落卡。
  const ended = await request(base, `/api/v1/calls/${callId}/end`, { method: 'POST', key: 'end-1' });
  assert.equal(ended.status, 200);
  assert.equal(ended.body.call.state, 'ENDED');
  assert.equal(ended.body.call.end_reason, 'USER_HANGUP');
  assert.equal(ended.body.call.turn_count, 1);
  const repeat = await request(base, `/api/v1/calls/${callId}/end`, { method: 'POST', key: 'end-2' });
  assert.equal(repeat.status, 200);
  const afterEnd = await request(base, `/api/v1/conversations/${conversationId}/messages`);
  const cards = afterEnd.body.messages.filter((item) => item.provider === 'call-record');
  assert.equal(cards.length, 1, '重复挂断只落一张通话记录卡片');
  assert.match(cards[0].text, /通话结束 · 时长/);
  assert.match(cards[0].text, /共 1 轮对话/);
  assert.equal(cards[0].call_session_id, callId);
  assert.equal(cards[0].ai_generated, false, '通话记录卡片不是 AI 生成内容');
});

test('回合 SSE 未消费即挂断：回合按失败结算、缓冲丢弃、后续对账可见终态', async (t) => {
  const base = await start(t, { asrTranscriber: fakeAsr(), ttsGenerator: fakeTts(), voiceCallEnabled: true });
  const conversationId = await readyConversation(base, 'drop');
  await grantTrial(base, 'drop');
  const started = await startCall(base, conversationId, 'drop-call');
  const callId = started.body.call.call_id;
  const turnCreated = await request(base, `/api/v1/calls/${callId}/turns`, { method: 'POST', key: 'drop-turn' });
  const turn = turnCreated.body.turn;
  await uploadChunk(base, callId, turn.turn_id, 0, 'a'.repeat(32000));
  await request(base, `/api/v1/calls/${callId}/turns/${turn.turn_id}/finalize`, { method: 'POST', key: 'drop-finalize' });
  // 不消费 stream，直接挂断。
  const ended = await request(base, `/api/v1/calls/${callId}/end`, { method: 'POST', key: 'drop-end' });
  assert.equal(ended.status, 200);
  const detail = await request(base, `/api/v1/calls/${callId}`);
  const settledTurn = detail.body.turns.find((item) => item.turn_id === turn.turn_id);
  assert.equal(settledTurn.state, 'FAILED');
  assert.equal(settledTurn.failure_code, 'CALL_ENDED');
  // 挂断后回收令牌已被烧掉：原 stream 不再可消费（404 而非重新执行回合）。
  const messages = await request(base, `/api/v1/conversations/${conversationId}/messages`);
  assert.ok(messages.body.messages.some((item) => item.provider === 'call-record'), '挂断仍落通话记录卡片');
});

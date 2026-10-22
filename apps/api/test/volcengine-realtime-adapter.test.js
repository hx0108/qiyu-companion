'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { gzipSync } = require('node:zlib');
const { VolcengineRealtimeAdapter, encodeRealtimeFrame, decodeRealtimeFrame, createVolcengineRealtimeAdapterFromEnvironment } = require('../src/providers/volcengine-realtime-adapter');

function integer(value) { const bytes = Buffer.alloc(4); bytes.writeUInt32BE(value); return bytes; }
function server(event, payload = {}, id = 'connect', compression = false) {
  let bytes = Buffer.isBuffer(payload) ? payload : Buffer.from(JSON.stringify(payload));
  if (compression) bytes = gzipSync(bytes);
  return Buffer.concat([Buffer.from([0x11, Buffer.isBuffer(payload) ? 0xb4 : 0x94, (Buffer.isBuffer(payload) ? 0 : 16) | (compression ? 1 : 0), 0]), integer(event), integer(Buffer.byteLength(id)), Buffer.from(id), integer(bytes.length), bytes]);
}
// Payload schema fixtures transcribed from the official V3 page (updated 2026-09-28).
// https://docs.volcengine.com/docs/DoubaoVoice/End-to-endreal-timespeechlargemodelAPIaccessdocument?lang=zh
// 350: tts_type/text/question_id/reply_id; 351: question_id/reply_id;
// 359: question_id/reply_id/status_code; 450: question_id;
// 451: results[{text,is_interim}]; 459: {}; 150: dialog_id.
const OFFICIAL_PAYLOADS = {
  150: { dialog_id: 'd' },
  350: { tts_type: 'default', text: '你好。', question_id: 'q', reply_id: 'r' },
  351: { question_id: 'q', reply_id: 'r' },
  359: { question_id: 'q', reply_id: 'r', status_code: '20000000' },
  450: { question_id: 'q' },
  451: { results: [{ text: '你好', is_interim: false }] },
  459: {}
};
function client(frame) {
  const event = frame.readUInt32BE(4); let offset = 8; let id;
  if (event >= 100) { const size = frame.readUInt32BE(offset); offset += 4; id = frame.subarray(offset, offset + size).toString(); offset += size; }
  const length = frame.readUInt32BE(offset); offset += 4;
  return { event, id, payload: frame[2] === 0x10 ? JSON.parse(frame.subarray(offset, offset + length).toString()) : frame.subarray(offset, offset + length) };
}
class FakeSocket extends EventEmitter {
  constructor() { super(); this.readyState = 1; this.bufferedAmount = 0; this.sent = []; this.stopped = false; }
  send(bytes) {
    this.sent.push(bytes); const message = client(bytes);
    if (message.event === 1) queueMicrotask(() => this.emit('message', server(50), true));
    if (message.event === 100) { this.sessionId = message.id; queueMicrotask(() => this.emit('message', server(150, {}, message.id), true)); }
  }
  terminate() { this.stopped = true; this.readyState = 3; this.emit('close'); }
  frame(event, payload) { this.emit('message', server(event, payload, this.sessionId), true); }
}
const drain = () => new Promise((resolve) => setImmediate(resolve));
async function fixture(options = {}, sessionOptions = {}) {
  const socket = new FakeSocket(); const events = []; let receivedOptions;
  const adapter = new VolcengineRealtimeAdapter({ apiKey: 'test-synthetic-api-key', wsFactory: (_url, opt) => { receivedOptions = opt; queueMicrotask(() => socket.emit('open')); return socket; }, ...options });
  const session = await adapter.createSession({ instructions: '你叫小栖，保持角色一致。', onEvent: (event) => events.push(event), ...sessionOptions });
  return { socket, events, session, receivedOptions };
}

test('wire encoder exactly matches official StartConnection bytes and UTF8 length', () => {
  assert.deepEqual([...encodeRealtimeFrame(1)], [17, 20, 16, 0, 0, 0, 0, 1, 0, 0, 0, 2, 123, 125]);
  assert.equal(client(encodeRealtimeFrame(100, { text: '你好' }, '会话')).payload.text, '你好');
});
test('decoder handles gzip, raw PCM, errors and rejects malformed size/compression', () => {
  assert.deepEqual(decodeRealtimeFrame(server(350, { text: '好' }, 's', true)).payload, { text: '好' });
  assert.deepEqual(decodeRealtimeFrame(server(352, Buffer.from([0, 1]), 's')).payload, Buffer.from([0, 1]));
  const bad = server(350); bad.writeUInt32BE(9999, 8); assert.throws(() => decodeRealtimeFrame(bad), /实时语音/);
  const compressed = server(350); compressed[2] = 0x12; assert.throws(() => decodeRealtimeFrame(compressed));
  assert.throws(() => decodeRealtimeFrame(Buffer.alloc(10)));
  const payload = Buffer.from('{}'); const error = Buffer.concat([Buffer.from([17, 240, 16, 0]), integer(45000001), integer(payload.length), payload]);
  assert.equal(decodeRealtimeFrame(error).errorCode, 45000001);
});
test('API Key authentication and audited O2 session configuration are applied before input', async () => {
  const f = await fixture();
  try {
    assert.equal(f.receivedOptions.headers['X-Api-Key'], 'test-synthetic-api-key');
    assert.equal(f.receivedOptions.headers['X-Api-App-ID'], undefined);
    const config = client(f.socket.sent[1]).payload;
    assert.equal(config.dialog.extra.strict_audit, true); assert.equal(config.dialog.extra.enable_volc_websearch, false);
    assert.equal(config.dialog.system_role, '你叫小栖，保持角色一致。'); assert.equal(config.asr.extra.end_smooth_window_ms, 500);
    assert.equal(config.tts.audio_config.format, 'pcm_s16le');
    f.session.sendAudio(Buffer.from([0, 1])); assert.equal(client(f.socket.sent.at(-1)).event, 200);
    f.session.finishInput(); assert.throws(() => f.session.sendAudio(Buffer.from([0, 1])));
    assert.equal(f.socket.sent.length, 3, 'finishInput must not close server VAD before a response');
  } finally { f.session.close(); }
});
test('server gender chooses documented standard voices; explicit standard override is validated', async () => {
  for (const [gender, voice] of [['MALE', 'zh_male_yunzhou_jupiter_bigtts'], ['FEMALE', 'zh_female_vv_jupiter_bigtts']]) {
    const f = await fixture({}, { voiceGender: gender });
    try { assert.equal(client(f.socket.sent[1]).payload.tts.speaker, voice); } finally { f.session.close(); }
  }
  const override = await fixture({ speaker: 'zh_male_xiaotian_jupiter_bigtts' }, { voiceGender: 'MALE' });
  try { assert.equal(client(override.socket.sent[1]).payload.tts.speaker, 'zh_male_xiaotian_jupiter_bigtts'); } finally { override.session.close(); }
  const adapter = new VolcengineRealtimeAdapter({ apiKey: 'test' });
  await assert.rejects(adapter.createSession({ instructions: 'test', onEvent() {}, voiceGender: 'client-supplied-voice' }), { code: 'REALTIME_VOICE_GENDER_INVALID' });
  assert.throws(() => new VolcengineRealtimeAdapter({ apiKey: 'test', speaker: 'S_unverified_clone' }), { code: 'VOLCENGINE_REALTIME_CONFIG_INVALID' });
});

test('explicit O2 character gender wins over a global voice of another gender', async () => {
  for (const [voiceGender, speaker, expected] of [
    ['MALE', 'zh_female_vv_jupiter_bigtts', 'zh_male_yunzhou_jupiter_bigtts'],
    ['MALE', 'zh_female_xiaohe_jupiter_bigtts', 'zh_male_yunzhou_jupiter_bigtts'],
    ['FEMALE', 'zh_male_yunzhou_jupiter_bigtts', 'zh_female_vv_jupiter_bigtts'],
    ['FEMALE', 'zh_male_xiaotian_jupiter_bigtts', 'zh_female_vv_jupiter_bigtts'],
    ['MALE', 'zh_male_xiaotian_jupiter_bigtts', 'zh_male_xiaotian_jupiter_bigtts'],
    ['FEMALE', 'zh_female_xiaohe_jupiter_bigtts', 'zh_female_xiaohe_jupiter_bigtts']
  ]) {
    const f = await fixture({ speaker }, { voiceGender });
    try { assert.equal(client(f.socket.sent[1]).payload.tts.speaker, expected); }
    finally { f.session.close(); }
  }
  const sc = await fixture({ model: '2.2.0.0', speaker: 'S_explicit_unclassified_voice' }, { voiceGender: 'MALE' });
  try { assert.equal(client(sc.socket.sent[1]).payload.tts.speaker, 'S_explicit_unclassified_voice'); }
  finally { sc.session.close(); }
});
test('provider maps a whole audited sentence before correlated PCM and preserves order', async () => {
  const f = await fixture();
  try {
    f.socket.frame(451, { question_id: 'q1', results: [{ text: '你好', is_interim: false }] });
    f.socket.frame(459, {});
    f.socket.frame(350, { text: '你好呀。', reply_id: 'r1', question_id: 'q1' });
    f.socket.frame(352, Buffer.from([1, 0, 2, 0]));
    f.socket.frame(351, { reply_id: 'r1', question_id: 'q1' });
    f.socket.frame(359, { reply_id: 'r1', question_id: 'q1' }); await drain();
    assert.deepEqual(f.events.map((e) => e.type), ['transcript', 'transcript', 'speech-end', 'sentence-start', 'audio', 'sentence-end', 'response-complete']);
    assert.equal(f.events[0].final, false); assert.equal(f.events[1].final, true); assert.equal(f.events[4].segmentId, f.events[3].segmentId);
    assert.equal(f.events[4].clearedForPlayback, false); assert.equal(f.events[4].sampleRate, 24000);
  } finally { f.session.close(); }
});
test('official ASRInfo supplies question ID to ASRResponse and ASREnded without IDs', async () => {
  const f = await fixture();
  try {
    f.socket.frame(450, { question_id: 'official-q' });
    f.socket.frame(451, { results: [{ text: '晚上好', is_interim: false }] });
    f.socket.frame(459, {}); await drain();
    assert.deepEqual(f.events.map((e) => e.questionId), ['official-q', 'official-q', 'official-q', 'official-q']);
  } finally { f.session.close(); }
});
test('current official payload fixtures complete an entire correlated response', async () => {
  const f = await fixture();
  try {
    for (const event of [450, 451, 459, 350]) f.socket.frame(event, OFFICIAL_PAYLOADS[event]);
    f.socket.frame(352, Buffer.from([1, 0]));
    for (const event of [351, 359]) f.socket.frame(event, OFFICIAL_PAYLOADS[event]);
    await drain(); assert.equal(f.events.at(-1).type, 'response-complete');
  } finally { f.session.close(); }
});

// Reproduces the observed real O2.0 event shapes, using synthetic text and IDs.
// The actual diagnostic contains only field types, lengths and ID equality flags.
function completedReply(socket, { question = 'q', reply = 'r', complete = true } = {}) {
  socket.frame(450, { question_id: question });
  socket.frame(451, { results: [{ text: '你好', is_interim: false }] });
  socket.frame(459, {});
  for (const content of ['你好。', '今天', '开心吗？']) socket.frame(550, { content, question_id: question, reply_id: reply });
  if (complete) socket.frame(559, { question_id: question, reply_id: reply });
}
test('observed empty TTS text binds only sealed matching full reply before PCM review', async () => {
  const f = await fixture();
  try {
    completedReply(f.socket);
    f.socket.frame(350, { text: '', tts_type: 'default', question_id: 'q', reply_id: 'r' });
    f.socket.frame(352, Buffer.from([1, 0]));
    f.socket.frame(351, { question_id: 'q', reply_id: 'r' });
    f.socket.frame(359, { question_id: 'q', reply_id: 'r' }); await drain();
    assert.equal(f.session.closed, false);
    assert.deepEqual(f.events.slice(4).map((event) => event.type), ['sentence-start', 'audio', 'sentence-end', 'response-complete']);
    assert.equal(f.events.find((event) => event.type === 'sentence-start').text, '你好。今天开心吗？');
    assert.equal(f.events.find((event) => event.type === 'audio').clearedForPlayback, false);
  } finally { f.session.close(); }
});
test('multiple wire subclauses share one reviewed full-reply segment without duplicated text', async () => {
  const f = await fixture();
  try {
    completedReply(f.socket);
    for (const text of ['', '', '今天开心吗？']) {
      f.socket.frame(350, { text, tts_type: 'default', question_id: 'q', reply_id: 'r' });
      f.socket.frame(352, Buffer.from([1, 0]));
      f.socket.frame(351, { question_id: 'q', reply_id: 'r' });
    }
    f.socket.frame(359, { question_id: 'q', reply_id: 'r' }); await drain();
    assert.equal(f.session.closed, false);
    assert.equal(f.events.filter((event) => event.type === 'sentence-start').length, 1);
    assert.equal(f.events.filter((event) => event.type === 'sentence-end').length, 1);
    const audio = f.events.filter((event) => event.type === 'audio');
    assert.equal(audio.length, 3); assert.equal(new Set(audio.map((event) => event.segmentId)).size, 1);
  } finally { f.session.close(); }
});
test('empty TTS cannot bind conflicting reply IDs or changed full reply', async () => {
  for (const kind of ['wrong-start', 'wrong-end', 'late-delta', 'unreviewed-subclause', 'too-long']) {
    const f = await fixture();
    completedReply(f.socket, { complete: kind !== 'unfinished' });
    if (kind === 'wrong-end') f.socket.frame(559, { question_id: 'q', reply_id: 'other' });
    if (kind === 'late-delta') f.socket.frame(550, { content: '新文字', question_id: 'q', reply_id: 'r' });
    if (kind === 'too-long') {
      f.socket.frame(450, { question_id: 'next' });
      f.socket.frame(550, { content: '长'.repeat(4001), question_id: 'next', reply_id: 'r2' });
    }
    f.socket.frame(350, { text: '', tts_type: 'default', question_id: 'q', reply_id: kind === 'wrong-start' ? 'other' : 'r' });
    if (kind === 'unreviewed-subclause') {
      f.socket.frame(351, { question_id: 'q', reply_id: 'r' });
      f.socket.frame(350, { text: '不在完整回复里的新文字', question_id: 'q', reply_id: 'r' });
    }
    f.socket.frame(352, Buffer.from([1, 0])); await drain();
    assert.equal(f.session.closed, true, kind);
    assert.equal(f.events.some((event) => event.type === 'audio'), false, kind);
  }
});

test('early empty TTS is withheld until the matching text stream is sealed', async () => {
  const f = await fixture();
  try {
    completedReply(f.socket, { complete: false });
    f.socket.frame(350, { text: '', tts_type: 'default', question_id: 'q', reply_id: 'r' });
    f.socket.frame(352, Buffer.from([1, 0]));
    f.socket.frame(351, { question_id: 'q', reply_id: 'r' });
    await drain();
    assert.equal(f.session.closed, false);
    assert.equal(f.events.some((event) => ['sentence-start', 'audio'].includes(event.type)), false);
    f.socket.frame(559, { question_id: 'q', reply_id: 'r' });
    f.socket.frame(359, { question_id: 'q', reply_id: 'r' }); await drain();
    assert.deepEqual(f.events.slice(4).map((event) => event.type), ['sentence-start', 'audio', 'sentence-end', 'response-complete']);
    assert.equal(f.events.find((event) => event.type === 'sentence-start').text, '你好。今天开心吗？');
    assert.equal(f.session.closed, false);
  } finally { f.session.close(); }
});

test('pending unsealed TTS has a timeout and bounded bytes and never emits audio', async (t) => {
  for (const kind of ['timeout', 'bytes', 'frames', 'wrong-id']) {
    await t.test(kind, async (t) => {
      if (kind === 'timeout') t.mock.timers.enable({ apis: ['setTimeout'] });
      const f = await fixture();
      try {
        completedReply(f.socket, { complete: false });
        f.socket.frame(350, { text: '', tts_type: 'default', question_id: 'q', reply_id: 'r' }); await drain();
        if (kind === 'timeout') t.mock.timers.tick(5001);
        if (kind === 'bytes') for (let i = 0; i < 34; i++) f.socket.frame(352, Buffer.alloc(32000));
        if (kind === 'frames') for (let i = 0; i < 512; i++) f.socket.frame(352, Buffer.alloc(2));
        if (kind === 'wrong-id') f.socket.frame(559, { question_id: 'q', reply_id: 'different' });
        await drain();
        assert.equal(f.session.closed, true);
        assert.equal(f.events.some((event) => ['sentence-start', 'audio'].includes(event.type)), false);
        assert.equal(f.session.closedReason, f.events.at(-1).code);
        assert.throws(() => f.session.sendAudio(Buffer.alloc(2)), { code: f.session.closedReason });
      } finally { f.session.close(); }
    });
  }
});

test('barge-in discards buffered old TTS before accepting the next reply', async () => {
  const f = await fixture();
  try {
    completedReply(f.socket, { complete: false, question: 'old', reply: 'old-r' });
    f.socket.frame(350, { text: '', tts_type: 'default', question_id: 'old', reply_id: 'old-r' });
    f.socket.frame(352, Buffer.from([1, 0]));
    completedReply(f.socket, { question: 'new', reply: 'new-r' });
    f.socket.frame(351, { question_id: 'old', reply_id: 'old-r' });
    f.socket.frame(559, { question_id: 'old', reply_id: 'old-r' });
    f.socket.frame(350, { text: '', tts_type: 'default', question_id: 'new', reply_id: 'new-r' });
    f.socket.frame(352, Buffer.from([2, 0]));
    f.socket.frame(351, { question_id: 'new', reply_id: 'new-r' });
    f.socket.frame(359, { question_id: 'new', reply_id: 'new-r' }); await drain();
    assert.equal(f.session.closed, false);
    assert.deepEqual(f.events.filter((event) => event.type === 'audio').map((event) => event.replyId), ['new-r']);
  } finally { f.session.close(); }
});

test('terminal send retains the original protocol failure and safe branch diagnostic', async () => {
  const f = await fixture();
  f.socket.frame(350, { text: 'first', reply_id: 'r', question_id: 'q' });
  f.socket.frame(350, { text: 'private text must not appear in diagnostics', reply_id: 'r', question_id: 'q' }); await drain();
  assert.equal(f.events.at(-1).diagnostic, 'OVERLAPPING_START');
  assert.equal(f.session.closedReason, 'REALTIME_SENTENCE_UNBOUND');
  assert.throws(() => f.session.sendAudio(Buffer.alloc(2)), { code: 'REALTIME_SENTENCE_UNBOUND', diagnostic: 'OVERLAPPING_START' });
});

test('late interrupted sentence end cannot terminate the current reply sentence', async () => {
  const f = await fixture();
  try {
    f.socket.frame(450, { question_id: 'old' });
    f.socket.frame(350, { text: '旧回复', question_id: 'old', reply_id: 'old-r' });
    f.socket.frame(450, { question_id: 'new' });
    f.socket.frame(350, { text: '新回复', question_id: 'new', reply_id: 'new-r' });
    f.socket.frame(351, { question_id: 'old', reply_id: 'old-r' });
    f.socket.frame(352, Buffer.from([2, 0]));
    f.socket.frame(351, { question_id: 'new', reply_id: 'new-r' });
    f.socket.frame(359, { question_id: 'new', reply_id: 'new-r' }); await drain();
    assert.equal(f.session.closed, false);
    assert.equal(f.events.find((event) => event.type === 'audio').replyId, 'new-r');
    assert.equal(f.events.at(-1).type, 'response-complete');
  } finally { f.session.close(); }
});

test('explicit empty ASR activity is discarded without text or audio and the next turn works', async () => {
  const f = await fixture();
  try {
    f.socket.frame(450, { question_id: 'noise' });
    f.socket.frame(451, { results: [] });
    f.socket.frame(459, {});
    f.socket.frame(350, { text: 'must not play', question_id: 'noise', reply_id: 'noise-r' });
    f.socket.frame(352, Buffer.from([1, 0]));
    f.socket.frame(351, { question_id: 'noise', reply_id: 'noise-r' });
    f.socket.frame(359, { question_id: 'noise', reply_id: 'noise-r' }); await drain();
    assert.equal(f.session.closed, false);
    assert.equal(f.events.some((event) => ['transcript', 'audio', 'sentence-start'].includes(event.type)), false);
    completedReply(f.socket);
    f.socket.frame(350, { text: '', tts_type: 'default', question_id: 'q', reply_id: 'r' });
    f.socket.frame(352, Buffer.from([2, 0]));
    f.socket.frame(351, { question_id: 'q', reply_id: 'r' });
    f.socket.frame(359, { question_id: 'q', reply_id: 'r' }); await drain();
    assert.equal(f.session.closed, false);
    assert.deepEqual(f.events.filter((event) => event.type === 'audio').map((event) => event.replyId), ['r']);
  } finally { f.session.close(); }
});

test('empty ASR cannot turn an unconfirmed interim into a final user message', async () => {
  const f = await fixture();
  try {
  f.socket.frame(450, { question_id: 'q' });
  f.socket.frame(451, { results: [{ text: '非空但未确认', is_interim: true }] });
  f.socket.frame(451, { results: [] });
  f.socket.frame(459, {}); await drain();
  assert.equal(f.session.closed, false);
  assert.equal(f.events.at(-1).reason, 'ASR_UNCONFIRMED');
  assert.equal(f.events.some((event) => event.type === 'transcript' && event.final), false);
  } finally { f.session.close(); }
});

test('late old completion does not invalidate pending new TTS', async () => {
  const f = await fixture();
  try {
    completedReply(f.socket, { question: 'old', reply: 'old-r' });
    completedReply(f.socket, { question: 'new', reply: 'new-r', complete: false });
    f.socket.frame(350, { text: '', tts_type: 'default', question_id: 'new', reply_id: 'new-r' });
    f.socket.frame(352, Buffer.from([2, 0]));
    f.socket.frame(351, { question_id: 'old', reply_id: 'old-r' });
    f.socket.frame(359, { question_id: 'old', reply_id: 'old-r' });
    f.socket.frame(559, { question_id: 'new', reply_id: 'new-r' });
    f.socket.frame(351, { question_id: 'new', reply_id: 'new-r' });
    f.socket.frame(359, { question_id: 'new', reply_id: 'new-r' }); await drain();
    assert.equal(f.session.closed, false);
    assert.deepEqual(f.events.filter((event) => event.type === 'audio').map((event) => event.replyId), ['new-r']);
  } finally { f.session.close(); }
});

test('ambiguous old TTS start cannot put unlabelled old PCM in a pending new reply', async () => {
  const f = await fixture();
  completedReply(f.socket, { question: 'old', reply: 'old-r' });
  completedReply(f.socket, { question: 'new', reply: 'new-r', complete: false });
  f.socket.frame(350, { text: '', tts_type: 'default', question_id: 'new', reply_id: 'new-r' });
  f.socket.frame(350, { text: 'old output', question_id: 'old', reply_id: 'old-r' });
  f.socket.frame(352, Buffer.from([1, 0]));
  f.socket.frame(351, { question_id: 'old', reply_id: 'old-r' });
  f.socket.frame(559, { question_id: 'new', reply_id: 'new-r' }); await drain();
  assert.equal(f.session.closedReason, 'REALTIME_SENTENCE_UNBOUND');
  assert.equal(f.events.some((event) => event.type === 'audio'), false);
});
test('full-reply mapping rejects PCM in wire gaps and overlapping wire sentences', async () => {
  for (const kind of ['gap', 'overlap', 'early-complete']) {
    const f = await fixture(); completedReply(f.socket);
    f.socket.frame(350, { text: '', tts_type: 'default', question_id: 'q', reply_id: 'r' });
    if (kind === 'gap') f.socket.frame(351, { question_id: 'q', reply_id: 'r' });
    if (kind === 'overlap') f.socket.frame(350, { text: '', tts_type: 'default', question_id: 'q', reply_id: 'r' });
    if (kind === 'early-complete') f.socket.frame(359, { question_id: 'q', reply_id: 'r' });
    f.socket.frame(352, Buffer.from([1, 0])); await drain();
    assert.equal(f.session.closed, true); assert.equal(f.events.some((event) => event.type === 'audio'), false);
  }
});
test('explicit risky or unknown TTS types fail closed; only default permits empty-text binding', async () => {
  for (const tts_type of ['audit_content_risky', 'unknown-provider-type', 'network', 'sing', 'external_rag', 'chat_tts_text', undefined]) {
    const f = await fixture(); completedReply(f.socket);
    f.socket.frame(350, { text: '', tts_type, question_id: 'q', reply_id: 'r' });
    f.socket.frame(352, Buffer.from([1, 0])); await drain();
    assert.equal(f.session.closed, true, String(tts_type));
    assert.equal(f.events.some((event) => event.type === 'audio'), false);
  }
  for (const tts_type of ['audit_content_risky', 'unknown-provider-type']) {
    const f = await fixture();
    f.socket.frame(350, { text: '供应商审核风险回复', tts_type, question_id: 'q', reply_id: 'r' });
    f.socket.frame(352, Buffer.from([1, 0])); await drain();
    assert.equal(f.events.at(-1).code, 'REALTIME_TTS_TYPE_REJECTED');
    assert.equal(f.events.some((event) => event.type === 'audio'), false);
  }
});
test('barge-in discards sealed old reply and late text while a new sealed reply works', async () => {
  const f = await fixture();
  try {
    completedReply(f.socket, { question: 'old', reply: 'old-r' });
    completedReply(f.socket, { question: 'new', reply: 'new-r' });
    f.socket.frame(550, { content: '旧文字', question_id: 'old', reply_id: 'old-r' });
    f.socket.frame(559, { question_id: 'old', reply_id: 'old-r' });
    f.socket.frame(350, { text: '', tts_type: 'default', question_id: 'old', reply_id: 'old-r' });
    f.socket.frame(352, Buffer.from([1, 0]));
    f.socket.frame(351, { question_id: 'old', reply_id: 'old-r' });
    f.socket.frame(359, { question_id: 'old', reply_id: 'old-r' });
    f.socket.frame(350, { text: '', tts_type: 'default', question_id: 'new', reply_id: 'new-r' });
    f.socket.frame(352, Buffer.from([2, 0]));
    f.socket.frame(351, { question_id: 'new', reply_id: 'new-r' });
    f.socket.frame(359, { question_id: 'new', reply_id: 'new-r' }); await drain();
    assert.equal(f.session.closed, false);
    assert.deepEqual(f.events.filter((event) => event.type === 'audio').map((event) => event.replyId), ['new-r']);
  } finally { f.session.close(); }
});
test('completed reply cannot restart a duplicate segment with late nonempty TTS text', async () => {
  const f = await fixture(); completedReply(f.socket);
  f.socket.frame(350, { text: '', tts_type: 'default', question_id: 'q', reply_id: 'r' });
  f.socket.frame(351, { question_id: 'q', reply_id: 'r' });
  f.socket.frame(359, { question_id: 'q', reply_id: 'r' });
  f.socket.frame(350, { text: '你好。今天开心吗？', question_id: 'q', reply_id: 'r' });
  f.socket.frame(352, Buffer.from([1, 0])); await drain();
  assert.equal(f.session.closed, true);
  assert.equal(f.events.filter((event) => event.type === 'sentence-start').length, 1);
  assert.equal(f.events.some((event) => event.type === 'audio'), false);
});
test('text deltas preserve whitespace but a whitespace-only sealed reply cannot authorize audio', async () => {
  for (const contents of [['你', ' ', '', '好'], [' ', '\n', '']]) {
    const f = await fixture();
    try {
      f.socket.frame(450, { question_id: 'q' });
      for (const content of contents) f.socket.frame(550, { content, question_id: 'q', reply_id: 'r' });
      f.socket.frame(559, { question_id: 'q', reply_id: 'r' });
      f.socket.frame(350, { text: '', tts_type: 'default', question_id: 'q', reply_id: 'r' });
      f.socket.frame(352, Buffer.from([1, 0])); await drain();
      if (contents[0] === '你') {
        assert.equal(f.session.closed, false);
        assert.equal(f.events.find((event) => event.type === 'sentence-start').text, '你 好');
        assert.equal(f.events.at(-1).type, 'audio');
      } else {
        assert.equal(f.session.closed, true);
        assert.equal(f.events.some((event) => event.type === 'audio'), false);
      }
    } finally { f.session.close(); }
  }
});
test('old uncorrelated sentence end or wrong reply completion fails closed', async () => {
  for (const ending of [351, 359]) {
    const f = await fixture();
    f.socket.frame(350, OFFICIAL_PAYLOADS[350]);
    if (ending === 359) f.socket.frame(351, OFFICIAL_PAYLOADS[351]);
    f.socket.frame(ending, ending === 351 ? {} : { question_id: 'q', reply_id: 'other' });
    await drain(); assert.equal(f.session.closed, true);
    assert.equal(f.events.some((event) => event.type === 'response-complete'), false);
  }
});
test('ASR interim revisions are preview only; one final complete snapshot is published at Ended', async () => {
  const f = await fixture();
  try {
    f.socket.frame(450, { question_id: 'q' });
    f.socket.frame(451, { results: [{ text: '我不', is_interim: true }] });
    f.socket.frame(451, { results: [{ text: '我不喜欢', is_interim: false }, { text: '咖啡。', is_interim: false }] });
    f.socket.frame(459, {}); await drain();
    const final = f.events.filter((event) => event.type === 'transcript' && event.final);
    assert.equal(final.length, 1); assert.equal(final[0].text, '我不喜欢咖啡。');
  } finally { f.session.close(); }
});

test('ASR whitespace placeholders are filtered and an explicit final survives empty snapshots', async () => {
  const f = await fixture();
  try {
    f.socket.frame(450, { question_id: 'q' });
    f.socket.frame(451, { results: [{ text: ' ', is_interim: true }, { text: '你好', is_interim: false }, { text: '' }] });
    f.socket.frame(451, { results: [] });
    f.socket.frame(451, { results: [{ text: '\n' }] });
    f.socket.frame(459, {}); await drain();
    assert.equal(f.session.closed, false);
    assert.deepEqual(f.events.filter((event) => event.type === 'transcript' && event.final).map((event) => event.text), ['你好']);
  } finally { f.session.close(); }
});

test('missing ASR confirmation skips only that question and never authorizes its PCM', async () => {
  const f = await fixture();
  try {
    f.socket.frame(450, { question_id: 'uncertain' });
    f.socket.frame(451, { results: [{ text: '未明确确认的内容' }] });
    f.socket.frame(459, {});
    f.socket.frame(350, { text: '不能播放', question_id: 'uncertain', reply_id: 'uncertain-r' });
    f.socket.frame(352, Buffer.from([1, 0]));
    f.socket.frame(351, { question_id: 'uncertain', reply_id: 'uncertain-r' }); await drain();
    assert.equal(f.session.closed, false);
    assert.equal(f.events.some((event) => event.type === 'audio' || event.type === 'transcript' && event.final), false);
    assert.equal(f.events.find((event) => event.type === 'speech-end').reason, 'ASR_UNCONFIRMED');
    completedReply(f.socket);
    f.socket.frame(350, { text: '', tts_type: 'default', question_id: 'q', reply_id: 'r' });
    f.socket.frame(352, Buffer.from([2, 0]));
    f.socket.frame(351, { question_id: 'q', reply_id: 'r' });
    f.socket.frame(359, { question_id: 'q', reply_id: 'r' }); await drain();
    assert.equal(f.session.closed, false);
    assert.deepEqual(f.events.filter((event) => event.type === 'audio').map((event) => event.replyId), ['r']);
  } finally { f.session.close(); }
});

test('ASR malformed shapes and identifiers expose only fixed diagnostic codes', async () => {
  for (const [kind, diagnostic] of [['info', 'ASR_INFO'], ['question', 'ASR_QUESTION_MISMATCH'], ['schema', 'ASR_SCHEMA'], ['length', 'ASR_LENGTH']]) {
    const f = await fixture();
    f.socket.frame(450, { question_id: kind === 'info' ? '' : 'q' });
    if (kind === 'question') f.socket.frame(451, { question_id: 'other', results: [] });
    if (kind === 'schema') f.socket.frame(451, { results: [{ text: 'do-not-log', is_interim: 'false' }] });
    if (kind === 'length') f.socket.frame(451, { results: [{ text: '长'.repeat(4001), is_interim: false }] });
    await drain();
    assert.equal(f.session.closed, true);
    assert.equal(f.events.at(-1).diagnostic, diagnostic);
    assert.equal(JSON.stringify(f.events.at(-1)).includes('do-not-log'), false);
  }
});

test('optional speaking style is bounded and only sent to the O2 dialog schema', async () => {
  for (const model of ['1.2.1.1', '2.2.0.0']) {
    const f = await fixture(model === '2.2.0.0' ? { model, speaker: 'S_synthetic' } : { model }, { speakingStyle: '按当前角色语气自然回应。' });
    try { assert.equal(client(f.socket.sent[1]).payload.dialog.speaking_style, model === '1.2.1.1' ? '按当前角色语气自然回应。' : undefined); }
    finally { f.session.close(); }
  }
  for (const speakingStyle of [42, '', ' '.repeat(2), '长'.repeat(1001)]) {
    await assert.rejects(fixture({}, { speakingStyle }), { code: 'REALTIME_SESSION_CONFIG_INVALID' });
  }
  await assert.rejects(fixture({}, { instructions: '人'.repeat(3990), speakingStyle: '语'.repeat(11) }), { code: 'REALTIME_SESSION_CONFIG_INVALID' });
  const edge = await fixture({}, { instructions: '人'.repeat(3990), speakingStyle: '语'.repeat(10) });
  edge.session.close();
});
test('usage event forwards numeric token counts only without raw provider metadata', async () => {
  const f = await fixture();
  try {
    f.socket.frame(154, { usage: { input_text_tokens: 10, input_audio_tokens: 12, cached_text_tokens: 0, cached_audio_tokens: 0, output_text_tokens: 4, output_audio_tokens: 25, private_extra: 'do-not-forward' }, other: 'do-not-forward' });
    await drain(); assert.equal(f.events[0].type, 'usage'); assert.equal(f.events[0].usage.output_audio_tokens, 25);
    assert.equal(f.events[0].usage.private_extra, undefined); assert.equal(f.events[0].other, undefined);
  } finally { f.session.close(); }
});
test('barge-in revokes late old question frames while permitting the next response on same socket', async () => {
  const f = await fixture();
  try {
    f.socket.frame(450, { question_id: 'old-q' });
    f.socket.frame(350, { text: '旧回复。', question_id: 'old-q', reply_id: 'old-r' });
    f.socket.frame(450, { question_id: 'new-q' });
    f.socket.frame(352, Buffer.from([1, 0]));
    f.socket.frame(351, { question_id: 'old-q', reply_id: 'old-r' });
    f.socket.frame(350, { text: '旧的延迟句。', question_id: 'old-q', reply_id: 'old-r' });
    f.socket.frame(352, Buffer.from([1, 0]));
    f.socket.frame(351, { question_id: 'old-q', reply_id: 'old-r' });
    f.socket.frame(359, { question_id: 'old-q', reply_id: 'old-r' });
    f.socket.frame(350, { text: '新回复。', question_id: 'new-q', reply_id: 'new-r' });
    f.socket.frame(352, Buffer.from([2, 0]));
    f.socket.frame(351, { question_id: 'new-q', reply_id: 'new-r' });
    f.socket.frame(359, { question_id: 'new-q', reply_id: 'new-r' }); await drain();
    assert.equal(f.session.closed, false);
    assert.deepEqual(f.events.filter((event) => event.type === 'audio').map((event) => event.replyId), ['new-r']);
    assert.equal(f.events.at(-1).type, 'response-complete');
  } finally { f.session.close(); }
});
test('unbound PCM or mismatched session fails closed and emits only safe error codes', async () => {
  for (const mismatch of [false, true]) {
    const f = await fixture();
    if (mismatch) f.socket.emit('message', server(350, { text: '密钥不得泄露' }, 'other-session'), true);
    else f.socket.frame(352, Buffer.from([1, 0]));
    await drain(); assert.equal(f.socket.stopped, true); assert.equal(f.events.some((e) => e.type === 'audio'), false);
    assert.equal(f.events.at(-1).code, mismatch ? 'REALTIME_SESSION_MISMATCH' : 'REALTIME_AUDIO_UNBOUND');
  }
});
test('overlapping sentence mapping terminates instead of leaking audio', async () => {
  const f = await fixture();
  f.socket.frame(350, { text: '第一句', reply_id: 'r', question_id: 'q' });
  f.socket.frame(350, { text: '第二句', reply_id: 'r', question_id: 'q' });
  f.socket.frame(352, Buffer.from([1, 0])); await drain();
  assert.equal(f.events.at(-1).code, 'REALTIME_SENTENCE_UNBOUND'); assert.equal(f.events.some((e) => e.type === 'audio'), false);
});
test('asynchronous gate rejection blocks queued audio and terminates the provider session', async () => {
  const socket = new FakeSocket(); const events = [];
  const adapter = new VolcengineRealtimeAdapter({ apiKey: 'synthetic', wsFactory: () => { queueMicrotask(() => socket.emit('open')); return socket; } });
  const session = await adapter.createSession({ instructions: '测试', async onEvent(event) {
    events.push(event);
    if (event.type === 'sentence-start') { await drain(); throw new Error('not-cleared'); }
  } });
  socket.frame(350, { text: '未经审核的文字', reply_id: 'r', question_id: 'q' });
  socket.frame(352, Buffer.from([1, 0]));
  await drain(); await drain();
  assert.equal(session.closed, true); assert.equal(events.some((e) => e.type === 'audio'), false);
  assert.equal(events.at(-1).code, 'REALTIME_EVENT_HANDLER_FAILED');
});
test('abort or interrupt closes the connection and ignores all late provider audio', async () => {
  const f = await fixture(); f.session.interrupt(); f.socket.frame(352, Buffer.from([1, 0])); await drain();
  assert.equal(f.session.closed, true); assert.equal(f.events.some((e) => e.type === 'audio'), false);
  const signal = AbortSignal.abort(); const adapter = new VolcengineRealtimeAdapter({ apiKey: 'test' });
  await assert.rejects(adapter.createSession({ instructions: 'test', onEvent() {}, signal }), { code: 'REALTIME_ABORTED' });
});
test('startup timeout is bounded and never exposes credentials or raw provider rejection', async () => {
  const socket = new FakeSocket();
  const adapter = new VolcengineRealtimeAdapter({ apiKey: 'test-do-not-expose', timeoutMs: 5, wsFactory: () => socket });
  await assert.rejects(adapter.createSession({ instructions: 'test', onEvent() {} }), (error) => error.code === 'REALTIME_START_TIMEOUT' && !String(error).includes('test-do-not-expose'));
  assert.equal(socket.stopped, true);
});
test('legacy auth works, SC2 configuration is explicit, Ark-looking key is never auto-mapped', async () => {
  assert.equal(createVolcengineRealtimeAdapterFromEnvironment({ Doubao_API_KEY: 'unclassified-key' }), null);
  const f = await fixture({ apiKey: '  ', appId: '1234', accessKey: 'synthetic-access', model: '2.2.0.0', speaker: 'S_synthetic' });
  try { assert.equal(f.receivedOptions.headers['X-Api-App-ID'], '1234'); assert.equal(client(f.socket.sent[1]).payload.dialog.character_manifest, '你叫小栖，保持角色一致。'); }
  finally { f.session.close(); }
});
test('bounded session duration and outbound backpressure fail visibly', async () => {
  const f = await fixture({ maxSessionMs: 5 }); await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(f.events.at(-1).code, 'REALTIME_SESSION_LIMIT');
  const g = await fixture(); try { g.socket.bufferedAmount = 2 * 1024 * 1024; assert.throws(() => g.session.sendAudio(Buffer.from([0, 0])), { code: 'REALTIME_BACKPRESSURE' }); } finally { g.session.close(); }
});

test('real ws transport performs header handshake, binary framing and PCM over localhost only', async () => {
  const { WebSocket, WebSocketServer } = require('ws');
  const serverSocket = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise((resolve) => serverSocket.once('listening', resolve));
  let capturedHeaders; let receivedAudio;
  serverSocket.on('connection', (ws, request) => {
    capturedHeaders = request.headers;
    ws.on('message', (bytes, binary) => {
      assert.equal(binary, true); const frame = client(bytes);
      if (frame.event === 1) ws.send(server(50));
      if (frame.event === 100) ws.send(server(150, {}, frame.id));
      if (frame.event === 200) {
        receivedAudio = frame.payload;
        ws.send(server(450, { question_id: 'q' }, frame.id));
        ws.send(server(451, { results: [{ text: '你好', is_interim: false }] }, frame.id));
        ws.send(server(350, { text: '你好。', question_id: 'q', reply_id: 'r' }, frame.id));
        ws.send(server(352, Buffer.from([1, 0]), frame.id));
      }
    });
  });
  let session;
  try {
    const events = [];
    const adapter = new VolcengineRealtimeAdapter({ apiKey: 'synthetic-local-only', wsFactory: (_url, options) => new WebSocket(`ws://127.0.0.1:${serverSocket.address().port}`, options) });
    session = await adapter.createSession({ instructions: '测试', onEvent: (event) => events.push(event) });
    session.sendAudio(Buffer.from([0, 1]));
    for (let i = 0; i < 100 && !events.some((e) => e.type === 'audio'); i++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(capturedHeaders['x-api-key'], 'synthetic-local-only');
    assert.deepEqual(receivedAudio, Buffer.from([0, 1])); assert.equal(events.at(-1).type, 'audio');
    assert.equal(events.at(-1).questionId, 'q');
  } finally {
    session?.close(); for (const socket of serverSocket.clients) socket.terminate();
    await new Promise((resolve) => serverSocket.close(resolve));
  }
});

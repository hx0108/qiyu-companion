'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { TencentTtsAdapter, createTencentTtsGeneratorFromEnvironment } = require('../src/providers/tencent-tts-adapter');

test('腾讯 TTS 适配器只生成受限长度的 MP3 字节并记录请求 ID', async () => {
  let input;
  const adapter = new TencentTtsAdapter({ client: { request: async (request) => { input = request; return { Audio: Buffer.from('synthetic-mp3').toString('base64'), RequestId: 'tts_req_1' }; } }, voiceType: 101001 });
  const result = await adapter.synthesize({ text: '一段合成文本。', sessionId: 'tts_job_1' });
  assert.equal(input.service, 'tts');
  assert.equal(input.action, 'TextToVoice');
  assert.equal(input.version, '2019-08-23');
  assert.equal(input.body.Codec, 'mp3');
  assert.equal(input.body.VoiceType, 101001);
  assert.equal(result.providerRequestId, 'tts_req_1');
  assert.equal(result.asset.mimeType, 'audio/mpeg');
  assert.equal(result.asset.bytes.toString(), 'synthetic-mp3');
  await assert.rejects(() => adapter.synthesize({ text: 'x'.repeat(301), sessionId: 'too-long' }), (error) => error.code === 'TENCENT_TTS_TEXT_INVALID');
});

test('TTS 工厂保持显式开关，并要求固定音色的授权与审核溯源', () => {
  assert.equal(createTencentTtsGeneratorFromEnvironment({}), null);
  assert.throws(() => createTencentTtsGeneratorFromEnvironment({ QIYU_TTS_PROVIDER: 'tencent', TENCENT_SECRET_ID: 'id', TENCENT_SECRET_KEY: 'key', TENCENT_REGION: 'ap-guangzhou' }), (error) => error.code === 'TENCENT_TTS_VOICE_TYPE_REQUIRED');
  assert.throws(() => createTencentTtsGeneratorFromEnvironment({ QIYU_TTS_PROVIDER: 'tencent', TENCENT_SECRET_ID: 'id', TENCENT_SECRET_KEY: 'key', TENCENT_REGION: 'ap-guangzhou', TENCENT_TTS_VOICE_TYPE: '101001' }), (error) => error.code === 'TENCENT_TTS_VOICE_PROVENANCE_REQUIRED');
  const generator = createTencentTtsGeneratorFromEnvironment({
    QIYU_TTS_PROVIDER: 'tencent', TENCENT_SECRET_ID: 'id', TENCENT_SECRET_KEY: 'key', TENCENT_REGION: 'ap-guangzhou', TENCENT_TTS_VOICE_TYPE: '101001',
    TENCENT_TTS_VOICE_VERSION: 'provider-catalog-2026-09', TENCENT_TTS_AUTHORIZATION_RECORD_ID: 'tencent-service-entitlement-2026', TENCENT_TTS_RIGHTS_REVIEW_ID: 'rights-review-voice-001'
  });
  assert.deepEqual(generator.voiceProfile, {
    voice_id: 'tencent-standard-101001', voice_version: 'provider-catalog-2026-09', authorization_record_id: 'tencent-service-entitlement-2026', rights_review_id: 'rights-review-voice-001', rights_review_state: 'APPROVED', source: 'TENCENT_STANDARD_VOICE_OPERATOR_RECORD'
  });
});

// ---- 实时语音合成（WebSocket，情感参数）----

const { createHmac } = require('node:crypto');
const { TencentStreamTtsAdapter } = require('../src/providers/tencent-tts-adapter');

function fakeStreamServer(frames) {
  const sockets = [];
  const wsFactory = (url) => {
    const socket = { url, closeCalls: 0, close() { this.closeCalls += 1; this.onclose?.(); } };
    sockets.push(socket);
    queueMicrotask(() => { for (const frame of frames) socket.onmessage({ data: frame }); });
    return socket;
  };
  return { wsFactory, sockets };
}

const FIXED_NOW = () => new Date('2026-09-10T00:00:00Z');

test('流式适配器拼接签名 URL，收齐 binary 帧后关闭连接并返回 MP3 字节', async () => {
  const { wsFactory, sockets } = fakeStreamServer([
    JSON.stringify({ code: 0, message: 'success', request_id: 'ws_req_1', final: 0 }),
    new Uint8Array([104, 105]).buffer,
    new Blob([Buffer.from('!')]),
    JSON.stringify({ code: 0, message: 'success', final: 1 }),
  ]);
  const adapter = new TencentStreamTtsAdapter({ secretId: 'id', secretKey: 'key', appId: '1300123456', voiceType: 101001, wsFactory, timeoutMs: 2000, now: FIXED_NOW });
  const result = await adapter.synthesize({ text: '你好。', sessionId: 'tts_job_1' });
  assert.equal(result.asset.bytes.toString(), 'hi!');
  assert.equal(result.providerRequestId, 'ws_req_1');
  assert.equal(sockets[0].closeCalls, 1);

  // 签名快照：固定 now 后整条参数串与 HMAC 结果都可复现，防止排序/编码回归。
  const timestamp = Math.floor(FIXED_NOW().getTime() / 1000);
  const raw = `Action=TextToStreamAudioWS&AppId=1300123456&Codec=mp3&Expired=${timestamp + 300}&SampleRate=16000&SecretId=id&SessionId=tts_job_1&Text=你好。&Timestamp=${timestamp}&VoiceType=101001&Volume=0`;
  const expectedSignature = createHmac('sha1', 'key').update(`GETtts.cloud.tencent.com/stream_ws?${raw}`).digest('base64');
  const query = sockets[0].url.slice('wss://tts.cloud.tencent.com/stream_ws?'.length);
  assert.ok(query.includes(`Text=${encodeURIComponent('你好。')}`));
  assert.ok(query.includes(`Signature=${encodeURIComponent(expectedSignature)}`));
  const keys = query.split('&').map((pair) => pair.split('=')[0]);
  assert.deepEqual(keys.slice(0, -1), keys.slice(0, -1).slice().sort());
  assert.equal(keys.at(-1), 'Signature');
});

test('流式适配器把情感三元组编码进请求参数', async () => {
  const { wsFactory, sockets } = fakeStreamServer([
    JSON.stringify({ code: 0, request_id: 'ws_req_2', final: 0 }),
    new Uint8Array([1]).buffer,
    JSON.stringify({ code: 0, final: 1 }),
  ]);
  const adapter = new TencentStreamTtsAdapter({ secretId: 'id', secretKey: 'key', appId: '1300123456', voiceType: 101001, wsFactory, timeoutMs: 2000, now: FIXED_NOW });
  await adapter.synthesize({ text: '开心一点说。', sessionId: 'job', emotion: 'happy', intensity: 110, speed: 0.2 });
  const query = sockets[0].url.slice('wss://tts.cloud.tencent.com/stream_ws?'.length);
  assert.ok(query.includes('EmotionCategory=happy'));
  assert.ok(query.includes('EmotionIntensity=110'));
  assert.ok(query.includes('Speed=0.2'));
});

test('流式适配器映射上游错误码并标记可重试，超时也会关闭连接', async () => {
  const concurrency = fakeStreamServer([JSON.stringify({ code: 10002, message: '并发超限', final: 0 })]);
  const limited = new TencentStreamTtsAdapter({ secretId: 'id', secretKey: 'key', appId: '1300123456', voiceType: 101001, wsFactory: concurrency.wsFactory, timeoutMs: 2000, now: FIXED_NOW });
  await assert.rejects(() => limited.synthesize({ text: 'x', sessionId: 'job' }), (error) => {
    assert.equal(error.code, 'TENCENT_TTS_STREAM_CONCURRENCY_LIMIT');
    assert.equal(error.details.upstream_error_code, '10002');
    assert.equal(error.retryable, true);
    return true;
  });

  const { wsFactory, sockets } = fakeStreamServer([]);
  const silent = new TencentStreamTtsAdapter({ secretId: 'id', secretKey: 'key', appId: '1300123456', voiceType: 101001, wsFactory, timeoutMs: 40, now: FIXED_NOW });
  await assert.rejects(() => silent.synthesize({ text: 'x', sessionId: 'job' }), (error) => error.code === 'TENCENT_TTS_STREAM_TIMEOUT');
  assert.equal(sockets[0].closeCalls, 1);
});

test('流式适配器校验文本长度与情感参数取值', async () => {
  const { wsFactory } = fakeStreamServer([]);
  const adapter = new TencentStreamTtsAdapter({ secretId: 'id', secretKey: 'key', appId: '1300123456', voiceType: 101001, wsFactory, timeoutMs: 2000, now: FIXED_NOW });
  await assert.rejects(() => adapter.synthesize({ text: '长'.repeat(601), sessionId: 'job' }), (error) => error.code === 'TENCENT_TTS_TEXT_INVALID');
  await assert.rejects(() => adapter.synthesize({ text: 'x', sessionId: 'job', emotion: 'Joyful' }), (error) => error.code === 'TENCENT_TTS_EMOTION_INVALID');
  await assert.rejects(() => adapter.synthesize({ text: 'x', sessionId: 'job', emotion: 'sad', intensity: 300 }), (error) => error.code === 'TENCENT_TTS_EMOTION_INVALID');
  await assert.rejects(() => adapter.synthesize({ text: 'x', sessionId: 'job', emotion: 'sad', speed: 9 }), (error) => error.code === 'TENCENT_TTS_SPEED_INVALID');
});

test('synthesizeStream：首段音频即时回调，final 汇总仍返回完整字节与请求 ID', async () => {
  const { wsFactory, sockets } = fakeStreamServer([
    JSON.stringify({ code: 0, request_id: 'ws_req_stream', final: 0 }),
    new Uint8Array([104, 105]).buffer,
    new Blob([Buffer.from('!')]),
    JSON.stringify({ code: 0, final: 1 }),
  ]);
  const adapter = new TencentStreamTtsAdapter({ secretId: 'id', secretKey: 'key', appId: '1300123456', voiceType: 101001, wsFactory, timeoutMs: 2000, now: FIXED_NOW });
  const order = [];
  const result = await adapter.synthesizeStream({
    text: '你好。',
    sessionId: 'tts_job_stream',
    onAudioSegment: (segment) => order.push(`seg:${segment.toString()}`)
  }).then((aggregate) => { order.push('done'); return aggregate; });
  // 回调必须发生在 final 汇总之前（逐段下发不等整句合成完）。
  assert.deepEqual(order, ['seg:hi', 'seg:!', 'done']);
  assert.equal(result.asset.bytes.toString(), 'hi!');
  assert.equal(result.providerRequestId, 'ws_req_stream');
  assert.equal(sockets[0].closeCalls, 1);
});

test('synthesizeStream：abort 即关 WS 立刻中止，余帧与回调不再发生（打断不继续烧钱）', async () => {
  const { wsFactory, sockets } = fakeStreamServer([
    JSON.stringify({ code: 0, request_id: 'ws_req_abort', final: 0 }),
    new Uint8Array([1]).buffer,
    JSON.stringify({ code: 0, final: 1 }),
  ]);
  const adapter = new TencentStreamTtsAdapter({ secretId: 'id', secretKey: 'key', appId: '1300123456', voiceType: 101001, wsFactory, timeoutMs: 2000, now: FIXED_NOW });
  const controller = new AbortController();
  const segments = [];
  await assert.rejects(
    () => adapter.synthesizeStream({
      text: '打断我。',
      sessionId: 'job_abort',
      onAudioSegment: (segment) => { segments.push(segment); controller.abort(); },
      signal: controller.signal
    }),
    (error) => error.code === 'TENCENT_TTS_STREAM_ABORTED' && error.retryable === false && error.status === 499
  );
  assert.equal(segments.length, 1); // 首段之后到达的 final 帧不触发任何回调
  assert.equal(sockets[0].closeCalls, 1);

  // 起播前就打断（帧尚未到达）：abort 监听器路径同样立即关 WS。
  const quiet = fakeStreamServer([]);
  const early = new TencentStreamTtsAdapter({ secretId: 'id', secretKey: 'key', appId: '1300123456', voiceType: 101001, wsFactory: quiet.wsFactory, timeoutMs: 2000, now: FIXED_NOW });
  const earlyController = new AbortController();
  const pending = early.synthesizeStream({ text: '早停。', sessionId: 'job_early', signal: earlyController.signal });
  earlyController.abort();
  await assert.rejects(() => pending, (error) => error.code === 'TENCENT_TTS_STREAM_ABORTED');
  assert.equal(quiet.sockets[0].closeCalls, 1);
});

test('TTS 工厂 stream 模式要求 AppId，并切换到实时合成模型版本', () => {
  const base = { QIYU_TTS_PROVIDER: 'tencent', TENCENT_SECRET_ID: 'id', TENCENT_SECRET_KEY: 'key', TENCENT_REGION: 'ap-guangzhou', TENCENT_TTS_VOICE_TYPE: '101001', TENCENT_TTS_VOICE_VERSION: 'provider-catalog-2026-09', TENCENT_TTS_AUTHORIZATION_RECORD_ID: 'tencent-service-entitlement-2026', TENCENT_TTS_RIGHTS_REVIEW_ID: 'rights-review-voice-001' };
  assert.throws(() => createTencentTtsGeneratorFromEnvironment({ ...base, TENCENT_TTS_API_MODE: 'stream' }), (error) => error.code === 'TENCENT_TTS_APP_ID_REQUIRED');
  const generator = createTencentTtsGeneratorFromEnvironment({ ...base, TENCENT_TTS_API_MODE: 'stream', TENCENT_TTS_APP_ID: '1300123456' }, { wsFactory: fakeStreamServer([]).wsFactory });
  assert.equal(generator.modelVersion, 'TextToStreamAudioWS:emotion-v1');
  assert.equal(generator.provider, 'tencent-tts');
});

test('TTS 工厂按角色性别分派双音色：male 用男声音色，其余回默认音色', async () => {
  const base = {
    QIYU_TTS_PROVIDER: 'tencent', TENCENT_SECRET_ID: 'id', TENCENT_SECRET_KEY: 'key', TENCENT_TTS_API_MODE: 'stream', TENCENT_TTS_APP_ID: '1300123456',
    TENCENT_TTS_VOICE_TYPE: '601009', TENCENT_TTS_VOICE_TYPE_MALE: '601008',
    TENCENT_TTS_VOICE_VERSION: 'provider-catalog-2026-09', TENCENT_TTS_AUTHORIZATION_RECORD_ID: 'tencent-service-entitlement-2026', TENCENT_TTS_RIGHTS_REVIEW_ID: 'rights-review-voice-001'
  };
  const frames = [new Uint8Array([1, 2, 3]).buffer, JSON.stringify({ code: 0, final: 1, request_id: 'req_gender' })];
  const { wsFactory, sockets } = fakeStreamServer(frames);
  const generator = createTencentTtsGeneratorFromEnvironment(base, { wsFactory });
  await generator({ text: '男声台词。', sessionId: 'job_male', gender: 'male' });
  assert.match(sockets[0].url, /VoiceType=601008/);
  assert.equal(generator.voiceProfileFor('male').voice_id, 'tencent-standard-601008');
  assert.equal(generator.voiceProfileFor('female').voice_id, 'tencent-standard-601009');
  assert.equal(generator.voiceProfile.voice_id, 'tencent-standard-601009');
  await generator({ text: '默认台词。', sessionId: 'job_default' });
  assert.match(sockets[1].url, /VoiceType=601009/);

  // 男声音色未配置时回退默认音色：不会静默构建第二个适配器或失败。
  const fallback = createTencentTtsGeneratorFromEnvironment({ ...base, TENCENT_TTS_VOICE_TYPE_MALE: undefined }, { wsFactory: fakeStreamServer(frames).wsFactory });
  assert.equal(fallback.voiceProfileFor('male').voice_id, 'tencent-standard-601009');
});

test('TTS 工厂 stream 模式透出 synthesizeStream 分派（含双音色与回调），basic 模式不透出', async () => {
  const base = {
    QIYU_TTS_PROVIDER: 'tencent', TENCENT_SECRET_ID: 'id', TENCENT_SECRET_KEY: 'key', TENCENT_REGION: 'ap-guangzhou',
    TENCENT_TTS_API_MODE: 'stream', TENCENT_TTS_APP_ID: '1300123456',
    TENCENT_TTS_VOICE_TYPE: '601009', TENCENT_TTS_VOICE_TYPE_MALE: '601008',
    TENCENT_TTS_VOICE_VERSION: 'provider-catalog-2026-09', TENCENT_TTS_AUTHORIZATION_RECORD_ID: 'tencent-service-entitlement-2026', TENCENT_TTS_RIGHTS_REVIEW_ID: 'rights-review-voice-001'
  };
  const frames = [new Uint8Array([7]).buffer, JSON.stringify({ code: 0, final: 1, request_id: 'req_dispatch' })];
  const { wsFactory, sockets } = fakeStreamServer(frames);
  const generator = createTencentTtsGeneratorFromEnvironment(base, { wsFactory });
  assert.equal(typeof generator.synthesizeStream, 'function');
  const segments = [];
  const result = await generator.synthesizeStream({ text: '男声台词。', sessionId: 'job_dispatch', gender: 'male', onAudioSegment: (segment) => segments.push(segment) });
  assert.equal(result.asset.bytes.toString(), '\x07');
  assert.match(sockets[0].url, /VoiceType=601008/); // 分派沿性别路由，不因流式回调旁路
  assert.equal(segments.length, 1);

  // basic 模式（无 WS 适配器）不透出 synthesizeStream，调用方回退聚合合同。
  const basicGenerator = createTencentTtsGeneratorFromEnvironment({ ...base, TENCENT_TTS_API_MODE: undefined, TENCENT_TTS_APP_ID: undefined });
  assert.equal(basicGenerator.synthesizeStream, undefined);
});

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

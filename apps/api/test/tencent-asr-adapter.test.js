'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { MAX_ASR_AUDIO_BYTES, TencentAsrAdapter, createTencentAsrTranscriberFromEnvironment } = require('../src/providers/tencent-asr-adapter');

test('腾讯 ASR 适配器仅发送受控短音频并返回可编辑转写', async () => {
  let input;
  const adapter = new TencentAsrAdapter({ client: { request: async (request) => { input = request; return { Result: '你好，栖语。', RequestId: 'asr_req_1' }; } } });
  const result = await adapter.transcribe({ bytes: Buffer.from('synthetic-wav'), mimeType: 'audio/wav' });
  assert.equal(input.service, 'asr');
  assert.equal(input.action, 'SentenceRecognition');
  assert.equal(input.version, '2019-06-14');
  assert.equal(input.body.EngSerViceType, '16k_zh');
  assert.equal(input.body.VoiceFormat, 'wav');
  assert.equal(input.body.Data, Buffer.from('synthetic-wav').toString('base64'));
  assert.equal(input.body.DataLen, Buffer.byteLength('synthetic-wav'));
  assert.deepEqual(result, { text: '你好，栖语。', providerRequestId: 'asr_req_1' });
  await assert.rejects(() => adapter.transcribe({ bytes: Buffer.alloc(MAX_ASR_AUDIO_BYTES + 1), mimeType: 'audio/wav' }), (error) => error.code === 'TENCENT_ASR_AUDIO_INVALID');
  await assert.rejects(() => adapter.transcribe({ bytes: Buffer.from('x'), mimeType: 'audio/webm' }), (error) => error.code === 'TENCENT_ASR_AUDIO_FORMAT_INVALID');
});

test('ASR 工厂保持显式开关并使用默认中文引擎', () => {
  assert.equal(createTencentAsrTranscriberFromEnvironment({}), null);
  const transcriber = createTencentAsrTranscriberFromEnvironment({ QIYU_ASR_PROVIDER: 'tencent', TENCENT_SECRET_ID: 'id', TENCENT_SECRET_KEY: 'key', TENCENT_REGION: 'ap-guangzhou' }, { fetchImpl: async () => ({}) });
  assert.equal(typeof transcriber, 'function');
});

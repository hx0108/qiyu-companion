'use strict';

const { assertAdapterResult } = require('../production/adapter-contracts');
const { TencentTc3Client, TencentProviderError } = require('./tencent-tc3-client');

const ASR_VERSION = '2019-06-14';
const MAX_ASR_AUDIO_BYTES = 2 * 1024 * 1024;
const VOICE_FORMATS = Object.freeze({
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'audio/ogg': 'ogg-opus'
});

class TencentAsrAdapter {
  constructor({ client, engineModelType = '16k_zh' } = {}) {
    if (!client || typeof client.request !== 'function') throw new TypeError('TencentAsrAdapter requires a Tencent TC3 client');
    if (!validEngineModelType(engineModelType)) throw new TencentProviderError('TENCENT_ASR_CONFIGURATION_INVALID', '腾讯云 ASR 引擎配置无效', 500);
    this.client = client;
    this.engineModelType = engineModelType;
  }

  async transcribe({ bytes, mimeType } = {}) {
    if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > MAX_ASR_AUDIO_BYTES) {
      throw new TencentProviderError('TENCENT_ASR_AUDIO_INVALID', `语音文件必须为 1-${MAX_ASR_AUDIO_BYTES} 字节`, 400);
    }
    const voiceFormat = VOICE_FORMATS[mimeType];
    if (!voiceFormat) throw new TencentProviderError('TENCENT_ASR_AUDIO_FORMAT_INVALID', '语音文件格式不受支持', 400);
    const response = await this.client.request({
      service: 'asr', action: 'SentenceRecognition', version: ASR_VERSION,
      body: {
        EngSerViceType: this.engineModelType, SourceType: 1, VoiceFormat: voiceFormat,
        Data: bytes.toString('base64'), DataLen: bytes.length, WordInfo: 0,
        FilterDirty: 0, FilterModal: 0, FilterPunc: 0, ConvertNumMode: 1
      }
    });
    if (!nonBlank(response.Result) || !nonBlank(response.RequestId)) {
      throw new TencentProviderError('TENCENT_ASR_RESPONSE_INVALID', '腾讯云 ASR 未返回可用转写', 502);
    }
    return assertAdapterResult('ASR', { text: response.Result.trim(), providerRequestId: response.RequestId });
  }
}

function createTencentAsrTranscriberFromEnvironment(environment = process.env, dependencies = {}) {
  if (environment.QIYU_ASR_PROVIDER !== 'tencent') return null;
  const adapter = new TencentAsrAdapter({
    client: new TencentTc3Client({ secretId: environment.TENCENT_SECRET_ID, secretKey: environment.TENCENT_SECRET_KEY, region: environment.TENCENT_REGION, fetchImpl: dependencies.fetchImpl || globalThis.fetch, timeoutMs: environment.TENCENT_ASR_TIMEOUT_MS, now: dependencies.now }),
    engineModelType: environment.TENCENT_ASR_ENGINE_MODEL_TYPE || '16k_zh'
  });
  const transcribe = (input) => adapter.transcribe(input);
  transcribe.provider = 'tencent-asr';
  transcribe.modelVersion = `SentenceRecognition/${ASR_VERSION}:${adapter.engineModelType}`;
  return transcribe;
}

function validEngineModelType(value) { return typeof value === 'string' && /^[A-Za-z0-9_.-]{3,64}$/.test(value); }
function nonBlank(value) { return typeof value === 'string' && value.trim().length > 0; }
module.exports = { ASR_VERSION, MAX_ASR_AUDIO_BYTES, VOICE_FORMATS, TencentAsrAdapter, createTencentAsrTranscriberFromEnvironment };

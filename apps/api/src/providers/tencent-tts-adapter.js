'use strict';

const { assertAdapterResult } = require('../production/adapter-contracts');
const { TencentTc3Client, TencentProviderError } = require('./tencent-tc3-client');

const TTS_VERSION = '2019-08-23';
const MAX_TTS_TEXT_LENGTH = 300;

class TencentTtsAdapter {
  constructor({ client, voiceType, modelType = 1, codec = 'mp3', sampleRate = 16000 } = {}) {
    if (!client || typeof client.request !== 'function') throw new TypeError('TencentTtsAdapter requires a Tencent TC3 client');
    if (!positiveInteger(voiceType)) throw new TencentProviderError('TENCENT_TTS_VOICE_TYPE_REQUIRED', '腾讯云 TTS 音色未配置', 500);
    if (!positiveInteger(modelType) || codec !== 'mp3' || ![8000, 16000, 24000].includes(Number(sampleRate))) {
      throw new TencentProviderError('TENCENT_TTS_CONFIGURATION_INVALID', '腾讯云 TTS 配置无效', 500);
    }
    this.client = client;
    this.voiceType = Number(voiceType);
    this.modelType = Number(modelType);
    this.codec = codec;
    this.sampleRate = Number(sampleRate);
  }

  async synthesize({ text, sessionId }) {
    if (!nonBlank(text) || text.trim().length > MAX_TTS_TEXT_LENGTH) {
      throw new TencentProviderError('TENCENT_TTS_TEXT_INVALID', `语音文本必须为 1-${MAX_TTS_TEXT_LENGTH} 个字符`, 400);
    }
    const response = await this.client.request({
      service: 'tts', action: 'TextToVoice', version: TTS_VERSION,
      body: { Text: text.trim(), SessionId: safeSessionId(sessionId), ModelType: this.modelType, VoiceType: this.voiceType, Codec: this.codec, SampleRate: this.sampleRate, Speed: 0, Volume: 0, EnableSubtitle: false }
    });
    if (!nonBlank(response.Audio) || !nonBlank(response.RequestId)) throw new TencentProviderError('TENCENT_TTS_RESPONSE_INVALID', '腾讯云 TTS 未返回音频', 502);
    let bytes;
    try { bytes = Buffer.from(response.Audio, 'base64'); } catch { throw new TencentProviderError('TENCENT_TTS_RESPONSE_INVALID', '腾讯云 TTS 音频格式无效', 502); }
    if (bytes.length === 0 || bytes.length > 10 * 1024 * 1024) throw new TencentProviderError('TENCENT_TTS_RESPONSE_INVALID', '腾讯云 TTS 音频大小无效', 502);
    return assertAdapterResult('TTS', { asset: { bytes, mimeType: 'audio/mpeg', byteLength: bytes.length }, providerRequestId: response.RequestId });
  }
}

function createTencentTtsGeneratorFromEnvironment(environment = process.env, dependencies = {}) {
  if (environment.QIYU_TTS_PROVIDER !== 'tencent') return null;
  const adapter = new TencentTtsAdapter({
    client: new TencentTc3Client({ secretId: environment.TENCENT_SECRET_ID, secretKey: environment.TENCENT_SECRET_KEY, region: environment.TENCENT_REGION, fetchImpl: dependencies.fetchImpl || globalThis.fetch, timeoutMs: environment.TENCENT_TTS_TIMEOUT_MS, now: dependencies.now }),
    voiceType: environment.TENCENT_TTS_VOICE_TYPE,
    modelType: environment.TENCENT_TTS_MODEL_TYPE || 1,
    codec: 'mp3', sampleRate: environment.TENCENT_TTS_SAMPLE_RATE || 16000
  });
  const synthesize = (input) => adapter.synthesize(input);
  // Standard Tencent voices are never selected by the client.  The operator
  // records the provider entitlement and the completed internal rights review
  // once, then every task snapshots this immutable provenance.
  synthesize.voiceProfile = Object.freeze({
    voice_id: `tencent-standard-${adapter.voiceType}`,
    voice_version: requiredProfileValue(environment.TENCENT_TTS_VOICE_VERSION, 'TENCENT_TTS_VOICE_VERSION'),
    authorization_record_id: requiredProfileValue(environment.TENCENT_TTS_AUTHORIZATION_RECORD_ID, 'TENCENT_TTS_AUTHORIZATION_RECORD_ID'),
    rights_review_id: requiredProfileValue(environment.TENCENT_TTS_RIGHTS_REVIEW_ID, 'TENCENT_TTS_RIGHTS_REVIEW_ID'),
    rights_review_state: 'APPROVED',
    source: 'TENCENT_STANDARD_VOICE_OPERATOR_RECORD'
  });
  synthesize.provider = 'tencent-tts';
  synthesize.modelVersion = `TextToVoice/${TTS_VERSION}:${adapter.modelType}`;
  return synthesize;
}

function safeSessionId(value) { return nonBlank(value) ? value.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64) : 'qiyu_tts'; }
function nonBlank(value) { return typeof value === 'string' && value.trim().length > 0; }
function positiveInteger(value) { return Number.isInteger(Number(value)) && Number(value) > 0; }
function requiredProfileValue(value, name) {
  if (!nonBlank(value) || !/^[A-Za-z0-9._:-]{1,128}$/.test(value.trim())) {
    throw new TencentProviderError('TENCENT_TTS_VOICE_PROVENANCE_REQUIRED', `${name} 必须是 1-128 位的服务端音色授权记录标识`, 500);
  }
  return value.trim();
}

module.exports = { MAX_TTS_TEXT_LENGTH, TTS_VERSION, TencentTtsAdapter, createTencentTtsGeneratorFromEnvironment };
